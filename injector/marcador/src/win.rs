//! Declarações Win32 mínimas (sem dependências externas).
#![allow(non_snake_case, clippy::upper_case_acronyms)]
use std::ffi::c_void;

pub const MEM_FREE: u32 = 0x10000;
pub const MEM_COMMIT: u32 = 0x1000;
pub const MEM_RESERVE: u32 = 0x2000;
pub const PAGE_EXECUTE_READWRITE: u32 = 0x40;
pub const TH32CS_SNAPTHREAD: u32 = 0x4;
pub const THREAD_SUSPEND_RESUME: u32 = 0x2;
pub const THREAD_GET_CONTEXT: u32 = 0x8;
pub const INVALID_HANDLE: isize = -1;
pub const PIPE_ACCESS_DUPLEX: u32 = 3;
pub const PIPE_REJECT_REMOTE_CLIENTS: u32 = 8;
pub const ERROR_PIPE_CONNECTED: u32 = 535;

#[repr(C)]
pub struct MBI { pub base: usize, pub alloc_base: usize, pub alloc_protect: u32, pub partition: u16, pub region: usize, pub state: u32, pub protect: u32, pub typ: u32 }
#[repr(C)]
pub struct THREADENTRY32 { pub size: u32, pub usage: u32, pub tid: u32, pub owner_pid: u32, pub base_pri: i32, pub delta_pri: i32, pub flags: u32 }

/// CONTEXT x64 (0x4d0 bytes, alinhado em 16); só usamos ContextFlags (+0x30) e Rip (+0xf8).
#[repr(C, align(16))]
pub struct Ctx([u8; 0x4d0]);
impl Ctx {
    pub fn new() -> Self { let mut c = Ctx([0; 0x4d0]); c.0[0x30..0x34].copy_from_slice(&0x0010_0001u32.to_le_bytes()); c } // CONTEXT_CONTROL
    pub fn ptr(&mut self) -> *mut c_void { self.0.as_mut_ptr() as *mut c_void }
    pub fn rip(&self) -> usize { u64::from_le_bytes(self.0[0xf8..0x100].try_into().unwrap()) as usize }
}

#[link(name = "kernel32")]
extern "system" {
    pub fn GetModuleHandleW(n: *const u16) -> *mut c_void;
    pub fn VirtualQuery(a: *const c_void, b: *mut MBI, l: usize) -> usize;
    pub fn VirtualAlloc(a: *mut c_void, s: usize, t: u32, p: u32) -> *mut c_void;
    pub fn VirtualProtect(a: *mut c_void, s: usize, p: u32, old: *mut u32) -> i32;
    pub fn FlushInstructionCache(h: isize, a: *const c_void, s: usize) -> i32;
    pub fn GetCurrentProcess() -> isize;
    pub fn GetCurrentProcessId() -> u32;
    pub fn GetCurrentThreadId() -> u32;
    pub fn CreateToolhelp32Snapshot(f: u32, pid: u32) -> isize;
    pub fn Thread32First(h: isize, te: *mut THREADENTRY32) -> i32;
    pub fn Thread32Next(h: isize, te: *mut THREADENTRY32) -> i32;
    pub fn OpenThread(acc: u32, inh: i32, tid: u32) -> isize;
    pub fn SuspendThread(h: isize) -> u32;
    pub fn ResumeThread(h: isize) -> u32;
    pub fn GetThreadContext(h: isize, c: *mut c_void) -> i32;
    pub fn CloseHandle(h: isize) -> i32;
    pub fn GetLastError() -> u32;
    pub fn CreateNamedPipeW(n: *const u16, open: u32, mode: u32, max: u32, outb: u32, inb: u32, to: u32, sa: *mut c_void) -> isize;
    pub fn ConnectNamedPipe(h: isize, ov: *mut c_void) -> i32;
    pub fn DisconnectNamedPipe(h: isize) -> i32;
    pub fn ReadFile(h: isize, b: *mut c_void, n: u32, lidos: *mut u32, ov: *mut c_void) -> i32;
    pub fn WriteFile(h: isize, b: *const c_void, n: u32, esc: *mut u32, ov: *mut c_void) -> i32;
    pub fn FlushFileBuffers(h: isize) -> i32;
}
