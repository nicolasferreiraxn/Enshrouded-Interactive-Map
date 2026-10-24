// Busca tolerante: sem acento, palavras em qualquer ordem, aceita variações ("caida" ~ "caído",
// "monstruosidade" ~ "monstruoso") e procura também no nome em inglês.
export const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
function pre(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
const wordHit = (q, w) => w.startsWith(q) || (q.length >= 4 && pre(q, w) >= Math.max(4, Math.min(q.length, w.length) - 2));
export function fmatch(q, ...texts) {
  const nq = norm(q).trim();
  if (!nq) return true;
  const qw = words(q);
  for (const t of texts) {
    if (!t) continue;
    if (norm(t).includes(nq)) return true;
    const tw = words(t);
    if (qw.every((a) => tw.some((w) => wordHit(a, w)))) return true;
  }
  return false;
}

// ícone de categoria/marcador: nome do ícone do jogo (public/icons) ou caminho (ex.: et/pins/x.png)
export const icSrc = (icon) => (icon.includes('/') ? `./${icon}` : `./icons/${icon}.png`);
