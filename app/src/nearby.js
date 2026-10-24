// Índice espacial do nearby.bin (tudo que dá para coletar no mundo) + marcadores do data.json.
import { t } from './i18n.js';
const CELL = 64;
// ícone dos recursos do mundo pelo que eles dão
const RES_IMG = { 'Árvore': 'et/items/wood-logs.webp', 'Galhos/tronco caído': 'et/items/twigs.webp', 'Arbusto': 'et/items/twigs.webp', 'Pedra (recurso)': 'items/stone.webp' };
const CHEST = { 'Baú de Ouro': 'et/pins/chest-gold.png', 'Baú de Prata': 'et/pins/chest-silver.png', 'Baú de Madeira': 'et/pins/chest-wood.png' }; // pinos do enshrouded.tools

export async function loadNearby(points, cats) {
  const buf = await (await fetch('./nearby.bin')).arrayBuffer();
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const n = (buf.byteLength - 4 - hl) / 14;
  const grid = new Map();
  const items = [];
  const add = (it) => {
    const k = `${Math.floor(it.x / CELL)},${Math.floor(it.z / CELL)}`;
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(items.length);
    items.push(it);
  };
  const catMap = Object.fromEntries(cats.map((c) => [c.id, c]));
  // baús: os do jogo (nearby.bin) têm a altura exata, então valem em todo lugar;
  // os do site só entram onde o jogo não tem baú a menos de 6 m
  const chestCell = new Set();
  const cellKey = (x, z) => `${Math.round(x / 6)},${Math.round(z / 6)}`;
  const hasChest = (x, z) => { const a = Math.round(x / 6), b = Math.round(z / 6); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (chestCell.has(`${a + i},${b + j}`)) return true; return false; };
  const resGrid = new Map(); // célula -> offsets dos registros no buffer
  let o = 4 + hl;
  for (let i = 0; i < n; i++, o += 14) {
    const l = head.labels[dv.getUint16(o + 12, true)];
    const x = dv.getFloat32(o, true), z = dv.getFloat32(o + 4, true), y = dv.getFloat32(o + 8, true);
    if (l.k === 'chest') {
      chestCell.add(cellKey(x, z));
      add({ x, z, y, n: l.n, kind: 'chest', icon: CHEST[l.n.replace(' (trancado, gazua)', '')] || '#a58fc9' });
      continue;
    }
    if (l.k === 'logic') { add({ x, z, y, n: l.n, kind: 'logic', icon: '#ffd34d' }); continue; }
    if (l.k === 'res') { // ~730 mil árvores/arbustos/pedras: guardados compactos, viram objeto só na consulta
      const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      let a = resGrid.get(k);
      if (!a) resGrid.set(k, (a = []));
      a.push(o);
      continue;
    }
    add({ x, z, y, n: l.n, kind: 'item', img: l.img });
  }
  // pontos de surgimento de criaturas (enshrouded.tools + altura do jogo)
  try {
    const mobs = await (await fetch('./mobs.json')).json();
    for (const [x, z, y, ni] of mobs.pts) {
      const m = mobs.names[ni];
      add({ x, z, y, n: m.n, kind: 'mob', boss: m.boss, img: m.img, icon: m.boss ? '#ff4d2e' : '#e0533a' });
    }
  } catch {}
  for (const p of points) {
    if (['grapple', 'updraft', 'jump-pad', 'hint'].includes(p.c)) continue;
    if ((p.c.startsWith('chest') || p.gk === 'chest') && hasChest(p.x, p.z)) continue; // o baú do jogo já está na lista (com estado ao vivo)
    // porta secreta ligada à porta do jogo (p.g): posição exata, para o estado ao vivo (já usada = some)
    if (p.c === 'secret-door' && p.g) { add({ x: p.g[0], z: p.g[1], y: p.y, n: p.n, kind: 'door', icon: catMap[p.c].icon }); continue; }
    add({ x: p.x, z: p.z, y: p.y, n: p.n, kind: p.c, icon: catMap[p.c].icon, img: p.img, chest: p.c.startsWith('chest') });
  }
  const byLabel = new Map();
  items.forEach((it, i) => { if (it.kind === 'item') { let a = byLabel.get(it.n); if (!a) byLabel.set(it.n, (a = [])); a.push(i); } });
  return {
    labelCounts() { return [...byLabel.entries()].map(([n, a]) => ({ n, count: a.length })).sort((a, b) => b.count - a.count); },
    byName(n) { return (byLabel.get(n) || []).map((i) => items[i]); },
    query(x, z, r) {
      const out = [];
      const c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL);
      const r0 = Math.floor((z - r) / CELL), r1 = Math.floor((z + r) / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const a = grid.get(`${cx},${cz}`);
          if (!a) continue;
          for (const i of a) {
            const it = items[i];
            const d = Math.hypot(it.x - x, it.z - z);
            if (d <= r) out.push({ ...it, d });
          }
          const ra = resGrid.get(`${cx},${cz}`);
          if (ra) for (const ro of ra) {
            const rx = dv.getFloat32(ro, true), rz = dv.getFloat32(ro + 4, true);
            const d = Math.hypot(rx - x, rz - z);
            if (d <= r) { const n = head.labels[dv.getUint16(ro + 12, true)].n; out.push({ x: rx, z: rz, y: dv.getFloat32(ro + 8, true), n, kind: 'res', icon: '#7fbf6a', img: RES_IMG[n], d }); }
          }
        }
      }
      return out.sort((a, b) => a.d - b.d);
    },
  };
}

const DIRS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']; // chaves dir.* do i18n
export const bearing = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz); // 0 = norte (+z), horário
export const dirName = (b) => t(`dir.${DIRS[((Math.round(b / (Math.PI / 4)) % 8) + 8) % 8]}`);
export function heightText(dy) {
  if (Math.abs(dy) < 2.5) return { t: t('height.same'), c: 'lvl' };
  return dy > 0 ? { t: t('height.above', { n: Math.round(dy) }), c: 'up' } : { t: t('height.below', { n: Math.round(-dy) }), c: 'down' };
}
