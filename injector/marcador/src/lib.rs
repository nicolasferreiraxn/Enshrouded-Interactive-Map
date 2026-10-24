//! DLL carregada no enshrouded.exe: cria/remove marcadores personalizados do mapa na thread do jogo.
//! Registro de marcadores, funções e assinaturas: ver as constantes SIG_* abaixo.
//!
//! Fluxo: DllMain -> thread `iniciar` (acha funções por AOB, instala hook no laço de eventos do cliente,
//! abre o pipe \\.\pipe\embervale-marcador). Cada pedido do pipe vai para FILA; o hook (`on_tick`, thread do
//! jogo, no começo de FUN_140845600) esvazia a fila com try_lock e chama as funções do próprio jogo.

#![allow(clippy::missing_safety_doc)]
use std::collections::VecDeque;
use std::ffi::c_void;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

mod json;
mod win;
use win::*;

const PIPE: &str = r"\\.\pipe\embervale-marcador";

// ---------- assinaturas ----------
const SIG_LOOP: &str = "40 53 55 56 57 41 54 41 55 41 56 41 57 48 81 EC 98 00 00 00 48 8D 81 ?? ?? ?? ?? 48 8B F9";
const SIG_ADD: &str = "48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 41 56 41 57 48 83 EC 20 4C 8B F1 41 8B D9 48 8D 4A 40 4D 8B F8 48 8B F2 E8";
const SIG_REM: &str = "48 89 5C 24 08 48 89 74 24 10 57 48 83 EC 40 8B FA 48 8B D9 8B C2 83 E7 3F 48 C1 E8 06";
const SIG_CASE43: &str = "48 8B 8F ?? ?? ?? ?? 48 85 C9 0F 84 ?? ?? ?? ?? E8 ?? ?? ?? ?? 4C 8B D0 48 85 C0 0F 84 ?? ?? ?? ?? 80 7E 28 00 74 ?? 44 8B 4E 24";
const SIG_B_C: &str = "48 8B 8B ?? ?? ?? ?? 48 85 C9 74 05 E8 ?? ?? ?? ?? 4C 8D 5C 24";
const SIG_A_B: &str = "48 8B 8F ?? ?? ?? ?? 48 85 C9 74 ?? 48 8B D6 E8";
/// bytes originais do começo de FUN_140845600 que o hook substitui (instruções inteiras: push rbx(rex) / rbp / rsi / rdi)
const STOLEN: [u8; 5] = [0x40, 0x53, 0x55, 0x56, 0x57];

type FnAdd = unsafe extern "system" fn(out: *mut u64, reg: usize, pos: *const i64, cor: u32, icone: u8, nome: *const StrView) -> *mut u64;
type FnRem = unsafe extern "system" fn(reg: usize, indice: u32) -> u64;
#[repr(C)]
struct StrView { p: *const u8, len: u64 }

struct Addrs { base: usize, hook: usize, add: usize, rem: usize, off_ab: u32, off_bc: u32, off_cg: u32, off_gr: u32 }
static ADDRS: OnceLock<Addrs> = OnceLock::new();
static TICKS: AtomicU64 = AtomicU64::new(0);
static PENDENTE: AtomicBool = AtomicBool::new(false);
static HOOK_ON: AtomicBool = AtomicBool::new(false);
static STUB: AtomicUsize = AtomicUsize::new(0);
static ORIG8: AtomicU64 = AtomicU64::new(0);
static ULTIMO_REG: AtomicUsize = AtomicUsize::new(0);

enum Pedido { Criar { x: f64, z: f64, nome: String, icone: u8, cor: u32 }, Remover { indice: Option<u32>, nome: Option<String> }, Listar }
type Resp = Arc<(Mutex<Option<String>>, Condvar)>;
static FILA: Mutex<VecDeque<(Pedido, Resp)>> = Mutex::new(VecDeque::new());

pub(crate) fn log(msg: &str) {
    let p = std::env::temp_dir().join("embervale-marcador.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "[{t}] {msg}");
    }
}

#[no_mangle]
pub extern "system" fn DllMain(_h: *mut c_void, reason: u32, _r: *mut c_void) -> i32 {
    if reason == 1 {
        std::thread::spawn(|| {
            if let Err(e) = std::panic::catch_unwind(iniciar).unwrap_or_else(|_| Err("panic em iniciar".into())) {
                log(&format!("ERRO ao iniciar: {e}"));
            }
        });
    }
    1
}

// ---------- AOB ----------
fn parse_sig(s: &str) -> Vec<Option<u8>> {
    s.split_whitespace().map(|t| if t == "??" { None } else { Some(u8::from_str_radix(t, 16).unwrap()) }).collect()
}
fn scan(text: &[u8], text_va: usize, sig: &str) -> Vec<usize> {
    let p = parse_sig(sig);
    let first = p[0].unwrap();
    let mut out = vec![];
    let mut i = 0;
    while i + p.len() <= text.len() {
        if text[i] == first && p.iter().enumerate().all(|(k, b)| b.map_or(true, |b| text[i + k] == b)) {
            out.push(text_va + i);
        }
        i += 1;
    }
    out
}
fn um(text: &[u8], va: usize, nome: &str, sig: &str) -> Result<usize, String> {
    let v = scan(text, va, sig);
    if v.len() != 1 { return Err(format!("assinatura {nome}: {} ocorrências (esperado 1)", v.len())); }
    Ok(v[0])
}
unsafe fn rd32(a: usize) -> u32 { std::ptr::read_unaligned(a as *const u32) }
unsafe fn rel32(call_at: usize) -> usize { (call_at as isize + 5 + rd32(call_at + 1) as i32 as isize) as usize }

fn achar() -> Result<Addrs, String> {
    unsafe {
        let base = GetModuleHandleW(std::ptr::null()) as usize;
        if base == 0 { return Err("sem módulo principal".into()); }
        // seção .text pelos cabeçalhos PE em memória
        let pe = base + rd32(base + 0x3c) as usize;
        let nsec = std::ptr::read_unaligned((pe + 6) as *const u16) as usize;
        let opt = std::ptr::read_unaligned((pe + 20) as *const u16) as usize;
        let mut text = None;
        for i in 0..nsec {
            let s = pe + 24 + opt + i * 40;
            let name = std::slice::from_raw_parts(s as *const u8, 8);
            if name.starts_with(b".text") { text = Some((base + rd32(s + 12) as usize, rd32(s + 8) as usize)); }
        }
        let (tva, tsz) = text.ok_or("sem .text")?;
        let t = std::slice::from_raw_parts(tva as *const u8, tsz);
        let hook = um(t, tva, "laço", SIG_LOOP)?;
        let add = um(t, tva, "criar", SIG_ADD)?;
        let rem = um(t, tva, "remover", SIG_REM)?;
        let c43 = um(t, tva, "caso43", SIG_CASE43)?;
        let bc = um(t, tva, "B->C", SIG_B_C)?;
        let ab = um(t, tva, "A->B", SIG_A_B)?;
        // conferências cruzadas: o caso 0x43 chama exatamente as funções achadas
        if rel32(c43 + 0x60) != add { return Err("caso43 não chama 'criar' achado".into()); }
        if rel32(c43 + 0x70) != rem { return Err("caso43 não chama 'remover' achado".into()); }
        let getter = rel32(c43 + 0x10);
        let g = std::slice::from_raw_parts(getter as *const u8, 8);
        if g[0..3] != [0x48, 0x8B, 0x81] || g[7] != 0xC3 { return Err(format!("getter inesperado {g:02x?}")); }
        if hook % 8 != 0 { return Err("laço não alinhado em 8".into()); }
        let a = Addrs { base, hook, add, rem, off_ab: rd32(ab + 3), off_bc: rd32(bc + 3), off_cg: rd32(c43 + 3), off_gr: rd32(getter + 3) };
        log(&format!("achado: hook +{:#x} criar +{:#x} remover +{:#x} offs A->B {:#x} B->C {:#x} C->G {:#x} G->R {:#x}",
            a.hook - base, a.add - base, a.rem - base, a.off_ab, a.off_bc, a.off_cg, a.off_gr));
        Ok(a)
    }
}

// ---------- hook ----------
unsafe fn alocar_perto(alvo: usize) -> Option<usize> {
    let mut a = (alvo & !0xffff).saturating_sub(0x10000);
    let lim = alvo.saturating_sub(0x7000_0000);
    let mut mbi: MBI = std::mem::zeroed();
    while a > lim {
        if VirtualQuery(a as *const c_void, &mut mbi, std::mem::size_of::<MBI>()) != 0 && mbi.state == MEM_FREE {
            let p = VirtualAlloc(a as *mut c_void, 0x1000, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
            if !p.is_null() { return Some(p as usize); }
        }
        a -= 0x10000;
    }
    None
}

/// Grava 8 bytes alinhados em `alvo` com as outras threads suspensas, garantindo que nenhuma está
/// parada dentro dos 5 primeiros bytes (meio do prólogo).
unsafe fn gravar8(alvo: usize, novo: u64) -> Result<(), String> {
    let pid = GetCurrentProcessId();
    let eu = GetCurrentThreadId();
    let mut old = 0u32;
    if VirtualProtect(alvo as *mut c_void, 8, PAGE_EXECUTE_READWRITE, &mut old) == 0 { return Err("VirtualProtect".into()); }
    let mut res = Err("threads no prólogo em todas as tentativas".to_string());
    for _ in 0..50 {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE { res = Err("snapshot".into()); break; }
        let mut tids: Vec<u32> = Vec::with_capacity(4096);
        let mut te: THREADENTRY32 = std::mem::zeroed();
        te.size = std::mem::size_of::<THREADENTRY32>() as u32;
        if Thread32First(snap, &mut te) != 0 {
            loop {
                if te.owner_pid == pid && te.tid != eu && tids.len() < tids.capacity() { tids.push(te.tid); }
                if Thread32Next(snap, &mut te) == 0 { break; }
            }
        }
        CloseHandle(snap);
        // daqui até retomar: nada de alocar (uma thread suspensa pode estar com a trava do heap)
        let mut hs: Vec<isize> = Vec::with_capacity(tids.len());
        let mut perigo = false;
        for &tid in &tids {
            let h = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, 0, tid);
            if h == 0 { continue; }
            if SuspendThread(h) == u32::MAX { CloseHandle(h); continue; }
            hs.push(h);
            let mut ctx = Ctx::new();
            if GetThreadContext(h, ctx.ptr()) != 0 {
                let rip = ctx.rip();
                if rip > alvo && rip < alvo + STOLEN.len() { perigo = true; }
            }
        }
        if !perigo {
            std::ptr::write_volatile(alvo as *mut u64, novo);
            FlushInstructionCache(GetCurrentProcess(), alvo as *const c_void, 8);
        }
        for &h in &hs { ResumeThread(h); CloseHandle(h); }
        if !perigo { res = Ok(()); break; }
        std::thread::sleep(Duration::from_millis(2));
    }
    VirtualProtect(alvo as *mut c_void, 8, old, &mut old);
    res
}

unsafe fn instalar(a: &Addrs) -> Result<(), String> {
    let orig = std::ptr::read_volatile(a.hook as *const u64);
    if orig.to_le_bytes()[..5] != STOLEN { return Err(format!("prólogo diferente do esperado: {:02x?}", orig.to_le_bytes())); }
    let stub = alocar_perto(a.hook).ok_or("sem memória perto do módulo para o trampolim")?;
    let mut c: Vec<u8> = vec![];
    c.extend([0x51, 0x52, 0x41, 0x50, 0x41, 0x51]); // push rcx, rdx, r8, r9
    c.extend([0x48, 0x83, 0xEC, 0x28]); // sub rsp,28h (alinha em 16 + shadow space)
    c.extend([0x48, 0xB8]); c.extend((on_tick as extern "system" fn(usize) as usize as u64).to_le_bytes()); // mov rax, on_tick
    c.extend([0xFF, 0xD0]); // call rax
    c.extend([0x48, 0x83, 0xC4, 0x28]); // add rsp,28h
    c.extend([0x41, 0x59, 0x41, 0x58, 0x5A, 0x59]); // pop r9, r8, rdx, rcx
    c.extend(STOLEN); // instruções originais
    c.extend([0xFF, 0x25, 0, 0, 0, 0]); c.extend(((a.hook + STOLEN.len()) as u64).to_le_bytes()); // jmp [rip] -> hook+5
    std::ptr::copy_nonoverlapping(c.as_ptr(), stub as *mut u8, c.len());
    FlushInstructionCache(GetCurrentProcess(), stub as *const c_void, c.len());
    let rel = (stub as isize - (a.hook as isize + 5)) as i32;
    let mut b = orig.to_le_bytes();
    b[0] = 0xE9; b[1..5].copy_from_slice(&rel.to_le_bytes());
    STUB.store(stub, Ordering::SeqCst);
    ORIG8.store(orig, Ordering::SeqCst);
    gravar8(a.hook, u64::from_le_bytes(b))?;
    HOOK_ON.store(true, Ordering::SeqCst);
    log(&format!("hook instalado; trampolim {stub:#x}"));
    Ok(())
}

unsafe fn desinstalar() -> Result<(), String> {
    let a = ADDRS.get().ok_or("sem endereços")?;
    if !HOOK_ON.load(Ordering::SeqCst) { return Ok(()); }
    gravar8(a.hook, ORIG8.load(Ordering::SeqCst))?;
    HOOK_ON.store(false, Ordering::SeqCst);
    log("hook removido (o trampolim fica alocado; a DLL continua carregada mas inerte)");
    Ok(())
}

// ---------- thread do jogo ----------
unsafe fn ptr_ok(v: u64) -> bool { v >= 0x10000 && v < 0x7fff_ffff_0000 && v % 8 == 0 }
unsafe fn rd64(a: usize) -> Option<usize> { let v = std::ptr::read_volatile(a as *const u64); if ptr_ok(v) { Some(v as usize) } else { None } }

unsafe fn registro(a_obj: usize, ad: &Addrs) -> Option<usize> {
    let b = rd64(a_obj + ad.off_ab as usize)?;
    let c = rd64(b + ad.off_bc as usize)?;
    let g = rd64(c + ad.off_cg as usize)?;
    let r = rd64(g + ad.off_gr as usize)?;
    (rd32(r + 0x68) == 0x400 && rd32(r + 0x6c) == 0xc0).then_some(r)
}

extern "system" fn on_tick(a_obj: usize) {
    TICKS.fetch_add(1, Ordering::Relaxed);
    if !PENDENTE.load(Ordering::Relaxed) { return; }
    let _ = std::panic::catch_unwind(|| unsafe { processar(a_obj) });
}

unsafe fn processar(a_obj: usize) {
    let Some(ad) = ADDRS.get() else { return };
    let Ok(mut fila) = FILA.try_lock() else { return };
    let Some(r) = (if ptr_ok(a_obj as u64) { registro(a_obj, ad) } else { None }) else { return }; // tenta no próximo quadro
    ULTIMO_REG.store(r, Ordering::Relaxed);
    let mut n = 0;
    while let Some((p, resp)) = fila.pop_front() {
        let txt = executar(r, ad, p);
        let (m, cv) = &*resp;
        *m.lock().unwrap() = Some(txt);
        cv.notify_all();
        n += 1;
        if n >= 16 { break; }
    }
    PENDENTE.store(!fila.is_empty(), Ordering::Relaxed);
}

unsafe fn nos(r: usize) -> Vec<usize> {
    let mut v = vec![];
    let mut n = std::ptr::read_volatile((r + 0x80) as *const u64) as usize;
    while n != 0 && v.len() < 0x400 { v.push(n); n = std::ptr::read_volatile((n + 0xb8) as *const u64) as usize; }
    v
}
unsafe fn nome_no(n: usize) -> String {
    let len = (*((n + 0xa0) as *const u8)).min(0x80) as usize;
    String::from_utf8_lossy(std::slice::from_raw_parts((n + 0x20) as *const u8, len)).into_owned()
}
fn fx(v: f64) -> i64 { (v * 4294967296.0).round() as i64 }
fn unfx(v: i64) -> f64 { v as f64 / 4294967296.0 }

unsafe fn executar(r: usize, ad: &Addrs, p: Pedido) -> String {
    match p {
        Pedido::Listar => {
            let itens: Vec<String> = nos(r).into_iter().map(|n| {
                let x = unfx(*(n as *const i64)); let z = unfx(*((n + 0x10) as *const i64));
                format!("{{\"indice\":{},\"x\":{:.3},\"z\":{:.3},\"icone\":{},\"cor\":{},\"nome\":{}}}",
                    rd32(n + 0xa8), x, z, *((n + 0x18) as *const u8), rd32(n + 0x1c), json::esc(&nome_no(n)))
            }).collect();
            format!("{{\"ok\":true,\"versao\":{},\"marcadores\":[{}]}}", rd32(r + 0x38), itens.join(","))
        }
        Pedido::Criar { x, z, nome, icone, cor } => {
            let mut b = nome.as_bytes();
            if b.len() > 0x80 { let mut k = 0x80; while !nome.is_char_boundary(k) { k -= 1; } b = &b[..k]; }
            if b.is_empty() { return "{\"ok\":false,\"erro\":\"nome vazio\"}".into(); }
            let pos = [fx(x), 0i64, fx(z)];
            let sv = StrView { p: b.as_ptr(), len: b.len() as u64 };
            let mut out = [0u64; 2];
            let f: FnAdd = std::mem::transmute(ad.add);
            f(out.as_mut_ptr(), r, pos.as_ptr(), cor, icone, &sv);
            let code = out[0] as u8;
            if code != 0 { return format!("{{\"ok\":false,\"erro\":\"jogo recusou (codigo {code:#x}; 0x27 = sem espaco)\"}}"); }
            let ult = std::ptr::read_volatile((r + 0x88) as *const u64) as usize;
            let idx = if ult != 0 { rd32(ult + 0xa8) } else { u32::MAX };
            log(&format!("criado #{idx} '{}' em x {x:.1} z {z:.1}", String::from_utf8_lossy(b)));
            format!("{{\"ok\":true,\"indice\":{idx},\"versao\":{}}}", rd32(r + 0x38))
        }
        Pedido::Remover { indice, nome } => {
            let alvo = match (indice, nome) {
                (Some(i), _) => nos(r).into_iter().find(|&n| rd32(n + 0xa8) == i).map(|_| i),
                (None, Some(s)) => nos(r).into_iter().find(|&n| nome_no(n) == s).map(|n| rd32(n + 0xa8)),
                _ => None,
            };
            let Some(i) = alvo else { return "{\"ok\":false,\"erro\":\"marcador nao encontrado\"}".into() };
            let f: FnRem = std::mem::transmute(ad.rem);
            f(r, i);
            log(&format!("removido #{i}"));
            format!("{{\"ok\":true,\"indice\":{i},\"versao\":{}}}", rd32(r + 0x38))
        }
    }
}

// ---------- pipe ----------
fn enfileirar(p: Pedido) -> String {
    if !HOOK_ON.load(Ordering::SeqCst) { return "{\"ok\":false,\"erro\":\"hook desligado\"}".into(); }
    let resp: Resp = Arc::new((Mutex::new(None), Condvar::new()));
    FILA.lock().unwrap().push_back((p, resp.clone()));
    PENDENTE.store(true, Ordering::SeqCst);
    let (m, cv) = &*resp;
    let g = cv.wait_timeout_while(m.lock().unwrap(), Duration::from_secs(5), |v| v.is_none()).unwrap().0;
    match g.clone() {
        Some(s) => s,
        None => {
            // tira o pedido da fila para não rodar depois sem ninguém esperando
            FILA.lock().unwrap().retain(|(_, r)| !Arc::ptr_eq(r, &resp));
            "{\"ok\":false,\"erro\":\"timeout: o jogo nao processou em 5 s (tela de carregamento? registro indisponivel?)\"}".into()
        }
    }
}

fn tratar(linha: &str) -> String {
    let o = match json::parse_obj(linha) { Ok(o) => o, Err(e) => return format!("{{\"ok\":false,\"erro\":{}}}", json::esc(&e)) };
    let s = |k: &str| o.get(k).and_then(|v| v.as_str().map(str::to_owned));
    let n = |k: &str| o.get(k).and_then(|v| v.as_f64());
    match s("acao").as_deref() {
        Some("status") => {
            let a = ADDRS.get();
            format!("{{\"ok\":true,\"hook\":{},\"quadros\":{},\"registro\":\"{:#x}\",\"base\":\"{:#x}\"}}",
                HOOK_ON.load(Ordering::SeqCst), TICKS.load(Ordering::Relaxed), ULTIMO_REG.load(Ordering::Relaxed), a.map_or(0, |a| a.base))
        }
        Some("listar") => enfileirar(Pedido::Listar),
        Some("criar") => {
            let (Some(x), Some(z), Some(nome)) = (n("x"), n("z"), s("nome")) else { return "{\"ok\":false,\"erro\":\"criar precisa de x, z, nome\"}".into() };
            if !(x.is_finite() && z.is_finite() && (-1.0e6..1.0e6).contains(&x) && (-1.0e6..1.0e6).contains(&z)) {
                return "{\"ok\":false,\"erro\":\"coordenada invalida\"}".into();
            }
            let icone = n("icone").unwrap_or(6.0) as u8;
            let cor = n("cor").unwrap_or(0x0e6558ff as f64) as u32;
            enfileirar(Pedido::Criar { x, z, nome, icone, cor })
        }
        Some("remover") => enfileirar(Pedido::Remover { indice: n("indice").map(|v| v as u32), nome: s("nome") }),
        Some("desligar") => match unsafe { desinstalar() } { Ok(()) => "{\"ok\":true}".into(), Err(e) => format!("{{\"ok\":false,\"erro\":{}}}", json::esc(&e)) },
        _ => "{\"ok\":false,\"erro\":\"acao desconhecida (status|listar|criar|remover|desligar)\"}".into(),
    }
}

fn servir_pipe() {
    let nome: Vec<u16> = PIPE.encode_utf16().chain([0]).collect();
    loop {
        let h = unsafe { CreateNamedPipeW(nome.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, std::ptr::null_mut()) };
        if h == INVALID_HANDLE { log("ERRO CreateNamedPipeW"); std::thread::sleep(Duration::from_secs(5)); continue; }
        let ok = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) != 0 || GetLastError() == ERROR_PIPE_CONNECTED };
        if ok {
            let mut buf = vec![];
            let mut tmp = [0u8; 4096];
            loop {
                let mut lidos = 0u32;
                if unsafe { ReadFile(h, tmp.as_mut_ptr() as *mut c_void, tmp.len() as u32, &mut lidos, std::ptr::null_mut()) } == 0 || lidos == 0 { break; }
                buf.extend_from_slice(&tmp[..lidos as usize]);
                if buf.contains(&b'\n') || buf.len() > 65536 { break; }
            }
            let linha = String::from_utf8_lossy(&buf).lines().next().unwrap_or("").to_string();
            let resp = std::panic::catch_unwind(|| tratar(&linha)).unwrap_or_else(|_| "{\"ok\":false,\"erro\":\"panic\"}".into()) + "\n";
            let mut esc = 0u32;
            unsafe {
                WriteFile(h, resp.as_ptr() as *const c_void, resp.len() as u32, &mut esc, std::ptr::null_mut());
                FlushFileBuffers(h);
            }
        }
        unsafe { DisconnectNamedPipe(h); CloseHandle(h); }
    }
}

fn iniciar() -> Result<(), String> {
    log("carregada");
    let a = achar()?;
    let a = ADDRS.get_or_init(|| a);
    unsafe { instalar(a)? };
    servir_pipe();
    Ok(())
}
