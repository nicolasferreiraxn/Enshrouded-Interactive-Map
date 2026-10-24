// Leitura (somente leitura) dos voxels de terreno do cliente para saber se um depósito de minério foi esgotado.
// Formato: pedaços 8³ comprimidos (camada modificada) + tiles do mundo base.
//  - camada modificada: VoxelData "Terraforming" (o que alguém cavou/minerou), tabela hash em +0x120;
//  - mundo base: tiles do VoxelWorldResource (nível 6, 128 m) carregados em volta do jogador no
//    "VoxelDataContentLoader" (tabela de slots em +0x190).
// 1 voxel = 0,5 m; pedaço 8³; índice x + y*8 + z*64; byte material + byte forma (0xff cheio, 0 ar).
use crate::tracker::{find_pid, module_base, Proc};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const LEVEL: u64 = 6;
const MAP: u64 = 0x120;
const NAME: &[u8] = b"Terraforming\0";
const LOADER: &[u8] = b"VoxelDataContentLoader\0";
// hash (size, h0, h1, h2) dos 80×80 tiles do nível 6 do mundo principal (VoxelWorldResource parte 0)
static TILES: &[u8] = include_bytes!("voxel_tiles6.bin");
// menor grupo de blocos encostados (26 vizinhos) que ainda conta como minério; menos que isso são lascas
const MIN_GRUPO: usize = 6;

type Sub = Box<([u8; 512], [u8; 512])>;

fn u16_(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn u32_(b: &[u8], o: usize) -> u32 { u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) }
fn u64_(b: &[u8], o: usize) -> u64 { u64::from_le_bytes(b[o..o + 8].try_into().unwrap()) }
fn u24_(b: &[u8], o: usize) -> usize { b[o] as usize | (b[o + 1] as usize) << 8 | (b[o + 2] as usize) << 16 }

struct Bits<'a> { b: &'a [u8], p: usize }
impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let v = (*self.b.get(self.p >> 3)? >> (self.p & 7)) & 1;
        self.p += 1;
        Some(v as u32)
    }
    // pares (continua, bit) até continua = 0, começando de 1
    fn count(&mut self) -> Option<usize> {
        let mut c = 1usize;
        while self.bit()? == 1 {
            c = c * 2 | self.bit()? as usize;
            if c > 4096 { return None; }
        }
        Some(c)
    }
}

// pedaço comprimido -> (material, forma). Bits do começo (LSB primeiro), literais do fim para trás.
fn decode(blob: &[u8]) -> Option<Sub> {
    let mut s = Bits { b: blob, p: 0 };
    let mut lit = blob.len();
    let mut out: Sub = Box::new(([0; 512], [0; 512]));
    let (mut i, mut prev2, mut prev1) = (0usize, 0u8, 0u8);
    while i < 512 {
        let m = if s.bit()? == 1 { lit = lit.checked_sub(1)?; blob[lit] } else { prev2 };
        let c = s.count()?;
        if i + c > 512 { return None; }
        out.0[i..i + c].fill(m);
        i += c; prev2 = prev1; prev1 = m;
    }
    let (mut i, mut lastb) = (0usize, 0u8);
    while i < 512 {
        let m = out.0[i];
        let (v, c);
        if s.bit()? == 1 {
            lit = lit.checked_sub(1)?; v = blob[lit];
            if m >= 0x80 { lastb = v; }
            c = if v == 0 || v == 0xff || m >= 0x80 { s.count()? } else { 1 };
        } else {
            v = if m == 0 { 0 } else if m >= 0x80 { lastb } else { 0xff };
            c = s.count()?;
        }
        if i + c > 512 { return None; }
        out.1[i..i + c].fill(v);
        i += c;
    }
    if (s.p + 7) / 8 != lit { return None; }
    Some(out)
}

// coluna 8×8 voxels (4 m) de um tile do mundo base: pedaço y (de baixo para cima)
fn column_sub(c: &[u8], y: i32) -> Option<Sub> {
    let uni = |m: u8, f: u8| Some(Box::new(([m; 512], [f; 512])));
    if y < 0 { return uni(1, 0xff); } // abaixo do mundo
    let n = u16_(c, 0) as i32;
    let l = u16_(c, 2) as usize;
    if y >= n { return uni(0, 0); }
    let mut s = Bits { b: c.get(4..4 + l)?, p: 0 };
    let data = c.get(4 + l..)?;
    let (mut idx, mut acc, mut mat, mut shp) = (0i32, 0usize, 0u8, None::<u8>);
    loop {
        let g = s.count()? as i32;
        if s.bit()? == 0 {
            if s.bit()? == 1 {
                mat = *data.get(acc)?; acc += 1;
                shp = if s.bit()? == 1 { acc += 1; Some(*data.get(acc - 1)?) } else { None };
            }
            if y < idx + g { return uni(mat, shp.unwrap_or(if mat != 0 { 0xff } else { 0 })); }
            idx += g;
        } else {
            for _ in 0..g {
                let mut size = 0usize;
                for b in 0..10 { size |= (s.bit()? as usize) << b; }
                acc += size;
                if idx == y { return decode(data.get(acc - size..acc)?); }
                idx += 1;
            }
        }
    }
}

pub struct Terreno {
    p: Proc,
    pid: u32,
    vd: u64,
    loader: u64,
    tidx: HashMap<[u32; 4], usize>,
    mac: HashMap<u64, u64>,
    tiles: HashMap<(i32, i32), (u64, u64)>,
    tbytes: HashMap<u64, Vec<u8>>,
    mcache: HashMap<(i32, i32, i32), Option<Sub>>,
    bcache: HashMap<(i32, i32, i32), Option<Sub>>,
}
unsafe impl Send for Terreno {}

fn find_named(p: &Proc, name: &[u8], ok: &mut dyn FnMut(u64) -> bool) -> Option<u64> {
    let mut buf = vec![0u8; 64 << 20];
    for (base, size) in p.regions_from(0x300_0000_0000) {
        let mut off = 0usize;
        while off < size {
            let n = (size - off).min(buf.len());
            let got = p.read(base + off as u64, &mut buf[..n]);
            let b = &buf[..got];
            let mut i = 0;
            while i + name.len() <= b.len() {
                match b[i..].iter().position(|&c| c == name[0]) {
                    None => break,
                    Some(k) => i += k,
                }
                if b[i..].starts_with(name) {
                    let a = base + (off + i) as u64 - 0x38;
                    if a & 7 == 0 && ok(a) { return Some(a); }
                }
                i += 1;
            }
            off += n.max(1);
        }
    }
    None
}

impl Terreno {
    pub fn open() -> Option<Terreno> {
        let pid = find_pid()?;
        let p = Proc::open(pid)?;
        let mb = module_base(&p)?;
        let rd = |a: u64, n: usize| { let mut b = vec![0u8; n]; if p.read(a, &mut b) == n { Some(b) } else { None } };
        // Terraforming: vtable no exe e tabela não vazia (há um segundo objeto com o mesmo nome, vazio)
        let mut best: Option<(u64, u32)> = None;
        let mut acc = |a: u64| {
            if let Some(h) = rd(a, 0x180) {
                let vt = u64_(&h, 8);
                let cnt = u32_(&h, (MAP + 0x54) as usize);
                if vt >= mb && vt < mb + 0x300_0000 && cnt > 0 && best.map_or(true, |b| cnt > b.1) { best = Some((a, cnt)); }
            }
            false
        };
        find_named(&p, NAME, &mut acc);
        let vd = best?.0;
        let vt = u64_(&rd(vd + 8, 8)?, 0);
        let loader = find_named(&p, LOADER, &mut |a| rd(a + 8, 8).map_or(false, |b| u64_(&b, 0) == vt))?;
        let tidx = (0..TILES.len() / 16)
            .map(|i| ([u32_(TILES, i * 16), u32_(TILES, i * 16 + 4), u32_(TILES, i * 16 + 8), u32_(TILES, i * 16 + 12)], i))
            .collect();
        Some(Terreno { p, pid, vd, loader, tidx, mac: HashMap::new(), tiles: HashMap::new(), tbytes: HashMap::new(), mcache: HashMap::new(), bcache: HashMap::new() })
    }

    fn rd(&self, a: u64, n: usize) -> Option<Vec<u8>> {
        let mut b = vec![0u8; n];
        if n == 0 || self.p.read(a, &mut b) == n { Some(b) } else { None }
    }

    // relê a camada modificada (muda a cada golpe) e a lista de tiles base carregados
    fn reload(&mut self) -> Option<()> {
        let h = self.rd(self.vd + MAP, 0x58)?;
        let (bm, cap, keys, vals) = (u64_(&h, 8), u64_(&h, 0x10) as usize, u64_(&h, 0x28), u64_(&h, 0x40));
        if cap == 0 || cap > 1 << 22 { return None; }
        let occ = self.rd(bm, cap / 8)?;
        let k = self.rd(keys, cap * 8)?;
        let v = self.rd(vals, cap * 8)?;
        self.mac.clear();
        for i in 0..cap {
            if occ[i >> 3] >> (i & 7) & 1 == 0 { continue; }
            let key = u64_(&k, i * 8);
            if key >> 48 == LEVEL { self.mac.insert(key & 0xffff_ffff_ffff, u64_(&v, i * 8)); }
        }
        self.mcache.clear();
        // tiles base: slots de 64 B {alocador, ptr, qtd}; entradas de 0x50 B (hash +0x18, dados +0x38, tamanho +0x40, estado +0x48)
        let t = self.rd(self.loader + 0x190, 16)?;
        let (tab, tcap) = (u64_(&t, 0), u64_(&t, 8) as usize);
        let mut tiles = HashMap::new();
        if tcap > 0 && tcap < 1 << 16 {
            let e = self.rd(tab, tcap * 64)?;
            for s in 0..tcap {
                let (ptr, n) = (u64_(&e, s * 64 + 8), u64_(&e, s * 64 + 16) as usize);
                if ptr == 0 || n == 0 || n > 4096 { continue; }
                let Some(arr) = self.rd(ptr, n * 0x50) else { continue };
                for j in 0..n {
                    let o = j * 0x50;
                    let hk = [u32_(&arr, o + 0x18), u32_(&arr, o + 0x1c), u32_(&arr, o + 0x20), u32_(&arr, o + 0x24)];
                    let Some(&ti) = self.tidx.get(&hk) else { continue };
                    let (dp, dn, st) = (u64_(&arr, o + 0x38), u64_(&arr, o + 0x40), u64_(&arr, o + 0x48));
                    if st == 2 && dp != 0 && dn < 64 << 20 { tiles.insert(((ti % 80) as i32, (ti / 80) as i32), (dp, dn)); }
                }
            }
        }
        if tiles != self.tiles {
            self.tbytes.retain(|dp, _| tiles.values().any(|t| t.0 == *dp));
            self.bcache.clear();
            self.tiles = tiles;
        }
        if self.bcache.len() > 50_000 { self.bcache.clear(); }
        Some(())
    }

    // pedaço modificado que contém o voxel; None = não mexido (vale o mundo base)
    fn msub(&mut self, vx: i32, vy: i32, vz: i32) -> Option<&Sub> {
        let k = (vx & !7, vy & !7, vz & !7);
        if !self.mcache.contains_key(&k) {
            let r = self.read_msub(vx, vy, vz);
            self.mcache.insert(k, r);
        }
        self.mcache.get(&k).unwrap().as_ref()
    }
    fn read_msub(&self, vx: i32, vy: i32, vz: i32) -> Option<Sub> {
        if vx < 0 || vy < 0 || vz < 0 { return None; }
        let key = (vx as u64 & 0xffe0) | (vy as u64 & 0xffe0) << 16 | (vz as u64 & 0xffe0) << 32;
        let a = *self.mac.get(&key)?;
        let b = self.rd(a, 0xd8)?;
        let s = b[0x28 + ((vx >> 3) & 3) as usize + ((vy >> 3) & 3) as usize * 4 + ((vz >> 3) & 3) as usize * 16];
        if s >= 0xc0 {
            let e = self.rd(u64_(&b, 0x68) + (s as u64 - 0xc0) * 16, 16)?;
            let (ptr, n) = (u64_(&e, 0), u64_(&e, 8) as usize);
            if n < 3 || n > 1 << 16 { return None; }
            let blob = self.rd(ptr, n)?;
            decode(&blob[..n - 2])
        } else if s != 0 {
            Some(Box::new(([s - 1; 512], [if s == 1 { 0 } else { 0xff }; 512])))
        } else {
            None
        }
    }
    // pedaço do mundo base; None = tile não carregado (longe do jogador)
    fn bsub(&mut self, vx: i32, vy: i32, vz: i32) -> Option<&Sub> {
        let k = (vx & !7, vy & !7, vz & !7);
        if !self.bcache.contains_key(&k) {
            let r = self.read_bsub(vx, vy, vz);
            self.bcache.insert(k, r);
        }
        self.bcache.get(&k).unwrap().as_ref()
    }
    fn read_bsub(&mut self, vx: i32, vy: i32, vz: i32) -> Option<Sub> {
        let (cx, cz) = (vx >> 3, vz >> 3);
        let (dp, dn) = *self.tiles.get(&(cx >> 5, cz >> 5))?;
        if !self.tbytes.contains_key(&dp) {
            let b = self.rd(dp, dn as usize)?;
            self.tbytes.insert(dp, b);
        }
        let b = self.tbytes.get(&dp)?;
        let (w, h) = (b[0] as usize, b[1] as usize);
        let li = (cz & 31) as usize * w + (cx & 31) as usize;
        if li >= w * h { return None; }
        let d = 2 + 3 * w * h;
        let off = u24_(b, 2 + 3 * li);
        let end = if li + 1 < w * h { u24_(b, 5 + 3 * li) } else { b.len() - d };
        column_sub(b.get(d + off..d + end)?, vy >> 3)
    }

    /// estado de um depósito de minério (x, z, m³, altura) para o material:
    /// 0 intocado (nada mexido em volta e o mundo base carregado: o minério está lá), 1 ainda tem minério, 2 esgotado (mexido e nenhum grupo de MIN_GRUPO blocos
    /// encostados do material, contando a parte mexida e a original), 3 sem dados (mundo base longe, não carregado)
    fn deposit(&mut self, x: f32, z: f32, m3: f32, h: f32, mat: u8) -> u8 {
        let r = (3.0 * m3.max(1.0) / (4.0 * std::f32::consts::PI)).cbrt() + 1.5;
        let (cx, cy, cz, rv) = ((x * 2.0) as i32, (h * 2.0) as i32, (z * 2.0) as i32, (r * 2.0) as i32);
        let subs: Vec<(i32, i32, i32)> = (((cx - rv) & !7)..=cx + rv).step_by(8)
            .flat_map(|sx| (((cy - rv) & !7)..=cy + rv).step_by(8).flat_map(move |sy| (((cz - rv) & !7)..=cz + rv).step_by(8).map(move |sz| (sx, sy, sz))))
            .collect();
        // nada mexido: com o mundo base carregado o jogo mostra o depósito original (intocado ou já renascido —
        // o servidor desfaz a mineração fora das bases com o tempo); sem ele, não dá para saber
        if !subs.iter().any(|&(a, b, c)| self.msub(a, b, c).is_some()) { return if self.bsub(cx, cy, cz).is_some() { 0 } else { 3 }; }
        let mut vox: HashSet<(i32, i32, i32)> = HashSet::new();
        let mut falta = false; // pedaço sem dados (mundo base não carregado): só decide se já houver minério
        for &(sx, sy, sz) in &subs {
            let s = if self.msub(sx, sy, sz).is_some() {
                self.msub(sx, sy, sz).unwrap()
            } else {
                match self.bsub(sx, sy, sz) { Some(s) => s, None => { falta = true; continue } }
            };
            for i in 0..512 {
                if s.0[i] == mat && s.1[i] >= 128 { vox.insert((sx + (i & 7) as i32, sy + ((i >> 3) & 7) as i32, sz + (i >> 6) as i32)); }
            }
        }
        let mut seen = HashSet::new();
        for &v in &vox {
            if seen.contains(&v) { continue; }
            seen.insert(v);
            let (mut q, mut n) = (vec![v], 0usize);
            while let Some(u) = q.pop() {
                n += 1;
                if n >= MIN_GRUPO { return 1; }
                for a in -1..=1 { for b in -1..=1 { for c in -1..=1 {
                    let w = (u.0 + a, u.1 + b, u.2 + c);
                    if vox.contains(&w) && seen.insert(w) { q.push(w); }
                } } }
            }
        }
        if falta { 3 } else { 2 }
    }
}

static T: Mutex<Option<Terreno>> = Mutex::new(None);

/// estados (ver Terreno::deposit) de uma lista de depósitos [x, z, m³, altura, material]; vazio se o jogo está fechado
pub fn ore_state(deps: &[[f32; 5]]) -> Vec<u8> {
    let mut g = T.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map_or(false, |t| find_pid() != Some(t.pid)) { *g = None; }
    if g.is_none() { *g = Terreno::open(); }
    let Some(t) = g.as_mut() else { return vec![] };
    if t.reload().is_none() { *g = None; return vec![]; }
    deps.iter().map(|d| t.deposit(d[0], d[1], d[2], d[3], d[4] as u8)).collect()
}
