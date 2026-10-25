import { icSrc } from './match.js';
import { fmatch } from './match.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { onPlayer, onDismiss, onLive, currentSave, fogOfWar, relocate, myPins, gameConnect, gameReq, saveMyPins, playerKnowledge, oreState, relaunchAdmin } from './bridge.js';
import { loadNearby, bearing, dirName, heightText } from './nearby.js';
import { GameMapLayer } from './gamemap.js';
import Sidebar from './Sidebar.jsx';
import { t, tc, tn, tIn, fmtNum, getLang, useLang } from './i18n.js';

const WORLD = 10240; // metros; no zoom 5 cada pixel do mapa é 1 m
const NATIVE = 5;
const STORE = 'embervale.map.v2';

const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(STORE, JSON.stringify({ ...load(), ...s })); } catch {} };
const fmt = fmtNum;
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const m = (d) => (d >= 1000 ? t('unit.km', { n: (d / 1000).toLocaleString(getLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }) : t('unit.m', { n: Math.round(d) }));

function useData() {
  const [data, setData] = useState(null);
  useEffect(() => { fetch('./data.json').then((r) => r.json()).then(setData); }, []);
  return data;
}

function Arrow({ angle, size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" style={{ transform: `rotate(${angle}rad)` }}>
      <path d="M0 -11 L7 8 L0 4 L-7 8 Z" fill="currentColor" />
    </svg>
  );
}

// Estado ao vivo de um ponto do nearby.bin (posição exata do jogo): 'ok' = existe agora,
// 'aberto' = baú já saqueado (inventário vazio), 'pego' = não existe mais (o cliente carrega tudo até ~95 m), null = sem leitura.
const LIVE_LOADED = 85;
// saques de monstro e itens soltos: vêm só do estado ao vivo (evento live.loot), sem posição fixa
let LIVE_NAMES = {};
fetch('./live_names.json').then((r) => r.json()).then((j) => { LIVE_NAMES = j; }).catch(() => {});
let LIVE_TPL = []; // índice do template (live.rs "tpl") -> nome do template do jogo
let LIVE_TPL_NAMES = {}; // índice do template -> nome PT para variantes sem espécie própria (_Dungeon, _Patrol...; gerado por script interno, não publicado)
fetch('./live_tpl_names.json').then((r) => r.json()).then((j) => { LIVE_TPL_NAMES = j; }).catch(() => {});
// nome PT da criatura viva/corpo: espécie do leitor ou, sem ela, pelo template
const mobName = (m) => (m.creature != null && m.creature >= 0 ? LIVE_NAMES.creatures?.[m.creature] : null) || LIVE_TPL_NAMES[m.tpl] || null;
// sem nome nenhum: o nome técnico do template, legível, com "?" (melhor que "Criatura viva" sem pista)
const tplLabel = (m) => { const t = LIVE_TPL[m.tpl]; return t ? `${t.replace(/^(Base_)?(Enemy|Animal)_(Wildlife_|Wildbeast_)?/, '').replace(/_(T\d|AG2|hook\w*|Dungeon|Patrol)$/g, '').replace(/_/g, ' ')}?` : null; };
fetch('./live_templates.json').then((r) => r.json()).then((j) => { LIVE_TPL = Array.isArray(j) ? j : j.templates || []; }).catch(() => {});
// espécie provável do animal pelo conteúdo do corpo: criaturas que dropam TODOS os itens (drops.json)
let DROPS = null, MOBN = {};
fetch('./drops.json').then((r) => r.json()).then((j) => { DROPS = j; }).catch(() => {});
let MOBIMG = {}, LIVE_ICONS = {};
fetch('./find/index.json').then((r) => r.json()).then((j) => { for (const [s, e] of Object.entries(j.spawns || {})) { MOBN[s] = e.n; MOBIMG[e.n] = e.img; } }).catch(() => {});
fetch('./live_icons.json').then((r) => r.json()).then((j) => { LIVE_ICONS = j; }).catch(() => {});
const HUMANOID = /Sanguin|Vukah|Extinguid|Caíd|Drak|Ancião|Construto/i;
function species(names) {
  if (!DROPS || !names.length) return null;
  let cand = null;
  for (const n of names) {
    const by = new Set((DROPS.items[n]?.by || []).map((s) => MOBN[s]).filter((x) => x && !HUMANOID.test(x)));
    cand = cand ? new Set([...cand].filter((x) => by.has(x))) : by;
  }
  return cand && cand.size ? [...cand] : null;
}
function lootName(l, show = false) {
  const T = show ? t : (k, v) => tIn('pt-BR', k, v), N = show ? tn : (x) => x;
  const nm = (id) => (LIVE_NAMES[String(id)] ? N(LIVE_NAMES[String(id)]) : T('loot.item'));
  const items = (l.items || []).filter(([, q]) => q > 0);
  const list = items.map(([id, q]) => `${nm(id)}${q > 1 ? ' ×' + q : ''}`);
  if (l.kind === 4 && l.item) { // item solto: o próprio item, com a quantidade
    const it = items.find(([id]) => id === l.item) || (l.items || []).find(([id]) => id === l.item);
    const q = it?.[1];
    if (q === 0) return `${nm(l.item)}?`; // deduzido pelo material do objeto, quantidade desconhecida
    return q > 1 ? `${nm(l.item)} ×${q}` : nm(l.item);
  }
  if (mobName(l)) { // espécie lida direto da memória (ou pelo template, nas variantes _Dungeon etc.)
    const c = T('loot.dead', { name: N(mobName(l)) });
    return list.length ? T('loot.list', { who: c, list: list.join(', ') }) : c;
  }
  if (l.kind === 4 && !l.hp_max) { // sem vida máxima = não é bicho (isca lançada, armadilha, objeto)
    return list.length ? T('loot.list', { who: T('loot.ground'), list: list.join(', ') }) : T('loot.ground_object');
  }
  if (l.kind === 4) {
    const sp = species(items.map(([id]) => LIVE_NAMES[String(id)] || 'item')); // espécie pelos nomes PT (drops.json)
    const hp = l.hp_max ? ` ${T('loot.hp', { n: l.hp_max })}` : ''; // desempate quando o saque não basta
    const who = !sp ? `${T('loot.animal_dead')}${hp}` : sp.length === 1 ? T('loot.dead', { name: N(sp[0]) }) : sp.length <= 3 ? `${T('loot.dead_maybe', { name: sp.map(N).join('/') })}${hp}` : `${T('loot.animal_dead')}${hp}`;
    return list.length ? T('loot.list', { who, list: list.join(', ') }) : who;
  }
  return list.length ? T('loot.list', { who: T('loot.monster'), list: list.join(', ') }) : T('loot.monster');
}
// ícone real: item solto = ícone do item; corpo = ícone da criatura (se a espécie for única) ou do 1º item
function lootImg(l) {
  if (l.kind === 4 && l.item) return LIVE_ICONS[String(l.item)];
  const items = (l.items || []).filter(([, q]) => q > 0);
  let sp = null;
  if (mobName(l)) sp = [mobName(l)];
  else if (l.kind === 4) sp = species(items.map(([id]) => LIVE_NAMES[String(id)] || ''));
  if (sp && sp.length === 1 && MOBIMG[sp[0]]) return MOBIMG[sp[0]];
  return items.length ? LIVE_ICONS[String(items[0][0])] : undefined;
}
// criaturas vivas lidas da memória (evento live.mobs)
function liveMobs(ls, lv, r) {
  if (!ls.t || Date.now() - ls.t > 5000) return [];
  const out = [];
  for (const m of ls.mobs || []) {
    const d = Math.hypot(m.x - lv.tx, m.z - lv.tz);
    if (d > r) continue;
    // peixes não têm espécie nos dados do mapa: pelo nome do template (antes apareciam como "Criatura viva" perto dos mariscos)
    const nm = mobName(m);
    // nome sem a vida (a vida muda a cada segundo e recriava o ícone); a vida vai em hp/hpMax e o id segue a criatura
    out.push({ x: m.x, y: m.y, z: m.z, d, n: tIn('pt-BR', 'live.alive', { name: nm || tplLabel(m) || tIn('pt-BR', 'live.creature') }), sp: nm, tplL: tplLabel(m), hp: m.hp, hpMax: m.hp_max, mobId: m.id, kind: 'alive', img: nm ? MOBIMG[nm] : undefined, icon: '#e0533a', st: 'ok' });
  }
  return out;
}
// mesma criatura com nomes um pouco diferentes (ex.: barra de vida "Matrona dos Sanguinários" x ponto "Matrona Devoradora dos Sanguinários")
function sameCreature(a, b) {
  if (a === b) return true;
  const w = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !['dos', 'das', 'de', 'da', 'do'].includes(x));
  const A = w(a), B = new Set(w(b));
  return A.length > 0 && A.every((x) => B.has(x)) || [...B].every((x) => A.includes(x));
}
// ponto de surgimento: dentro da área carregada (~85 m) só vale se houver criatura viva a até 30 m
// spawns (opcional): os outros pontos de surgimento por perto; cada criatura viva só mantém o ponto da MESMA espécie
// mais perto dela (antes um caranguejo vivo do ponto vizinho mantinha os dois acesos)
function spawnState(ls, lv, it, spawns) {
  if (!ls.t || Date.now() - ls.t > 5000 || !ls.mobs) return null;
  if (it.boss) return null; // chefe: anda pela arena e o nome muda (barra de vida); nunca esconder o ponto dele
  if (Math.hypot(it.x - lv.tx, it.z - lv.tz) > 85) return null;
  for (const m of ls.mobs) {
    if (Math.hypot(m.x - it.x, m.z - it.z) > 30 || (it.y != null && Math.abs(m.y - it.y) > 30)) continue;
    const tn = LIVE_TPL[m.tpl] || '';
    if (/Fish|Critter_Ambient|Butterfly|Bird_Ambient/i.test(tn)) continue; // peixes e bichos de enfeite não são o ponto
    const nm = mobName(m);
    if (nm && it.n && !sameCreature(nm, it.n)) continue; // outra espécie viva ao lado não mantém o ponto
    if (nm && spawns) {
      const d0 = Math.hypot(m.x - it.x, m.z - it.z);
      if (spawns.some((o) => (o.x !== it.x || o.z !== it.z) && o.n && sameCreature(nm, o.n) && Math.hypot(m.x - o.x, m.z - o.z) < d0 - 0.5)) continue; // a criatura é de outro ponto
    }
    return 'ok';
  }
  return 'vazio';
}

// nome para MOSTRAR de um ponto do painel/alvo (o it.n continua PT: é a chave interna)
function label(it) {
  if (!it) return '';
  if (it.ui) return t(it.ui);
  if (it.loot) return lootName(it.loot, true);
  if (it.kind === 'alive') return t('live.alive', { name: it.sp ? tn(it.sp) : it.tplL || t('live.creature') });
  return showName(it.n);
}
// só o nome PT (lista de ocultos, F8): "X (vivo)" vira o modelo do idioma
function showName(n) {
  const suf = tIn('pt-BR', 'live.alive', { name: '' });
  if (typeof n === 'string' && n.endsWith(suf) && n.length > suf.length) return t('live.alive', { name: tn(n.slice(0, -suf.length)) });
  return tn(n);
}

function liveLoot(ls, lv, r) {
  if (!ls.t || Date.now() - ls.t > 5000) return [];
  const out = [];
  for (const l of ls.loot || []) {
    const d = Math.hypot(l.x - lv.tx, l.z - lv.tz);
    if (d > r) continue;
    const loose = l.kind === 4 && l.item;
    out.push({ x: l.x, y: l.y, z: l.z, d, n: lootName(l), loot: l, kind: loose ? 'loose' : 'loot', icon: '#ff9d4d', img: lootImg(l), st: 'ok' });
  }
  return out;
}

// material de voxel de cada minério (TerraformingEfficiencyRegistryResource; terreno lido em src-tauri/src/terreno.rs)
const ORE_MAT = {
  'archaic-essence-i': 68, 'archaic-essence-ii': 82, 'archaic-essence-iii': 83, 'archaic-essence-iv': 84,
  'archaic-essence-v': 85, 'archaic-essence-vi': 98, 'archaic-essence-vii': 116,
  'copper-ore': 26, 'tin-ore': 27, 'iron-ore': 29, 'silver-ore': 63, 'gold-ore': 89, 'celestium-ore': 115,
  'coal': 6, 'obsidian': 7, 'salt': 17, 'amber': 18, 'flintstone': 19, 'amethyst': 24, 'lump-of-clay': 25,
  'sulfur': 30, 'lapislazuli': 31, 'twigs': 35, 'fossilized-bone': 38, 'bones': 48, 'tar': 51,
  'red-marble-fragment': 60, 'aquamarine': 96, 'mother-of-pearl': 97, 'diamond': 113,
  'active-mycelium-terrain': 33, // terreno de Micélio Ativo (gerado por script interno, não publicado)
};

// memória do estado ao vivo: o que foi visto pego/aberto/acionado/vazio continua assim mesmo fora da área
// carregada (o jogo só carrega ~95 m), até ser visto de novo disponível — ou até expirar (respawn).
const STICKY_TTL = { esgotado: 7 * 24 * 3600e3, pego: 2 * 3600e3, aberto: 365 * 24 * 3600e3, acionado: 12 * 3600e3, vazio: 30 * 60e3, ausente: 30 * 24 * 3600e3 };
// Dupla verificação: marcadores que são OBJETOS (não lugares) são conferidos na memória quando estão na área
// carregada; sem nenhum objeto do jogo a até 3 m em 3 leituras seguidas = "ausente" (o ícone sai).
const OBJ_CATS = /^(unique|fossil|music-sheet|cyclops-skeleton|drak-relief|dragons-map|pikemead-statue|wall-hanging|tapestry|flame-mosaic|lore-.*|chest-.*|pearl-clam|shroud-root|elixir-well|puzzle|secret-door)$/;
// marcador-objeto na área carregada: existe algum objeto do jogo no ponto? (senão "ausente")
function verifyObj(ls, lv, it) {
  if (!OBJ_CATS.test(it.kind || '') || !ls.t || Date.now() - ls.t > 5000 || ls.n < 50 || Math.hypot(it.x - lv.tx, it.z - lv.tz) > 80) return null;
  return anyEntityNear(ls, it.x, it.z, it.y) ? 'ok' : 'ausente';
}
function anyEntityNear(ls, x, z, y, r = 3) {
  const kx = Math.round(x * 10), kz = Math.round(z * 10), R = Math.ceil(r * 10);
  for (let i = -R; i <= R; i += 1) for (let j = -R; j <= R; j += 1) {
    const a = ls.grid.get(`${kx + i},${kz + j}`);
    if (!a) continue;
    for (let k = 0; k < a.length; k += 4) if (Math.hypot(a[k] - x, a[k + 2] - z) <= r && (y == null || Math.abs(a[k + 1] - y) < 8)) return true;
  }
  return false;
} // baú do mundo não reabastece: aberto fica guardado
const STICKY = new Map(); // posição -> { st, t }
try { for (const [k, v] of JSON.parse(localStorage.getItem('embervale.sticky') || '[]')) STICKY.set(k, v); } catch {}
setInterval(() => { try { const now = Date.now(); localStorage.setItem('embervale.sticky', JSON.stringify([...STICKY].filter(([, v]) => now - v.t < STICKY_TTL[v.st]))); } catch {} }, 10000);
const stickyKey = (it) => `${Math.round(it.x * 10)},${Math.round(it.z * 10)}`;
function stickyState(it, st) {
  const k = stickyKey(it), now = Date.now(), s = STICKY.get(k);
  if (st === 'pego' || st === 'aberto' || st === 'acionado' || st === 'vazio' || st === 'ausente') { STICKY.set(k, { st, t: now }); return st; }
  if (s && now - s.t > STICKY_TTL[s.st]) { STICKY.delete(k); return st; } // expirou (pode ter renascido)
  if (st === 'ok') {
    if (s && now - s.t < 60000) return s.st; // uma leitura sem a marca logo depois não "ressuscita"
    STICKY.delete(k); return 'ok'; // visto disponível de novo, de verdade
  }
  return s ? s.st : st; // fora da área carregada: lembra o último estado conhecido
}
function stickyHidden(it) { const s = STICKY.get(stickyKey(it)); return !!s && Date.now() - s.t < STICKY_TTL[s.st]; }

// Menu de contexto do botão direito (mapa inteiro e qualquer ponto): popup com ações.
// items: [{ t: 'texto', fn }]; o mapa é passado por quem chama.
// sem o menu nativo do WebView2 (Voltar/Atualizar/Inspecionar) no botão direito: ele roubava os cliques seguintes
if (typeof document !== 'undefined') document.addEventListener('contextmenu', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
function ctxMenu(map, latlng, title, items) {
  const el = document.createElement('div');
  el.className = 'ctxmenu';
  if (title) { const h = document.createElement('b'); h.textContent = title; el.appendChild(h); }
  const pop = L.popup({ closeButton: false, className: 'ctxpop', offset: [0, -4], autoPan: false }).setLatLng(latlng).setContent(el);
  for (const it of items) {
    const bt = document.createElement('button');
    bt.textContent = it.t;
    bt.onclick = (ev) => { ev.stopPropagation(); map.closePopup(pop); it.fn(); };
    el.appendChild(bt);
  }
  pop.openOn(map);
}

// caixinha de renomear no mesmo estilo do menu: Enter confirma, Esc cancela
function renameBox(map, latlng, atual, ok) {
  const el = document.createElement('div');
  el.className = 'ctxmenu';
  const h = document.createElement('b'); h.textContent = t('ctx.rename_title'); el.appendChild(h);
  const inp = document.createElement('input');
  inp.className = 'renin'; inp.value = atual || ''; inp.maxLength = 128;
  el.appendChild(inp);
  const pop = L.popup({ closeButton: false, className: 'ctxpop', offset: [0, -4], autoPan: false }).setLatLng(latlng).setContent(el);
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { const v = inp.value.trim(); map.closePopup(pop); if (v && v !== atual) ok(v); }
    else if (ev.key === 'Escape') map.closePopup(pop);
  };
  L.DomEvent.disableClickPropagation(el);
  pop.openOn(map);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

function liveState(ls, it) {
  if (it.kind !== 'item' && it.kind !== 'chest' && it.kind !== 'logic' && it.kind !== 'res' && it.kind !== 'door') return null; // só pontos com posição exata do jogo
  if (!ls.t || Date.now() - ls.t > 5000 || ls.n < 50) return null;
  const kx = Math.round(it.x * 10), kz = Math.round(it.z * 10);
  let seen = false;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const a = ls.grid.get(`${kx + i},${kz + j}`);
    if (!a) continue;
    for (let k = 0; k < a.length; k += 4) {
      if (Math.abs(a[k] - it.x) < 0.03 && Math.abs(a[k + 2] - it.z) < 0.03 && (it.y == null || it.kind === 'chest' || Math.abs(a[k + 1] - it.y) < 0.05)) { // baú: o 'vazio' vem de subentidade com outra altura
        if (it.kind === 'chest' && a[k + 3] === 1) return 'aberto'; // baú com o inventário vazio (o baú e as subentidades têm a mesma posição)
        // baú sem "inventário vazio" na memória (23/10, X 3887 Z 7550): tampa aberta (ToggleState, 5) ou já usado por um
        // jogador (lastAcceptionId, 7) = aberto; um baú fechado do lado (X 3815 Z 7431) só tinha marcas 0
        if (it.kind === 'chest' && (a[k + 3] === 5 || a[k + 3] === 7)) return 'aberto';
        if (it.kind === 'logic' && a[k + 3] === 5) return 'acionado'; // botão/alavanca já apertado (ToggleState)
        if (a[k + 3] === 6) return 'aberto'; // porta/baú trancado já destrancado com gazua ou chave (fica assim)
        if (it.kind === 'door' && a[k + 3] === 7) return 'aberto'; // porta secreta já usada por um jogador
        seen = true;
      }
    }
  }
  if (seen) return 'ok';
  if (it.kind === 'door') return null;
  return Math.hypot(it.x - ls.x, it.z - ls.z) < LIVE_LOADED ? 'pego' : null;
}

export default function App() {
  const langV = useLang(); // re-renderiza tudo ao trocar de idioma
  const data = useData();
  const saved = useMemo(load, []);
  const [visible, setVisible] = useState(saved.visible || null);
  const [names, setNames] = useState(saved.names ?? true);
  const [fog, setFog] = useState(saved.fog ?? false);
  const [follow, setFollow] = useState(saved.follow ?? true);
  const [activities, setActivities] = useState(saved.activities ?? false);
  const [radius, setRadius] = useState(saved.radius ?? 100);
  const [dungeon, setDungeon] = useState(saved.dungeon ?? false);
  const [dungeonH, setDungeonH] = useState(saved.dungeonH ?? 50);
  const [hiddenNear, setHiddenNear] = useState(saved.hiddenNear ?? []);
  // estado ao vivo (memória do jogo): esconde o que já foi pego / baú já aberto
  const [hideTaken, setHideTaken] = useState(saved.hideTaken ?? true);
  const hideTakenRef = useRef(hideTaken); hideTakenRef.current = hideTaken;
  const liveSt = useRef({ t: 0, x: 0, z: 0, n: 0, grid: new Map() });
  // F8: pontos escondidos temporariamente (voltam após 30 min ou quando você se afasta 300 m)
  const [dismissed, setDismissed] = useState(saved.dismissed ?? []);
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;
  const [toast, setToast] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [hidQ, setHidQ] = useState(''); // busca dentro da lista de ocultos
  // ocultar por nome (olho), guardando o ícone para a lista de ocultos
  const [hiddenMeta, setHiddenMeta] = useState(saved.hiddenMeta ?? {});
  const toggleHidden = (n, it) => {
    if (it) setHiddenMeta((m) => ({ ...m, [n]: { img: it.img, icon: it.icon, kind: it.kind } }));
    setHiddenNear((h) => (h.includes(n) ? h.filter((x) => x !== n) : [...h, n]));
  };
  // filtros do painel: tipos desligados e busca
  const [nearOff, setNearOff] = useState(saved.nearOff2 ?? ['res']); // recursos (árvores etc.) vêm desligados
  const [nearQ, setNearQ] = useState('');
  const [tab, setTab] = useState('markers');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(saved.open || { Locais: true });
  const [collapsed, setCollapsed] = useState(false);
  const [player, setPlayer] = useState({ status: 'fechado' });
  const [character, setCharacter] = useState(null);
  const [target, setTarget] = useState(saved.target || null);
  const targetRef = useRef(null); // alvo atual (para o evento ao vivo seguir a criatura)
  targetRef.current = target;
  const [nearby, setNearby] = useState([]);
  const [hideFound, setHideFound] = useState(saved.hideFound ?? false);
  const [found, setFound] = useState(() => new Set(saved.found || []));
  const [finders, setFinders] = useState(saved.finders || []);
  const [findIndex, setFindIndex] = useState(null);
  const [surfaceOnly, setSurfaceOnly] = useState(saved.surfaceOnly ?? false);
  const findCache = useRef({});
  const visibleRef = useRef(null), findersRef = useRef([]), nearbyRef = useRef([]);
  visibleRef.current = visible; findersRef.current = finders; nearbyRef.current = nearby;
  const [labelCounts, setLabelCounts] = useState(null);
  const markerRefs = useRef({});
  const findLayer = useRef(null);
  const mapRef = useRef(null);
  const gameLayer = useRef(null);
  const [spacing, setSpacing] = useState(saved.spacing ?? 8);
  const [flame, setFlame] = useState(saved.flame ?? 5);
  const layers = useRef({});
  const friendMk = useRef(new Map()); // amigos no mapa: nome -> marcador
  const pinAct = useRef({});
  const readKRef = useRef(new Set()); // histórias lidas (save), para as dicas // ações de pin para o menu do botão direito (addPin etc.), sempre as atuais
  const playerMarker = useRef(null);
  const fogLayer = useRef(null);
  const labelLayer = useRef(null);
  const placeMks = useRef([]); // [marcador, lugar] dos nomes de lugares
  const navLine = useRef(null);
  // UM canvas para todos os ícones clicáveis (categorias + Meu filtro) e um painel que ignora o mouse para a rota e o
  // raio: cada L.canvas novo ficava por cima dos outros e engolia a dica/clique dos ícones de baixo
  const iconCanvas = useRef(null), decor = useRef(null);
  const nearMks = useRef(new Map()); // marcadores do painel ao vivo, por chave (atualizados no lugar)
  const ringRef = useRef(null);
  const nearLayer = useRef(null);
  const findH = useRef([]);
  const oreMk = useRef([]); // depósitos de minério do "Meu filtro", conferidos na leitura do terreno
  const findHLayer = useRef(null);
  // nível dos baús (zona da Chama): filtro de/até, vale para os baús dos marcadores e do Meu filtro
  const [chestLv, setChestLv] = useState(() => { try { return JSON.parse(localStorage.getItem('embervale.chestLv') || '[5,50]'); } catch { return [5, 50]; } });
  useEffect(() => { try { localStorage.setItem('embervale.chestLv', JSON.stringify(chestLv)); } catch {} }, [chestLv]);
  const lvOut = (lv) => lv != null && (lv < chestLv[0] || lv > chestLv[1]);
  // altura ao lado de todos os ícones visíveis (opção), não só dos 8 mais próximos
  const [allH, setAllH] = useState(() => { try { return localStorage.getItem('embervale.allH') === '1'; } catch { return false; } });
  const allHRef = useRef(false); allHRef.current = allH;
  useEffect(() => { try { localStorage.setItem('embervale.allH', allH ? '1' : '0'); } catch {} }, [allH]);
  const nearIdx = useRef(null);
  const live = useRef({ have: false, tx: 0, tz: 0, ty: 0, th: 0, x: 0, z: 0, h: 0 });
  const followRef = useRef(follow); followRef.current = follow;
  const fogRef = useRef(fog); fogRef.current = fog;

  useEffect(() => { if (data && !visible) setVisible(Object.fromEntries(data.cats.map((c) => [c.id, c.on]))); }, [data]);
  useEffect(() => { save({ visible, names, fog, follow, open, activities, radius, dungeon, dungeonH, hiddenNear, hiddenMeta, nearOff2: nearOff, hideTaken, dismissed, target, spacing, flame, hideFound, found: [...found], finders, surfaceOnly }); }, [visible, names, fog, follow, open, activities, radius, dungeon, dungeonH, hiddenNear, hiddenMeta, nearOff, hideTaken, dismissed, target, spacing, flame, hideFound, found, finders, surfaceOnly]);
  useEffect(() => { fetch('./find/index.json').then((r) => r.json()).then(setFindIndex); }, []);
  useEffect(() => { gameLayer.current?.setOptions({ isolineSpacing: spacing, playerFogLevel: flame }); }, [spacing, flame]);

  const toLL = (x, z) => mapRef.current.unproject([x, WORLD - z], NATIVE);
  const fromLL = (ll) => { const p = mapRef.current.project(ll, NATIVE); return { x: p.x, z: WORLD - p.y }; };

  // mapa
  useEffect(() => {
    const map = L.map('map', {
      crs: L.CRS.Simple, minZoom: 1, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
      zoomControl: false, attributionControl: false, preferCanvas: true, maxBoundsViscosity: 0.8, zoomAnimation: false, fadeAnimation: false, maxZoom: 9,
    });
    mapRef.current = map;
    const bounds = L.latLngBounds(map.unproject([0, WORLD], NATIVE), map.unproject([WORLD, 0], NATIVE));
    // mapa desenhado com o shader do próprio jogo; os tiles ficam de reserva se não houver WebGL2
    const probe = document.createElement('canvas').getContext('webgl2');
    if (probe) { gameLayer.current = new GameMapLayer({ isolineSpacing: saved.spacing ?? 8, playerFogLevel: saved.flame ?? 5 }).addTo(map); }
    else L.tileLayer('./tiles/{z}/{x}_{y}.webp', { tileSize: 256, minNativeZoom: 0, maxNativeZoom: NATIVE, noWrap: true, bounds, keepBuffer: 6 }).addTo(map);
    map.setMaxBounds(bounds.pad(0.15));
    const v = saved.view;
    const hm = /^#(\d+),(\d+),([\d.]+)$/.exec(location.hash); // #x,z,zoom
    if (hm) map.setView(map.unproject([+hm[1], WORLD - +hm[2]], NATIVE), +hm[3]);
    else if (v) map.setView([v.lat, v.lng], v.zoom); else map.fitBounds(bounds);
    map.createPane('decor'); map.getPane('decor').style.zIndex = 450; map.getPane('decor').style.pointerEvents = 'none';
    decor.current = L.svg({ pane: 'decor' });
    iconCanvas.current = L.canvas({ padding: 0.3 });
    map.on('moveend', () => { const c = map.getCenter(); save({ view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() } }); });
    map.on('dragstart', () => setFollow(false));
    map.on('contextmenu', (e) => {
      const p = fromLL(e.latlng);
      ctxMenu(map, e.latlng, `X ${Math.round(p.x)} · Z ${Math.round(p.z)}`, [
        { t: t('ctx.pin_here'), fn: () => pinAct.current.add?.(p.x, p.z, null) },
        { t: t('ctx.route_here'), fn: () => setTarget({ n: tIn('pt-BR', 'target.marked_point'), ui: 'target.marked_point', x: p.x, z: p.z, y: null }) },
      ]);
    });
    const onZoom = () => {
      const z = map.getZoom();
      document.documentElement.style.setProperty('--icon', `${Math.round(Math.max(18, Math.min(40, 14 + z * 4.2)))}px`);
      const el = document.getElementById('map');
      el.dataset.zoom = Math.floor(z);
      // limites de zoom do mapa
      el.dataset.ltier = z >= 5.08 ? 3 : z >= 4.28 ? 2 : z >= 3.28 ? 1 : 0;
    };
    map.on('zoomend', onZoom); onZoom();
    // jogador: interpola entre as leituras (20/s) para andar liso a 60 quadros
    let raf;
    const frame = () => {
      const s = live.current;
      if (s.have && playerMarker.current) {
        const k = 0.5;
        s.x += (s.tx - s.x) * k; s.z += (s.tz - s.z) * k;
        let dh = s.th - s.h; s.h += dh * 0.6;
        const ll = toLL(s.x, s.z);
        playerMarker.current.setLatLng(ll);
        const img = playerMarker.current.getElement()?.querySelector('img');
        if (img) img.style.transform = `rotate(${s.h - Math.PI / 2}rad)`; // a textura do jogo aponta para a direita (leste)
        if (followRef.current && !map._animatingZoom) map.panTo(ll, { animate: false, noMoveStart: true });
        if (navLine.current) navLine.current.setLatLngs([ll, navLine.current.getLatLngs()[1]]);
        if (ringRef.current) ringRef.current.setLatLng(ll);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); map.remove(); };
  }, []);

  // camadas de marcadores
  useEffect(() => {
    if (!data || !mapRef.current) return;
    const renderer = iconCanvas.current;
    for (const c of data.cats) {
      const g = L.layerGroup();
      for (let pi = 0; pi < data.points.length; pi++) {
        const p = data.points[pi];
        if (p.c !== c.id) continue;
        const src = p.img ? `./${p.img}` : !c.icon.startsWith('#') ? icSrc(c.icon) : null;
        const mk = !src
          ? L.circleMarker(toLL(p.x, p.z), { renderer, radius: 4.5, color: '#120f0c', weight: 1.2, fillColor: c.icon, fillOpacity: 0.95 })
          : L.marker(toLL(p.x, p.z), { icon: L.divIcon({ className: `mk ${p.img ? 'item' : ''}`, html: `<img src="${src}" draggable="false">`, iconSize: null }), riseOnHover: true });
        const chest = c.id.startsWith('chest'), lore = c.id.startsWith('lore');
        mk.bindTooltip(() => {
          const lv = live.current;
          const h = (chest || lore) && p.y != null && lv.have ? hText(p.y - lv.ty) : ''; // baús e histórias: altura exata do jogo
          const lida = p.k ? (readKRef.current.has(p.k) ? `<span>${t('tip.read')}</span>` : `<span>${t('tip.unread')}</span>`) : '';
          return `<b>${tn(p.n)}</b><span>${tn(c.label)}${p.lv ? ` · ${t('tip.level', { n: p.lv })}` : ''}${p.d ? ' · ' + tn(p.d) : ''}</span>${lida}${h}<em>${t('tip.marker_hint')}</em>`;
        }, { direction: 'top', offset: [0, -10], className: 'tip' });
        mk.on('click', () => setTarget({ n: p.n, x: p.x, z: p.z, y: p.y, icon: c.icon }));
        mk.on('contextmenu', (e) => {
          L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
          ctxMenu(mapRef.current, e.latlng, tn(p.n || c.n), [
            { t: t('ctx.pin_here'), fn: () => pinAct.current.add?.(p.x, p.z, p.y ?? null, tn(p.n || c.n)) },
            { t: t('ctx.route_here'), fn: () => setTarget({ n: p.n, x: p.x, z: p.z, y: p.y, icon: c.icon }) },
            { t: t('ctx.found_toggle'), fn: () => setFound((f) => { const n = new Set(f); n.has(pi) ? n.delete(pi) : n.add(pi); return n; }) },
          ]);
        });
        markerRefs.current[pi] = { mk, g };
        g.addLayer(mk);
      }
      layers.current[c.id] = g;
    }
    const lg = L.layerGroup();
    placeMks.current = [];
    for (const l of data.labels) {
      const mk = L.marker(toLL(l.x, l.z), { interactive: false, keyboard: false, icon: placeIcon(l) });
      placeMks.current.push([mk, l]);
      lg.addLayer(mk);
    }
    labelLayer.current = lg;
    return () => { Object.values(layers.current).forEach((g) => g.remove()); lg.remove(); };
  }, [data]);

  // troca de idioma: os nomes de lugares são HTML fixo no ícone, então refaz só o ícone
  useEffect(() => { for (const [mk, l] of placeMks.current) mk.setIcon(placeIcon(l)); }, [langV]);
  useEffect(() => {
    if (!data || !visible || !mapRef.current) return;
    for (const c of data.cats) { const g = layers.current[c.id]; if (!g) continue; if (visible[c.id]) g.addTo(mapRef.current); else g.remove(); }
  }, [data, visible]);
  // histórias já lidas: conhecimentos do save do personagem (relido a cada minuto; o jogo grava de tempos em tempos)
  const [readK, setReadK] = useState(() => new Set());
  readKRef.current = readK;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const s = await currentSave(); const ids = await playerKnowledge(s?.path); if (alive) setReadK((cur) => (cur.size === ids.length ? cur : new Set(ids))); } catch {}
    };
    load(); const timer = setInterval(load, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    for (const [pi, r] of Object.entries(markerRefs.current)) {
      const p0 = data?.points[+pi];
      const isF = found.has(+pi) || !!(p0?.k && readK.has(p0.k)); // encontrado à mão ou história já lida (save)
      if (r.mk.setStyle) r.mk.setStyle({ fillOpacity: isF ? 0.25 : 0.95, opacity: isF ? 0.3 : 1 });
      else r.mk.setOpacity(isF ? 0.35 : 1);
      const p = data?.points[+pi];
      const isD = p && isDismissed(dismissed, p.x, p.z);
      if ((hideFound && isF) || isD || (p && lvOut(p.lv))) r.g.removeLayer(r.mk); else if (!r.g.hasLayer(r.mk)) r.g.addLayer(r.mk);
    }
  }, [found, hideFound, data, dismissed, chestLv, readK]);
  // contagem de itens coletáveis (para o "Encontre uma criatura, planta…") e camada dos achados
  useEffect(() => {
    if (!data) return;
    loadNearby(data.points, data.cats).then((idx) => { nearIdx.current = idx; setLabelCounts(idx.labelCounts()); });
  }, [data]);
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    let alive = true;
    (async () => {
      const renderer = iconCanvas.current;
      const g = L.layerGroup();
      const hpts = [];
      const liveChestMk = [];
      const ores = [];
      const stats = []; // para o teste e2e (window.__emb)
      for (const f of finders) {
        const key = `${f.kind}/${f.slug}`;
        if (!findCache.current[key]) findCache.current[key] = await (await fetch(`./find/${key}.json`)).json();
        const pts = findCache.current[key];
        const icon = !!f.img; // ícone desenhado no canvas (todos os tipos, minérios inclusive): aguenta milhares de pontos
        const st = { key, kind: f.kind, n: f.n, img: f.img || null, total: pts.length, icons: 0, circles: 0, heights: 0 };
        stats.push(st);
        for (const p of pts) {
          const [x, z] = p;
          if (f.kind === 'ore' && surfaceOnly && !(p[3] > 0)) continue;
          if (f.kind === 'chests' && lvOut(p[6])) continue; // nível do baú fora da faixa escolhida
          if (isDismissed(dismissed, x, z)) continue; // escondido com F8
          let mk;
          if (icon) {
            // minério: tamanho pelo volume do depósito e apagado se estiver enterrado (como no site)
            const ore = f.kind === 'ore';
            const size = ore ? Math.round(16 + 10 * Math.min(1, Math.log10(Math.max(1, p[2])) / 4)) : 24;
            // item que vem em baú: no mapa aparece o baú (ouro/prata/madeira), o item fica no tooltip
            const src = f.kind === 'chests' && CHEST_PIN[p[2]] ? CHEST_PIN[p[2]] : f.img;
            const ring = f.slug.startsWith('archaic-essence') ? '#ff5ad8' : null; // Essência Arcaica: contorno magenta (difícil de ver no terreno)
            mk = new ImgMarker(toLL(x, z), { renderer, img: imgFor(src), size, ring, opacity: ore && !(p[3] > 0) ? 0.45 : 1 });
            st.icons++;
          }
          else {
            const r = f.kind === 'ore' ? 3 + 4 * Math.min(1.5, 0.5 + Math.log10(Math.max(1, p[2])) / 4) : 4;
            const op = f.kind === 'ore' && !(p[3] > 0) ? 0.4 : 0.95;
            mk = L.circleMarker(toLL(x, z), { renderer, radius: r, color: '#0b0b0b', weight: 1, fillColor: f.color, fillOpacity: op, opacity: op });
            st.circles++;
          }
          const extra = () => (f.kind === 'ore' ? ` · ${t('tip.volume', { n: p[2] })}${p[3] > 0 ? '' : ` · ${t('tip.buried')}`}${p[4] > 0 ? ` · ${t('tip.below_ground', { n: p[4] })}` : ''}` : f.kind === 'chests' && p[2] ? ` · ${({ gold: t('tip.chest_gold'), silver: t('tip.chest_silver'), wood: t('tip.chest_wood') })[p[2]] || t('tip.chest_other', { type: p[2] })}${p[6] ? ` · ${t('tip.level', { n: p[6] })}` : ''}` : '');

          // altura: criaturas e colmeias em p[2], itens de baú em p[3] (baú do jogo mais próximo), minérios em p[5] (terreno − profundidade)
          const gl = Array.isArray(p[p.length - 1]) ? p[p.length - 1] : null;
          const gpos = gl && !Array.isArray(gl[0]) ? gl : null; // posição exata do item do jogo (plantas/itens)
          const gcand = gl && Array.isArray(gl[0]) ? gl : null; // sem par exato: objetos do jogo que dão o item a até 10 m
          const y = (f.kind === 'spawns' || f.slug === 'colmeia' ? p[2] : f.kind === 'chests' ? p[3] : f.kind === 'ore' ? p[5] : f.kind === 'gather' && gpos ? gpos[2] : null) ?? null;
          const tipImg = f.kind === 'chests' && f.img ? `<img class="tipimg" src="./${f.img}">` : '';
          // tooltip montado na hora: mostra se está acima/abaixo do personagem agora
          mk.bindTooltip(() => {
            const lv = live.current;
            const h = y != null && lv.have ? hText(y - lv.ty) : '';
            return `${tipImg}<b>${tn(f.n)}</b><span>${extra().replace(/^ · /, '')}</span>${h}`;
          }, { direction: 'top', className: 'tip' });
          mk.on('click', () => setTarget({ n: f.n, x, z, y, icon: f.img ? null : f.color }));
          mk.on('contextmenu', (e) => {
            L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
            ctxMenu(mapRef.current, e.latlng, tn(f.n), [
              { t: t('ctx.pin_here'), fn: () => pinAct.current.add?.(x, z, y, tn(f.n)) },
              { t: t('ctx.route_here'), fn: () => setTarget({ n: f.n, x, z, y, icon: f.img ? null : f.color }) },
            ]);
          });
          if (y != null) { hpts.push({ x, z, y, mk, g }); st.heights++; } // mk/g: a etiqueta de altura some junto com o ícone
          let oreGone = false;
          if (f.kind === 'ore' && ORE_MAT[f.slug] != null) {
            const e = { mk, g, x, z, y: p[5], m3: p[2], mat: ORE_MAT[f.slug], op: !(p[3] > 0) ? 0.45 : 1, gone: false };
            ores.push(e);
            const s = STICKY.get(stickyKey(e));
            if (s?.st === 'esgotado' && stickyHidden(e)) { e.gone = true; oreGone = hideTaken; if (!hideTaken) mk.setOpacity?.(0.25); }
          }
          if (f.kind === 'chests' && p[4] != null) liveChestMk.push({ mk, g, x: p[4], z: p[5], y: p[3] }); // estado ao vivo do baú
          if (f.kind === 'gather' && gpos) liveChestMk.push({ mk, g, x: gpos[0], z: gpos[1], y: gpos[2], item: !f.chest }); // f.chest: item que vem de baú (some ao abrir)
          if (f.kind === 'gather' && gcand) liveChestMk.push({ mk, g, x: gcand[0][0], z: gcand[0][1], y: gcand[0][2], cands: gcand });
          if (f.kind === 'spawns' && !f.boss) liveChestMk.push({ mk, g, x, z, y, spawn: f.n }); // ponto de surgimento: some sem criatura viva (chefe nunca)
          if (!oreGone) g.addLayer(mk);
        }
      }
      if (!alive) return;
      findLayer.current?.remove();
      findLayer.current = g.addTo(map);
      findH.current = hpts;
      findChestMk.current = liveChestMk;
      oreMk.current = ores;
      window.__emb = { ...(window.__emb || {}), finders: stats, images: () => [...imgCache.values()].map((im) => ({ src: im.src, ok: im.complete && im.naturalWidth > 0, done: im.complete })) };
    })();
    return () => { alive = false; };
  }, [finders, surfaceOnly, dismissed, chestLv, hideTaken]);
  // minério esgotado (leitura do terreno): sem nenhum grupo de 6+ blocos encostados do material, o ícone sai sozinho e
  // fica guardado (o jogo descarrega o terreno longe); volta se a leitura mostrar o minério de novo (o servidor refaz)
  useEffect(() => {
    let busy = false;
    const timer = setInterval(async () => {
      const lv = live.current, fl = findLayer.current;
      if (busy || !lv.have || !fl) return;
      const near = oreMk.current.filter((e) => Math.hypot(e.x - lv.tx, e.z - lv.tz) < 250);
      if (!near.length) return;
      busy = true;
      try {
        const st = await oreState(near.map((e) => [e.x, e.z, e.m3, e.y, e.mat]));
        near.forEach((e, i) => {
          const s = st[i];
          if (s === 2 && !e.gone) {
            e.gone = true; STICKY.set(stickyKey(e), { st: 'esgotado', t: Date.now() });
            if (hideTaken) fl.removeLayer(e.mk); else e.mk.setOpacity?.(0.25);
          } else if ((s === 0 || s === 1) && (e.gone || STICKY.get(stickyKey(e))?.st === 'esgotado')) {
            e.gone = false; STICKY.delete(stickyKey(e));
            if (!fl.hasLayer(e.mk)) fl.addLayer(e.mk); e.mk.setOpacity?.(e.op);
          }
        });
      } catch {}
      busy = false;
    }, 3000);
    return () => clearInterval(timer);
  }, [finders, hideTaken]);
  useEffect(() => { if (labelLayer.current) { if (names) labelLayer.current.addTo(mapRef.current); else labelLayer.current.remove(); } }, [names, data]);

  // jogador em tempo real (memória do jogo)
  useEffect(() => {
    let off = () => {};
    onPlayer((s) => {
      setPlayer(s);
      const map = mapRef.current;
      if (!map || (s.status !== 'ok' && s.status !== 'parado')) return;
      const lv = live.current;
      lv.tx = s.x; lv.tz = s.z; lv.ty = s.y; lv.th = s.heading;
      if (!lv.have) {
        lv.have = true; lv.x = s.x; lv.z = s.z; lv.h = s.heading;
        if (followRef.current) map.setView(toLL(s.x, s.z), Math.max(map.getZoom(), 4.5), { animate: false });
      }
      if (!playerMarker.current) {
        playerMarker.current = L.marker(toLL(s.x, s.z), {
          zIndexOffset: 10000, interactive: false,
          icon: L.divIcon({ className: 'player', html: '<div class="ring"></div><img src="./icons/player_position.png">', iconSize: [44, 44], iconAnchor: [22, 22] }),
        }).addTo(map);
      }
    }).then((u) => { off = u; });
    return () => off();
  }, []);

  // estado ao vivo: posições das entidades que existem agora no cliente (grade de 10 cm)
  useEffect(() => {
    let off = () => {};
    onLive((s) => {
      if (s.status === 'jogadores') { friends(s.players); return; } // só a posição dos amigos (10 Hz)
      if (s.status !== 'ok') return; // tropeço de leitura: mantém a última leitura boa (expira pelo tempo)
      friends(s.players);
      const grid = new Map(), p = s.pts;
      for (let i = 0; i < p.length; i += 4) {
        const k = `${Math.round(p[i] * 10)},${Math.round(p[i + 2] * 10)}`;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(p[i], p[i + 1], p[i + 2], p[i + 3]);
      }
      // PLACEMENT_HELPER_*_Animal_Farm_*: molde de posicionamento dos animais da fazenda (tem vida, mas não é bicho)
      const mobs = (s.mobs || []).filter((q) => !/^PLACEMENT_HELPER/.test(LIVE_TPL[q.tpl] || ''));
      liveSt.current = { t: Date.now(), x: s.x, z: s.z, n: p.length / 4, grid, loot: s.loot || [], mobs };
      // alvo criatura: a rota acompanha quando ela anda
      const tg = targetRef.current;
      if (tg?.mobId) { const q = (s.mobs || []).find((o) => o.id === tg.mobId); if (q && Math.hypot(q.x - tg.x, q.z - tg.z) > 1) setTarget((cur) => (cur && cur.mobId === tg.mobId ? { ...cur, x: q.x, y: q.y, z: q.z } : cur)); }
    }).then((u) => (off = u));
    // amigos no servidor (nome da Steam + posição da entidade do jogador, a qualquer distância)
    function friends(players) {
      const map = mapRef.current;
      if (map) {
        const seen = new Set();
        for (const f of players || []) {
          seen.add(f.name);
          let mk = friendMk.current.get(f.name);
          if (!mk) {
            const name = f.name.replace(/[<>&"]/g, '');
            mk = L.marker(toLL(f.x, f.z), { zIndexOffset: 9000, icon: L.divIcon({ className: 'friend', html: `<i></i><span>${name}</span>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
              .bindTooltip(() => { const lv = live.current, p = mk.pos; return `<b>${name}</b>${lv.have ? `<span>${t('unit.m', { n: Math.round(Math.hypot(p.x - lv.tx, p.z - lv.tz)) })}</span>${hText(p.y - lv.ty)}` : ''}`; }, { direction: 'top', className: 'tip' })
              .on('click', () => setTarget({ n: name, x: mk.pos.x, z: mk.pos.z, y: mk.pos.y, icon: '#7dff9b' }))
              .on('contextmenu', (e) => { L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent); ctxMenu(map, e.latlng, name, [
                { t: t('ctx.pin_here'), fn: () => pinAct.current.add?.(mk.pos.x, mk.pos.z, mk.pos.y, name) },
                { t: t('ctx.route_here'), fn: () => setTarget({ n: name, x: mk.pos.x, z: mk.pos.z, y: mk.pos.y, icon: '#7dff9b' }) },
              ]); })
              .addTo(map);
            friendMk.current.set(f.name, mk);
          }
          mk.pos = f;
          mk.setLatLng(toLL(f.x, f.z));
        }
        for (const [n, mk] of friendMk.current) if (!seen.has(n)) { mk.remove(); friendMk.current.delete(n); }
      }
    }
    return () => off();
  }, []);

  // Pins = os marcadores do mapa do jogo (tecla M), sincronizados sozinhos pela DLL:
  // com o jogo aberto, o app conecta, lê a lista a cada 2 s e cria/remove direto no jogo. Com o jogo fechado, o pin
  // novo fica pendente (guardado neste PC) e vai para o jogo quando ele abrir. + os de meus-marcadores.json.
  const PIN_COLORS = ['#ffd34d', '#ff6b6b', '#6fd3ff', '#7dff9b', '#c38bff', '#ff9d4d'];
  const [pending, setPending] = useState(() => { try { return JSON.parse(localStorage.getItem('embervale.pins') || '[]'); } catch { return []; } });
  const [gamePins, setGamePins] = useState(null); // null = sem conexão com o jogo
  const [gameErr, setGameErr] = useState('');
  const [filePins, setFilePins] = useState([]);
  const [pinsDone, setPinsDone] = useState(() => { try { return JSON.parse(localStorage.getItem('embervale.pinsDone') || '[]'); } catch { return []; } });
  const [pinMode, setPinMode] = useState(false);
  const [pinName, setPinName] = useState('');
  const pinModeRef = useRef(false); pinModeRef.current = pinMode;
  const pinNameRef = useRef(''); pinNameRef.current = pinName;
  const gameOnRef = useRef(false); gameOnRef.current = gamePins !== null;
  useEffect(() => { try { localStorage.setItem('embervale.pins', JSON.stringify(pending)); } catch {} }, [pending]);
  useEffect(() => { try { localStorage.setItem('embervale.pinsDone', JSON.stringify(pinsDone)); } catch {} }, [pinsDone]);
  const pinKey = (p) => `${p.n ?? p.nome}@${Math.round(p.x)},${Math.round(p.z)}`;
  const refreshGame = async () => {
    const r = await gameReq({ acao: 'listar' });
    if (!r.ok) throw new Error(r.erro || t('pins.list_failed'));
    const next = r.marcadores.map((q) => ({ ...q, n: q.nome }));
    setGamePins((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next)); // igual: não recria os ícones
    setGameErr('');
  };
  const addPin = async (x, z, y = null, nome = null) => {
    const n = (nome || '').trim() || (pinNameRef.current || '').trim() || t('pins.default', { n: (gamePins?.length ?? 0) + pending.length + 1 });
    if (gameOnRef.current) {
      try { const r = await gameReq({ acao: 'criar', x, z, nome: n }); if (!r.ok) throw new Error(r.erro); await refreshGame(); return; }
      catch (e) { setGameErr(String(e.message || e)); }
    }
    setPending((a) => [...a, { id: `${Date.now()}`, n, x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, y: y == null ? null : Math.round(y * 10) / 10 }]);
  };
  pinAct.current.add = addPin;
  const removeGamePin = async (q) => {
    try { const r = await gameReq({ acao: 'remover', indice: q.indice }); if (!r.ok) throw new Error(r.erro); await refreshGame(); }
    catch (e) { setGameErr(String(e.message || e)); }
  };
  const removeFilePin = async (q) => {
    const next = filePins.filter((p) => pinKey(p) !== pinKey(q));
    setFilePins(next);
    try { await saveMyPins(next); } catch (e) { setGameErr(String(e.message || e)); }
  };
  // renomear: no jogo não há "renomear", então cria o novo (mesmo lugar, ícone e cor) e só depois apaga o antigo
  const renamePin = async (p, novo) => {
    const nome = novo.trim().slice(0, 128);
    if (!nome) return;
    const k0 = pinKey(p), k1 = pinKey({ ...p, n: nome });
    setPinsDone((a) => (a.includes(k0) ? [...a.filter((v) => v !== k0), k1] : a));
    if (p.kind === 'game' || p.indice != null) {
      try {
        const r = await gameReq({ acao: 'criar', x: p.x, z: p.z, nome, ...(p.icone != null ? { icone: p.icone } : {}), ...(typeof p.cor === 'number' ? { cor: p.cor } : {}) });
        if (!r.ok) throw new Error(r.erro);
        const r2 = await gameReq({ acao: 'remover', indice: p.indice });
        if (!r2.ok) throw new Error(r2.erro);
        await refreshGame();
      } catch (e) { setGameErr(String(e.message || e)); }
    } else if (p.kind === 'file' || filePins.some((q) => pinKey(q) === k0)) {
      const next = filePins.map((q) => (pinKey(q) === k0 ? { ...q, n: nome } : q));
      setFilePins(next);
      try { await saveMyPins(next); } catch (e) { setGameErr(String(e.message || e)); }
    } else setPending((a) => a.map((q) => (q.id === p.id ? { ...q, n: nome } : q)));
  };
  const [editPin, setEditPin] = useState(null); // chave do pin sendo renomeado na aba Pins
  const toggleDone = (p) => { const k = pinKey(p); setPinsDone((a) => (a.includes(k) ? a.filter((v) => v !== k) : [...a, k])); };
  // conexão automática: com o jogo aberto conecta (carrega a DLL se preciso), lê a lista e envia os pendentes
  const playerOk = player.status === 'ok' || player.status === 'parado';
  useEffect(() => {
    if (!playerOk) { setGamePins(null); return; }
    let alive = true, nextTry = 0, connected = false;
    const tick = async () => {
      if (!alive) return;
      try {
        if (!connected) {
          if (Date.now() < nextTry) return;
          await gameConnect();
          connected = true;
        }
        await refreshGame();
        const pend = (() => { try { return JSON.parse(localStorage.getItem('embervale.pins') || '[]'); } catch { return []; } })();
        if (pend.length) {
          for (const p of pend) { const r = await gameReq({ acao: 'criar', x: p.x, z: p.z, nome: p.n }); if (!r.ok) throw new Error(r.erro); }
          setPending([]);
          await refreshGame();
        }
      } catch (e) {
        connected = false; nextTry = Date.now() + 15000;
        if (alive) { setGamePins(null); setGameErr(String(e.message || e)); }
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [playerOk]);
  useEffect(() => {
    let alive = true, last = '';
    const load = async () => { const a = await myPins(); const k = JSON.stringify(a); if (alive && k !== last) { last = k; setFilePins(Array.isArray(a) ? a.filter((p) => typeof p.x === 'number' && typeof p.z === 'number') : []); } };
    load(); const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  // modo "adicionar": cada clique no mapa põe um pin (até desligar)
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const onClick = (e) => { if (!pinModeRef.current) return; const p = fromLL(e.latlng); addPin(p.x, p.z); };
    map.on('click', onClick);
    document.getElementById('map')?.classList.toggle('pinmode', pinMode);
    return () => map.off('click', onClick);
  }, [data, pinMode, gamePins, pending]);
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const layer = L.layerGroup();
    const all = [
      ...(gamePins || []).map((p) => ({ ...p, kind: 'game', cor: '#ffd34d', corJogo: p.cor })),
      ...pending.map((p) => ({ ...p, kind: 'pend', cor: '#9aa3ad' })),
      ...filePins.map((p) => ({ ...p, kind: 'file', cor: p.cor })),
    ];
    for (const p of all) {
      const name = String(p.n || '').replace(/[<>&"]/g, '');
      const cor = /^#[0-9a-f]{3,8}$/i.test(p.cor || '') ? p.cor : '#ffd34d';
      const done = pinsDone.includes(pinKey(p));
      const tag = () => t(p.kind === 'game' ? 'pins.tag_game' : p.kind === 'pend' ? 'pins.tag_pending' : 'pins.tag_file');
      const mk = L.marker(toLL(p.x, p.z), { zIndexOffset: 8000, icon: L.divIcon({ className: `mypin ${p.kind}${done ? ' done' : ''}`, html: `<i style="background:${cor};box-shadow:0 0 10px ${cor}">${p.kind === 'game' ? '◆' : '★'}</i><span style="color:${cor}">${name}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
        .bindTooltip(() => { const lv = live.current; return `<b>${name}</b><span>${tag()}</span>${p.d ? `<span>${String(p.d).replace(/[<>&]/g, '')}</span>` : ''}${lv.have ? `<span>${t('unit.m', { n: Math.round(Math.hypot(p.x - lv.tx, p.z - lv.tz)) })}</span>` : ''}${p.y != null && lv.have ? hText(p.y - lv.ty) : ''}`; }, { direction: 'top', className: 'tip' })
        .on('click', (e) => { L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent); setTarget({ n: name, x: p.x, z: p.z, y: p.y ?? null, icon: cor }); })
        .on('contextmenu', (e) => {
          L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
          ctxMenu(map, e.latlng, name, [
            { t: t('ctx.route_here'), fn: () => setTarget({ n: name, x: p.x, z: p.z, y: p.y ?? null, icon: cor }) },
            { t: done ? t('ctx.undone') : t('ctx.done'), fn: () => toggleDone(p) },
            { t: p.kind === 'game' ? t('ctx.rename_game') : t('ctx.rename'), fn: () => renameBox(map, e.latlng, p.n, (v) => renamePin(p.kind === 'game' ? { ...p, cor: p.corJogo } : p, v)) },
            { t: p.kind === 'game' ? t('ctx.delete_game') : t('ctx.delete'), fn: () => (p.kind === 'game' ? removeGamePin(p) : p.kind === 'file' ? removeFilePin(p) : setPending((a) => a.filter((r) => r.id !== p.id))) },
          ]);
        });
      layer.addLayer(mk);
    }
    layer.addTo(map);
    return () => layer.remove();
  }, [data, gamePins, pending, filePins, pinsDone]);

  // destino: linha tracejada do jogador até o alvo
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (navLine.current) { navLine.current.remove(); navLine.current = null; }
    if (target) {
      const lv = live.current;
      const from = lv.have ? toLL(lv.x, lv.z) : toLL(target.x, target.z);
      navLine.current = L.polyline([from, toLL(target.x, target.z)], { color: '#f0c25a', weight: 3, dashArray: '8 8', opacity: 0.9, interactive: false, pane: 'decor', renderer: decor.current }).addTo(map);
    }
  }, [target]);

  // atividades em tempo real: tudo num raio em volta do personagem
  useEffect(() => {
    if (!activities || !data || nearIdx.current) return;
  }, [activities, data]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!activities) {
      ringRef.current?.remove(); ringRef.current = null; nearLayer.current?.remove(); nearLayer.current = null; nearMks.current.clear(); setNearby([]);
      return;
    }
    const timer = setInterval(() => {
      const lv = live.current;
      if (!lv.have || !nearIdx.current) return;
      const list = nearIdx.current.query(lv.tx, lv.tz, radius).filter((it) => !isDismissed(dismissedRef.current, it.x, it.z)) // ignora os escondidos com F8
        .concat(liveLoot(liveSt.current, lv, radius), liveMobs(liveSt.current, lv, radius))
        .filter((it) => it.y == null || Math.abs(it.y - lv.ty) <= (dungeon ? dungeonH : 200)) // outro andar/superfície: depois de juntar criaturas e saques ao vivo (antes eles escapavam)
        .filter((it) => !hiddenNear.includes(it.n)) // ocultos pelo olho: depois de juntar criaturas vivas e saques ao vivo (antes eles escapavam)
        .map((it, _i, arr) => ({ ...it, st: it.st || (it.kind === 'mob' && it.boss ? null : stickyState(it, it.kind === 'mob' ? spawnState(liveSt.current, lv, it, arr.filter((o) => o.kind === 'mob')) : (liveState(liveSt.current, it) ?? verifyObj(liveSt.current, lv, it)))) }))
        .filter((it) => !(hideTaken && (it.st === 'pego' || it.st === 'aberto' || it.st === 'acionado' || it.st === 'vazio' || it.st === 'ausente' || it.st === 'ausente')))
        .filter((it) => !nearOff.includes(nearGroup(it)) && (!nearQ.trim() || fmatch(nearQ, it.n, label(it))))
        .map((it) => ({ ...it, d3: it.y == null ? it.d : Math.hypot(it.d, it.y - lv.ty) }))
        .sort((a, b) => a.d3 - b.d3); // mais perto primeiro, contando a altura
      setNearby(list);
      if (!ringRef.current) ringRef.current = L.circle(toLL(lv.x, lv.z), { radius: 0, color: '#6fd3ff', weight: 1.5, fillOpacity: 0.05, interactive: false, pane: 'decor', renderer: decor.current }).addTo(map);
      // raio em metros -> unidades do CRS (1 m = 2^-5 no zoom 0)
      ringRef.current.setRadius(radius / 32);
      if (!nearLayer.current) nearLayer.current = L.layerGroup().addTo(map);
      // atualiza no lugar (sem apagar e recriar): recriar a cada 400 ms trocava o elemento debaixo do cursor entre o
      // apertar e o soltar do botão, e o clique virava arrasto do mapa
      const keep = new Set();
      const mks = nearMks.current;
      for (const it of list.slice(0, 300)) {
        // tudo o que está na lista vira ícone no mapa, inclusive os marcadores (porta secreta, pista...): antes eles só
        // apareciam na lista quando a categoria estava desligada no mapa
        let html = it.kind === 'logic' ? '<i class="logicmk"></i>' : it.kind === 'res' && !it.img ? '<i class="resmk"></i>' : (it.kind === 'loot' || it.kind === 'loose') && !it.img ? `<i class="lootmk${it.kind === 'loose' ? ' loose' : ''}"></i>` : it.img ? `<img class="${it.kind === 'mob' ? (it.boss ? 'mobimg boss' : 'mobimg') : ''}" src="./${it.img}">` : it.kind === 'mob' || it.kind === 'alive' ? `<i class="mobmk${it.boss ? ' boss' : ''}${it.kind === 'alive' ? ' alive' : ''}"></i>` : (it.icon && it.icon.includes('/') ? `<img src="./${it.icon}">` : `<i class="chestmk" style="background:${it.icon || '#7fe0ff'}"></i>`);
        if (it.y != null) html += hBadge(it.y - lv.ty); // altura relativa ao personagem, ao lado do ícone
        const taken = it.st === 'pego' || it.st === 'aberto' || it.st === 'acionado' || it.st === 'vazio' || it.st === 'ausente';
        const key = `${it.kind}|${it.n}|${Math.round(it.x * 10)},${Math.round(it.z * 10)}`;
        keep.add(key);
        const tip = `<b>${label(it)}</b><span>${it.hp != null ? `${t('tip.hp', { hp: it.hp, max: it.hpMax })} · ` : ''}${m(it.d)}${taken ? ` · ${it.st === 'aberto' ? t('tip.opened') : t('tip.taken')}` : ''}</span>`;
        let rec = mks.get(key);
        if (!rec) {
          const mk = L.marker(toLL(it.x, it.z), { icon: L.divIcon({ className: `mk item near-mk${taken ? ' taken' : ''}`, html, iconSize: null }) })
            .bindTooltip(tip, { direction: 'top', className: 'tip' })
            .on('click', () => setTarget({ n: it.n, x: it.x, z: it.z, y: it.y, mobId: it.mobId, kind: it.kind, loot: it.loot, sp: it.sp, tplL: it.tplL }))
            .on('contextmenu', (e) => { L.DomEvent.stop(e); if (e.originalEvent) L.DomEvent.stop(e.originalEvent); ctxMenu(mapRef.current, e.latlng, label(it), [
              { t: t('ctx.pin_here'), fn: () => pinAct.current.add?.(it.x, it.z, it.y ?? null, label(it)) },
              { t: t('ctx.route_here'), fn: () => setTarget({ n: it.n, x: it.x, z: it.z, y: it.y, kind: it.kind, loot: it.loot, sp: it.sp, tplL: it.tplL }) },
            ]); });
          nearLayer.current.addLayer(mk);
          mks.set(key, (rec = { mk, html, taken, tip }));
          continue;
        }
        const el = rec.mk.getElement();
        if (el && rec.html !== html) { el.innerHTML = html; rec.html = html; } // só o conteúdo: o elemento continua o mesmo
        if (el && rec.taken !== taken) { el.classList.toggle('taken', taken); rec.taken = taken; }
        if (rec.tip !== tip) { rec.mk.setTooltipContent(tip); rec.tip = tip; }
      }
      for (const [k, rec] of mks) if (!keep.has(k)) { nearLayer.current.removeLayer(rec.mk); mks.delete(k); }
    }, 400);
    return () => clearInterval(timer);
  }, [activities, radius, dungeon, dungeonH, hiddenNear, dismissed, hideTaken, nearOff, nearQ]);

  // F8: esconde o ponto visível mais perto do personagem (marcadores, Meu filtro, Atividades)
  useEffect(() => {
    let off = () => {};
    onDismiss(() => {
      const lv = live.current;
      if (!lv.have) { setToast(t('toast.f8_nopos')); return; }
      const cand = [];
      const push = (n, x, z, y) => {
        if (isDismissed(dismissedRef.current, x, z)) return;
        const d = Math.hypot(x - lv.tx, z - lv.tz);
        if (d <= 25) cand.push({ n, x, z, d: d + (y != null ? Math.abs(y - lv.ty) * 0.5 : 0) });
      };
      if (data) for (const p of data.points) if (visibleRef.current?.[p.c]) push(p.n, p.x, p.z, p.y);
      for (const f of findersRef.current) for (const p of findCache.current[`${f.kind}/${f.slug}`] || []) {
        const y = f.kind === 'spawns' || f.slug === 'colmeia' ? p[2] : f.kind === 'chests' ? p[3] : null;
        push(f.n, p[0], p[1], y);
      }
      for (const it of nearbyRef.current) push(it.n, it.x, it.z, it.y);
      if (!cand.length) { setToast(t('toast.f8_none')); return; }
      cand.sort((a, b) => a.d - b.d);
      const c = cand[0];
      setDismissed((ds) => [...ds, { x: c.x, z: c.z, n: c.n, t: Date.now() }]);
      setToast(t('toast.hidden', { name: showName(c.n) }));
    }).then((u) => (off = u));
    return () => off();
  }, [data]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const timer = setInterval(() => {
      const lv = live.current, now = Date.now();
      const keep = dismissedRef.current.filter((d) => now - d.t < 30 * 60e3 && (!lv.have || Math.hypot(d.x - lv.tx, d.z - lv.tz) < 300));
      if (keep.length !== dismissedRef.current.length) setDismissed(keep);
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // baús já saqueados (estado ao vivo) também nos marcadores do mapa e do "Meu filtro"
  const findChestMk = useRef([]);
  useEffect(() => {
    const opened = new Set();
    const miss = new Map(); // leituras seguidas sem objeto do jogo no ponto (dupla verificação)
    const timer = setInterval(() => {
      const lv = live.current, ls = liveSt.current, map = mapRef.current;
      if (!lv.have || !data || !map) return;
      const near = (x, z) => Math.hypot(x - lv.tx, z - lv.tz) < 125 || stickyHidden({ x, z });
      const applySpawn = (key, mk, g, c) => {
        const st = stickyState(c, Math.hypot(c.x - lv.tx, c.z - lv.tz) > 85 ? null : spawnState(ls, lv, { x: c.x, z: c.z, y: c.y, n: c.spawn }, nearSpawns));
        const was = opened.has(key);
        if (st === 'vazio' && !was) { opened.add(key); if (hideTaken) g.removeLayer(mk); else mk.setOpacity?.(0.3); }
        else if (st === 'ok' && was) { opened.delete(key); if (!g.hasLayer(mk)) g.addLayer(mk); mk.setOpacity?.(1); }
      };
      const apply = (key, mk, g, x, z, y, kind = 'chest') => {
        const st = stickyState({ x, z }, liveState(ls, { kind, x, z, y: null })); // y arredondado nos dados: compara só x/z exatos
        const wasOpen = opened.has(key);
        if ((st === 'aberto' || st === 'pego') && !wasOpen) { opened.add(key); if (hideTaken) g.removeLayer(mk); else mk.setOpacity ? mk.setOpacity(0.3) : mk.setStyle?.({ opacity: 0.3, fillOpacity: 0.3 }); }
        else if (st === 'ok' && wasOpen) { opened.delete(key); if (!g.hasLayer(mk)) g.addLayer(mk); mk.setOpacity ? mk.setOpacity(1) : mk.setStyle?.({ opacity: 1, fillOpacity: 0.95 }); }
      };
      // ponto ligado a vários objetos possíveis: some só quando todos foram colhidos; volta se algum reaparecer
      const applyAll = (key, mk, g, cands) => {
        const sts = cands.map(([x, z]) => stickyState({ x, z }, liveState(ls, { kind: 'item', x, z, y: null })));
        const wasOpen = opened.has(key);
        if (sts.every((s) => s === 'pego') && !wasOpen) { opened.add(key); if (hideTaken) g.removeLayer(mk); else mk.setOpacity?.(0.3); }
        else if (sts.some((s) => s === 'ok') && wasOpen) { opened.delete(key); if (!g.hasLayer(mk)) g.addLayer(mk); mk.setOpacity?.(1); }
      };
      // dupla verificação dos objetos (ver OBJ_CATS)
      const fresh = ls.t && Date.now() - ls.t < 5000 && ls.n > 50;
      for (const [pi, r] of Object.entries(markerRefs.current)) {
        const p = data.points[+pi];
        if (!p || !OBJ_CATS.test(p.c)) continue;
        const x = p.g ? p.g[0] : p.x, z = p.g ? p.g[1] : p.z;
        const d = Math.hypot(x - lv.tx, z - lv.tz);
        const key = 'v' + pi;
        if (fresh && d < 80) {
          if (anyEntityNear(ls, x, z, p.y)) { miss.delete(key); if (opened.has(key)) { opened.delete(key); STICKY.delete(stickyKey({ x, z })); if (!r.g.hasLayer(r.mk)) r.g.addLayer(r.mk); r.mk.setOpacity?.(1); } }
          else { const m = (miss.get(key) || 0) + 1; miss.set(key, m); if (m >= 3 && !opened.has(key)) { opened.add(key); STICKY.set(stickyKey({ x, z }), { st: 'ausente', t: Date.now() }); if (hideTaken) r.g.removeLayer(r.mk); else r.mk.setOpacity?.(0.3); } }
        } else if (!opened.has(key) && stickyHidden({ x, z })) { opened.add(key); if (hideTaken) r.g.removeLayer(r.mk); else r.mk.setOpacity?.(0.3); }
      }
      for (const [pi, r] of Object.entries(markerRefs.current)) {
        const p = data.points[+pi];
        if (!p || !p.g || !(p.c.startsWith('chest') || p.gk === 'chest' || p.c === 'secret-door') || !near(p.g[0], p.g[1])) continue;
        apply('m' + pi, r.mk, r.g, p.g[0], p.g[1], p.y, p.c === 'secret-door' ? 'door' : 'chest');
      }
      const fl = findLayer.current;
      const nearSpawns = findChestMk.current.filter((c) => c.spawn && Math.hypot(c.x - lv.tx, c.z - lv.tz) < 130).map((c) => ({ x: c.x, z: c.z, n: c.spawn }));
      if (fl) findChestMk.current.forEach((c, i) => {
        if (!near(c.x, c.z)) return;
        if (c.spawn) applySpawn('s' + i + ':' + c.x, c.mk, fl, c);
        else if (c.cands) applyAll('c' + i + ':' + c.x, c.mk, fl, c.cands);
        else apply('f' + i + ':' + c.x, c.mk, fl, c.x, c.z, c.y, c.item ? 'item' : 'chest');
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [data, hideTaken, finders]);

  // altura ao lado dos pontos do "Meu filtro" que estão perto do personagem
  useEffect(() => {
    const timer = setInterval(() => {
      const map = mapRef.current, lv = live.current;
      if (!map) return;
      if (!findHLayer.current) findHLayer.current = L.layerGroup().addTo(map);
      findHLayer.current.clearLayers();
      if (!lv.have) return;
      let near;
      if (allHRef.current) {
        // todos os pontos com altura que estão na tela (Meu filtro + marcadores ligados), os 300 mais perto do centro
        const b = map.getBounds().pad(0.05), c = map.getCenter();
        const pts = [...findH.current];
        const vis = visibleRef.current || {};
        (data?.points || []).forEach((p, pi) => { const r = markerRefs.current[pi]; if (p.y != null && vis[p.c]) pts.push(r ? { ...p, mk: r.mk, g: r.g } : p); });
        near = pts.filter((p) => b.contains(toLL(p.x, p.z)) && !(p.mk && !p.g.hasLayer(p.mk)) && !(hideTakenRef.current && stickyHidden(p)))
          .map((p) => ({ ...p, d: map.distance(c, toLL(p.x, p.z)) })).sort((a, b2) => a.d - b2.d).slice(0, 300);
      } else {
        if (!findH.current.length) return;
        near = findH.current.filter((p) => !(p.mk && !p.g.hasLayer(p.mk))).map((p) => ({ ...p, d: Math.hypot(p.x - lv.tx, p.z - lv.tz) })).filter((p) => p.d < 400 && !(hideTakenRef.current && stickyHidden(p))).sort((a, b2) => a.d - b2.d).slice(0, 8); // só os mais próximos, sem poluir a tela
      }
      for (const p of near) findHLayer.current.addLayer(L.marker(toLL(p.x, p.z), { interactive: false, icon: L.divIcon({ className: 'mk hlabel', html: hBadge(p.y - lv.ty), iconSize: null }) }));
    }, 500);
    return () => clearInterval(timer);
  }, [data]);

  // névoa de guerra (opcional): áreas exploradas do save
  useEffect(() => {
    let alive = true, last = 0;
    async function tick() {
      try {
        const s = await currentSave();
        if (s) setCharacter(s);
        if (s && s.modified !== last) { last = s.modified; const mask = await fogOfWar(s.path); if (mask && alive) drawFog(mask); }
      } catch {}
      if (alive) setTimeout(tick, 15000);
    }
    tick();
    return () => { alive = false; };
  }, []);
  function drawFog(mask) {
    const N = 1280, S = 2560;
    const src = document.createElement('canvas'); src.width = src.height = N;
    const sctx = src.getContext('2d'); const img = sctx.createImageData(N, N);
    for (let i = 0; i < N * N; i++) { img.data[i * 4] = 24; img.data[i * 4 + 1] = 23; img.data[i * 4 + 2] = 22; img.data[i * 4 + 3] = (255 - mask[i]) * 0.9; }
    sctx.putImageData(img, 0, 0);
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d'); ctx.filter = 'blur(10px)'; ctx.drawImage(src, 0, 0, S, S);
    const map = mapRef.current;
    const b = L.latLngBounds(map.unproject([0, WORLD], NATIVE), map.unproject([WORLD, 0], NATIVE));
    const url = c.toDataURL('image/png');
    if (fogLayer.current) fogLayer.current.setUrl(url); else fogLayer.current = L.imageOverlay(url, b, { className: 'fog', interactive: false });
    if (fogRef.current) fogLayer.current.addTo(map);
  }
  useEffect(() => { if (fogLayer.current) { if (fog) fogLayer.current.addTo(mapRef.current); else fogLayer.current.remove(); } }, [fog]);

  // busca
  const results = useMemo(() => {
    if (!data || query.trim().length < 2) return [];
    const q = norm(query);
    const cats = Object.fromEntries(data.cats.map((c) => [c.id, c]));
    const out = [];
    for (const l of data.labels) if (fmatch(query, l.n, l.en, tn(l.n))) out.push({ n: l.n, x: l.x, z: l.z, y: null, label: t('search.place') });
    for (const p of data.points) if (fmatch(query, p.n, p.en, cats[p.c].label, tn(p.n), tn(cats[p.c].label))) out.push({ ...p, label: cats[p.c].label, icon: cats[p.c].icon });
    const lv = live.current;
    if (lv.have) out.sort((a, b) => Math.hypot(a.x - lv.x, a.z - lv.z) - Math.hypot(b.x - lv.x, b.z - lv.z));
    return out.slice(0, 80);
  }, [data, query, player.status, langV]);

  const onExport = async () => {
    const txt = JSON.stringify({ found: [...found] });
    try { await navigator.clipboard.writeText(txt); alert(t('export.copied')); } catch { prompt(t('export.copy_prompt'), txt); }
  };
  const onImport = () => {
    const txt = prompt(t('import.prompt'));
    try { const j = JSON.parse(txt); if (Array.isArray(j.found)) setFound(new Set(j.found)); } catch {}
  };
  const flyTo = (x, z, zoom = 4.5) => { setFollow(false); mapRef.current.flyTo(toLL(x, z), zoom, { duration: 0.8 }); };
  const groups = useMemo(() => {
    if (!data) return [];
    const g = [];
    for (const c of data.cats) { let e = g.find((x) => x.name === c.group); if (!e) g.push((e = { name: c.group, cats: [] })); e.cats.push(c); }
    return g;
  }, [data]);
  const setAll = (v) => setVisible(Object.fromEntries(data.cats.map((c) => [c.id, v])));
  const isLive = player.status === 'ok' || player.status === 'parado';
  const statusText = { fechado: t('status.closed'), sem_acesso: t('status.no_access'), procurando: t('status.searching'), sem_personagem: t('status.no_character'), parado: t('status.located'), ok: t('status.tracking') }[player.status] || player.status;
  // jogo aberto mas ilegível (Windows negou o acesso) ou sem personagem há muito tempo: explica o que fazer
  const alertBar = player.status === 'sem_acesso' ? (
    <div className="alertbar">
      <span>{player.admin ? t('alert.no_access_admin', { code: player.erro }) : t('alert.no_access', { code: player.erro })}</span>
      {!player.admin && <button className="btn" onClick={() => relaunchAdmin().catch(() => setToast(t('alert.relaunch_fail')))}>{t('alert.relaunch')}</button>}
    </div>
  ) : player.status === 'sem_personagem' ? <div className="alertbar"><span>{t('alert.no_character')}</span></div> : null;

  // painel de navegação
  let nav = null;
  // alvo que é uma criatura: vida atual pelo id (leitura ao vivo, 1x/s); morta = corpo de saque no lugar
  const targetMob = target?.mobId ? (liveSt.current.mobs || []).find((q) => q.id === target.mobId) : null;
  const targetCorpse = target?.mobId && !targetMob ? (liveSt.current.loot || []).some((l) => Math.hypot(l.x - target.x, l.z - target.z) < 6) : false;
  if (target && isLive) {
    const d = Math.hypot(target.x - player.x, target.z - player.z);
    const b = bearing(player.x, player.z, target.x, target.z);
    nav = { d, b, rel: b - player.heading, dir: dirName(b), h: target.y != null ? heightText(target.y - player.y) : null };
  }

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <header className="top">
        <div className="brand"><span className="flame">✦</span>EMBERVALE<span className="dot">{t('app.brand_suffix')}</span></div>
        <div className={`live ${player.status}`}><i />{statusText}</div>
        <button className="btn reloc" title={t('top.relocate_title')} onClick={() => { live.current.have = false; relocate(); }}>{t('top.relocate')}</button>
        {isLive && <div className="coords">X {Math.round(player.x)} · Z {Math.round(player.z)} · {t('top.alt', { n: Math.round(player.y) })}</div>}
      </header>
      {alertBar}
      <aside className="side">
        <Sidebar data={data} tab={tab} setTab={setTab} query={query} setQuery={setQuery}
          results={results.map((r) => ({ ...r, dist: isLive ? m(Math.hypot(r.x - player.x, r.z - player.z)) : null }))}
          onPick={(r, fly) => { if (fly !== false) flyTo(r.x, r.z); setTarget({ n: r.n, x: r.x, z: r.z, y: r.y ?? null, icon: r.icon }); }}
          allH={allH} setAllH={setAllH} chestLv={chestLv} setChestLv={setChestLv} visible={visible || {}} setVisible={setVisible} names={names} setNames={setNames} hideFound={hideFound} setHideFound={setHideFound}
          found={found} labelCounts={labelCounts} finders={finders} setFinders={setFinders} activities={activities} setActivities={setActivities}
          radius={radius} setRadius={setRadius} dungeon={dungeon} setDungeon={setDungeon} dungeonH={dungeonH} setDungeonH={setDungeonH} nearbyCount={nearby.length} follow={follow} setFollow={setFollow} fog={fog} setFog={setFog}
          onExport={onExport} onImport={onImport} findIndex={findIndex} surfaceOnly={surfaceOnly} setSurfaceOnly={setSurfaceOnly}
          pinsBox={(
          <div className="pinsbox">
            <div className={`gamestate ${gamePins ? 'on' : ''}`}>{gamePins ? t('pins.linked', { n: gamePins.length }) : isLive ? `${t('pins.connecting')}${gameErr ? ` (${gameErr})` : ''}` : t('pins.game_closed')}</div>
            <div className="row">
              <input className="pinname" placeholder={t('pins.name_placeholder')} value={pinName} onChange={(e) => setPinName(e.target.value)} maxLength={120} />
            </div>
            <div className="row">
              <button className={`btn ${pinMode ? 'on' : ''}`} onClick={() => setPinMode(!pinMode)}>{pinMode ? t('pins.mode_on') : t('pins.mode_off')}</button>
              <button className="btn" disabled={!isLive} title={t('pins.here_title')} onClick={() => addPin(player.x, player.z, player.y)}>{t('pins.here')}</button>
            </div>
            <p className="hint">{t('pins.hint')}</p>
            {(gamePins || []).map((q) => { const k = pinKey(q), done = pinsDone.includes(k); return (
              <div key={`g${q.indice}`} className={`pinrow${done ? ' done' : ''}`}>
                <i style={{ background: '#ffd34d' }} />
                {editPin === pinKey(q) ? <input className="renin" autoFocus defaultValue={q.n} maxLength={128} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { const v = ev.currentTarget.value.trim(); setEditPin(null); if (v && v !== q.n) renamePin({ ...q, kind: 'game' }, v); } else if (ev.key === 'Escape') setEditPin(null); }} onBlur={() => setEditPin(null)} /> : <span className="pn" title={t('pins.dblclick')} onDoubleClick={() => setEditPin(pinKey(q))}>{q.n}</span>}
                <small>{isLive ? m(Math.hypot(q.x - player.x, q.z - player.z)) : ''}</small>
                <button title={t('pins.rename_game')} onClick={() => setEditPin(pinKey(q))}>✏</button>
                <button title={t('pins.go')} onClick={() => { flyTo(q.x, q.z); setTarget({ n: q.n, x: q.x, z: q.z, y: null, icon: '#ffd34d' }); }}>➜</button>
                <button title={t('pins.done')} onClick={() => toggleDone(q)}>✓</button>
                <button title={t('pins.delete_game')} onClick={() => removeGamePin(q)}>🗑</button>
              </div>
            ); })}
            {pending.map((q) => (
              <div key={q.id} className="pinrow pend">
                <i style={{ background: '#9aa3ad' }} title={t('pins.tag_pending')} />
                {editPin === pinKey(q) ? <input className="renin" autoFocus defaultValue={q.n} maxLength={128} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { const v = ev.currentTarget.value.trim(); setEditPin(null); if (v && v !== q.n) renamePin({ ...q, kind: 'pend' }, v); } else if (ev.key === 'Escape') setEditPin(null); }} onBlur={() => setEditPin(null)} /> : <span className="pn" onDoubleClick={() => setEditPin(pinKey(q))}>{q.n} <small>{t('pins.pending')}</small></span>}
                <button title={t('pins.rename')} onClick={() => setEditPin(pinKey(q))}>✏</button>
                <button title={t('pins.go')} onClick={() => { flyTo(q.x, q.z); setTarget({ n: q.n, x: q.x, z: q.z, y: q.y ?? null, icon: '#9aa3ad' }); }}>➜</button>
                <button title={t('pins.delete')} onClick={() => setPending((a) => a.filter((r) => r.id !== q.id))}>🗑</button>
              </div>
            ))}
            {filePins.length > 0 && <h3 className="pinh">{t('pins.file', { n: filePins.length })}</h3>}
            {filePins.map((q) => { const k = pinKey(q), done = pinsDone.includes(k); return (
              <div key={k} className={`pinrow${done ? ' done' : ''}`}>
                <i style={{ background: q.cor || '#ffd34d' }} />
                {editPin === pinKey(q) ? <input className="renin" autoFocus defaultValue={q.n} maxLength={128} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { const v = ev.currentTarget.value.trim(); setEditPin(null); if (v && v !== q.n) renamePin({ ...q, kind: 'file' }, v); } else if (ev.key === 'Escape') setEditPin(null); }} onBlur={() => setEditPin(null)} /> : <span className="pn" title={q.d || ''} onDoubleClick={() => setEditPin(pinKey(q))}>{q.n}</span>}
                <button title={t('pins.rename')} onClick={() => setEditPin(pinKey(q))}>✏</button>
                <small>{isLive ? m(Math.hypot(q.x - player.x, q.z - player.z)) : ''}</small>
                <button title={t('pins.go')} onClick={() => { flyTo(q.x, q.z); setTarget({ n: q.n, x: q.x, z: q.z, y: q.y ?? null, icon: q.cor || '#ffd34d' }); }}>➜</button>
                <button title={t('pins.done')} onClick={() => toggleDone(q)}>✓</button>
                <button title={t('pins.delete')} onClick={() => removeFilePin(q)}>🗑</button>
              </div>
            ); })}
          </div>
          )}
          liveBox={(
          <div className="livebox">
            <div className="stat"><span>{t('live.character')}</span><b>{character?.name || '—'}</b></div>
            <div className="stat"><span>{t('live.situation')}</span><b className={`st ${player.status}`}>{statusText}</b></div>
            <div className="stat"><span>{t('live.position')}</span><b>{isLive ? `X ${player.x.toFixed(1)} · Z ${player.z.toFixed(1)}` : '—'}</b></div>
            <div className="stat"><span>{t('live.height')}</span><b>{isLive ? t('unit.m', { n: player.y.toFixed(1) }) : '—'}</b></div>
            <div className="stat"><span>{t('live.heading')}</span><b>{isLive ? dirName(player.heading) : '—'}</b></div>
            <div className="row">
              <button className="btn" disabled={!isLive} onClick={() => { setFollow(true); mapRef.current.flyTo(toLL(player.x, player.z), Math.max(mapRef.current.getZoom(), 4.5), { duration: 0.6 }); }}>{t('live.center')}</button>
              <label className="chk"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{t('live.follow')}</label>
            </div>
            <div className="stat"><span>{t('live.flame_level')}</span><b><input className="num" type="number" min="1" max="20" value={flame} onChange={(e) => setFlame(+e.target.value || 1)} /></b></div>
            <div className="stat"><span>{t('live.isolines')}</span><b><input className="num" type="number" min="2" max="64" value={spacing} onChange={(e) => setSpacing(+e.target.value || 8)} /> m</b></div>
            <p className="foot">{t('live.foot')}</p>
          </div>
          )} />
      </aside>
      <main className="mapwrap">
        <button className="collapse" onClick={() => { setCollapsed(!collapsed); setTimeout(() => mapRef.current.invalidateSize(), 220); }}>{collapsed ? '›' : '‹'}</button>
        <div id="map" />
        {target && (
          <div className="nav">
            <div className="navhead">
              {target.img ? <img src={`./${target.img}`} /> : target.icon && !target.icon.startsWith('#') ? <img src={icSrc(target.icon)} /> : <span className="dotc" style={{ background: target.icon || '#f0c25a' }} />}
              <b>{label(target)}{targetMob ? ` · ${t('tip.hp', { hp: targetMob.hp, max: targetMob.hp_max })}` : target.mobId ? ` · ${targetCorpse ? t('nav.dead') : t('nav.gone')}` : ''}</b>
              <button onClick={() => flyTo(target.x, target.z)} title={t('nav.view')}>⌖</button>
              <button onClick={() => setTarget(null)} title={t('nav.remove')}>✕</button>
            </div>
            {nav ? (
              <div className="navbody">
                <div className="dist">{m(nav.d)}</div>
                <div className="dir"><span className="arrow"><Arrow angle={nav.b} /></span>{nav.dir}</div>
                <div className="dir rel"><span className="arrow"><Arrow angle={nav.rel} /></span>{t('nav.relative')}</div>
                {nav.h ? <div className={`hgt ${nav.h.c}`}>{nav.h.c === 'up' ? '▲' : nav.h.c === 'down' ? '▼' : '='} {nav.h.t}</div> : <div className="hgt lvl">{t('height.unknown')}</div>}
              </div>
            ) : <div className="navbody wait">{t('nav.waiting')}</div>}
          </div>
        )}
        {activities && (
          <div className="near">
            <h4>{t('near.title')} <span>{t('unit.m', { n: radius })}{dungeon ? ` · ±${t('unit.m', { n: dungeonH })}` : ''}</span></h4>
            <label className="taken-t" title={t('near.hide_taken_title')}>
              <input type="checkbox" checked={hideTaken} onChange={(e) => setHideTaken(e.target.checked)} /> {t('near.hide_taken')}
            </label>
            <div className="ngroups">
              {NEAR_GROUPS.map((g) => (
                <button key={g.id} className={nearOff.includes(g.id) ? 'off' : ''} onClick={() => setNearOff((o) => (o.includes(g.id) ? o.filter((x) => x !== g.id) : [...o, g.id]))} title={nearOff.includes(g.id) ? t('near.show') : t('near.hide')}>
                  <i style={{ background: g.color }} />{t(`ng.${g.id}`)}
                </button>
              ))}
            </div>
            <input className="nsearch" type="search" placeholder={t('near.search')} value={nearQ} onChange={(e) => setNearQ(e.target.value)} />
            {hiddenNear.length > 0 && (
              <div className="hidn">
                <button className="hidn-t" onClick={() => setShowHidden(!showHidden)}><Eye off /> {tc('near.hidden', hiddenNear.length)} {showHidden ? '▴' : '▾'}</button>
                {showHidden && hiddenNear.length > 6 && <input className="nsearch" type="search" placeholder={t('near.hidden_search')} value={hidQ} onChange={(e) => setHidQ(e.target.value)} />}
                {showHidden && hiddenNear.filter((n) => !hidQ.trim() || fmatch(hidQ, n, showName(n))).map((n) => (
                  <button key={n} className="hidn-i" onClick={() => toggleHidden(n)} title={t('near.show_again')}>
                    {hiddenMeta[n]?.img ? <img src={`./${hiddenMeta[n].img}`} /> : hiddenMeta[n]?.icon && !hiddenMeta[n].icon.startsWith('#') ? <img src={icSrc(hiddenMeta[n].icon)} /> : <span className="dotc" style={{ background: hiddenMeta[n]?.icon || '#7fe0ff' }} />}
                    <span className="nm">{showName(n)}</span><Eye />
                  </button>
                ))}
              </div>
            )}
            {!isLive && <p className="wait">{t('nav.waiting')}</p>}
            {isLive && nearby.length === 0 && <p className="wait">{t('near.nothing')}</p>}
            <div className="list">
              {nearby.slice(0, 60).map((it, i) => {
                const h = heightText(it.y - player.y);
                return (
                  <button key={i} className={it.st === 'pego' || it.st === 'aberto' || it.st === 'acionado' || it.st === 'vazio' || it.st === 'ausente' ? 'taken' : ''} title={it.st === 'pego' ? t('st.taken') : it.st === 'aberto' ? t('st.opened') : it.st === 'acionado' ? t('st.triggered') : it.st === 'vazio' ? t('st.empty') : it.st === 'ausente' ? t('st.absent') : undefined} onClick={() => setTarget({ n: it.n, x: it.x, z: it.z, y: it.y, icon: it.icon, img: it.img, mobId: it.mobId, kind: it.kind, loot: it.loot, sp: it.sp, tplL: it.tplL })}>
                    {it.img ? <img src={`./${it.img}`} /> : it.icon && !it.icon.startsWith('#') ? <img src={icSrc(it.icon)} /> : <span className={it.kind === 'chest' || it.chest ? 'dotc sq' : it.kind === 'mob' || it.kind === 'logic' ? 'dotc mob' : 'dotc'} style={{ background: it.icon || '#7fe0ff' }} />}
                    <span className="nm">{label(it)}{it.hp != null ? ` ${it.hp}/${it.hpMax}` : ''}</span>
                    <span className={`h ${h.c}`}>{h.c === 'up' ? '▲' : h.c === 'down' ? '▼' : ''}{h.c !== 'lvl' ? Math.round(Math.abs(it.y - player.y)) : ''}</span>
                    <span className="ar"><Arrow angle={bearing(player.x, player.z, it.x, it.z)} size={16} /></span>
                    <span className="dd">{m(it.d)}</span>
                    <span className="eye" role="button" title={t('near.hide_item')} onClick={(e) => { e.stopPropagation(); toggleHidden(it.n, it); }}><Eye off /></span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
        {dismissed.length > 0 && (
          <button className="dchip" onClick={() => setDismissed([])} title={t('dchip.title')}>
            {tc('dchip.text', dismissed.length)}
          </button>
        )}
        <div className="zoom">
          <button onClick={() => mapRef.current.zoomIn()}>+</button>
          <button onClick={() => mapRef.current.zoomOut()}>−</button>
          <button className={follow ? 'on' : ''} title={t('live.follow')} disabled={!isLive} onClick={() => setFollow(true)}>◎</button>
        </div>
      </main>
    </div>
  );
}

function Eye({ off }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

function hText(dy) {
  const c = Math.abs(dy) < 2.5 ? 'lvl' : dy > 0 ? 'up' : 'down';
  return `<em class="th ${c}">${c === 'lvl' ? t('height.same_you') : `${c === 'up' ? '▲' : '▼'} ${t(c === 'up' ? 'height.above_you' : 'height.below_you', { n: Math.round(Math.abs(dy)) })}`}</em>`;
}

// etiqueta "50 m abaixo" / "12 m acima" / "mesmo nível" ao lado do ícone
function hBadge(dy) {
  const c = Math.abs(dy) < 2.5 ? 'lvl' : dy > 0 ? 'up' : 'down';
  const txt = c === 'lvl' ? t('height.same') : t(c === 'up' ? 'height.above' : 'height.below', { n: Math.round(Math.abs(dy)) });
  return `<b class="hb ${c}">${c === 'up' ? '▲ ' : c === 'down' ? '▼ ' : ''}${txt}</b>`;
}

const CHEST_PIN = { gold: 'et/pins/chest-gold.png', silver: 'et/pins/chest-silver.png', wood: 'et/pins/chest-wood.png' };

// ícone desenhado direto no canvas do Leaflet (DOM com milhares de <img> trava o mapa)
const imgCache = new Map();
function imgFor(src) {
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.src = `./${src}`; im.waiting = []; im.onload = () => { for (const l of im.waiting) l.redraw(); im.waiting = []; }; imgCache.set(src, im); }
  return im;
}
const ImgMarker = L.CircleMarker.extend({
  options: { size: 24, radius: 12, stroke: false, fill: false },
  _updatePath() {
    const im = this.options.img, s = this.options.size, p = this._point, ctx = this._renderer._ctx;
    if (!im.complete || !im.naturalWidth) { im.waiting.push(this); return; }
    ctx.save();
    ctx.globalAlpha = this.options.opacity ?? 1;
    if (this.options.ring) { // contorno para ícones difíceis de ver (Essência Arcaica): disco escuro + anel brilhante
      const r = s * 0.62;
      ctx.globalAlpha = Math.max(0.85, ctx.globalAlpha); // o anel aparece mesmo no depósito enterrado (esmaecido)
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0b0b10d9'; ctx.fill();
      ctx.shadowColor = this.options.ring; ctx.shadowBlur = 8;
      ctx.lineWidth = 2.5; ctx.strokeStyle = this.options.ring; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = this.options.opacity ?? 1;
    }
    ctx.shadowColor = '#000c'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    ctx.drawImage(im, p.x - s / 2, p.y - s / 2, s, s);
    ctx.restore();
  },
  setOpacity(o) { this.options.opacity = o; this.redraw(); },
});

// ponto escondido com F8? (mesma posição, tolerância de 1,5 m)
function isDismissed(ds, x, z) {
  for (const d of ds) if (Math.abs(d.x - x) < 1.5 && Math.abs(d.z - z) < 1.5) return true;
  return false;
}

// grupos do painel "Atividades em tempo real" (filtro por tipo); o nome mostrado é t('ng.<id>')
const NEAR_GROUPS = [
  { id: 'mob', color: '#e0533a' },
  { id: 'chest', color: '#cfd4dc' },
  { id: 'item', color: '#f2c14e' },
  { id: 'logic', color: '#ffd34d' },
  { id: 'res', color: '#7fbf6a' },
  { id: 'loot', color: '#ff9d4d' },
  { id: 'mark', color: '#6fd3ff' },
];

// ícone de nome de lugar (refeito ao trocar de idioma)
const placeIcon = (l) => L.divIcon({ className: `place t${l.t || 1}`, html: `<span>${tn(l.n)}</span>`, iconSize: null });
function nearGroup(it) {
  if (it.kind === 'mob' || it.kind === 'alive') return 'mob';
  if (it.kind === 'chest' || it.chest || (it.kind || '').startsWith('chest')) return 'chest';
  if (it.kind === 'item') return 'item';
  if (it.kind === 'logic') return 'logic';
  if (it.kind === 'res') return 'res';
  if (it.kind === 'loot' || it.kind === 'loose') return 'loot';
  return 'mark';
}
