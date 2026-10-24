// Carrega a DLL dos pins (injector/marcador, embutida neste exe) no enshrouded.exe.
// A DLL é gravada em %TEMP% com o hash do conteúdo no nome (o Windows só carrega DLL de arquivo; versão nova = arquivo
// novo, e o arquivo em uso pelo jogo nunca é sobrescrito) e carregada com LoadLibraryW via CreateRemoteThread.
use std::ffi::c_void;

static DLL: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../injector/target/release/embervale_marcador.dll"));
const NOME_DLL: &str = "embervale_marcador";

#[repr(C)]
struct ME32 { size: u32, module_id: u32, pid: u32, g: u32, p: u32, base: *mut u8, base_size: u32, hmod: *mut c_void, name: [u16; 256], path: [u16; 260] }

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(f: u32, pid: u32) -> isize;
    fn Module32FirstW(h: isize, e: *mut ME32) -> i32;
    fn Module32NextW(h: isize, e: *mut ME32) -> i32;
    fn OpenProcess(acc: u32, inh: i32, pid: u32) -> isize;
    fn VirtualAllocEx(h: isize, a: *mut c_void, s: usize, t: u32, p: u32) -> *mut c_void;
    fn VirtualFreeEx(h: isize, a: *mut c_void, s: usize, t: u32) -> i32;
    fn WriteProcessMemory(h: isize, a: *mut c_void, b: *const c_void, s: usize, w: *mut usize) -> i32;
    fn GetModuleHandleW(n: *const u16) -> *mut c_void;
    fn GetProcAddress(m: *mut c_void, n: *const u8) -> *mut c_void;
    fn CreateRemoteThread(h: isize, sa: *mut c_void, st: usize, f: *mut c_void, p: *mut c_void, fl: u32, tid: *mut u32) -> isize;
    fn WaitForSingleObject(h: isize, ms: u32) -> u32;
    fn GetExitCodeThread(h: isize, c: *mut u32) -> i32;
    fn CloseHandle(h: isize) -> i32;
    fn GetLastError() -> u32;
}

fn w(s: &str) -> Vec<u16> { s.encode_utf16().chain([0]).collect() }
fn de_w(s: &[u16]) -> String { String::from_utf16_lossy(&s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())]) }

fn ja_carregada(pid: u32) -> bool {
    unsafe {
        let h = CreateToolhelp32Snapshot(0x8 | 0x10, pid);
        if h == -1 { return false; }
        let mut e: ME32 = std::mem::zeroed();
        e.size = std::mem::size_of::<ME32>() as u32;
        let mut r = false;
        if Module32FirstW(h, &mut e) != 0 {
            loop {
                if de_w(&e.name).to_lowercase().starts_with(NOME_DLL) { r = true; break; }
                if Module32NextW(h, &mut e) == 0 { break; }
            }
        }
        CloseHandle(h);
        r
    }
}

/// carrega a DLL no jogo (nada a fazer se já estiver carregada)
pub fn injetar() -> Result<(), String> {
    let pid = crate::tracker::find_pid().ok_or("enshrouded.exe não está aberto")?;
    if ja_carregada(pid) { return Ok(()); }
    let hash = DLL.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3)); // FNV-1a 64
    let copia = std::env::temp_dir().join(format!("{NOME_DLL}_{hash:016x}.dll"));
    if std::fs::metadata(&copia).map_or(true, |m| m.len() != DLL.len() as u64) {
        std::fs::write(&copia, DLL).map_err(|e| format!("gravar DLL: {e}"))?;
    }
    let caminho = w(&copia.to_string_lossy());
    unsafe {
        let h = OpenProcess(0x2 | 0x8 | 0x10 | 0x20 | 0x400, 0, pid); // CREATE_THREAD|VM_OPERATION|VM_READ|VM_WRITE|QUERY_INFORMATION
        if h == 0 { return Err(format!("OpenProcess falhou ({})", GetLastError())); }
        let n = caminho.len() * 2;
        let mem = VirtualAllocEx(h, std::ptr::null_mut(), n, 0x3000, 0x04);
        if mem.is_null() { CloseHandle(h); return Err("VirtualAllocEx falhou".into()); }
        let mut esc = 0usize;
        if WriteProcessMemory(h, mem, caminho.as_ptr() as *const c_void, n, &mut esc) == 0 {
            VirtualFreeEx(h, mem, 0, 0x8000); CloseHandle(h); return Err("WriteProcessMemory falhou".into());
        }
        let k32 = GetModuleHandleW(w("kernel32.dll").as_ptr());
        let llw = GetProcAddress(k32, b"LoadLibraryW\0".as_ptr());
        let th = CreateRemoteThread(h, std::ptr::null_mut(), 0, llw, mem, 0, std::ptr::null_mut());
        if th == 0 { VirtualFreeEx(h, mem, 0, 0x8000); CloseHandle(h); return Err(format!("CreateRemoteThread falhou ({})", GetLastError())); }
        WaitForSingleObject(th, 15000);
        let mut code = 0u32;
        GetExitCodeThread(th, &mut code);
        CloseHandle(th);
        VirtualFreeEx(h, mem, 0, 0x8000);
        CloseHandle(h);
        if code == 0 { return Err("LoadLibraryW devolveu NULL no jogo".into()); }
    }
    Ok(())
}
