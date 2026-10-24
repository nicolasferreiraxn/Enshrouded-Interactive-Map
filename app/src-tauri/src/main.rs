// Mapa de Embervale: mapa do jogo (tiles gerados do shader do próprio jogo) com a posição
// do jogador lida da memória do enshrouded.exe e a névoa de guerra lida do save do personagem.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod injetor;
mod item_ids;
mod live;
mod terreno;
mod tracker;

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;
use tauri::Emitter;

fn saves() -> Vec<PathBuf> {
    let mut out = vec![];
    for root in ["C:/Program Files (x86)/Steam/userdata", "C:/Program Files/Steam/userdata"] {
        let Ok(users) = fs::read_dir(root) else { continue };
        for u in users.flatten() {
            let dir = u.path().join("1203620").join("remote");
            let Ok(files) = fs::read_dir(&dir) else { continue };
            for f in files.flatten() {
                let n = f.file_name().to_string_lossy().to_string();
                if n.starts_with("character") && n.ends_with(".ksd") {
                    out.push(f.path());
                }
            }
        }
    }
    out
}

fn modified(p: &PathBuf) -> u64 {
    fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn u32le(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

// Lê um bloco do container SV2C (ver EnshroudedSaveEditor/electron/core/sv2c.cjs).
fn block(data: &[u8], want: &str) -> Option<Vec<u8>> {
    if data.len() < 0x30 || &data[..4] != b"SV2C" {
        return None;
    }
    let dir = u32le(data, 0x28) as usize + 40;
    let count = u32le(data, 0x2c) as usize;
    for i in 0..count {
        let e = dir + 20 * i;
        let (nrel, nlen) = (u32le(data, e) as usize, u32le(data, e + 4) as usize);
        let (off, size) = (u32le(data, e + 8) as usize, u32le(data, e + 12) as usize);
        let name = std::str::from_utf8(data.get(e + nrel..e + nrel + nlen)?).ok()?;
        if name != want {
            continue;
        }
        let raw = data.get(off..off + size)?;
        let body = &raw[14..];
        return if raw[9] == 1 { zstd::stream::decode_all(body).ok() } else { Some(body.to_vec()) };
    }
    None
}

fn character_name(data: &[u8]) -> String {
    let Some(cd) = block(data, "character_data") else { return String::new() };
    // primeiro texto legível do bloco é o nome do personagem
    let mut best = String::new();
    let mut curr = String::new();
    for &b in &cd {
        if (b as char).is_ascii_alphanumeric() || b == b' ' {
            curr.push(b as char);
        } else {
            if curr.trim().len() >= 3 {
                best = curr.trim().to_string();
                break;
            }
            curr.clear();
        }
    }
    best
}

#[derive(serde::Serialize)]
struct SaveInfo {
    path: String,
    name: String,
    modified: u64,
}

// Save do personagem que está sendo jogado = o modificado por último.
#[tauri::command]
fn relocate() {
    tracker::RESET.store(true, std::sync::atomic::Ordering::Relaxed);
}

// Pins no mapa do jogo: a DLL embervale_marcador.dll (embutida neste exe, ver injetor.rs), carregada
// no enshrouded.exe, atende pedidos JSON de uma linha no pipe abaixo e cria/remove os marcadores na thread do jogo.
const GAME_PIPE: &str = r"\\.\pipe\embervale-marcador";
fn game_pipe(req: &str) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut f = None;
    for _ in 0..10 {
        match fs::OpenOptions::new().read(true).write(true).open(GAME_PIPE) {
            Ok(x) => { f = Some(x); break; }
            Err(e) if e.raw_os_error() == Some(231) => std::thread::sleep(std::time::Duration::from_millis(50)), // ocupado
            Err(e) => return Err(format!("sem conexão com o jogo ({e})")),
        }
    }
    let mut f = f.ok_or("pipe ocupado")?;
    f.write_all(format!("{}
", req.trim()).as_bytes()).map_err(|e| e.to_string())?;
    let mut s = String::new();
    BufReader::new(f).read_line(&mut s).map_err(|e| e.to_string())?;
    Ok(s.trim().to_string())
}

#[tauri::command]
async fn game_pins(req: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || game_pipe(&req)).await.map_err(|e| e.to_string())?
}

// conecta: se a DLL já responde, nada a fazer; senão carrega a DLL no jogo e espera o pipe abrir
#[tauri::command]
async fn game_connect() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if let Ok(s) = game_pipe(r#"{"acao":"status"}"#) {
            return Ok(s);
        }
        injetor::injetar()?;
        let mut ult = String::new();
        for _ in 0..30 {
            match game_pipe(r#"{"acao":"status"}"#) {
                Ok(s) => return Ok(s),
                Err(e) => ult = e,
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err(ult)
    })
    .await
    .map_err(|e| e.to_string())?
}

// regrava meus-marcadores.json (para apagar pins do arquivo)
// estado dos depósitos de minério pela leitura do terreno (ver terreno.rs): [x, z, m³, altura, material] -> 0..3
#[tauri::command]
async fn ore_state(deps: Vec<[f32; 5]>) -> Vec<u8> {
    tauri::async_runtime::spawn_blocking(move || terreno::ore_state(&deps)).await.unwrap_or_default()
}

#[tauri::command]
fn save_my_pins(json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("sem pasta")?.join("meus-marcadores.json");
    fs::write(p, json).map_err(|e| e.to_string())
}

// Marcadores pessoais: meus-marcadores.json ao lado do executável (lista de {n, x, z, y?, d?, cor?}).
// Editado à mão e relido pelo app a cada 5 s.
#[tauri::command]
fn my_pins() -> String {
    let p = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("meus-marcadores.json")));
    p.and_then(|p| fs::read_to_string(p).ok()).unwrap_or_else(|| "[]".into())
}

#[tauri::command]
fn current_save() -> Option<SaveInfo> {
    let mut s = saves();
    s.sort_by_key(|p| std::cmp::Reverse(modified(p)));
    let p = s.into_iter().next()?;
    let data = fs::read(&p).ok()?;
    Some(SaveInfo { path: p.to_string_lossy().to_string(), name: character_name(&data), modified: modified(&p) })
}

// Máscara de áreas exploradas: 1280x1280 bytes (0 = nunca visto, 255 = explorado).
#[tauri::command]
fn fog_of_war(path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    if !p.file_name().map_or(false, |n| n.to_string_lossy().ends_with(".ksd")) {
        return Err("arquivo inválido".into());
    }
    let data = fs::read(&p).map_err(|e| e.to_string())?;
    let f = block(&data, "fogofwar").ok_or("save sem névoa de guerra")?;
    const N: usize = 1280 * 1280;
    if f.len() < N {
        return Err("névoa de guerra em formato desconhecido".into());
    }
    Ok(Response::new(f[f.len() - N..].to_vec()))
}

// Conhecimentos do personagem (bloco player_knowledge do save: u32, u32 n, n chaves, n valores): ids com valor >= 1.
// O app usa para saber quais histórias (notas) o jogador já leu.
#[tauri::command]
fn player_knowledge(path: String) -> Result<Vec<u32>, String> {
    let p = PathBuf::from(&path);
    if !p.file_name().map_or(false, |n| n.to_string_lossy().ends_with(".ksd")) {
        return Err("arquivo inválido".into());
    }
    let data = fs::read(&p).map_err(|e| e.to_string())?;
    let b = block(&data, "player_knowledge").ok_or("save sem conhecimentos")?;
    if b.len() < 8 {
        return Err("formato desconhecido".into());
    }
    let n = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
    if 8 + 8 * n > b.len() {
        return Err("formato desconhecido".into());
    }
    let rd = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    Ok((0..n).filter(|&k| rd(8 + 4 * n + 4 * k) >= 1).map(|k| rd(8 + 4 * k)).collect())
}

fn main() {
    // modo de teste: imprime as leituras do rastreador (redirecione a saída para um arquivo)
    // modo de teste do estado ao vivo: quantos objetos existem perto e o tempo de leitura
    // uma leitura em JSON (para testes do frontend)
    if std::env::args().any(|a| a == "--live-json") {
        live::run(|s| {
            if s.status == "ok" {
                println!("{}", serde_json::to_string(s).unwrap_or_default());
                std::process::exit(0);
            }
        });
        return;
    }
    // modo de teste do minério: --ore ARQUIVO.json MATERIAL -> estado de cada depósito mexido (0 intocado fica de fora)
    let a: Vec<String> = std::env::args().collect();
    if a.len() >= 4 && a[1] == "--ore" {
        let deps: Vec<Vec<f32>> = serde_json::from_str(&fs::read_to_string(&a[2]).unwrap_or_default()).unwrap_or_default();
        let mat: f32 = a[3].parse().unwrap_or(0.0);
        let q: Vec<[f32; 5]> = deps.iter().map(|d| [d[0], d[1], d[2], d[5], mat]).collect();
        let t0 = std::time::Instant::now();
        let _ = terreno::ore_state(&q[..1.min(q.len())]);
        let t1 = t0.elapsed();
        let st = terreno::ore_state(&q);
        println!("achar {:?}, {} depósitos em {:?}", t1, q.len(), t0.elapsed() - t1);
        for (d, s) in q.iter().zip(&st) {
            if *s != 0 { println!("{} {} alt {} -> {}", d[0], d[1], d[3], ["intocado", "tem minério", "esgotado", "sem dados"][*s as usize]); }
        }
        return;
    }
    // modo de teste dos amigos: posição a 10 Hz
    if std::env::args().any(|a| a == "--players") {
        let t0 = std::time::Instant::now();
        live::run(|s| {
            let pl: Vec<String> = s.players.iter().map(|p| format!("{} ({:.1}, {:.1}, {:.1})", p.name, p.x, p.y, p.z)).collect();
            println!("{:.2}s {} [{}]", t0.elapsed().as_secs_f32(), s.status, pl.join(", "));
        });
        return;
    }
    if std::env::args().any(|a| a == "--live") {
        live::run(|s| {
            if s.status == "jogadores" {
                return;
            }
            let used = s.pts.chunks(4).filter(|p| p[3] == 1.0).count();
            let full = s.pts.chunks(4).filter(|p| p[3] == 2.0).count();
            let loot = s.loot.len();
            let on = s.pts.chunks(4).filter(|p| p[3] == 5.0).count();
            let destr = s.pts.chunks(4).filter(|p| p[3] == 6.0).count();
            let pl: Vec<String> = s.players.iter().map(|p| format!("{} ({:.0}, {:.0}, {:.0})", p.name, p.x, p.y, p.z)).collect();
            println!("{} x={:.1} z={:.1} chunks={} vivos={} baus_vazios={} baus_com_itens={} saques_soltos={} acionados={} destrancados={} criaturas={} jogadores=[{}] {}ms", s.status, s.x, s.z, s.chunks, s.pts.len() / 4, used, full, loot, on, destr, s.mobs.len(), pl.join(", "), s.ms);
        });
        return;
    }
    if std::env::args().any(|a| a == "--track") {
        let t0 = std::time::Instant::now();
        tracker::run(|s| {
            println!("{:.1}s {} x={:.1} y={:.1} z={:.1} rumo={:.2} copias={} cand={}", t0.elapsed().as_secs_f32(), s.status, s.x, s.y, s.z, s.heading, s.copies, s.candidates);
        });
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                tracker::run(|s| {
                    let _ = handle.emit("player", s.clone());
                });
            });
            // estado ao vivo dos objetos perto (itens pegos, baús abertos), 1x por segundo
            let h3 = app.handle().clone();
            std::thread::spawn(move || {
                live::run(|s| {
                    let _ = h3.emit("live", s.clone());
                });
            });
            // F8 global (funciona com o jogo em foco): esconde o marcador mais perto do personagem
            let h2 = app.handle().clone();
            std::thread::spawn(move || {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_F8};
                let mut was = false;
                loop {
                    let down = unsafe { GetAsyncKeyState(VK_F8 as i32) } as u16 & 0x8000 != 0;
                    if down && !was {
                        let _ = h2.emit("dismiss", ());
                    }
                    was = down;
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![current_save, fog_of_war, relocate, my_pins, game_pins, game_connect, save_my_pins, player_knowledge, ore_state])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o mapa");
}
