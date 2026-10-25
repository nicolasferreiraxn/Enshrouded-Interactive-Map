// Acha a posição do jogador lendo a memória do enshrouded.exe (somente leitura).
//
// Não depende de endereços fixos (que mudam a cada atualização do jogo): varre a memória
// atrás de trios de floats (x, y, z) dentro do mundo (0..10240 m), acompanha esses
// candidatos e escolhe o grupo que se move junto e tem mais cópias. O personagem local
// aparece em centenas de cópias (física, render, rede); NPCs e outros jogadores em poucas.
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Memory::{
    VirtualQueryEx, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_IMAGE, MEM_PRIVATE, PAGE_EXECUTE_READWRITE, PAGE_READWRITE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

#[derive(Clone, Serialize, Default)]
pub struct PlayerState {
    // "fechado" | "sem_acesso" (o Windows negou abrir/ler o jogo) | "procurando" | "sem_personagem" (jogo aberto e
    // legível, mas nenhum personagem há mais de 2 min: menu, ou versão do jogo que o mapa não conhece) | "parado" | "ok"
    pub status: &'static str,
    pub erro: u32,     // código do Windows quando "sem_acesso" (5 = acesso negado)
    pub admin: bool,   // o mapa está rodando como administrador
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub heading: f32, // radianos, 0 = norte (+z), sentido horário
    pub copies: usize,
    pub candidates: usize,
}

const WORLD: f32 = 10240.0;

pub fn find_pid() -> Option<u32> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        let mut found = None;
        while ok != 0 {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
            if name == "enshrouded.exe" {
                found = Some(e.th32ProcessID);
                break;
            }
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
        found
    }
}

pub(crate) struct Proc {
    h: HANDLE,
    pid: u32,
}
impl Drop for Proc {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.h) };
    }
}
impl Proc {
    pub(crate) fn open(pid: u32) -> Option<Proc> {
        Self::open_err(pid).ok()
    }
    /// abre o jogo para leitura; Err = código do Windows (5 = acesso negado: jogo elevado ou antivírus)
    pub(crate) fn open_err(pid: u32) -> Result<Proc, u32> {
        let h = unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid) };
        if h.is_null() { Err(unsafe { GetLastError() }) } else { Ok(Proc { h, pid }) }
    }
    pub(crate) fn read(&self, addr: u64, buf: &mut [u8]) -> usize {
        let mut n: usize = 0;
        let ok = unsafe { ReadProcessMemory(self.h, addr as _, buf.as_mut_ptr() as _, buf.len(), &mut n) };
        if ok == 0 { 0 } else { n }
    }
    // regiões RW privadas a partir de start, de qualquer tamanho (a arena do ECS tem ~3 GB)
    pub(crate) fn regions_from(&self, start: u64) -> Vec<(u64, usize)> {
        let mut out = vec![];
        let mut a = start;
        loop {
            let mut m: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            let r = unsafe { VirtualQueryEx(self.h, a as _, &mut m, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) };
            if r == 0 {
                break;
            }
            let base = m.BaseAddress as u64;
            if m.State == MEM_COMMIT && m.Protect == PAGE_READWRITE && m.Type == MEM_PRIVATE {
                out.push((base, m.RegionSize));
            }
            a = base + m.RegionSize as u64;
            if a == 0 {
                break;
            }
        }
        out
    }
    fn regions(&self) -> Vec<(u64, usize)> {
        let mut out = vec![];
        let mut a: u64 = 0;
        loop {
            let mut m: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            let r = unsafe { VirtualQueryEx(self.h, a as _, &mut m, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) };
            if r == 0 {
                break;
            }
            let base = m.BaseAddress as u64;
            if m.State == MEM_COMMIT
                && (m.Protect == PAGE_READWRITE || m.Protect == PAGE_EXECUTE_READWRITE)
                && (m.Type == MEM_PRIVATE || m.Type == MEM_IMAGE)
                && m.RegionSize < (1usize << 31)
            {
                out.push((base, m.RegionSize));
            }
            a = base + m.RegionSize as u64;
            if a == 0 {
                break;
            }
        }
        out
    }
}

fn plausible(x: f32, y: f32, z: f32) -> bool {
    x > 150.0 && x < WORLD - 150.0 && z > 150.0 && z < WORLD - 150.0 && y > -50.0 && y < 2600.0
}

// cópias de rede vêm arredondadas (0,5 m, 1/8 m...); a do jogo local tem precisão total
fn fine(v: f32) -> bool {
    (v * 64.0).fract().abs() > 1e-3
}

fn scan(p: &Proc) -> Vec<u64> {
    let mut out = vec![];
    let mut buf = vec![0u8; 32 << 20];
    for (base, size) in p.regions() {
        let mut off = 0usize;
        while off < size {
            let len = (size - off).min(buf.len());
            let n = p.read(base + off as u64, &mut buf[..len]);
            if n >= 12 {
                let f: &[f32] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const f32, n / 4) };
                for i in 0..f.len().saturating_sub(2) {
                    let (x, y, z) = (f[i], f[i + 1], f[i + 2]);
                    if plausible(x, y, z) && fine(x) && fine(z) {
                        out.push(base + off as u64 + (i as u64) * 4);
                    }
                }
            }
            off += len;
        }
    }
    out
}

fn read_all(p: &Proc, addrs: &[u64], out: &mut Vec<[f32; 3]>) {
    out.clear();
    out.resize(addrs.len(), [f32::NAN; 3]);
    let mut order: Vec<usize> = (0..addrs.len()).collect();
    order.sort_unstable_by_key(|&i| addrs[i]);
    let mut buf = vec![0u8; 1 << 20];
    let mut i = 0;
    while i < order.len() {
        let start = addrs[order[i]];
        let mut j = i;
        while j + 1 < order.len() && addrs[order[j + 1]] + 12 - start <= buf.len() as u64 {
            j += 1;
        }
        let len = (addrs[order[j]] + 12 - start) as usize;
        let n = p.read(start, &mut buf[..len]);
        for &k in &order[i..=j] {
            let o = (addrs[k] - start) as usize;
            if o + 12 <= n {
                let v: [f32; 3] = [
                    f32::from_le_bytes(buf[o..o + 4].try_into().unwrap()),
                    f32::from_le_bytes(buf[o + 4..o + 8].try_into().unwrap()),
                    f32::from_le_bytes(buf[o + 8..o + 12].try_into().unwrap()),
                ];
                out[k] = v;
            }
        }
        i = j + 1;
    }
}

fn median(v: &mut [f32]) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

fn ang_diff(a: f32, b: f32) -> f32 {
    let mut d = a - b;
    while d > std::f32::consts::PI {
        d -= 2.0 * std::f32::consts::PI;
    }
    while d < -std::f32::consts::PI {
        d += 2.0 * std::f32::consts::PI;
    }
    d
}

// Rumo de um quatérnio de rotação só em Y (personagem em pé): yaw bruto.
fn yaw_of(q: [f32; 4]) -> Option<f32> {
    let n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if !(0.98..1.02).contains(&n) || q[0].abs() > 0.03 || q[2].abs() > 0.03 {
        return None;
    }
    Some(2.0 * q[1].atan2(q[3]))
}

// 8 formas de converter o yaw do jogo para o rumo do mapa (sinal e deslocamento de 90°)
fn transform(yaw: f32, t: usize) -> f32 {
    let s = if t & 4 != 0 { -1.0 } else { 1.0 };
    s * yaw + (t & 3) as f32 * std::f32::consts::FRAC_PI_2
}

struct Quat {
    addr: u64,
    score: [i16; 8],
    last: f32,
    changes: u32,
}

fn dist2(a: [f32; 3], x: f32, z: f32) -> f32 {
    ((a[0] - x).powi(2) + (a[2] - z).powi(2)).sqrt()
}

// Caminho achado por engenharia reversa (Enshrouded 1.0):
// [enshrouded.exe + PLAYER_PTR] + 0x1f0 = keen::WorldPosition do personagem local (3 x int64 em ponto fixo 32.32);
// [enshrouded.exe + CAMERA_YAW_QUAT] = quatérnio só de yaw da câmera, com a WorldPosition da câmera 0x20 depois.
// Os offsets mudam a cada atualização do jogo (16/10: 0x281ccb0 / 0x1fc4f48; 21/10 08:47: +0x3000 nos dois), então
// são procurados perto dos últimos conhecidos e validados: câmera = quatérnio unitário só de yaw com posição no
// mundo; personagem = ponteiro cuja posição fica a menos de 50 m da câmera.
const PLAYER_PTR_GUESS: u64 = 0x281fcb0;
const PLAYER_POS: u64 = 0x1f0;
const CAMERA_YAW_QUAT_GUESS: u64 = 0x1fc7f48;
const SEARCH: u64 = 0x80000; // ± 512 KB em volta do palpite
static OFFS: std::sync::Mutex<(u64, u64, u64)> = std::sync::Mutex::new((0, 0, 0)); // (base, player, câmera)

fn fx(b: &[u8], o: usize) -> f32 {
    (i64::from_le_bytes(b[o..o + 8].try_into().unwrap()) as f64 / 4294967296.0) as f32
}
fn in_world(v: [f32; 3]) -> bool {
    v.iter().all(|c| c.is_finite()) && (0.0..=WORLD).contains(&v[0]) && (0.0..=WORLD).contains(&v[2]) && v[1] > -1000.0 && v[1] < 4000.0
}
fn yaw_quat(b: &[u8]) -> Option<[f32; 4]> {
    let q = [0, 4, 8, 12].map(|o| f32::from_le_bytes(b[o..o + 4].try_into().unwrap()));
    let n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if (n - 1.0).abs() > 0.01 || q[0].abs() > 0.02 || q[2].abs() > 0.02 { None } else { Some(q) }
}
fn cam_ok(b: &[u8], o: usize) -> Option<[f32; 3]> {
    yaw_quat(&b[o..o + 16])?;
    let v = [fx(b, o + 0x20), fx(b, o + 0x28), fx(b, o + 0x30)];
    if in_world(v) && v[0] > 1.0 && v[2] > 1.0 { Some(v) } else { None }
}
fn player_at(p: &Proc, base: u64, off: u64) -> Option<[f32; 3]> {
    let mut b8 = [0u8; 8];
    if p.read(base + off, &mut b8) != 8 {
        return None;
    }
    let obj = u64::from_le_bytes(b8);
    if obj < 0x10000 || obj > 0x7fff_ffff_ffff || obj & 7 != 0 {
        return None;
    }
    let mut b = [0u8; 24];
    if p.read(obj + PLAYER_POS, &mut b) != 24 {
        return None;
    }
    let v = [fx(&b, 0), fx(&b, 8), fx(&b, 16)];
    if in_world(v) { Some(v) } else { None }
}

// (player, câmera) válidos para este processo; procura de novo quando o palpite/cache deixa de valer
fn offsets(p: &Proc, base: u64) -> Option<(u64, u64)> {
    let cached = *OFFS.lock().unwrap();
    let mut cb = [0u8; 0x38];
    // depois de achados, valem enquanto o personagem tiver posição válida e a câmera um quatérnio de yaw:
    // a distância câmera–personagem só é exigida na busca (com o mapa do jogo aberto a câmera vai longe, e
    // exigir isso aqui derrubava para a busca aproximada e fazia a posição oscilar)
    // (a câmera nem entra: com o mapa aberto ela fica inclinada e o quatérnio deixa de ser só de yaw)
    let _ = &mut cb;
    if cached.0 == base && player_at(p, base, cached.1).is_some() {
        return Some((cached.1, cached.2));
    }
    // busca completa no máximo a cada 2 s (é pesada e, repetida a cada quadro, pode pegar outra entidade perto da câmera)
    {
        static LAST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
        let mut l = LAST.lock().unwrap();
        if l.map_or(false, |t| t.elapsed() < Duration::from_secs(2)) {
            return None;
        }
        *l = Some(Instant::now());
    }
    // câmera: varre ± SEARCH em volta do palpite
    let lo = CAMERA_YAW_QUAT_GUESS - SEARCH;
    let mut buf = vec![0u8; (2 * SEARCH) as usize + 0x38];
    let n = p.read(base + lo, &mut buf);
    let mut cams = vec![];
    let mut o = 0;
    while o + 0x38 <= n {
        if let Some(c) = cam_ok(&buf, o) {
            cams.push((lo + o as u64, c));
        }
        o += 8;
    }
    cams.sort_by_key(|(a, _)| (*a as i64 - CAMERA_YAW_QUAT_GUESS as i64).abs());
    // personagem: ponteiros em ± SEARCH em volta do palpite, mais perto do palpite primeiro
    let plo = PLAYER_PTR_GUESS - SEARCH;
    let mut pb = vec![0u8; (2 * SEARCH) as usize];
    let pn = p.read(base + plo, &mut pb);
    let mut offs: Vec<u64> = (0..pn / 8).map(|k| plo + 8 * k as u64).collect();
    offs.sort_by_key(|a| (*a as i64 - PLAYER_PTR_GUESS as i64).abs());
    for (coff, c) in &cams {
        for &poff in &offs {
            let v = u64::from_le_bytes(pb[(poff - plo) as usize..(poff - plo) as usize + 8].try_into().unwrap());
            if v < 0x10000 || v > 0x7fff_ffff_ffff || v & 7 != 0 {
                continue;
            }
            if let Some(pl) = player_at(p, base, poff) {
                if dist2(*c, pl[0], pl[2]) < 50.0 && (pl[1] - c[1]).abs() < 60.0 {
                    *OFFS.lock().unwrap() = (base, poff, *coff);
                    return Some((poff, *coff));
                }
            }
        }
    }
    None
}

fn read_camera_yaw(p: &Proc, base: u64) -> Option<f32> {
    let (_, coff) = offsets(p, base)?;
    let mut b = [0u8; 16];
    if p.read(base + coff, &mut b) != 16 {
        return None;
    }
    let q = yaw_quat(&b)?;
    Some(2.0 * q[1].atan2(q[3]))
}

pub(crate) fn module_base(p: &Proc) -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::EnumProcessModulesEx;
    let mut mods = [std::ptr::null_mut::<core::ffi::c_void>(); 1];
    let mut need = 0u32;
    let ok = unsafe { EnumProcessModulesEx(p.h, mods.as_mut_ptr() as _, std::mem::size_of_val(&mods) as u32, &mut need, 3) };
    if ok == 0 || mods[0].is_null() { None } else { Some(mods[0] as u64) }
}

pub(crate) fn read_world_pos(p: &Proc, base: u64) -> Option<[f32; 3]> {
    // o ponteiro é exato: aceita o mundo inteiro (dungeons ficam encostadas na borda do mapa)
    let (poff, _) = offsets(p, base)?;
    player_at(p, base, poff)
}

// Modo principal: lê a posição exata pelo ponteiro fixo, 30 vezes por segundo.
// Fica nele enquanto o jogo estiver aberto (esperando o personagem aparecer, se for o caso); devolve true quando o
// processo muda. A busca heurística antiga só roda com EMB_HEURISTIC.
fn run_pointer(p: &Proc, pid: u32, emit: &mut impl FnMut(&PlayerState)) -> bool {
    // jogo recém-aberto: a lista de módulos ainda pode não estar pronta; tenta de novo em vez de cair na heurística.
    // Se continuar falhando (ou o cabeçalho do exe não puder ser lido), o Windows está bloqueando a leitura.
    static FALHAS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let base = module_base(p).filter(|&b| {
        let mut mz = [0u8; 2];
        p.read(b, &mut mz) == 2 && mz == *b"MZ"
    });
    let Some(base) = base else {
        let e = unsafe { GetLastError() };
        if FALHAS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) >= 5 {
            emit(&PlayerState { status: "sem_acesso", erro: if e == 0 { 5 } else { e }, admin: is_admin(), ..Default::default() });
        }
        std::thread::sleep(Duration::from_secs(1));
        return true;
    };
    FALHAS.store(0, std::sync::atomic::Ordering::Relaxed);
    let inicio = Instant::now();
    let mut leu = false;
    let mut fails = 0;
    let mut last: Option<[f32; 3]> = None;
    let mut anchor: Option<[f32; 3]> = None;
    let mut heading = 0f32;
    let mut still_since = Instant::now();
    let mut tick = 0u64;
    loop {
        tick += 1;
        if tick % 60 == 0 && find_pid() != Some(pid) {
            return true;
        }
        match read_world_pos(p, base) {
            None => {
                // sem personagem ainda (menu, tela de carregamento, mapa aberto antes do jogo): continua esperando
                // aqui. Antes, 3 s sem leitura e sem nunca ter lido faziam cair na busca heurística antiga, que
                // nunca voltava — com o mapa aberto antes do jogo, o personagem não era mais achado.
                fails += 1;
                if fails % 90 == 0 {
                    // nunca achou o personagem em 2 min com o jogo legível: menu parado ou versão do jogo desconhecida
                    let st = if !leu && inicio.elapsed() > Duration::from_secs(120) { "sem_personagem" } else { "procurando" };
                    emit(&PlayerState { status: st, admin: is_admin(), ..Default::default() });
                }
                std::thread::sleep(Duration::from_millis(33));
                continue;
            }
            Some([x, y, z]) => {
                fails = 0;
                leu = true;
                if let Some(l) = last {
                    if dist2(l, x, z) > 0.01 {
                        still_since = Instant::now();
                    }
                }
                if let Some(yaw) = read_camera_yaw(p, base) {
                    // mesmo rumo da seta do mapa do jogo: a direção da câmera
                    heading += ang_diff(yaw, heading);
                } else {
                    match anchor {
                        None => anchor = Some([x, y, z]),
                        Some(a) => {
                            let d = dist2(a, x, z);
                            if d > 50.0 {
                                anchor = Some([x, y, z]);
                            } else if d > 0.8 {
                                heading += ang_diff((x - a[0]).atan2(z - a[2]), heading);
                                anchor = Some([x, y, z]);
                            }
                        }
                    }
                }
                last = Some([x, y, z]);
                emit(&PlayerState {
                    status: if still_since.elapsed() < Duration::from_secs(2) { "ok" } else { "parado" },
                    x,
                    y,
                    z,
                    heading,
                    copies: 1,
                    candidates: 0,
                    ..Default::default()
                });
            }
        }
        std::thread::sleep(Duration::from_millis(33));
    }
}

pub static RESET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn run(mut emit: impl FnMut(&PlayerState)) {
    let mut state = PlayerState { status: "fechado", ..Default::default() };
    loop {
        let Some(pid) = find_pid() else {
            state = PlayerState { status: "fechado", ..Default::default() };
            emit(&state);
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let p = match Proc::open_err(pid) {
            Ok(p) => p,
            Err(e) => {
                // o jogo está aberto, mas o Windows não deixa ler: avisa na tela em vez de ficar em silêncio
                state = PlayerState { status: "sem_acesso", erro: e, admin: is_admin(), ..Default::default() };
                emit(&state);
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        if std::env::var("EMB_HEURISTIC").is_err() && run_pointer(&p, pid, &mut emit) {
            continue;
        }
        let mut cands: Vec<u64> = vec![];
        let mut prev: Vec<[f32; 3]> = vec![];
        let mut cur: Vec<[f32; 3]> = vec![];
        let mut score: Vec<u8> = vec![];
        let mut origin: Vec<[f32; 3]> = vec![];
        let mut locked: Vec<u64> = vec![];
        let mut primary: Option<u64> = None;
        let mut vals: Vec<[f32; 3]> = vec![];
        let mut last_vals: HashMap<u64, [f32; 3]> = HashMap::new();
        let mut freq: HashMap<u64, u32> = HashMap::new();
        let mut freq_tick: HashMap<u64, u64> = HashMap::new();
        let mut last_pick = Instant::now();
        let mut quats: Vec<Quat> = vec![];
        let mut last_scan = Instant::now() - Duration::from_secs(3600);
        let mut last_score = Instant::now() - Duration::from_secs(3600);
        let mut anchor: Option<[f32; 3]> = None;
        let mut move_heading: Option<f32> = None;
        let mut heading = 0f32;
        let mut last_xyz = [0f32; 3];
        let mut still_since = Instant::now();
        let mut tick: u64 = 0;
        loop {
            tick += 1;
            if RESET.swap(false, std::sync::atomic::Ordering::Relaxed) {
                cands.clear();
                locked.clear();
                primary = None;
                quats.clear();
            }
            if tick % 40 == 0 && find_pid() != Some(pid) {
                break;
            }
            if cands.is_empty() || (locked.is_empty() && last_scan.elapsed() > Duration::from_secs(20)) {
                state.status = "procurando";
                emit(&state);
                cands = scan(&p);
                last_scan = Instant::now();
                read_all(&p, &cands, &mut prev);
                origin = prev.clone();
                score = vec![0; cands.len()];
                state.candidates = cands.len();
            }
            // 1) a cada 300 ms: pontua os candidatos e acha o grupo do personagem
            if last_score.elapsed() >= Duration::from_millis(300) {
                last_score = Instant::now();
                read_all(&p, &cands, &mut cur);
                for k in 0..cands.len() {
                    let (a, b) = (prev[k], cur[k]);
                    if !plausible(b[0], b[1], b[2]) {
                        score[k] = 0;
                        continue;
                    }
                    let d = dist2(a, b[0], b[2]);
                    if !d.is_finite() || d > 60.0 || (b[1] - a[1]).abs() > 30.0 {
                        origin[k] = b;
                        score[k] = 0;
                        continue;
                    }
                    if d > 0.02 && dist2(origin[k], b[0], b[2]) > 1.5 {
                        score[k] = score[k].saturating_add(1).min(60);
                    }
                }
                std::mem::swap(&mut prev, &mut cur);
                let mut cells: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
                for k in 0..cands.len() {
                    if score[k] >= 3 {
                        let v = prev[k];
                        cells.entry(((v[0] / 2.5) as i32, (v[2] / 2.5) as i32)).or_default().push(k);
                    }
                }
                let mut best: Option<((i32, i32), usize)> = None;
                for (&c, _) in &cells {
                    let mut n = 0;
                    for dx in -1..=1 {
                        for dz in -1..=1 {
                            n += cells.get(&(c.0 + dx, c.1 + dz)).map_or(0, |v| v.len());
                        }
                    }
                    if best.map_or(true, |(_, b)| n > b) {
                        best = Some((c, n));
                    }
                }
                if std::env::var("EMB_DEBUG").is_ok() {
                    let moving = score.iter().filter(|&&s| s >= 3).count();
                    eprintln!("debug: com pontos={} melhor={:?}", moving, best);
                }
                if let Some((c, n)) = best {
                    if (locked.is_empty() && n >= 25) || (!locked.is_empty() && n * 5 > locked.len() * 6) {
                        let mut ks = vec![];
                        for dx in -1..=1 {
                            for dz in -1..=1 {
                                if let Some(v) = cells.get(&(c.0 + dx, c.1 + dz)) {
                                    ks.extend(v.iter().copied());
                                }
                            }
                        }
                        let new: Vec<u64> = ks.iter().map(|&k| cands[k]).collect();
                        if !primary.map_or(false, |a| new.contains(&a)) {
                            primary = None;
                            quats.clear();
                            locked = new;
                        }
                    }
                }
            }
            if locked.is_empty() {
                state.status = "procurando";
                state.candidates = cands.len();
                emit(&state);
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            // 2) a cada 50 ms: lê só o grupo travado
            read_all(&p, &locked, &mut vals);
            let good: Vec<[f32; 3]> = vals.iter().copied().filter(|v| plausible(v[0], v[1], v[2])).collect();
            if good.len() * 2 < locked.len() {
                locked.clear();
                cands.clear();
                primary = None;
                quats.clear();
                continue;
            }
            let mut xs: Vec<f32> = good.iter().map(|v| v[0]).collect();
            let mut zs: Vec<f32> = good.iter().map(|v| v[2]).collect();
            let (mx, mz) = (median(&mut xs), median(&mut zs));
            // conta quantas vezes cada cópia muda: a do quadro atual muda sempre, as atrasadas raramente
            for (i, &a) in locked.iter().enumerate() {
                let v = vals[i];
                if let Some(o) = last_vals.get(&a) {
                    if o[0] != v[0] || o[2] != v[2] {
                        *freq.entry(a).or_insert(0) += 1;
                        freq_tick.insert(a, tick);
                    }
                }
                last_vals.insert(a, v);
            }
            // uma única cópia (a mais atualizada, perto da mediana): movimento liso e sem atraso
            let pv = primary.and_then(|a| locked.iter().position(|&x| x == a)).map(|i| vals[i]);
            // o principal só é trocado se parar de atualizar ou sair do grupo (evita pular entre cópias)
            let stale = primary.map_or(true, |a| freq_tick.get(&a).map_or(true, |&t| tick - t > 30));
            let bad = !pv.map_or(false, |v| plausible(v[0], v[1], v[2]) && dist2(v, mx, mz) < 6.0) || stale;
            if bad && last_pick.elapsed() > Duration::from_millis(500) || primary.is_none() {
                last_pick = Instant::now();
                let mut best: Option<(u32, f32, u64)> = None;
                for (i, v) in vals.iter().enumerate() {
                    if !plausible(v[0], v[1], v[2]) || dist2(*v, mx, mz) > 4.0 || !(fine(v[0]) || fine(v[2])) {
                        continue;
                    }
                    let f = *freq.get(&locked[i]).unwrap_or(&0);
                    let d = dist2(*v, mx, mz);
                    if best.map_or(true, |(bf, bd, _)| f > bf || (f == bf && d < bd)) {
                        best = Some((f, d, locked[i]));
                    }
                }
                if let Some((_, _, a)) = best {
                    if primary != Some(a) {
                        primary = Some(a);
                    }
                }
                if freq.len() > 4000 {
                    freq.clear();
                    freq_tick.clear();
                    last_vals.clear();
                }
            }
            let Some(pi) = locked.iter().position(|&x| Some(x) == primary) else { std::thread::sleep(Duration::from_millis(50)); continue };
            let [x, y, z] = vals[pi];
            if tick % 20 == 0 {
                let keep: Vec<u64> = locked.iter().zip(vals.iter()).filter(|(_, v)| dist2(**v, x, z) < 1.5).map(|(a, _)| *a).collect();
                if keep.len() >= 5 {
                    locked = keep;
                }
            }
            // quatérnios de rotação perto das cópias (procura uma vez por trava)
            if quats.is_empty() {
                let mut buf = vec![0u8; 0x800];
                let mut seen = std::collections::HashSet::new();
                for &a in locked.iter().take(48) {
                    let start = a.saturating_sub(0x400) & !3;
                    let n = p.read(start, &mut buf);
                    let f: &[f32] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const f32, n / 4) };
                    for i in 0..f.len().saturating_sub(3) {
                        let q = [f[i], f[i + 1], f[i + 2], f[i + 3]];
                        if let Some(yw) = yaw_of(q) {
                            let qa = start + i as u64 * 4;
                            if q[1].abs() > 0.01 && seen.insert(qa) {
                                quats.push(Quat { addr: qa, score: [0; 8], last: yw, changes: 0 });
                            }
                        }
                    }
                }
            }
            // rumo pelo movimento: só depois de 1,5 m percorridos (não treme)
            match anchor {
                None => anchor = Some([x, y, z]),
                Some(a) => {
                    let d = dist2(a, x, z);
                    if d > 40.0 {
                        anchor = Some([x, y, z]);
                    } else if d > 1.5 {
                        move_heading = Some((x - a[0]).atan2(z - a[2]));
                        anchor = Some([x, y, z]);
                    }
                }
            }
            let moving = dist2(last_xyz, x, z) > 0.03;
            // calibra os quatérnios contra o rumo do movimento e usa o melhor
            let mut qbest: Option<(f32, i16)> = None;
            if !quats.is_empty() {
                let mut b16 = [0u8; 16];
                let mh = if moving { move_heading } else { None };
                for q in quats.iter_mut() {
                    if p.read(q.addr, &mut b16) != 16 {
                        continue;
                    }
                    let v = [0, 4, 8, 12].map(|o| f32::from_le_bytes(b16[o..o + 4].try_into().unwrap()));
                    let Some(yw) = yaw_of(v) else { continue };
                    if ang_diff(yw, q.last).abs() > 0.02 {
                        q.changes += 1;
                    }
                    q.last = yw;
                    if let Some(h) = mh {
                        for t in 0..8 {
                            let e = ang_diff(transform(yw, t), h).abs();
                            q.score[t] = (q.score[t] + if e < 0.35 { 1 } else { -1 }).clamp(-50, 200);
                        }
                    }
                    if q.changes > 3 {
                        for t in 0..8 {
                            if q.score[t] >= 8 && qbest.map_or(true, |(_, s)| q.score[t] > s) {
                                qbest = Some((transform(yw, t), q.score[t]));
                            }
                        }
                    }
                }
                quats.retain(|q| q.score.iter().any(|&s| s > -40));
            }
            let target = qbest.map(|b| b.0).or(move_heading).unwrap_or(heading);
            heading += ang_diff(target, heading) * if qbest.is_some() { 0.8 } else { 0.35 };
            if moving {
                still_since = Instant::now();
            }
            last_xyz = [x, y, z];
            if std::env::var("EMB_DEBUG").is_ok() && tick % 4 == 0 {
                eprintln!("prim={:x?} q={} qbest={:?} mh={:?}", primary, quats.len(), qbest.map(|b| (b.0, b.1)), move_heading);
            }
            state = PlayerState {
                status: if still_since.elapsed() < Duration::from_secs(2) { "ok" } else { "parado" },
                x,
                y,
                z,
                heading,
                copies: locked.len(),
                candidates: cands.len(),
                ..Default::default()
            };
            emit(&state);
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// o mapa está rodando elevado (administrador)?
pub fn is_admin() -> bool {
    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
    }
    unsafe { IsUserAnAdmin() != 0 }
}
