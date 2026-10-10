// Player logins, end to end: the GM adds a player, the player sees the live map through their party's fog, and
// changes flow both ways; the player is refused GM actions and is signed out when the GM removes them.
// Usage: BASE_URL=http://localhost:3020 ATLAS_USER=gm ATLAS_PASS=... CHROMIUM_PATH=... SHOTS=/tmp/players node scripts/players.mjs
// Runs against a world with a campaign and a party marker (the demo world has both). It explores the ring around the
// marker for that party; the player, the hidden marker, the GM note and the party notes it adds are removed at the end.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const USER = process.env.ATLAS_USER ?? 'gm';
const PASS = process.env.ATLAS_PASS ?? 'correcthorse1';
const LIMIT = Number(process.env.LIVE_LIMIT_MS ?? 3000);
const DIR = process.env.SHOTS ?? './shots-players';
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
    for (const [i, p] of pages.entries()) await p.screenshot({ path: `${DIR}/fail-${name.replace(/\W+/g, '-')}-${i}.png` }).catch(() => {});
  }
};
const must = (ok, msg) => { if (!ok) throw new Error(msg); };
const arrives = async (p, fn, arg, limit = LIMIT) => {
  const t0 = Date.now();
  await p.waitForFunction(fn, arg, { timeout: limit, polling: 40 });
  return Date.now() - t0;
};
const ms = (n) => `(${n} ms)`;

/** A browser of its own (separate cookies, like another person's machine), on the flat map. */
async function context(label) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('atlas.mapMode', '"2d"'); localStorage.setItem('atlas.glass', '"lite"'); localStorage.setItem('atlas.ambient', 'false'); } catch { /* private */ }
  });
  const p = await ctx.newPage();
  p.setDefaultTimeout(90_000);
  p.on('console', (m) => { if (m.type() === 'error' && !/401|403|404|WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push(`${label}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${label} pageerror: ${e.message}`));
  pages.push(p);
  return p;
}
async function signIn(p, user, pass) {
  await p.goto(BASE);
  await p.fill('#u', user);
  await p.fill('#p', pass);
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('.topbar');
}
const mapReady = (p) => p.waitForFunction(() => window.__atlasMap?.hexes?.length > 0 && document.querySelector('.presence')?.dataset.status === 'live', null, { polling: 100 });
const still = (p) => p.waitForFunction(() => {
  const r = window.__atlasMap;
  return r.viewport.w > 0 && Math.abs(r.cam.zoom / r.target.zoom - 1) < 1e-4 && Math.hypot(r.cam.x - r.target.x, r.cam.y - r.target.y) < 0.05;
}, null, { polling: 100 });
/** fetch() from inside a page, as whoever is signed in there. */
const call = (p, path, method = 'GET', body) => p.evaluate(async ([path, method, body]) => {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}, [path, method, body]);

// ---------------------------------------------------------------- the GM sets the table
const GM = await context('GM');
await signIn(GM, USER, PASS);
const worlds = (await call(GM, '/api/worlds')).json;
const roster = (await call(GM, '/api/players')).json;
const camp = roster.campaigns.find((c) => c.worldName === 'The Sundered Reach') ?? roster.campaigns[0];
must(camp, 'no campaign to put the player in');
const world = worlds.find((w) => w.id === camp.worldId);
const W = `/api/worlds/${world.id}`;
console.log(`world: ${world.name}, campaign: ${camp.name}`);
const gmMap = (await call(GM, `${W}/map`)).json;
const party = gmMap.tokens.find((t) => t.kind === 'party' && (t.campaignId === camp.id || !t.campaignId) && t.hexId);
must(party, 'no party marker for the campaign');

// Explored ground around the party (the marker's hex and its ring), and one more hex to reveal live later.
const around = (id, hexes) => {
  const h = hexes.find((x) => x.id === id);
  return hexes.filter((x) => x.id !== id && Math.max(Math.abs(x.q - h.q), Math.abs(x.r - h.r), Math.abs(x.q + x.r - h.q - h.r)) === 1);
};
const ring = around(party.hexId, gmMap.hexes);
await call(GM, `${W}/campaigns/${camp.id}/fog`, 'POST', { hexIds: [party.hexId, ...ring.map((h) => h.id)], explored: true });
const fog = new Set((await call(GM, `${W}/campaigns/${camp.id}/fog`)).json);
// The unexplored land nearest the party: revealed (then hidden again) while the player watches.
const home = gmMap.hexes.find((h) => h.id === party.hexId);
const dist = (a, c) => Math.max(Math.abs(a.q - c.q), Math.abs(a.r - c.r), Math.abs(a.q + a.r - c.q - c.r));
const outer = gmMap.hexes.filter((h) => !fog.has(h.id) && h.terrain !== 'deep').sort((a, c) => dist(a, home) - dist(c, home))[0];
must(outer, 'no unexplored hex next to the explored ground');
const unexplored = gmMap.hexes.filter((h) => !fog.has(h.id));
// Secrets the player must never receive: a GM note on explored ground, and a marker hidden from players on it.
const SECRET = `gm-secret-${Date.now().toString(36)}`;
const cleanup = [];
const noteHex = ring[0];
const oldNote = gmMap.hexes.find((h) => h.id === noteHex.id).notes;
await call(GM, `${W}/hexes/${noteHex.id}`, 'PATCH', { notes: `${oldNote}\n${SECRET}`.trim() });
const hidden = (await call(GM, `${W}/tokens`, 'POST', { kind: 'marker', name: `Hidden ${SECRET}`, hexId: ring[1].id, visibleToPlayers: false })).json;
must(hidden?.id, 'could not place the hidden marker');

// ---------------------------------------------------------------- the GM adds a player in Settings
const username = `mira${Date.now().toString(36).slice(-5)}`;
let password = '';
await step('GM adds a player with a generated password', async () => {
  await GM.goto(`${BASE}/w/${world.id}/settings`);
  await GM.click('button:has-text("Add player")');
  await GM.fill('#np-name', 'Mira Thorn');
  await GM.fill('#np-user', username);
  await GM.click(`.dialog .camp-chip:has-text("${camp.name}")`);
  await GM.screenshot({ path: `${DIR}/01-gm-add-player.png` });
  await GM.click('.dialog button:has-text("Add player")');
  const code = GM.locator('[data-testid="generated-password"]');
  await code.waitFor();
  password = (await code.textContent()).trim();
  must(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(password), `odd generated password shape: ${password.replace(/./g, '*')}`);
  await GM.screenshot({ path: `${DIR}/02-gm-password-once.png` });
  await GM.click('.dialog button:has-text("Done")');
  await GM.locator(`.player-row[data-player="${username}"]`).waitFor();
  return `@${username}`;
});

// ---------------------------------------------------------------- the player signs in
const P = await context('Player');
await step('player signs in and sees only the explored hexes', async () => {
  await signIn(P, username, password);
  await P.waitForURL(new RegExp(`/w/${world.id}/map`));
  await mapReady(P);
  const seen = await P.evaluate(() => window.__atlasMap.hexes.filter((h) => h.terrain !== 'unknown').map((h) => h.id));
  const map = (await call(P, `${W}/map`)).json;
  const shown = new Set(map.hexes.filter((h) => !h.fogged).map((h) => h.id));
  must(shown.size === fog.size && [...fog].every((id) => shown.has(id)), `player map shows ${shown.size} hexes, party has explored ${fog.size}`);
  must(seen.every((id) => fog.has(id)), 'the map draws terrain on an unexplored hex');
  must(map.hexes.filter((h) => h.fogged).every((h) => h.terrain === 'unknown' && !h.name && !h.notes && !h.partyNotes), 'a fogged hex carries data');
  must(!map.tokens.some((t) => t.id === hidden.id), 'the hidden marker reached the player');
  must(!map.claims.some((c) => !fog.has(c.hexId)), 'a claim on unexplored ground reached the player');
  must(map.map.art === null && map.map.model === null, 'map art or model reached the player');
  must(!(await call(P, `${W}/map`)).text.includes(SECRET), 'the GM note reached the player');
  must(await P.locator('.dock-wrap').count() === 0, 'the player has the GM tool dock');
  must(await P.locator('.presence .avatar.player').count() >= 1, 'presence has no player badge');
  await P.waitForTimeout(400);
  await P.screenshot({ path: `${DIR}/03-player-map.png` });
  return `${shown.size} of ${map.hexes.length} hexes`;
});

await step('GM sees the player in presence, with a player badge', async () => {
  await GM.goto(`${BASE}/w/${world.id}/map?focus=hex:${party.hexId}`);
  await mapReady(GM);
  const took = await arrives(GM, () => !!document.querySelector('.presence .avatar.player'), null, LIMIT * 2);
  const tip = await GM.locator('.presence').getAttribute('data-tip');
  must(/Mira Thorn \(player\)/.test(tip), `presence tip: ${tip}`);
  return ms(took);
});

await step('GM reveals fog: the hex appears for the player live', async () => {
  await call(GM, `${W}/campaigns/${camp.id}/fog`, 'POST', { hexIds: [outer.id], explored: true });
  const took = await arrives(P, (id) => { const r = window.__atlasMap; return r.fog?.has(id) && r.byId.get(id)?.terrain !== 'unknown'; }, outer.id);
  return `${outer.terrain} ${ms(took)}`;
});

await step('GM hides it again: its terrain leaves the player\'s screen', async () => {
  await call(GM, `${W}/campaigns/${camp.id}/fog`, 'POST', { hexIds: [outer.id], explored: false });
  const took = await arrives(P, (id) => { const r = window.__atlasMap; return !r.fog?.has(id) && r.byId.get(id)?.terrain === 'unknown'; }, outer.id);
  const again = (await call(P, `${W}/map`)).json.hexes.find((h) => h.id === outer.id);
  must(again.fogged && again.terrain === 'unknown', 'the re-hidden hex still comes with data');
  return ms(took);
});

const target = ring.find((h) => h.id !== noteHex.id && h.terrain !== 'deep') ?? ring[2];
await step('GM moves the party marker: the player sees it move', async () => {
  const back = ring.find((h) => h.id !== target.id && h.terrain !== 'deep');
  await call(GM, `${W}/tokens/${party.id}`, 'PATCH', { hexId: back.id });
  const took = await arrives(P, ([id, hex]) => window.__atlasMap.tokens.find((t) => t.id === id)?.hexId === hex, [party.id, back.id]);
  return ms(took);
});

await step('player drags their party marker; the GM sees it', async () => {
  await P.goto(`${BASE}/w/${world.id}/map?focus=token:${party.id}`);
  await mapReady(P);
  await still(P);
  await P.keyboard.press('Escape');
  await still(P);
  const pts = await P.evaluate(([tok, hex]) => {
    const r = window.__atlasMap;
    const t = r.tokens.find((x) => x.id === tok);
    const a = r.worldToScreen(r.tokenPos(t).x, r.tokenPos(t).y);
    const h = r.byId.get(hex);
    const z = r.worldToScreen(h.cx, h.cy);
    const c = document.querySelector('canvas.map').getBoundingClientRect();
    return { a: { x: a.x + c.left, y: a.y + c.top }, z: { x: z.x + c.left, y: z.y + c.top } };
  }, [party.id, target.id]);
  await P.mouse.move(pts.a.x, pts.a.y);
  await P.mouse.down();
  for (let i = 1; i <= 8; i++) await P.mouse.move(pts.a.x + ((pts.z.x - pts.a.x) * i) / 8, pts.a.y + ((pts.z.y - pts.a.y) * i) / 8);
  await P.mouse.up();
  const took = await arrives(GM, ([id, hex]) => window.__atlasMap.tokens.find((t) => t.id === id)?.hexId === hex, [party.id, target.id]);
  return ms(took);
});

await step('player cannot drag onto unexplored ground', async () => {
  const res = await call(P, `${W}/tokens/${party.id}`, 'PATCH', { hexId: unexplored.find((h) => h.id !== outer.id).id });
  must(res.status === 403, `moving into fog answered ${res.status}`);
  const other = gmMap.tokens.find((t) => t.kind !== 'party' && fog.has(t.hexId));
  if (other) {
    const r2 = await call(P, `${W}/tokens/${other.id}`, 'PATCH', { hexId: target.id });
    must(r2.status === 403, `moving ${other.name} answered ${r2.status}`);
  }
  return '403';
});

const NOTE = `We camped by the old stones (${Date.now().toString(36)})`;
await step('player writes a party note; the GM sees it live', async () => {
  await P.goto(`${BASE}/w/${world.id}/map?focus=hex:${target.id}`);
  await P.locator('.inspector .psec:has(h4:text-is("Party notes"))').waitFor();
  must(await P.locator('.inspector .psec:has(h4:text-is("GM notes"))').count() === 0, 'the player sees a GM notes section');
  await GM.goto(`${BASE}/w/${world.id}/map?focus=hex:${target.id}`);
  await GM.locator('.inspector .psec:has(h4:text-is("Party notes"))').waitFor();
  await mapReady(GM);
  await P.click('.inspector .psec:has(h4:text-is("Party notes")) .notes-read');
  await P.keyboard.type(NOTE, { delay: 5 });
  // Typing pauses save on their own; leaving the editor saves the rest.
  await P.click('.inspector .panel-head');
  const took = await arrives(GM, ([w, h, note]) => window.__atlasLive.cache().getQueryData(['w', w, 'map'])?.hexes.find((x) => x.id === h)?.partyNotes === note,
    [world.id, target.id, NOTE], LIMIT + 1500);
  await GM.locator(`.inspector .psec:has(h4:text-is("Party notes")) .notes-read:has-text("${NOTE}")`).waitFor();
  await P.screenshot({ path: `${DIR}/04-player-party-note.png` });
  await GM.screenshot({ path: `${DIR}/05-gm-sees-party-note.png` });
  return `in the GM's map ${ms(took)} after the editor closed`;
});

await step('GM-only pages stay with the GM; players write the rest', async () => {
  const secret = (await call(GM, `${W}/pages`, 'POST', { title: `Vault of ${SECRET}`, gmOnly: true })).json;
  must(secret?.id, 'could not make a GM-only page');
  cleanup.push(() => call(GM, `${W}/pages/${secret.id}`, 'DELETE'));
  const index = (await call(P, `${W}/pages`)).json;
  must(!index.some((x) => x.id === secret.id), 'the GM-only page is in the player\'s index');
  must((await call(P, `${W}/pages/${secret.id}`)).status === 404, 'the GM-only page opens for the player');
  must(!(await call(P, `${W}/search?q=${SECRET}`)).text.includes(secret.id), 'search finds the GM-only page for the player');
  await P.goto(`${BASE}/w/${world.id}/wiki/${secret.id}`);
  await P.locator('text=kept for the GM').waitFor();
  // A page the player writes is everyone's, and they can't hide it or delete it.
  const mine = (await call(P, `${W}/pages`, 'POST', { title: `Notes of ${username}` })).json;
  must(mine?.id, 'the player could not write a page');
  cleanup.push(() => call(GM, `${W}/pages/${mine.id}`, 'DELETE'));
  must((await call(P, `${W}/pages/${mine.id}`, 'PATCH', { gmOnly: true })).status === 403, 'the player hid a page');
  must((await call(P, `${W}/pages/${mine.id}`, 'DELETE')).status === 403, 'the player deleted a page');
  await P.goto(`${BASE}/w/${world.id}/wiki/${mine.id}`);
  await P.locator('.wiki-doc .ProseMirror').waitFor();
  must(await P.locator('.wiki-meta button:has-text("Delete")').count() === 0, 'the player has a Delete button');
  await P.waitForTimeout(400);
  await P.screenshot({ path: `${DIR}/06-player-wiki.png` });
  await GM.goto(`${BASE}/w/${world.id}/wiki/${secret.id}`);
  await GM.locator('.gm-only-toggle.on').waitFor();
  await GM.waitForTimeout(400);
  await GM.screenshot({ path: `${DIR}/07-gm-only-page.png` });
});

await step('player is refused GM actions (403)', async () => {
  const tries = [
    ['POST', `${W}/hexes/paint`, { hexIds: [target.id], terrain: 'forest' }],
    ['PATCH', `${W}/hexes/${target.id}`, { notes: 'mine now' }],
    ['POST', `${W}/campaigns/${camp.id}/fog`, { hexIds: [outer.id], explored: true }],
    ['POST', `${W}/factions`, { name: 'Usurpers', color: '#ff0000' }],
    ['GET', `${W}/roll-tables`],
    ['GET', '/api/players'],
    ['DELETE', `${W}/tokens/${party.id}`],
  ];
  for (const [m, path, body] of tries) {
    const r = await call(P, path, m, body);
    must(r.status === 403, `${m} ${path} answered ${r.status}`);
  }
  return `${tries.length} routes`;
});

await step('player settings are their own account', async () => {
  await P.goto(`${BASE}/w/${world.id}/settings`);
  await P.locator('h1:text-is("Your account")').waitFor();
  await P.waitForTimeout(600);
  must(await P.locator('text=Terrain types').count() === 0, 'the player sees world settings');
  await P.screenshot({ path: `${DIR}/08-player-account.png` });
});

await step('GM players list', async () => {
  await GM.goto(`${BASE}/w/${world.id}/settings`);
  const row = GM.locator(`.player-row[data-player="${username}"]`);
  await row.waitFor();
  await row.scrollIntoViewIfNeeded();
  await GM.waitForTimeout(300);
  await GM.screenshot({ path: `${DIR}/09-gm-players.png` });
});

await step('GM removes the player: their screen signs out', async () => {
  await P.goto(`${BASE}/w/${world.id}/map`);
  await mapReady(P);
  await GM.click(`.player-row[data-player="${username}"] button:has-text("Remove")`);
  await P.evaluate(() => window.addEventListener('atlas:unauthenticated', () => { window.__signedOutAt = Date.now(); }));
  let removedAt = 0;
  GM.on('response', (r) => { if (r.request().method() === 'DELETE' && r.url().includes('/api/players/')) removedAt = Date.now(); });
  await GM.click('.dialog button:has-text("Remove player")');
  await P.waitForSelector('#u', { timeout: LIMIT + 6000 });
  const told = await P.evaluate(() => window.__signedOutAt);
  const after = await call(P, '/api/worlds');
  must(after.status === 401, `the removed player's session still answers ${after.status}`);
  await P.screenshot({ path: `${DIR}/10-player-signed-out.png` });
  return `socket closed ${ms(told - removedAt)} after the server removed them`;
});

// ---------------------------------------------------------------- tidy up
for (const fn of cleanup) await fn();
await call(GM, `${W}/tokens/${hidden.id}`, 'DELETE');
await call(GM, `${W}/hexes/${noteHex.id}`, 'PATCH', { notes: oldNote, partyNotes: '' });
await call(GM, `${W}/hexes/${target.id}`, 'PATCH', { partyNotes: '' });
await call(GM, `${W}/tokens/${party.id}`, 'PATCH', { hexId: party.hexId });
const left = (await call(GM, '/api/players')).json.players.filter((p) => p.username === username);
if (left.length) await call(GM, `/api/players/${left[0].id}`, 'DELETE');

await b.close();
if (errs.length) { console.log('console errors:'); errs.forEach((e) => console.log('  ', e)); }
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed || errs.length ? 1 : 0);
