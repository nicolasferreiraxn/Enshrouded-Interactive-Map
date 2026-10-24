import { icSrc } from './match.js';
import React, { useEffect, useMemo, useState } from 'react';
import { norm, fmatch } from './match.js';
import { t, tc, tn, fmtNum, LANGS, getLang, setLang, useLang } from './i18n.js';

const fmt = fmtNum;
const KIND_COLOR = { spawns: '#e0533a', gather: '#f2c14e', ore: '#5fd3c4', chests: '#f2c14e' };
const NOUN = (kind) => t(`noun.${kind}`); // spawns, gather, ore, chests

function Ores({ findIndex, finders, toggleFinder, surfaceOnly, setSurfaceOnly }) {
  const [more, setMore] = useState(false);
  if (!findIndex?.ore) return null;
  const all = Object.entries(findIndex.ore).map(([slug, e]) => ({ ...e, kind: 'ore', slug }));
  const main = all.filter((e) => !e.more).sort((a, b) => a.order - b.order);
  const extra = all.filter((e) => e.more).sort((a, b) => b.c - a.c);
  const total = main.reduce((t, e) => t + e.c, 0);
  const row = (e) => {
    const on = finders.some((f) => f.kind === 'ore' && f.slug === e.slug);
    return (
      <div key={e.slug} className={`cat ${on ? '' : 'off'}`} title={tn(e.n)} style={{ '--sw': e.color }} onClick={() => toggleFinder(e)}>
        <i className="sw" />{e.img ? <img src={`./${e.img}`} /> : null}<span className="label">{tn(e.n)}</span><span className="count">{fmt(e.c)}</span>
      </div>
    );
  };
  return (
    <section id="ores" className="group">
      <h2><span>{t('ores.title')}</span><small>{t('ores.count', { n: fmt(total) })}</small></h2>
      <label className="surf"><input type="checkbox" checked={surfaceOnly} onChange={(ev) => setSurfaceOnly(ev.target.checked)} /> {t('ores.surface')}</label>
      <div className="cats">{main.map(row)}</div>
      <button className="more" onClick={() => setMore(!more)}>{more ? '▾' : '›'} {t('ores.more', { n: extra.length })}</button>
      {more && <div className="cats">{extra.map(row)}</div>}
    </section>
  );
}

const SWATCH = ['#e0533a', '#f39237', '#f6d32d', '#b8e01f', '#36e0d0', '#46cde3', '#2f55d4', '#a65fe3', '#ec7d7d', '#efe4cc'];

function Quests({ onGo }) {
  const [quests, setQuests] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState(null);
  useLang();
  useEffect(() => { fetch('./quests.json').then((r) => r.json()).then(setQuests); }, []);
  if (!quests) return <p className="muted">{t('quests.loading')}</p>;
  if (view) {
    return (
      <div className="questview">
        <button className="back" onClick={() => setView(null)}>{t('quests.back')}</button>
        <h2>{tn(view.n)}</h2>
        {view.steps.map((s, i) => (
          <div key={i} className={`step ${s.x != null ? 'has' : ''}`} onClick={() => s.x != null && onGo({ n: s.n || view.n, x: s.x, z: s.z, y: s.y ?? null })}>
            <b>{i + 1}. {tn(s.n)}</b>
            {s.x != null && <span className="go">{t('quests.view')}</span>}
            <p>{tn(s.txt)}</p>
          </div>
        ))}
      </div>
    );
  }
  const nq = norm(q);
  return (
    <>
      <input className="search" type="search" placeholder={t('quests.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {quests.map((g) => {
        const list = g.quests.filter((x) => !nq || norm(x.n).includes(nq) || norm(g.g).includes(nq) || norm(tn(x.n)).includes(nq) || norm(tn(g.g)).includes(nq));
        if (!list.length) return null;
        return (
          <section key={g.g} className="qgroup">
            <h2><span>{tn(g.g)}</span><small>{list.length}</small></h2>
            {list.map((x, i) => (
              <div key={i} className={`qrow ${x.steps.some((s) => s.x != null) ? '' : 'elsewhere'}`} onClick={() => setView(x)}>
                <span className="t">{tn(x.n)}</span><span className="lv">{tc('quests.steps', x.steps.length)}</span>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}

export default function Sidebar(p) {
  const { data, tab, setTab, query, setQuery, results, onPick, visible, setVisible, names, setNames, hideFound, setHideFound,
    found, labelCounts, finders, setFinders, activities, setActivities, radius, setRadius, dungeon, setDungeon, dungeonH, setDungeonH, nearbyCount, follow, setFollow,
    fog, setFog, liveBox, pinsBox, allH, setAllH, chestLv, setChestLv, onExport, onImport, findIndex, surfaceOnly, setSurfaceOnly } = p;
  const lv = useLang(); // muda ao trocar de idioma (dependência dos useMemo com texto)
  const toggleFinder = (e) => {
    const on = finders.some((f) => f.kind === e.kind && f.slug === e.slug);
    setFinders(on ? finders.filter((f) => !(f.kind === e.kind && f.slug === e.slug)) : [...finders, e]);
  };
  const addFinders = (list) => setFinders([...finders, ...list.filter((e) => !finders.some((f) => f.kind === e.kind && f.slug === e.slug))]);
  const [drops, setDrops] = useState(null);
  useEffect(() => { fetch('./drops.json').then((r) => r.json()).then(setDrops).catch(() => {}); }, []);
  const mobEntry = (slug) => { const e = findIndex?.spawns?.[slug]; return e && { ...e, kind: 'spawns', slug, color: KIND_COLOR.spawns }; };
  // itens que criaturas dropam e batem com a busca
  const dropMatches = (q) => (!drops || q.trim().length < 3 ? [] : Object.entries(drops.items).filter(([n]) => fmatch(q, n, tn(n)))
    .map(([n, d]) => ({ n, img: d.img, by: d.by.map(mobEntry).filter(Boolean).sort((a, b) => (b.boss ? 1 : 0) - (a.boss ? 1 : 0) || b.c - a.c) })).slice(0, 6));
  const [open, setOpen] = useState({});
  const [findQ, setFindQ] = useState('');
  const groups = useMemo(() => {
    if (!data) return [];
    const g = [];
    for (const c of data.cats) { let e = g.find((x) => x.name === c.group); if (!e) g.push((e = { name: c.group, cats: [] })); e.cats.push(c); }
    return g;
  }, [data]);
  const [fopen, setFopen] = useState({ Chefes: true, Criaturas: true });
  const findGroups = useMemo(() => {
    if (!findIndex) return [];
    const q = findQ.trim();
    const abc = (a, b) => tn(a.n).localeCompare(tn(b.n), getLang()); // ordem alfabética do nome mostrado
    const pick = (kind) => Object.entries(findIndex[kind] || {}).map(([slug, e]) => ({ ...e, kind, slug, color: e.color || KIND_COLOR[kind] }))
      .filter((e) => q.length < 2 || fmatch(q, e.n, e.en, tn(e.n)));
    const out = [];
    for (const d of dropMatches(q)) out.push({ title: `${d.n} — dropa de`, label: t('find.drops_from', { item: tn(d.n) }), drop: d, list: d.by, sub: [{ t: '', list: d.by }] });
    const sp = pick('spawns');
    const bo = sp.filter((e) => e.boss).sort(abc), cr = sp.filter((e) => !e.boss).sort(abc);
    if (bo.length) out.push({ title: 'Chefes', label: t('find.bosses'), list: bo, sub: [{ t: '', list: bo }] });
    if (cr.length) out.push({ title: 'Criaturas', label: t('find.creatures'), list: cr, sub: [{ t: '', list: cr }] });
    const ga = pick('gather').sort(abc);
    if (ga.length) {
      const by = {};
      ga.forEach((e) => { (by[e.g || 'Outros'] ||= []).push(e); });
      out.push({ title: 'Plantas e itens', label: t('find.plants'), list: ga, sub: Object.entries(by).map(([t, list]) => ({ t, list })) });
    }
    const ch = pick('chests').sort((a, b) => b.c - a.c);
    if (ch.length) out.push({ title: 'Em baús', label: t('find.chests'), list: ch, sub: [{ t: '', list: q.length < 2 ? ch.slice(0, 120) : ch.slice(0, 60) }] });
    return out;
  }, [findIndex, findQ, drops, lv]);
  const findHits = useMemo(() => {
    if (!findIndex || query.trim().length < 3) return [];
    const out = [];
    for (const kind of ['spawns', 'gather', 'ore', 'chests'])
      for (const [slug, e] of Object.entries(findIndex[kind] || {}))
        if (fmatch(query, e.n, e.en, tn(e.n))) out.push({ ...e, kind, slug, color: e.color || KIND_COLOR[kind] });
    return out.sort((a, b) => (b.boss ? 1 : 0) - (a.boss ? 1 : 0) || b.c - a.c).slice(0, 8);
  }, [findIndex, query, lv]);
  const dropHits = useMemo(() => dropMatches(query), [drops, query, findIndex, lv]);
  if (!data) return null;
  const setAll = (v) => setVisible(Object.fromEntries(data.cats.map((c) => [c.id, v])));
  const toggleGroup = (g) => { const on = g.cats.some((c) => !visible[c.id]); const nv = { ...visible }; g.cats.forEach((c) => { nv[c.id] = on; }); setVisible(nv); };
  const total = data.points.length;
  const shown = data.points.filter((pt) => visible?.[pt.c]).length;
  const foundCount = found.size;
  return (
    <div className="inner">
      <header className="sbhead">
        <h1><img src="./icons/logo_enshrouded.png" alt="Enshrouded" /></h1>
        <p className="eyebrow">{t('side.eyebrow')}</p>
        <select className="langsel" value={getLang()} title={t('lang.title')} aria-label={t('lang.title')} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </header>
      <div className="tabs" role="tablist">
        <button className={tab === 'markers' ? 'on' : ''} onClick={() => setTab('markers')}>{t('tab.markers')}</button>
        <button className={tab === 'quests' ? 'on' : ''} onClick={() => setTab('quests')}>{t('tab.quests')}</button>
        <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>{t('tab.live')}</button>
        <button className={tab === 'pins' ? 'on' : ''} onClick={() => setTab('pins')}>{t('tab.pins')}</button>
      </div>

      {tab === 'quests' && <div id="panel-quests"><Quests onGo={onPick} /></div>}
      {tab === 'live' && liveBox}
      {tab === 'pins' && pinsBox}

      {tab === 'markers' && (
        <div id="panel-markers">
          <div className="searchbox">
            <input className="search" type="search" placeholder={t('search.placeholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
            {(results.length > 0 || findHits.length > 0 || dropHits.length > 0) && (
              <div className="results">
                {dropHits.map((d) => (
                  <button key={'drop' + d.n} onClick={() => addFinders(d.by)}>
                    {d.img ? <img src={`./${d.img}`} /> : <span className="dotc" style={{ background: '#e0533a' }} />}
                    <b>{tn(d.n)}</b><small>{t('search.drops_from', { list: d.by.slice(0, 4).map((m) => tn(m.n)).join(', ') })}{d.by.length > 4 ? ` +${d.by.length - 4}` : ''} · {t('search.show_on_map')}</small>
                  </button>
                ))}
                {findHits.map((f) => {
                  const on = finders.some((x) => x.kind === f.kind && x.slug === f.slug);
                  return (
                    <button key={f.kind + f.slug} className={on ? 'fon' : ''} onClick={() => toggleFinder(f)}>
                      {f.img ? <img src={`./${f.img}`} /> : <span className="dotc" style={{ background: f.color }} />}
                      <b>{tn(f.n)}</b><small>{f.en && f.en !== tn(f.n) ? `${f.en} · ` : ''}{fmt(f.c)} {NOUN(f.kind)} · {on ? t('search.on_map') : t('search.show_on_map')}</small>
                    </button>
                  );
                })}
                {results.map((r, i) => (
                  <button key={i} onClick={() => onPick(r, true)}>
                    {r.icon && !r.icon.startsWith('#') ? <img src={icSrc(r.icon)} /> : <span className="dotc" style={{ background: r.icon || '#d8c9a6' }} />}
                    <b>{tn(r.n)}</b><small>{tn(r.label)}{r.dist ? ` · ${r.dist}` : ''}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="tools">
            <button onClick={() => setAll(true)}>{t('tools.show_all')}</button>
            <button onClick={() => setAll(false)}>{t('tools.hide_all')}</button>
            <label><input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> {t('tools.place_names')}</label>
            <label><input type="checkbox" checked={hideFound} onChange={(e) => setHideFound(e.target.checked)} /> {t('tools.hide_found')}</label>
            <label title={t('tools.all_heights_title')}><input type="checkbox" checked={allH} onChange={(e) => setAllH(e.target.checked)} /> {t('tools.all_heights')}</label>
            <label className="chestlv" title={t('tools.chest_level_title')}>{t('tools.chest_level')}
              <select value={chestLv[0]} onChange={(e) => setChestLv([+e.target.value, Math.max(+e.target.value, chestLv[1])])}>{[5, 10, 13, 15, 20, 27, 30, 35, 40, 45, 50].map((v) => <option key={v} value={v}>{v}</option>)}</select>
              {t('tools.to')}
              <select value={chestLv[1]} onChange={(e) => setChestLv([Math.min(chestLv[0], +e.target.value), +e.target.value])}>{[5, 10, 13, 15, 20, 27, 30, 35, 40, 45, 50].map((v) => <option key={v} value={v}>{v}</option>)}</select>
            </label>
            <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t('live.follow')}</label>
            <label><input type="checkbox" checked={fog} onChange={(e) => setFog(e.target.checked)} /> {t('tools.fog')}</label>
          </div>
          <div id="find-note">
            <h4>{t('filter.title')}</h4>
            {finders.length === 0 && <p className="empty">{t('filter.empty')}</p>}
            {finders.map((f) => (
              <div key={f.kind + f.slug}>
                <span style={{ '--dot': f.color }}>{f.img ? <img src={`./${f.img}`} /> : <i className="d" />}{tn(f.n)}: {fmt(f.c)} {NOUN(f.kind)}</span>
                <button onClick={() => toggleFinder(f)}>{t('filter.off')}</button>
              </div>
            ))}
            {finders.length > 0 && <button className="clear" onClick={() => setFinders([])}>{t('filter.clear')}</button>}
          </div>

          <section className={`group actlive ${activities ? 'on' : ''}`}>
            <h2 onClick={() => setActivities(!activities)}><span><i className={`switch ${activities ? 'on' : ''}`} />{t('act.title')}</span><small>{activities ? t('act.near', { n: nearbyCount }) : t('act.off')}</small></h2>
            {activities && <div className="radius">{t('act.radius')} <input type="range" min="25" max="300" step="25" value={radius} onChange={(e) => setRadius(+e.target.value)} /> <b>{radius} m</b></div>}
            {activities && <div className="radius dung"><label onClick={() => setDungeon(!dungeon)}><i className={`switch ${dungeon ? 'on' : ''}`} />{t('act.dungeon')}</label>
              {dungeon && <><input type="range" min="10" max="150" step="5" value={dungeonH} onChange={(e) => setDungeonH(+e.target.value)} /> <b>±{dungeonH} m</b></>}</div>}
          </section>

          <Ores findIndex={findIndex} finders={finders} toggleFinder={toggleFinder} surfaceOnly={surfaceOnly} setSurfaceOnly={setSurfaceOnly} />
          <section id="finders">
            <input className="search" type="search" placeholder={t('find.placeholder')} value={findQ} onChange={(e) => setFindQ(e.target.value)} />
            {findGroups.map((g) => {
              const isOpen = findQ.trim().length >= 2 || !!fopen[g.title];
              const onCount = g.list.filter((e) => finders.some((f) => f.kind === e.kind && f.slug === e.slug)).length;
              return (
              <div key={g.title} className={`group fgroup ${isOpen ? 'open' : ''}`}>
                <h2 onClick={() => setFopen({ ...fopen, [g.title]: !isOpen })}><span>{g.drop?.img && <img className="dropimg" src={`./${g.drop.img}`} />}{g.label}</span>{g.drop && <button className="allon" onClick={(ev) => { ev.stopPropagation(); addFinders(g.list); }}>{t('find.show_all')}</button>}<small>{onCount ? tc('find.on', onCount) : ''}{fmt(g.list.length)} {isOpen ? '▾' : '▸'}</small></h2>
                {isOpen && g.sub.map((sg) => (
                  <React.Fragment key={sg.t}>
                    {sg.t && <h3 className="fsub">{sg.t === 'Outros' ? t('find.other') : tn(sg.t)}</h3>}
                    <div className="cats">
                      {sg.list.map((e) => {
                        const on = finders.some((f) => f.kind === e.kind && f.slug === e.slug);
                        return (
                          <div key={e.kind + e.slug} className={`cat ${on ? '' : 'off'}`} title={e.kind === 'spawns' && drops?.mobs[e.slug] ? `${tn(e.n)}
${t('find.drops', { list: drops.mobs[e.slug].map(tn).join(', ') })}` : tn(e.n)} onClick={() => toggleFinder(e)}>
                            {e.img ? <img src={`./${e.img}`} /> : <span className="dotc" style={{ background: e.color }} />}
                            <span className="label">{tn(e.n)}</span><span className="count">{fmt(e.c)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </React.Fragment>
                ))}
              </div>
              );
            })}
          </section>

          <div id="groups">
            {groups.map((g) => {
              const sum = g.cats.reduce((t, c) => t + c.count, 0);
              const isOpen = open[g.name] ?? true;
              return (
                <section key={g.name} className="group">
                  <h2 title={t('groups.toggle')}>
                    <span onClick={() => toggleGroup(g)}>{tn(g.name)}</span>
                    <small onClick={() => setOpen({ ...open, [g.name]: !isOpen })}>{fmt(sum)} {isOpen ? '▾' : '▸'}</small>
                  </h2>
                  {isOpen && (
                    <div className="cats">
                      {g.cats.map((c) => (
                        <div key={c.id} className={`cat ${visible?.[c.id] ? '' : 'off'}`} title={tn(c.label)} onClick={() => setVisible({ ...visible, [c.id]: !visible[c.id] })}>
                          {c.icon.startsWith('#') ? <span className="dotc" style={{ background: c.icon }} /> : <img src={icSrc(c.icon)} />}
                          <span className="label">{tn(c.label)}</span><span className="count">{fmt(c.count)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <div className="progress">
            <span>{t('progress.found', { a: fmt(foundCount), b: fmt(total) })}</span>
            <button onClick={onExport} title={t('progress.export_title')}>{t('progress.export')}</button>
            <button onClick={onImport} title={t('progress.import_title')}>{t('progress.import')}</button>
          </div>
          <p id="status">{t('status.markers', { total: fmt(total), shown: fmt(shown) })}</p>
        </div>
      )}
    </div>
  );
}
