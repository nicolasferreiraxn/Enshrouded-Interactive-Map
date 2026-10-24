// Estado ao vivo dos objetos perto do jogador.
//
// O ECS do cliente guarda as entidades replicadas em chunks de arquétipo, todos numa janela de
// ~32 MB do heap 0x300'0000'0000. Cabeçalho do chunk (alinhado a 64 bytes):
//   +0x00/+0x08 ponteiros p/ outros cabeçalhos (ou 0), +0x10 u32 n (entidades vivas), +0x14 u16 0x40
//   (offset dos ids) e mais 3 offsets crescentes. Depois vêm os arrays SoA dos componentes; o
//   CurrentTransform (56 bytes) começa com a WorldPosition 32.32 e a posição das entidades fixas bate
//   com a do SceneEntityChunkResource. Item pego / runa recolhida = entidade destruída = some dos chunks.
// Baús continuam existindo: no chunk do baú (o que tem ClientInteractionOffer com verbo de baú) o array
// seguinte é o InventoryEmptyState; isEmpty=1 = já saqueado. A mesma posição também aparece no chunk das
// subentidades do baú (flag 0), então o frontend deve preferir o ponto com flag != 0.
use crate::item_ids::ITEM_IDS;
use crate::tracker::{find_pid, module_base, read_world_pos, Proc};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize, Default)]
pub struct LiveState {
    pub status: &'static str, // "fechado" | "procurando" | "ok"
    pub x: f32,
    pub y: f32,
    pub z: f32,
    // x, y, z, flag por entidade viva perto do jogador. flag: 0 = existe; 1 = baú vazio (já saqueado);
    // 2 = baú com itens; 3 = saque de monstro (corpo) ainda não recolhido; 4 = item solto ("Pegar");
    // 5 = ToggleState ligado (botão/alavanca já acionado; só faz sentido nos pontos 'logic' do nearby.bin);
    // 6 = trancado já destrancado (ClientInteractionLock.itemUsed: porta/baú de gazua ou chave);
    // 7 = usado por um jogador (ClientInteractionOffer.lastAcceptionId != 0; o app usa nas portas secretas)
    pub pts: Vec<f32>,
    // saques de monstro / itens soltos / animais mortos (entidades dinâmicas) com o conteúdo
    pub loot: Vec<Loot>,
    // criaturas vivas (dinâmicas, NetworkHealth.health > 0) até LIVE_R
    pub mobs: Vec<Mob>,
    // outros jogadores do servidor (o cliente replica todos, a qualquer distância), com o nome da Steam
    pub players: Vec<Player>,
    pub chunks: usize,
    pub ms: u32,
}

#[derive(Clone, Serialize, Default)]
pub struct Loot {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub kind: u8,        // 3 = "Saquear" (corpo de monstro), 4 = "Pegar" (item solto ou animal morto)
    pub item: u32,       // PickupItem.itemId (item solto) ou 0
    pub items: Vec<[u32; 2]>, // Inventory: [itemId, quantidade] (nomes em app/public/live_names.json)
    pub creature: i32,   // índice em live_names.json "creatures": pelo template (exato) ou, sem ele, pelo GUID de modelo/animação/áudio no chunk; -1
    pub hp_max: u32,     // NetworkHealth.healthMax do bicho morto (0 = não achado); desempate de espécie
    pub tpl: i32,        // índice do template em template_info.bin = posição em app/public/live_templates.json (nome); -1
    pub provavel: bool,  // item tirado do modelo do pickup genérico (Base_LootPickup_*_Generic*): provável, não lido
}

// Template de cada entidade: o 3º array de sistema do chunk (offset u16 em +0x18 do cabeçalho)
// tem, por slot, um ponteiro para o TemplateInfo do cliente, que começa com o GUID do TemplateResource.
// template_info.bin (gerado por script interno, não publicado): 24 B por template, ordenado pelo GUID (bytes_le):
// GUID 16 | u32 itemId do PickupItem | i16 criatura (live_names "creatures") | u8 flags | u8 0
static TEMPLATE_INFO: &[u8] = include_bytes!("../template_info.bin");
const TF_GENERICO: u8 = 2; // pickup sem item no template: o item sai do modelo
const TF_PARTE: u8 = 8; // subentidade (colisor, ponto fraco) de criatura
const TF_CRIATURA: u8 = 16;
// model_items.bin: GUID de modelo de item (bytes_le) -> u32 itemId + u32 nº de itens com esse modelo
static MODEL_ITEMS: &[u8] = include_bytes!("../model_items.bin");

fn bsearch(tab: &[u8], rec: usize, g: &[u8]) -> Option<usize> {
    let (mut lo, mut hi) = (0usize, tab.len() / rec);
    while lo < hi {
        let mid = (lo + hi) / 2;
        match tab[mid * rec..mid * rec + 16].cmp(g) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Some(mid),
        }
    }
    None
}

fn tpl_item(t: i32) -> u32 {
    if t < 0 { 0 } else { rd_u32(TEMPLATE_INFO, t as usize * 24 + 16) }
}
fn tpl_creature(t: i32) -> i32 {
    if t < 0 { -1 } else { rd_u16(TEMPLATE_INFO, t as usize * 24 + 20) as i16 as i32 }
}
fn tpl_flags(t: i32) -> u8 {
    if t < 0 { 0 } else { TEMPLATE_INFO[t as usize * 24 + 22] }
}

// ponteiro do TemplateInfo -> índice em template_info.bin (os TemplateInfo não mudam enquanto o processo vive)
#[derive(Default)]
pub struct Templates {
    cache: HashMap<u64, i32>,
}

impl Templates {
    fn of(&mut self, p: &Proc, c: &[u8], n: usize, j: usize) -> i32 {
        let o2 = rd_u16(c, 0x18) as usize;
        if o2 < 0x40 || o2 + 8 * n > c.len() {
            return -1;
        }
        let ptr = rd_u64(c, o2 + 8 * j);
        if ptr >> 40 != 3 {
            return -1;
        }
        *self.cache.entry(ptr).or_insert_with(|| {
            let mut g = [0u8; 16];
            if p.read(ptr, &mut g) != 16 {
                return -1;
            }
            bsearch(TEMPLATE_INFO, 24, &g).map_or(-1, |i| i as i32)
        })
    }
}

// pickup genérico: array de 16 B por slot em que todos os n valores são GUIDs de modelo de item
fn model_array(c: &[u8], n: usize) -> Option<usize> {
    let mut o = 0x40;
    while o + 16 * n <= c.len() {
        if (0..n).all(|j| bsearch(MODEL_ITEMS, 24, &c[o + 16 * j..o + 16 * j + 16]).is_some()) {
            return Some(o);
        }
        o += 64;
    }
    None
}

// GUID de recurso -> criatura (gerado por script interno, não publicado): registros de 16 B (GUID bytes_le) + u16, ordenados
static CREATURE_GUIDS: &[u8] = include_bytes!("../creature_guids.bin");

fn creature_of(g: &[u8]) -> Option<u16> {
    let n = CREATURE_GUIDS.len() / 18;
    let (mut lo, mut hi) = (0usize, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        let k = &CREATURE_GUIDS[mid * 18..mid * 18 + 16];
        match k.cmp(g) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Some(rd_u16(CREATURE_GUIDS, mid * 18 + 16)),
        }
    }
    None
}

// procura, nos arrays de 16 bytes do chunk (passo 16), o GUID de criatura do slot j
fn creature_in(c: &[u8], n: usize, j: usize) -> i32 {
    let mut o = 0x40;
    while o + 16 * n <= c.len() {
        let r = o + 16 * j;
        if c[r..r + 16].iter().any(|&b| b != 0) {
            if let Some(i) = creature_of(&c[r..r + 16]) {
                return i as i32;
            }
        }
        o += 16;
    }
    -1
}

#[derive(Clone, Serialize, Default)]
pub struct Mob {
    pub id: u32, // EntityId (segue a criatura quando o jogo a muda de chunk)
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub hp: u32,
    pub hp_max: u32,
    pub creature: i32, // como em Loot (pelo template)
    pub tpl: i32,      // como em Loot
}

#[derive(Clone, Serialize, Default)]
pub struct Player {
    #[serde(skip)]
    pub addr: u64, // CurrentTransform da entidade (relido a 10 Hz entre as leituras completas)
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

// Tabela de jogadores da interface (20/10/2026): registros de 0x240 B no heap 0x300'..., um por jogador que já
// entrou na sessão (quem saiu continua lá, parado). +0x00 posição f32 xyz (atrasada), +0xe8 nome da Steam (UTF-8,
// terminado em 0). Assinatura: constantes f32 em +0x70 2,2 / +0x84 1,0 / +0x98 1,3 / +0xac 1,0 / +0x210 1,0.
// Só vale o registro que bate com uma entidade de jogador viva (EntityId 1..16); a posição usada é a da entidade.
const PREC: usize = 0x240;
fn is_player_rec(b: &[u8], o: usize) -> bool {
    o + PREC <= b.len()
        && rd_u32(b, o + 0x70) == 0x400c_cccd
        && rd_u32(b, o + 0x84) == 0x3f80_0000
        && rd_u32(b, o + 0x98) == 0x3fa6_6666
        && rd_u32(b, o + 0xac) == 0x3f80_0000
        && rd_u32(b, o + 0x210) == 0x3f80_0000
        && b[o + 0xe8] != 0
}

fn find_player_recs(p: &Proc) -> Vec<u64> {
    let mut out = vec![];
    let mut buf = vec![0u8; 16 << 20];
    for (base, size) in p.regions_from(ARENA) {
        if base >> 40 != 3 {
            break;
        }
        let mut off = 0usize;
        while off < size {
            let len = (size - off).min(buf.len());
            let n = p.read(base + off as u64, &mut buf[..len]);
            let mut o = 0;
            while o + PREC <= n {
                if rd_u32(&buf, o + 0x70) == 0x400c_cccd && is_player_rec(&buf, o) {
                    out.push(base + (off + o) as u64);
                }
                o += 16;
            }
            off += len;
        }
    }
    out
}

// casa os registros com as entidades de jogador; o registro do próprio jogador (o mais perto da posição exata dele) sai
fn players_of(p: &Proc, recs: &[u64], ents: &[[f32; 3]], addrs: &[u64], me: [f32; 3]) -> (Vec<Player>, bool) {
    let mut rs: Vec<(String, [f32; 3])> = vec![];
    let mut b = vec![0u8; PREC];
    for &a in recs {
        if p.read(a, &mut b) != PREC || !is_player_rec(&b, 0) {
            continue;
        }
        let nm = &b[0xe8..0xe8 + 64];
        let nm = &nm[..nm.iter().position(|&c| c == 0).unwrap_or(64)];
        rs.push((String::from_utf8_lossy(nm).trim().to_string(), [rd_f32(&b, 0), rd_f32(&b, 4), rd_f32(&b, 8)]));
    }
    let d = |a: [f32; 3], b: [f32; 3]| ((a[0] - b[0]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    // pares (registro, entidade) do mais perto ao mais longe, cada um usado uma vez
    let mut pairs = vec![];
    for (i, r) in rs.iter().enumerate() {
        for (j, e) in ents.iter().enumerate() {
            let dd = d(r.1, *e);
            if dd < 60.0 {
                pairs.push((dd, i, j));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let (mut ru, mut eu) = (vec![false; rs.len()], vec![false; ents.len()]);
    let mut out = vec![];
    for (_, i, j) in pairs {
        if ru[i] || eu[j] {
            continue;
        }
        ru[i] = true;
        eu[j] = true;
        let e = ents[j];
        if d(e, me) < 0.5 && (e[1] - me[1]).abs() < 2.0 {
            continue; // eu
        }
        out.push(Player { addr: addrs[j], name: rs[i].0.clone(), x: e[0], y: e[1], z: e[2] });
    }
    let missing = eu.iter().enumerate().any(|(j, &u)| !u && d(ents[j], me) >= 0.5);
    (out, missing)
}

// Descritores de arquétipo: páginas de 4 KB em 0x300'4000'0000.., descritor em +0x3c0; +0x50 = 1º chunk da lista
// e, a partir de +0xa0, tabela u16 de offsets indexada pelo id global do componente (0 = ausente).
const ARCH_BASE: u64 = 0x300_4000_0000;
const ARCH_SIZE: usize = 32 << 20;
const CID_CURRENT_TRANSFORM: usize = 119;
const CID_NETWORK_HEALTH: usize = 369; // medido em 19/10 (corpos de lobo/rato: health 0, healthMax 223/33)
// ClientInteractionLock { itemUsed: bool } (porta/baú trancado que pede gazua ou chave): 1 = já destrancado.
// Medido em 20/10 numa Prop_Door_Large_Castle_02_Locked_Pickable aberta com gazua (padrão do template: false).
const CID_CLIENT_INTERACTION_LOCK: usize = 68;
// ClientToggleState { state: bool, lastChange } (16 B): 1 = ligado. Barreira mágica aberta (todas as runas), botão,
// alavanca. Medido em 20/10 em duas Door_Magical_Barrier_Skeleton_trigger (0 fechada -> 1 ao pegar a última runa).
const CID_CLIENT_TOGGLE_STATE: usize = 84;
// ClientInteractionOffer { verbId u32, lastAcceptionId u32 (EntityId de quem usou por último), isOffered u8 } (12 B):
// lastAcceptionId != 0 = alguém já usou. Medido em 21/10 numa Door_Secret_Wetland_Piratebay_01 aberta num teste
// (portas secretas fechadas: 0). Vira flag 7 ("usado"); o app só usa nas portas secretas.
const CID_CLIENT_INTERACTION_OFFER: usize = 69;

// todos os chunks de um arquétipo a partir do 1º (descritor +0x50): a lista é ligada nos dois sentidos (+0x00 aponta
// para o anterior, +0x08 para o próximo). Antes só se andava pelo +0x00 e, na prática, só o 1º chunk era lido: com
// muitas criaturas juntas (vários chunks) as do 2º em diante sumiam do mapa (22/10, Sanguinários a 2 m do jogador).
fn arch_chunks(head: u64, hs: &HashMap<u64, usize>, win: (u64, u64), buf: &[u8]) -> Vec<u64> {
    let mut out = vec![];
    let mut stack = vec![head];
    while let Some(h) = stack.pop() {
        if out.len() >= 512 || !hs.contains_key(&h) || out.contains(&h) {
            continue;
        }
        out.push(h);
        let o = (h - win.0) as usize;
        stack.push(rd_u64(buf, o));
        stack.push(rd_u64(buf, o + 8));
    }
    out
}

// chunk (cabeçalho) -> (offset do CurrentTransform, offset do NetworkHealth), só para arquétipos com os dois;
// e chunk -> (CurrentTransform, ClientInteractionLock) para os trancados
type Arch = HashMap<u64, (usize, usize)>;
type Locks = HashMap<u64, (usize, usize, usize, usize)>; // chunk -> (CurrentTransform, ClientInteractionLock, ClientToggleState, ClientInteractionOffer), 0 = ausente
fn archetypes(p: &Proc, win: (u64, u64), buf: &[u8]) -> (Arch, Locks) {
    let mut out = HashMap::new();
    let mut locks = HashMap::new();
    let hs: HashMap<u64, usize> = chunk_headers(buf).into_iter().map(|(o, n)| (win.0 + o as u64, n)).collect();
    let mut page = vec![0u8; 4 << 20];
    let mut off = 0usize;
    while off < ARCH_SIZE {
        let n = p.read(ARCH_BASE + off as u64, &mut page);
        let mut pg = 0;
        while pg + 0x3c0 + 0x800 <= n {
            let d = &page[pg + 0x3c0..pg + 0x3c0 + 0x800];
            let head = rd_u64(d, 0x50);
            if hs.contains_key(&head) {
                let ct = rd_u16(d, 0xa0 + 2 * CID_CURRENT_TRANSFORM) as usize;
                let nh = rd_u16(d, 0xa0 + 2 * CID_NETWORK_HEALTH) as usize;
                let lk = rd_u16(d, 0xa0 + 2 * CID_CLIENT_INTERACTION_LOCK) as usize;
                let tg = rd_u16(d, 0xa0 + 2 * CID_CLIENT_TOGGLE_STATE) as usize;
                let co = rd_u16(d, 0xa0 + 2 * CID_CLIENT_INTERACTION_OFFER) as usize;
                if ct != 0 && (lk != 0 || tg != 0 || co != 0) {
                    for h in arch_chunks(head, &hs, win, buf) {
                        locks.insert(h, (ct, lk, tg, co));
                    }
                }
                if ct != 0 && nh != 0 {
                    for h in arch_chunks(head, &hs, win, buf) {
                        out.insert(h, (ct, nh));
                    }
                }
            }
            pg += 0x1000;
        }
        off += page.len();
    }
    (out, locks)
}

// trancados já destrancados (itemUsed = 1): ponto com flag 6; ToggleState ligado (barreira aberta, botão
// apertado...): flag 5, achado pelo id do componente (o modo antigo só pega quando ele fica logo antes do transform)
fn unlocked_of(win: (u64, u64), buf: &[u8], locks: &Locks, pts: &mut Vec<f32>) {
    for (o, n) in chunk_headers(buf) {
        let Some(&(ct, lk, tg, co)) = locks.get(&(win.0 + o as u64)) else { continue };
        let c = &buf[o..(o + 0x10000).min(buf.len())];
        if ct + 56 * n > c.len() || (lk != 0 && lk + n > c.len()) || (tg != 0 && tg + 16 * n > c.len()) || (co != 0 && co + 12 * n > c.len()) {
            continue;
        }
        for j in 0..n {
            let r = ct + 56 * j;
            if !valid_ct(c, r) {
                continue;
            }
            let v = [rd_i64(c, r), rd_i64(c, r + 8), rd_i64(c, r + 16)].map(|q| (q as f64 / 4294967296.0) as f32);
            if lk != 0 && c[lk + j] == 1 {
                pts.extend_from_slice(&[v[0], v[1], v[2], 6.0]);
            }
            let t = tg + 16 * j;
            if tg != 0 && c[t] == 1 && c[t + 1..t + 8].iter().all(|&b| b == 0) && rd_u64(c, t + 8) != 0 {
                pts.extend_from_slice(&[v[0], v[1], v[2], 5.0]);
            }
            if co != 0 && (1..=64).contains(&rd_u32(c, co + 12 * j + 4)) {
                pts.extend_from_slice(&[v[0], v[1], v[2], 7.0]); // usado por um jogador (EntityId 1..64)
            }
        }
    }
}

fn mobs_of(p: &Proc, tpls: &mut Templates, win: (u64, u64), buf: &[u8], arch: &HashMap<u64, (usize, usize)>, px: f32, pz: f32, mobs: &mut Vec<Mob>) {
    mobs.clear();
    for (o, n) in chunk_headers(buf) {
        let Some(&(ct, nh)) = arch.get(&(win.0 + o as u64)) else { continue };
        let c = &buf[o..(o + 0x10000).min(buf.len())];
        if ct + 56 * n > c.len() || nh + 8 * n > c.len() {
            continue;
        }
        for j in 0..n {
            if rd_u32(c, 0x40 + 16 * j) <= 16 {
                continue; // jogadores (EntityId 1, 2, 3...)
            }
            let (hp, mx) = (rd_u32(c, nh + 8 * j), rd_u32(c, nh + 8 * j + 4));
            if hp == 0 || hp > mx || mx > 10_000_000 || !valid_ct(c, ct + 56 * j) {
                continue;
            }
            let r = ct + 56 * j;
            let v = [rd_i64(c, r), rd_i64(c, r + 8), rd_i64(c, r + 16)].map(|q| (q as f64 / 4294967296.0) as f32);
            if (v[0] - px).abs() > LIVE_R || (v[2] - pz).abs() > LIVE_R || is_static(v[0], v[1], v[2]) {
                continue;
            }
            let tpl = tpls.of(p, c, n, j);
            let f = tpl_flags(tpl);
            if f & TF_PARTE != 0 && f & TF_CRIATURA == 0 {
                continue; // colisor/ponto fraco com vida própria: a criatura já aparece pela entidade principal
            }
            let creature = if tpl_creature(tpl) >= 0 { tpl_creature(tpl) } else { creature_in(c, n, j) };
            mobs.push(Mob { id: rd_u32(c, 0x40 + 16 * j), x: v[0], y: v[1], z: v[2], hp, hp_max: mx, creature, tpl });
        }
    }
}

const LIVE_R: f32 = 130.0;
const ARENA: u64 = 0x300_0000_0000;

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn rd_u64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn rd_i64(b: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn rd_f32(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}

// cabeçalhos de chunk dentro de b: (offset em b, n)
fn chunk_headers(b: &[u8]) -> Vec<(usize, usize)> {
    let ok = |p: u64| p == 0 || p >> 40 == 3;
    let mut out = vec![];
    let mut o = 0;
    while o + 0x18 <= b.len() {
        if rd_u16(b, o + 0x14) == 0x40 && rd_u16(b, o + 0x12) == 0 {
            let n = rd_u16(b, o + 0x10) as usize;
            let o1 = rd_u16(b, o + 0x16);
            if n > 0 && o1 > 0x40 && o1 < 0x8000 && ok(rd_u64(b, o)) && ok(rd_u64(b, o + 8)) {
                out.push((o, n));
            }
        }
        o += 64;
    }
    out
}

fn valid_ct(b: &[u8], o: usize) -> bool {
    if o + 56 > b.len() {
        return false;
    }
    let (x, y, z) = (rd_i64(b, o), rd_i64(b, o + 8), rd_i64(b, o + 16));
    if !((50i64 << 32) < x && x < (10200i64 << 32) && (50i64 << 32) < z && z < (10200i64 << 32) && -(200i64 << 32) < y && y < (2600i64 << 32)) {
        return false;
    }
    let q = [0, 4, 8, 12].map(|k| rd_f32(b, o + 24 + k));
    let n = q.iter().map(|v| v * v).sum::<f32>();
    (n - 1.0).abs() < 0.02
        && [40, 44, 48].iter().all(|&k| {
            let s = rd_f32(b, o + k);
            s > 0.01 && s < 100.0
        })
}

// verbId dos baús = InteractionOfferRuntime.defaultVerbId dos templates LootChest_* (dados extraídos do jogo)
// entidades dinâmicas que dá para recolher: "Saquear" (corpos LootContainer_Enemy_*) e "Pegar" (itens soltos)
const VERB_SAQUE: u32 = 0x9a599d0b;
const VERB_PEGAR: u32 = 0x0af6b5cb;
const CHEST_VERBS: [u32; 8] = [0x4e82e309, 0xdd3c0694, 0x9603a3f7, 0x3f816248, 0x33526a9e, 0xfd1d9f2f, 0xc88ea91c, 0xc268dca3];

// ClientInteractionOffer (12 bytes: verbId, lastAcceptionId, isOffered, 3 bytes 0). verbId = o do template
// quando o jogador está no alcance da interação e 0 fora dele: todos os slots têm o mesmo verbo de baú ou 0.
fn cio_array(c: &[u8], n: usize, verbs: &[u32]) -> Option<usize> {
    let mut o = 0x40;
    while o + 12 * n + 12 <= c.len() {
        let mut verb = 0u32;
        let mut ok = true;
        for j in 0..n {
            let r = o + 12 * j;
            let v = rd_u32(c, r);
            if v != 0 {
                if (verb != 0 && v != verb) || !verbs.contains(&v) {
                    ok = false;
                    break;
                }
                verb = v;
            }
            if c[r + 8] > 1 || c[r + 9] != 0 || c[r + 10] != 0 || c[r + 11] != 0 {
                ok = false;
                break;
            }
        }
        if ok && verb != 0 {
            return Some(o);
        }
        o += 64;
    }
    None
}

// InventoryEmptyState (toggleVFX, isEmpty): o array logo depois do ClientInteractionOffer (só zeros no meio)
fn ies_array(c: &[u8], n: usize, cio: usize) -> Option<usize> {
    let end = cio + 12 * n;
    let mut o = (end + 63) & !63;
    while o + 2 * n <= c.len() && o < cio + 12 * 64 + 64 {
        if c[end..o].iter().any(|&x| x != 0) {
            return None;
        }
        let pairs_ok = (0..n).all(|j| c[o + 2 * j] <= 1 && c[o + 2 * j + 1] <= 1);
        if pairs_ok && (0..n).any(|j| c[o + 2 * j] == 1) {
            return Some(o);
        }
        o += 64;
    }
    None
}

// Varre a arena inteira (~3 GB, ~2 s) atrás de cabeçalhos e devolve a janela de 16 MB em 16 MB onde eles moram.
fn find_window(p: &Proc) -> Option<(u64, u64)> {
    let mut bins: HashMap<u64, u32> = HashMap::new();
    let mut buf = vec![0u8; 16 << 20];
    for (base, size) in p.regions_from(ARENA) {
        if base >> 40 != 3 {
            break;
        }
        let mut off = 0usize;
        while off < size {
            let len = (size - off).min(buf.len());
            let n = p.read(base + off as u64, &mut buf[..len]);
            let start = base + off as u64;
            for (o, _) in chunk_headers(&buf[..n]) {
                *bins.entry((start + o as u64) >> 24).or_insert(0) += 1;
            }
            off += len;
        }
    }
    let (&best, _) = bins.iter().max_by_key(|(_, &v)| v)?;
    let (mut lo, mut hi) = (best, best);
    while bins.get(&(lo - 1)).copied().unwrap_or(0) >= 8 {
        lo -= 1;
    }
    while bins.get(&(hi + 1)).copied().unwrap_or(0) >= 8 {
        hi += 1;
    }
    Some(((lo - 1) << 24, (hi + 2) << 24))
}

// células de 0,5 m das entidades fixas (gerado por script interno, não publicado): separa o saque dinâmico do prop fixo com o mesmo verbo
static STATIC_CELLS: &[u8] = include_bytes!("../static_cells.bin");

fn cell_hash(x: f32, y: f32, z: f32) -> u32 {
    let mut h: u32 = 2166136261;
    for v in [(x as f64 * 2.0 + 0.5).floor() as i64, (z as f64 * 2.0 + 0.5).floor() as i64, ((y as f64 + 500.0) * 2.0 + 0.5).floor() as i64] {
        for k in 0..4 {
            h ^= ((v as u64 >> (8 * k)) & 0xff) as u32;
            h = h.wrapping_mul(16777619);
        }
    }
    h
}

fn is_static(x: f32, y: f32, z: f32) -> bool {
    let key = cell_hash(x, y, z);
    let n = STATIC_CELLS.len() / 4;
    let (mut lo, mut hi) = (0usize, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        let v = rd_u32(STATIC_CELLS, mid * 4);
        if v < key {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo < n && rd_u32(STATIC_CELLS, lo * 4) == key
}

// ItemInfo GUID (bytes_le) -> itemId (gerado por script interno, não publicado): 16 B + u32, ordenado
static ITEM_GUIDS: &[u8] = include_bytes!("../item_guids.bin");

fn item_of_guid(g: &[u8]) -> Option<u32> {
    let n = ITEM_GUIDS.len() / 20;
    let (mut lo, mut hi) = (0usize, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        match ITEM_GUIDS[mid * 20..mid * 20 + 16].cmp(g) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => return Some(rd_u32(ITEM_GUIDS, mid * 20 + 16)),
        }
    }
    None
}

// Itens que caem de árvore/planta/isca (LootPickup_Gravity_*, iscas): o PickupItem não fica no chunk; a entidade
// guarda um ponteiro (u64 em 0x200'xxxx'xxxx, um por slot) para os dados compartilhados do template, onde está o
// PickupItem (itemId u32, ItemReference GUID 16, level u32, rarity u16, pickupAmount u16). Devolve [itemId, qtd].
// Se não houver PickupItem, cai para o CollisionFeedbackMaterialComponent (material GUID, itemId, itemRef GUID...):
// é o material do objeto (ex.: metal -> "Sucatas"), devolvido com quantidade 0 = "provável, quantidade desconhecida".
fn shared_pickup(p: &Proc, c: &[u8], n: usize, j: usize) -> Option<[u32; 2]> {
    let mut blob = vec![0u8; 0x800];
    let mut fallback: Option<[u32; 2]> = None;
    let mut o = 0x40;
    while o + 8 * n <= c.len() {
        let v = rd_u64(c, o + 8 * j);
        if v >> 40 == 2 && v & 7 == 0 && p.read(v, &mut blob) == blob.len() {
            let mut a = 4;
            while a + 24 <= blob.len() {
                if let Some(id) = item_of_guid(&blob[a..a + 16]) {
                    let amount = rd_u16(&blob, a + 22) as u32;
                    let level = rd_u32(&blob, a + 16);
                    let rarity = rd_u16(&blob, a + 20);
                    if (rd_u32(&blob, a - 4) == 0 || rd_u32(&blob, a - 4) == id) && level < 100 && rarity < 16 && amount > 0 && amount < 1000 {
                        return Some([id, amount]);
                    }
                    if fallback.is_none() && rd_u32(&blob, a - 4) == id {
                        fallback = Some([id, 0]);
                    }
                }
                a += 4;
            }
        }
        o += 64;
    }
    fallback
}

fn is_item(i: u32) -> bool {
    ITEM_IDS.binary_search(&i).is_ok()
}

// keen::ecs::Inventory: 96 bytes = 8 ItemStack (itemId u32, quantidade u32, 4 bytes). Um offset desalinhado também
// pode passar; fica o candidato com mais slots começando por um item (o inventário é preenchido do começo).
fn inv_array(c: &[u8], n: usize) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    let mut o = 0x40;
    while o + 96 * n <= c.len() {
        let mut ok = true;
        let mut nz = 0;
        'outer: for j in 0..n {
            for k in 0..8 {
                let r = o + 96 * j + 12 * k;
                let (i, amt) = (rd_u32(c, r), rd_u32(c, r + 4));
                if i == 0 {
                    if amt != 0 {
                        ok = false;
                        break 'outer;
                    }
                } else if is_item(i) && amt > 0 && amt < 100000 {
                    nz += 1;
                } else {
                    ok = false;
                    break 'outer;
                }
            }
        }
        if ok && nz > 0 {
            let sc = (0..n).filter(|&j| rd_u32(c, o + 96 * j) != 0).count();
            if best.map_or(true, |(_, b)| sc > b) {
                best = Some((o, sc));
            }
        }
        o += 64;
    }
    best.map(|b| b.0)
}

// NetworkHealth (health u32, healthMax u32) de bicho morto: 1º array depois do inventário com health = 0 e
// 10 <= healthMax <= 200000 em todos os slots. Só para desempate de espécie (lobo 223, rato 33 em 19/10).
fn hp_array(c: &[u8], n: usize, after: usize) -> Option<usize> {
    let mut o = (after + 63) & !63;
    while o + 8 * n <= c.len() {
        if (0..n).all(|j| rd_u32(c, o + 8 * j) == 0 && (10..=200000).contains(&rd_u32(c, o + 8 * j + 4))) {
            return Some(o);
        }
        o += 64;
    }
    None
}

// keen::ecs::PickupItem: 28 bytes (itemId u32, ItemReference 16, level u32, rarity u16, pickupAmount u16)
fn pickup_array(c: &[u8], n: usize) -> Option<usize> {
    let mut o = 0x40;
    while o + 28 * n <= c.len() {
        if (0..n).all(|j| {
            let r = o + 28 * j;
            let amount = rd_u16(c, r + 26);
            is_item(rd_u32(c, r)) && rd_u32(c, r + 20) < 100 && amount > 0 && amount < 1000
        }) {
            return Some(o);
        }
        o += 64;
    }
    None
}

fn snapshot(p: &Proc, tpls: &mut Templates, win: (u64, u64), buf: &mut Vec<u8>, px: f32, pz: f32, pts: &mut Vec<f32>, loot: &mut Vec<Loot>, ents: &mut Vec<[f32; 3]>, addrs: &mut Vec<u64>) -> usize {
    let len = (win.1 - win.0) as usize;
    buf.resize(len, 0);
    // em pedaços de 4 MB (uma página não comprometida não derruba a leitura toda)
    let mut off = 0;
    while off < len {
        let l = (len - off).min(4 << 20);
        if p.read(win.0 + off as u64, &mut buf[off..off + l]) != l {
            buf[off..off + l].fill(0);
        }
        off += l;
    }
    let hs = chunk_headers(buf);
    pts.clear();
    loot.clear();
    ents.clear();
    addrs.clear();
    for (k, &(h, n)) in hs.iter().enumerate() {
        let end = (h + 0x10000).min(hs.get(k + 1).map_or(len, |x| x.0)).min(len);
        let c = &buf[h..end];
        let cio = cio_array(c, n, &CHEST_VERBS);
        let ies = cio.and_then(|ci| ies_array(c, n, ci));
        let dynl = cio_array(c, n, &[VERB_SAQUE, VERB_PEGAR]);
        let (inv, pick) = if dynl.is_some() { (inv_array(c, n), pickup_array(c, n)) } else { (None, None) };
        let hp = inv.and_then(|io| hp_array(c, n, io + 96 * n));
        let mut mdl: Option<Option<usize>> = None; // array de modelos (só procurado se houver pickup genérico)
        let mut first = true; // o 1º array de transform do chunk é o CurrentTransform (alinhado com os slots)
        let mut o = 0x40 + 56; // o registro anterior ao array precisa ser inválido
        o = (o + 63) & !63;
        while o + 56 * n <= c.len() {
            let x = rd_i64(c, o);
            if (50i64 << 32) < x && x < (10200i64 << 32) && valid_ct(c, o) && !valid_ct(c, o - 56) && (1..n).all(|j| valid_ct(c, o + 56 * j))
                // o RenderTransform (3 transforms por entidade) também passa, mas não alinha com os slots: repete posições
                && (n == 1 || (1..n).all(|j| (0..j).all(|i| c[o + 56 * i..o + 56 * i + 24] != c[o + 56 * j..o + 56 * j + 24])))
            {
                // botão/alavanca: ToggleState de 16 bytes logo antes do CurrentTransform;
                // cap = (2º offset do cabeçalho - 0x40) / 16. Vale só se o array inteiro tem cara de ToggleState.
                let cap = (rd_u16(c, 0x16) as usize).saturating_sub(0x40) / 16;
                let tg = if first && cap >= n && o >= 16 * cap + 0x40 {
                    let t0 = o - 16 * cap;
                    let ok = (0..n).all(|j| {
                        let r = t0 + 16 * j;
                        c[r] <= 1 && c[r + 1..r + 8].iter().all(|&b| b == 0) && (c[r] == 0 || rd_u64(c, r + 8) != 0)
                    });
                    if ok { Some(t0) } else { None }
                } else {
                    None
                };
                for j in 0..n {
                    let r = o + 56 * j;
                    let v = [rd_i64(c, r), rd_i64(c, r + 8), rd_i64(c, r + 16)].map(|q| (q as f64 / 4294967296.0) as f32);
                    // jogadores (EntityId 1..16), a qualquer distância; o local aparece em 2 chunks: sem repetir posição
                    let id = rd_u32(c, 0x40 + 16 * j);
                    if first && (1..=16).contains(&id) && !ents.iter().any(|e| (e[0] - v[0]).abs() < 0.01 && (e[2] - v[2]).abs() < 0.01) {
                        ents.push(v);
                        addrs.push(win.0 + (h + r) as u64);
                    }
                    if (v[0] - px).abs() > LIVE_R || (v[2] - pz).abs() > LIVE_R {
                        continue;
                    }
                    let mut flag = match (ies, cio) {
                        (Some(ie), _) if c[ie + 2 * j + 1] == 1 => 1.0,
                        (Some(_), _) => 2.0,
                        // arquétipo de transição logo depois de abrir: sem InventoryEmptyState, mas a interação
                        // foi aceita por um jogador (lastAcceptionId != 0) e não é mais oferecida = aberto
                        (None, Some(ci)) if rd_u32(c, ci + 12 * j) != 0 && rd_u32(c, ci + 12 * j + 4) != 0 && c[ci + 12 * j + 8] == 0 => 1.0,
                        _ => 0.0,
                    };
                    if let (Some(t0), 0.0) = (tg, flag) {
                        if c[t0 + 16 * j] == 1 {
                            flag = 5.0; // acionado (o frontend só usa em pontos 'logic')
                        }
                    }
                    if let (Some(d), true) = (dynl, first) {
                        let kind = match rd_u32(c, d + 12 * j) {
                            VERB_SAQUE => 3,
                            VERB_PEGAR => 4,
                            _ => 0,
                        };
                        if kind != 0 && !is_static(v[0], v[1], v[2]) {
                            flag = kind as f32;
                            let items = inv.map_or(vec![], |io| {
                                (0..8).map(|k| io + 96 * j + 12 * k).filter(|&r| rd_u32(c, r) != 0).map(|r| [rd_u32(c, r), rd_u32(c, r + 4)]).collect()
                            });
                            let item = pick.map_or(0, |po| rd_u32(c, po + 28 * j));
                            let creature = creature_in(c, n, j);
                            let (item, items) = if kind == 4 && item == 0 && items.is_empty() {
                                match shared_pickup(p, c, n, j) {
                                    Some(s) => (s[0], vec![s]),
                                    None => (item, items),
                                }
                            } else {
                                (item, items)
                            };
                            let hp_max = hp.map_or(0, |ho| rd_u32(c, ho + 8 * j + 4));
                            // template: item do PickupItem do template e criatura exata
                            let tpl = tpls.of(p, c, n, j);
                            let creature = if tpl_creature(tpl) >= 0 { tpl_creature(tpl) } else { creature };
                            let palpite = items.len() == 1 && items[0][1] == 0; // material do objeto, qtd desconhecida
                            let mut provavel = false;
                            let (item, items) = if tpl_item(tpl) != 0 && (item == 0 || palpite) {
                                (tpl_item(tpl), if palpite || items.is_empty() { vec![[tpl_item(tpl), 0]] } else { items })
                            } else if tpl_flags(tpl) & TF_GENERICO != 0 && item == 0 && (items.is_empty() || palpite) {
                                match *mdl.get_or_insert_with(|| model_array(c, n)) {
                                    Some(mo) => {
                                        let k = bsearch(MODEL_ITEMS, 24, &c[mo + 16 * j..mo + 16 * j + 16]).unwrap_or(0);
                                        provavel = true;
                                        let id = rd_u32(MODEL_ITEMS, k * 24 + 16);
                                        (id, vec![[id, 0]])
                                    }
                                    None => (item, items),
                                }
                            } else {
                                (item, items)
                            };
                            loot.push(Loot { x: v[0], y: v[1], z: v[2], kind, item, items, creature, hp_max, tpl, provavel });
                        }
                    }
                    pts.extend_from_slice(&[v[0], v[1], v[2], flag]);
                }
                first = false;
            }
            o += 64;
        }
    }
    hs.len()
}

// Laço do estado ao vivo: uma leitura da janela de chunks por segundo (~10-40 ms de CPU).
pub fn run(mut emit: impl FnMut(&LiveState)) {
    loop {
        let Some(pid) = find_pid() else {
            emit(&LiveState { status: "fechado", ..Default::default() });
            std::thread::sleep(Duration::from_secs(3));
            continue;
        };
        let Some(p) = Proc::open(pid) else {
            std::thread::sleep(Duration::from_secs(3));
            continue;
        };
        let Some(base) = module_base(&p) else {
            std::thread::sleep(Duration::from_secs(3));
            continue;
        };
        let mut win: Option<(u64, u64)> = None;
        let mut tpls = Templates::default(); // por processo
        let mut win_at = Instant::now();
        let mut arch: Arch = HashMap::new();
        let mut locks: Locks = HashMap::new();
        let mut arch_at = Instant::now() - Duration::from_secs(3600);
        let mut mobs = vec![];
        let mut ents = vec![];
        let mut addrs = vec![];
        let mut recs: Vec<u64> = vec![];
        let mut recs_at = Instant::now() - Duration::from_secs(3600);
        let mut players = vec![];
        let mut buf = vec![];
        let mut pts = vec![];
        let mut loot = vec![];
        let mut tick = 0u64;
        loop {
            tick += 1;
            if tick % 10 == 0 && find_pid() != Some(pid) {
                break;
            }
            let Some([x, y, z]) = read_world_pos(&p, base) else {
                std::thread::sleep(Duration::from_secs(1));
                continue;
            };
            if win.is_none() || win_at.elapsed() > Duration::from_secs(120) {
                emit(&LiveState { status: "procurando", x, y, z, ..Default::default() });
                win = find_window(&p).or(win);
                win_at = Instant::now();
            }
            let Some(w) = win else {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            };
            let t0 = Instant::now();
            let n = snapshot(&p, &mut tpls, w, &mut buf, x, z, &mut pts, &mut loot, &mut ents, &mut addrs);
            if arch_at.elapsed() > Duration::from_secs(5) {
                (arch, locks) = archetypes(&p, w, &buf);
                arch_at = Instant::now();
            }
            unlocked_of(w, &buf, &locks, &mut pts);
            mobs_of(&p, &mut tpls, w, &buf, &arch, x, z, &mut mobs);
            if ents.len() > 1 {
                let (pl, missing) = players_of(&p, &recs, &ents, &addrs, [x, y, z]);
                // tabela não achada ou jogador sem registro (entrou agora): procura de novo, no máximo a cada 20 s
                if (missing || recs.is_empty()) && recs_at.elapsed() > Duration::from_secs(20) {
                    recs = find_player_recs(&p);
                    recs_at = Instant::now();
                    players = players_of(&p, &recs, &ents, &addrs, [x, y, z]).0;
                } else {
                    players = pl;
                }
            } else {
                players.clear();
            }
            if n == 0 || pts.is_empty() {
                win = None; // chunks mudaram de lugar: procura a janela de novo
            }
            emit(&LiveState { status: "ok", x, y, z, pts: pts.clone(), loot: loot.clone(), mobs: mobs.clone(), players: players.clone(), chunks: n, ms: t0.elapsed().as_millis() as u32 });
            // entre as leituras completas, só a posição dos amigos a 10 Hz (evento leve "jogadores")
            for _ in 0..10 {
                std::thread::sleep(Duration::from_millis(100));
                if players.is_empty() {
                    continue;
                }
                let mut b = [0u8; 56];
                for pl in players.iter_mut() {
                    if p.read(pl.addr, &mut b) == 56 && valid_ct(&b, 0) {
                        let v = [rd_i64(&b, 0), rd_i64(&b, 8), rd_i64(&b, 16)].map(|q| (q as f64 / 4294967296.0) as f32);
                        // a entidade pode ter mudado de chunk (vale até a próxima leitura completa): ignora saltos absurdos
                        if (v[0] - pl.x).abs() < 50.0 && (v[2] - pl.z).abs() < 50.0 {
                            (pl.x, pl.y, pl.z) = (v[0], v[1], v[2]);
                        }
                    }
                }
                emit(&LiveState { status: "jogadores", players: players.clone(), ..Default::default() });
            }
        }
    }
}
