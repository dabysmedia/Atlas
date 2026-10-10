// Live sync, end to end: several browsers on one world, each change made in one showing up in the others.
// Usage: BASE_URL=http://localhost:3010 ATLAS_USER=gm ATLAS_PASS=... CHROMIUM_PATH=... SHOTS=/tmp/live node scripts/live.mjs
// RESTART_CMD (optional) restarts the server mid-run, e.g. "bash .scratch/serve.sh . 3010 atlas_live", to check
// that every screen reconnects and catches up. LIVE_LIMIT_MS (default 2000) is how long a change may take to arrive.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const USER = process.env.ATLAS_USER ?? 'gm';
const PASS = process.env.ATLAS_PASS ?? 'correcthorse1';
const LIMIT = Number(process.env.LIVE_LIMIT_MS ?? 2000);
const DIR = process.env.SHOTS ?? './shots-live';
mkdirSync(DIR, { recursive: true });

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errs = [];
let failed = 0;
const pages = [];
const step = async (name, fn) => {
  try { const note = await fn(); console.log('ok  ', name, note ?? ''); } catch (e) {
    failed++; console.log('FAIL', name, e.message.split('\n')[0]);
    for (const [i, p] of pages.entries()) await p.screenshot({ path: `${DIR}/fail-${name}-${i}.png` }).catch(() => {});
  }
};
/** Wait (polling fast) for a condition in a page; returns how long it took. */
const arrives = async (p, fn, arg, limit = LIMIT) => {
  const t0 = Date.now();
  await p.waitForFunction(fn, arg, { timeout: limit, polling: 40 });
  return Date.now() - t0;
};
const ms = (n) => `(${n} ms)`;

/** A signed-in browser of its own (separate cookies, like another player's machine), on the 2D map unless asked. */
async function open(label, mode = '2d') {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  // Software GL is slow: the flat map and plain glass keep each screen responsive.
  await ctx.addInitScript((mode) => {
    try { localStorage.setItem('atlas.mapMode', JSON.stringify(mode)); localStorage.setItem('atlas.glass', '"lite"'); localStorage.setItem('atlas.ambient', 'false'); } catch { /* private */ }
  }, mode);
  const p = await ctx.newPage();
  p.setDefaultTimeout(90_000);
  p.on('console', (m) => { if (m.type() === 'error' && !/401|WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push(`${label}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${label} pageerror: ${e.message}`));
  await p.goto(BASE);
  await p.fill('#u', USER);
  await p.fill('#p', PASS);
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('.topbar');
  pages.push(p);
  return p;
}
const mapReady = (p) => p.waitForFunction(() => window.__atlasMap?.hexes?.length > 0 && document.querySelector('.presence')?.dataset.status === 'live', null, { polling: 100 });
/** The camera has finished flying in, so screen positions read now still hold when the mouse gets there. */
const still = (p) => p.waitForFunction(() => {
  const r = window.__atlasMap;
  return r.viewport.w > 0 && Math.abs(r.cam.zoom / r.target.zoom - 1) < 1e-4 && Math.hypot(r.cam.x - r.target.x, r.cam.y - r.target.y) < 0.05;
}, null, { polling: 100 });
const canvasBox = (p) => p.evaluate(() => { const r = document.querySelector('canvas.map').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });

const A = await open('A');
const Bp = await open('B');
const worlds = await A.evaluate(() => fetch('/api/worlds').then((r) => r.json()));
const world = worlds.find((w) => w.name === 'The Sundered Reach') ?? worlds[0];
const W = `${BASE}/w/${world.id}`;
const info = await A.evaluate((id) => fetch(`/api/worlds/${id}`).then((r) => r.json()), world.id);
console.log(`world: ${world.name}`);
await Promise.all([A.goto(`${W}/map`), Bp.goto(`${W}/map`)]);
await Promise.all([mapReady(A), mapReady(Bp)]);

await step('presence', async () => {
  const C = await open('C');
  await C.goto(`${W}/map`);
  await mapReady(C);
  const count = (n) => (p) => p.waitForFunction((n) => document.querySelector('.presence')?.dataset.count === String(n), n, { timeout: 5000, polling: 100 });
  await Promise.all([A, Bp, C].map(count(3)));
  await A.screenshot({ path: `${DIR}/01-presence-3.png` });
  await C.context().close();
  pages.splice(pages.indexOf(C), 1);
  await Promise.all([A, Bp].map(count(2)));
  return '3 viewers, then 2';
});

await still(A);
const box = await canvasBox(A);
/** The hex under a point of A's map (canvas coordinates), as both screens know it. */
const hexAt = (x, y) => A.evaluate(([x, y]) => { const r = window.__atlasMap; const h = r.hexAt(x, y); return h && { id: h.id, terrain: h.terrain, control: r.control.get(h.id) ?? null }; }, [x, y]);
const stroke = async (x, y) => {
  await A.mouse.move(box.x + x, box.y + y);
  await A.mouse.down();
  await A.mouse.move(box.x + x + 1, box.y + y + 1);
  await A.mouse.up();
};

await step('hex paint', async () => {
  await A.keyboard.press('2');
  const h = await hexAt(box.w * 0.5, box.h * 0.5);
  const t = info.terrainTypes.find((x) => x.key !== h.terrain && x.key !== 'unknown');
  await A.click(`.brush-list .brush:has(.brush-name:text-is("${t.name}"))`);
  await stroke(box.w * 0.5, box.h * 0.5);
  const took = await arrives(Bp, ([id, key]) => window.__atlasMap.byId.get(id)?.terrain === key, [h.id, t.key]);
  await Bp.screenshot({ path: `${DIR}/02-paint-arrived.png` });
  return `${h.terrain} → ${t.key} ${ms(took)}`;
});

await step('claim', async () => {
  await A.keyboard.press('4');
  const h = await hexAt(box.w * 0.56, box.h * 0.42);
  const f = (await A.evaluate(() => window.__atlasMap.factions)).find((x) => x.id !== h.control);
  await A.click(`.brush-list .brush[title="${f.name}"]`);
  await stroke(box.w * 0.56, box.h * 0.42);
  const took = await arrives(Bp, ([id, fid]) => window.__atlasMap.control.get(id) === fid, [h.id, f.id]);
  return `${f.name} ${ms(took)}`;
});

let dragging = false;
await step('marker drag streams, then moves', async () => {
  await A.keyboard.press('1');
  await A.keyboard.press('Escape');
  await A.waitForSelector('.brush-list', { state: 'detached' });
  await still(A);
  // A marker that is on screen and on top, and a hex a little way off to drop it on.
  const pick = await A.evaluate(({ x: bx, y: by, w, h }) => {
    const r = window.__atlasMap;
    const map = document.querySelector('canvas.map');
    for (const t of r.tokens) {
      if (t.kind === 'city' || t.kind === 'outpost' || !t.hexId) continue;
      const p = r.tokenPos(t);
      const s = r.worldToScreen(p.x, p.y);
      if (s.x < 100 || s.y < 100 || s.x > w - 100 || s.y > h - 100 || r.tokenAt(s.x, s.y)?.id !== t.id) continue;
      // Toward the middle of the map, so repeated runs don't walk the marker off the edge.
      const tx = s.x + (s.x > w / 2 ? -70 : 70), ty = s.y + (s.y > h / 2 ? -30 : 30);
      // Not under the map's own chrome (the tool dock, a card).
      if (document.elementFromPoint(bx + s.x, by + s.y) !== map || document.elementFromPoint(bx + tx, by + ty) !== map) continue;
      const to = r.hexAt(tx, ty);
      if (to && to.id !== t.hexId) return { id: t.id, name: t.name, x: s.x, y: s.y, to: to.id, tx, ty };
    }
    return null;
  }, box);
  if (!pick) throw new Error('no marker on screen to drag');
  await A.mouse.move(box.x + pick.x, box.y + pick.y);
  await A.mouse.down();
  dragging = true;
  for (let i = 1; i <= 6; i++) { await A.mouse.move(box.x + pick.x + (pick.tx - pick.x) * i / 12, box.y + pick.y + (pick.ty - pick.y) * i / 12); await A.waitForTimeout(40); }
  await A.waitForFunction(() => !!window.__atlasMap.dragToken, null, { timeout: 3000, polling: 50 }).catch(async () => {
    throw new Error(`A never picked the marker up: ${JSON.stringify(await A.evaluate(([x, y]) => ({ under: window.__atlasMap.tokenAt(x, y)?.name ?? null }), [pick.x, pick.y]))}, wanted ${pick.name}`);
  });
  // Mid-drag, still held: B hears where A has the marker, and draws it heading there (software GL leaves B few
  // frames to draw with, so its picture is allowed to lag behind the message).
  const at = await A.evaluate(() => ({ x: window.__atlasMap.dragToken.x, y: window.__atlasMap.dragToken.y }));
  const streamed = await arrives(Bp, ([id, x, y]) => {
    const g = window.__atlasMap.glides.get(id);
    return !!g && Math.hypot(g.tx - x, g.ty - y) < 1;
  }, [pick.id, at.x, at.y]);
  const shown = await arrives(Bp, ([id, x, y, x0, y0]) => {
    const r = window.__atlasMap; const t = r.tokens.find((t) => t.id === id); const p = t && r.tokenPos(t);
    return !!p && Math.hypot(p.x - x, p.y - y) < Math.hypot(x0 - x, y0 - y) / 2;
  }, [pick.id, at.x, at.y, ...(await Bp.evaluate((id) => { const r = window.__atlasMap; const p = r.slotPos(r.tokens.find((t) => t.id === id)); return [p.x, p.y]; }, pick.id))], 10_000);
  await Bp.screenshot({ path: `${DIR}/03-drag-midway.png` });
  for (let i = 7; i <= 12; i++) { await A.mouse.move(box.x + pick.x + (pick.tx - pick.x) * i / 12, box.y + pick.y + (pick.ty - pick.y) * i / 12); await A.waitForTimeout(40); }
  await A.mouse.up();
  dragging = false;
  const moved = await arrives(Bp, ([id, to]) => window.__atlasMap.tokens.find((t) => t.id === id)?.hexId === to, [pick.id, pick.to]);
  // And it glides into place rather than jumping.
  const glided = await Bp.evaluate((id) => window.__atlasMap.glides.has(id), pick.id);
  return `${pick.name}: mid-drag message ${ms(streamed)}, drawn ${ms(shown)}, drop ${ms(moved)}${glided ? ', glided into place' : ''}`;
});
// A failed drag mustn't leave A's button held for the steps after.
if (dragging) await A.mouse.up();

await step('faction rename', async () => {
  await A.click('.rail a[aria-label="Factions"]');
  const f = (await Bp.evaluate(() => window.__atlasMap.factions))[0];
  const name = `${f.name.replace(/ \(live \d+\)$/, '')} (live ${Date.now() % 1000})`;
  await A.click(`.fr-head:has-text("${f.name}")`);
  await A.fill('.faction-row.open input[aria-label="Faction name"]', name);
  await A.press('.faction-row.open input[aria-label="Faction name"]', 'Enter');
  const took = await arrives(Bp, (n) => window.__atlasMap.factions.some((f) => f.name === n), name);
  return `${name} ${ms(took)}`;
});

await step('wiki edit', async () => {
  await A.click('.rail a[aria-label="Wiki"]');
  await A.click('.wiki-item >> nth=0');
  await A.waitForSelector('.ProseMirror');
  await Bp.goto(A.url());
  await Bp.waitForSelector('.ProseMirror');
  await Bp.waitForFunction(() => document.querySelector('.presence')?.dataset.status === 'live', null, { polling: 100 });
  const mark = `Live edit ${Date.now() % 100000}`;
  await A.click('.ProseMirror');
  await A.keyboard.press('Control+End');
  await A.keyboard.type(` ${mark}`);
  // The editor saves 0.7 s after the last keystroke; the change travels after that.
  const took = await arrives(Bp, (m) => document.querySelector('.ProseMirror')?.textContent.includes(m), mark, LIMIT + 700);
  await Bp.screenshot({ path: `${DIR}/04-wiki-arrived.png` });
  return `${ms(took)} incl. 700 ms autosave`;
});

const label = (p) => p.getAttribute('.wx-btn', 'aria-label');
const setWeather = async (p) => {
  const now = await label(p);
  const want = now === 'Weather: Thick fog' ? 'Rain' : 'Thick fog';
  await p.click('.wx-btn');
  await p.click(`.wx-kind:has-text("${want}")`);
  await p.keyboard.press('Escape');
  return want;
};
await step('weather', async () => {
  const want = await setWeather(A);
  const took = await arrives(Bp, (w) => document.querySelector('.wx-btn')?.getAttribute('aria-label') === `Weather: ${w}`, want);
  return `${want} ${ms(took)}`;
});

await step('clock', async () => {
  const before = (await A.evaluate((id) => fetch(`/api/worlds/${id}`).then((r) => r.json()), world.id)).currentDay;
  await A.click('button[aria-label="Next day"]');
  const took = await arrives(Bp, (d) => Number(document.querySelector('.clock .day')?.textContent.replace(/\D/g, '')) === d, before + 1);
  return `day ${before} → ${before + 1} ${ms(took)}`;
});

if (process.env.RESTART_CMD) {
  await step('server restart: reconnect and resync', async () => {
    // From the server: A's own clock click may still be landing on A when B has already heard of it.
    const before = (await A.evaluate((id) => fetch(`/api/worlds/${id}`).then((r) => r.json()), world.id)).currentDay;
    const done = new Promise((resolve, reject) => {
      const c = spawn('bash', ['-c', process.env.RESTART_CMD], { stdio: 'ignore' });
      c.on('exit', (code) => (code ? reject(new Error(`restart exited ${code}`)) : resolve()));
    });
    await Promise.all([A, Bp].map((p) => p.waitForFunction(() => document.querySelector('.presence')?.dataset.status !== 'live', null, { timeout: 15_000, polling: 20 })));
    await A.screenshot({ path: `${DIR}/05-reconnecting.png` });
    await done;
    // A change made the moment the server is back, from outside either page: whichever way it reaches them
    // (broadcast, or the resync on reconnect), both must show it.
    const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const moved = await fetch(`${BASE}/api/worlds/${world.id}/day`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ advance: 1 }) });
    if (!moved.ok) throw new Error(`day change after restart: ${moved.status}`);
    const after = await moved.json();
    const t0 = Date.now();
    const all = (what, fn, arg, timeout) => Promise.all([A, Bp].map((p) => p.waitForFunction(fn, arg, { timeout, polling: 100 }))).catch(async (e) => {
      const seen = await Promise.all([A, Bp].map((p) => p.evaluate(() => [document.querySelector('.presence')?.dataset.status, document.querySelector('.presence')?.dataset.count, document.querySelector('.clock .day')?.textContent])));
      const debug = await Promise.all([A, Bp].map((p) => p.evaluate(() => { const l = window.__atlasLive; const q = l.cache().getQueryCache().getAll().filter((q) => q.queryKey.length === 2 && q.queryKey[0] === 'w').map((q) => ({ k: q.queryKey[1].slice(0, 6), s: q.state.status, f: q.state.fetchStatus, day: q.state.data?.currentDay, at: Date.now() - q.state.dataUpdatedAt, obs: q.getObserversCount(), inv: q.state.isInvalidated, fails: q.state.fetchFailureCount })); return { pending: l.pendingWrites.count, held: l.live.held.size, opened: l.live.opened, tries: l.live.tries, q }; })));
      throw new Error(`${what} after ${Date.now() - t0} ms (day was ${before}, now ${after.currentDay}; A, B: ${JSON.stringify(seen)} ${JSON.stringify(debug)}): ${e.message}`);
    });
    await all('back live', () => document.querySelector('.presence')?.dataset.status === 'live', null, 30_000);
    const back = Date.now() - t0;
    await all('day caught up', (d) => Number(document.querySelector('.clock .day')?.textContent.replace(/\D/g, '')) === d, before + 1, 10_000);
    await all('both present', () => document.querySelector('.presence')?.dataset.count === '2', null, 10_000);
    // And the channel works again: a change in A reaches B.
    const want = await setWeather(A);
    const took = await arrives(Bp, (w) => document.querySelector('.wx-btn')?.getAttribute('aria-label') === `Weather: ${w}`, want);
    return `both back live after ${back} ms, day ${before + 1} caught up, weather after ${ms(took)}`;
  });
} else console.log('skip  server restart (set RESTART_CMD)');

// The 3D map redraws from the same cache: a screen on it sees paint, markers, weather and a model swap arrive.
// Slow under software GL, so only on request.
if (process.env.LIVE_3D) {
  await step('3D map follows remote changes', async () => {
    const nw = worlds.find((w) => w.name === 'The New World');
    if (!nw) throw new Error('needs The New World (with its model)');
    const call = (path, init = {}) => A.evaluate(([path, init]) => fetch(path, { ...init, headers: init.body ? { 'content-type': 'application/json' } : {} }).then(async (r) => {
      if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status}`);
      return r.json();
    }), [path, init]);
    let map = await call(`/api/worlds/${nw.id}/map`);
    // A run cut short may have left the model in the archive.
    if (!map.map.model) {
      const [last] = await call(`/api/worlds/${nw.id}/map/model/archive`);
      await call(`/api/worlds/${nw.id}/map/model/archive/${last.id}/restore`, { method: 'POST' });
      map = await call(`/api/worlds/${nw.id}/map`);
    }
    const D = await open('3D', '3d');
    await Promise.all([A.goto(`${BASE}/w/${nw.id}/map`), D.goto(`${BASE}/w/${nw.id}/map`)]);
    await mapReady(A);
    await D.waitForFunction(() => typeof window.__atlasMap?.setModel === 'function' && window.__atlasMap.hexes.length > 0 && window.__atlasMap.modelWanted, null, { polling: 250 });
    const hex = map.hexes.find((h) => h.terrain !== 'swamp');
    const notes = [];
    // Each frame takes seconds under software GL, so the page answers slowly: generous waits, named when they fail.
    const see = (what, fn, arg) => arrives(D, fn, arg, 90_000).catch((e) => { throw new Error(`${what}: ${e.message}`); });
    await call(`/api/worlds/${nw.id}/hexes/paint`, { method: 'POST', body: JSON.stringify({ hexIds: [hex.id], terrain: 'swamp' }) });
    notes.push(`paint ${ms(await see('paint', (id) => window.__atlasMap.byId.get(id)?.terrain === 'swamp', hex.id))}`);
    const tok = await call(`/api/worlds/${nw.id}/tokens`, { method: 'POST', body: JSON.stringify({ kind: 'unit', name: 'Live scouts', hexId: hex.id }) });
    await see('new marker', (id) => window.__atlasMap.tokens.some((t) => t.id === id), tok.id);
    const next = map.hexes.find((h) => h.q === hex.q + 1 && h.r === hex.r) ?? map.hexes.find((h) => h.id !== hex.id);
    await call(`/api/worlds/${nw.id}/tokens/${tok.id}`, { method: 'PATCH', body: JSON.stringify({ hexId: next.id }) });
    const moved = await see('marker move', ([id, to]) => window.__atlasMap.tokens.find((t) => t.id === id)?.hexId === to, [tok.id, next.id]);
    notes.push(`marker ${ms(moved)}${(await D.evaluate((id) => window.__atlasMap.glides.has(id), tok.id)) ? ' gliding' : ''}`);
    const kind = (await D.evaluate(() => window.__atlasMap.weatherInfo().kind)) === 'gale' ? 'drizzle' : 'gale';
    await call(`/api/worlds/${nw.id}/weather`, { method: 'PATCH', body: JSON.stringify({ kind }) });
    notes.push(`weather ${ms(await see('weather', (k) => window.__atlasMap.weatherInfo().kind === k, kind))}`);
    await call(`/api/worlds/${nw.id}/map/model`, { method: 'DELETE' });
    notes.push(`model off ${ms(await see('model removed', () => window.__atlasMap.modelWanted === null, null))}`);
    const [last] = await call(`/api/worlds/${nw.id}/map/model/archive`);
    await call(`/api/worlds/${nw.id}/map/model/archive/${last.id}/restore`, { method: 'POST' });
    notes.push(`model back ${ms(await see('model restored', () => !!window.__atlasMap.modelWanted, null))}`);
    await D.waitForTimeout(3000);
    await D.screenshot({ path: `${DIR}/06-3d-after.png` });
    await call(`/api/worlds/${nw.id}/tokens/${tok.id}`, { method: 'DELETE' });
    await D.context().close();
    pages.splice(pages.indexOf(D), 1);
    return notes.join(', ');
  });
}

console.log('console errors:', errs.length ? '\n' + errs.join('\n') : 'none');
await b.close();
if (failed || errs.length) process.exit(1);
