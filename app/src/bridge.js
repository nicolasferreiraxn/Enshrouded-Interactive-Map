// Ponte com o backend Tauri. Fora do Tauri (navegador, testes) devolve dados vazios.
import { t } from './i18n.js';

const T = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export async function onPlayer(cb) {
  if (!T) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('player', (e) => cb(e.payload));
}

export async function currentSave() {
  if (!T) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('current_save');
}

export async function fogOfWar(path) {
  if (!T) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const buf = await invoke('fog_of_war', { path });
  return new Uint8Array(buf);
}

// marcadores pessoais (meus-marcadores.json ao lado do exe); fora do Tauri: ./meus-marcadores.json se existir
export async function myPins() {
  try {
    if (!T) { const r = await fetch('./meus-marcadores.json'); return r.ok ? await r.json() : []; }
    const { invoke } = await import('@tauri-apps/api/core');
    return JSON.parse(await invoke('my_pins'));
  } catch { return []; }
}

// pins no mapa do jogo (DLL no enshrouded.exe): conectar (injeta se preciso) e pedidos JSON (listar/criar/remover)
export async function gameConnect() {
  if (!T) throw new Error(t('pins.app_only'));
  const { invoke } = await import('@tauri-apps/api/core');
  return JSON.parse(await invoke('game_connect'));
}
export async function gameReq(obj) {
  if (!T) throw new Error(t('pins.app_only'));
  const { invoke } = await import('@tauri-apps/api/core');
  return JSON.parse(await invoke('game_pins', { req: JSON.stringify(obj) }));
}
export async function saveMyPins(list) {
  if (!T) return;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('save_my_pins', { json: JSON.stringify(list, null, 1) });
}

// ids de conhecimento do personagem (histórias lidas etc.), do save
export async function playerKnowledge(path) {
  if (!T || !path) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('player_knowledge', { path });
}

// estado dos depósitos de minério pela leitura do terreno: [[x, z, m³, altura, material]] -> 0 intocado,
// 1 tem minério, 2 esgotado, 3 sem dados (ver src-tauri/src/terreno.rs)
export async function oreState(deps) {
  if (!T || !deps.length) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('ore_state', { deps });
}

export async function relocate() {
  if (!T) return;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('relocate');
}

// F8 global (backend): pedido para esconder o marcador mais perto do personagem
export async function onDismiss(cb) {
  if (!T) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('dismiss', () => cb());
}

// estado ao vivo dos objetos perto (backend live.rs): { status, x, y, z, pts: [x, y, z, flag, ...] }
export async function onLive(cb) {
  if (!T) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('live', (e) => cb(e.payload));
}
