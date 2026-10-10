/**
 * Player accounts: who may change what (every mutating route, as a player), and what never reaches a player's
 * screen (fogged hexes, GM notes, hidden markers, GM-only pages, the simulation's numbers), over HTTP and live.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../server/index';
import { ensureOwner } from '../server/auth';
import { ROUTE_ACCESS, accessGate } from '../server/access';
import { ROUTE_SCOPES, type ServerMsg } from '../server/live';
import { generatePassword } from '../server/routes/players';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/atlas_test';
let app: FastifyInstance;
let base = '';
let gm = '';
let player = '';
let playerId = '';
let playerPass = '';

// The world under test: a party that has explored some hexes and not others, with secrets on both.
let W = '';
let OTHER = '';
let camp = '';
let otherCamp = '';
let otherWorldCamp = '';
let faction = '';
let hexes: { id: string; q: number; r: number }[] = [];
let R: string[] = []; // explored by the party
let F: string[] = []; // fogged
const ids: Record<string, string> = {};

/** Strings that must never reach a player (anywhere: bodies, live messages). */
const SECRETS = [
  'SECRET-GM-NOTE', 'SECRET-FOG-NAME', 'SECRET-FOG-NOTE', 'SECRET-HIDDEN-TOKEN', 'SECRET-FOGGED-TOKEN', 'SECRET-FOG-OUTPOST',
  'SECRET-SETTLEMENT-NOTE', 'SECRET-CLAIM-NOTE', 'SECRET-CAMPAIGN-NOTE', 'SECRET-PAGE-TITLE', 'SECRET-PAGE-BODY', 'SECRET-METER-CAUSE',
  'SECRET-OTHER-PARTY', 'SECRET-OTHER-WORLD', 'SECRET-TOKEN-DATA', 'SECRET-HEX-DATA', 'SECRET-LIVE',
];

const call = async (cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({
    method: method as 'GET', url,
    headers: { cookie, ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  try { parsed = res.body ? JSON.parse(res.body) : undefined; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed as any, raw: res.body }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const asGm = (method: string, url: string, body?: unknown) => call(gm, method, url, body);
const asPlayer = (method: string, url: string, body?: unknown) => call(player, method, url, body);
const login = async (username: string, password: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0];
};
const leaks = (text: string) => [...SECRETS, ids.hidden, ids.fogged, ids.fogOutpost, ids.secretPage].filter((s) => s && text.includes(s));

beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await c.end();
  const built = await buildApp({ databaseUrl: URL });
  app = built.app;
  await ensureOwner(built.db, 'gm', 'test-password-123');
  gm = await login('gm', 'test-password-123');

  W = (await asGm('POST', '/api/worlds', { name: 'Fogland', cols: 8, rows: 6 })).body.id;
  OTHER = (await asGm('POST', '/api/worlds', { name: 'SECRET-OTHER-WORLD', cols: 4, rows: 4 })).body.id;
  camp = (await asGm('POST', `/api/worlds/${W}/campaigns`, { name: 'The Lanterns' })).body.id;
  otherCamp = (await asGm('POST', `/api/worlds/${W}/campaigns`, { name: 'SECRET-OTHER-PARTY' })).body.id;
  otherWorldCamp = (await asGm('POST', `/api/worlds/${OTHER}/campaigns`, { name: 'Elsewhere' })).body.id;
  faction = (await asGm('POST', `/api/worlds/${W}/factions`, { name: 'The Wardens' })).body.id;
  hexes = (await asGm('GET', `/api/worlds/${W}/map`)).body.hexes;
  R = hexes.slice(0, 12).map((h) => h.id);
  F = hexes.slice(20).map((h) => h.id);
  await asGm('POST', `/api/worlds/${W}/campaigns/${camp}/fog`, { hexIds: R, explored: true });
  await asGm('POST', `/api/worlds/${W}/campaigns/${otherCamp}/fog`, { hexIds: F.slice(0, 5), explored: true });

  // Secrets on explored and fogged ground.
  await asGm('PATCH', `/api/worlds/${W}/hexes/${R[0]}`, { notes: 'SECRET-GM-NOTE', name: 'Lantern Ford', terrain: 'forest', data: { danger: 'SECRET-HEX-DATA' } });
  await asGm('PATCH', `/api/worlds/${W}/hexes/${F[0]}`, { notes: 'SECRET-FOG-NOTE', name: 'SECRET-FOG-NAME', terrain: 'mountains' });
  ids.hidden = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'unit', name: 'SECRET-HIDDEN-TOKEN', hexId: R[1], visibleToPlayers: false })).body.id;
  ids.fogged = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'unit', name: 'SECRET-FOGGED-TOKEN', hexId: F[1] })).body.id;
  ids.scouts = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'unit', name: 'Open Scouts', hexId: R[2] })).body.id;
  await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { data: { orders: 'SECRET-TOKEN-DATA' } });
  ids.party = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'party', name: 'The Lanterns', hexId: R[3], campaignId: camp })).body.id;
  ids.otherParty = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'party', name: 'Rivals', hexId: R[4], campaignId: otherCamp })).body.id;
  ids.fogOutpost = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'outpost', name: 'SECRET-FOG-OUTPOST', hexId: F[2] })).body.id;
  const town = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'outpost', name: 'Open Town', hexId: R[5] })).body;
  await asGm('PATCH', `/api/worlds/${W}/settlements/${town.settlementId}`, { notes: 'SECRET-SETTLEMENT-NOTE' });
  await asGm('POST', `/api/worlds/${W}/claims/control`, { hexIds: [R[6], F[3]], factionId: faction, note: 'SECRET-CLAIM-NOTE' });
  await asGm('PATCH', `/api/worlds/${W}/campaigns/${camp}`, { notes: 'SECRET-CAMPAIGN-NOTE' });
  ids.secretPage = (await asGm('POST', `/api/worlds/${W}/pages`, {
    title: 'SECRET-PAGE-TITLE', gmOnly: true,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SECRET-PAGE-BODY lantern' }] }] },
  })).body.id;
  ids.openPage = (await asGm('POST', `/api/worlds/${W}/pages`, {
    title: 'Open Lore',
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The lantern road. ' }, { type: 'wikiLink', attrs: { pageId: ids.secretPage, label: 'the hidden truth' } }] }] },
  })).body.id;
  // The secret page links to the open one: a backlink a player must not see.
  await asGm('PATCH', `/api/worlds/${W}/pages/${ids.secretPage}`, {
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SECRET-PAGE-BODY ' }, { type: 'wikiLink', attrs: { pageId: ids.openPage, label: 'Open Lore' } }] }] },
  });
  await asGm('PATCH', `/api/worlds/${W}/hexes/${R[7]}`, { wikiPageId: ids.secretPage });
  await asGm('PATCH', `/api/worlds/${W}/factions/${faction}`, { wikiPageId: ids.secretPage, description: 'Keepers of the road.' });
  const meters = (await asGm('GET', `/api/worlds/${W}/meters`)).body;
  ids.meter = meters[0].id;
  await asGm('POST', `/api/worlds/${W}/factions/${faction}/meters/${ids.meter}`, { value: 12, cause: 'SECRET-METER-CAUSE' });

  // The GM adds a player with a generated password, and puts them in one campaign.
  const made = await asGm('POST', '/api/players', { displayName: 'Ana', username: 'ana' });
  expect(made.status).toBe(200);
  playerId = made.body.player.id;
  playerPass = made.body.password;
  expect(playerPass).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  expect((await asGm('PUT', `/api/players/${playerId}/campaigns`, { campaignIds: [camp] })).status).toBe(200);
  player = await login('Ana', playerPass);
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); });

describe('player accounts', () => {
  it('signs players in with their role, and keeps the GM the GM', async () => {
    expect((await asPlayer('GET', '/api/auth/me')).body).toMatchObject({ username: 'ana', name: 'Ana', role: 'player' });
    expect((await asGm('GET', '/api/auth/me')).body).toMatchObject({ username: 'gm', role: 'gm' });
    const list = (await asGm('GET', '/api/players')).body;
    expect(list.players).toEqual([expect.objectContaining({ id: playerId, username: 'ana', displayName: 'Ana', campaignIds: [camp] })]);
    expect(list.players[0]).not.toHaveProperty('passwordHash');
    expect(list.campaigns.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([camp, otherCamp, otherWorldCamp]));
  });

  it('refuses taken usernames regardless of case, and short passwords', async () => {
    expect((await asGm('POST', '/api/players', { displayName: 'X', username: 'ANA' })).status).toBe(409);
    expect((await asGm('POST', '/api/players', { displayName: 'X', username: 'GM' })).status).toBe(409);
    expect((await asGm('POST', '/api/players', { displayName: 'X', username: 'xavier', password: 'short' })).status).toBe(400);
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it('lets a player change their own display name and password, not the GM’s password', async () => {
    expect((await asPlayer('PATCH', '/api/account', { displayName: 'Ana the Bold' })).body.name).toBe('Ana the Bold');
    expect((await asPlayer('POST', '/api/account/password', { current: 'wrong-password', password: 'brand-new-pass-1' })).status).toBe(403);
    const elsewhere = await login('ana', playerPass);
    expect((await asPlayer('POST', '/api/account/password', { current: playerPass, password: 'brand-new-pass-1' })).status).toBe(200);
    playerPass = 'brand-new-pass-1';
    // This session stays; the player's other sessions are signed out.
    expect((await asPlayer('GET', '/api/auth/me')).status).toBe(200);
    expect((await call(elsewhere, 'GET', '/api/auth/me')).status).toBe(401);
    expect((await asGm('POST', '/api/account/password', { current: 'test-password-123', password: 'another-pass-123' })).status).toBe(400);
    await asPlayer('PATCH', '/api/account', { displayName: 'Ana' });
  });
});

describe('what a player sees', () => {
  it('only the worlds of their campaigns', async () => {
    const worlds = await asPlayer('GET', '/api/worlds');
    expect(worlds.body.map((w: { id: string }) => w.id)).toEqual([W]);
    expect(worlds.body[0]).toMatchObject({ pageCount: 1, campaignCount: 1, artVersion: null });
    expect(worlds.body[0].terrainMix.find((t: { terrain: string }) => t.terrain === 'mountains')).toBeUndefined();
    expect((await asPlayer('GET', `/api/worlds/${OTHER}`)).status).toBe(404);
    expect((await asPlayer('GET', `/api/worlds/${OTHER}/map`)).status).toBe(404);
    expect((await asPlayer('GET', `/api/worlds/${W}`)).status).toBe(200);
  });

  it('the map through their party’s fog, without GM notes, hidden markers, art or model', async () => {
    const res = await asPlayer('GET', `/api/worlds/${W}/map`);
    expect(res.status).toBe(200);
    expect(leaks(res.raw)).toEqual([]);
    const map = res.body;
    expect(map.hexes).toHaveLength(hexes.length);
    for (const h of map.hexes) {
      if (R.includes(h.id)) { expect(h.notes).toBe(''); expect(h.data).toEqual({}); expect(h.fogged).toBeUndefined(); }
      else expect(h).toEqual({ id: h.id, q: h.q, r: h.r, terrain: 'unknown', state: 'wild', name: '', notes: '', partyNotes: '', wikiPageId: null, data: {}, fogged: true });
    }
    expect(map.hexes.find((h: { id: string }) => h.id === R[0])).toMatchObject({ name: 'Lantern Ford', terrain: 'forest' });
    // The hex linking a GM-only page shows no link.
    expect(map.hexes.find((h: { id: string }) => h.id === R[7]).wikiPageId).toBeNull();
    expect(map.tokens.map((t: { name: string }) => t.name).sort()).toEqual(['Open Scouts', 'Open Town', 'Rivals', 'The Lanterns']);
    expect(map.settlements.map((s: { name: string; notes: string }) => [s.name, s.notes])).toEqual([['Open Town', '']]);
    expect(map.claims.map((c: { hexId: string; note: string }) => [c.hexId, c.note])).toEqual([[R[6], '']]);
    expect(map.campaigns).toEqual([{ id: camp, name: 'The Lanterns' }]);
    expect(map.map.art).toBeNull();
    expect(map.map.model).toBeNull();
    // Their own party's fog, and no one else's.
    expect((await asPlayer('GET', `/api/worlds/${W}/campaigns/${camp}/fog`)).body.sort()).toEqual([...R].sort());
    expect((await asPlayer('GET', `/api/worlds/${W}/campaigns/${otherCamp}/fog`)).status).toBe(404);
    // Asking to view as a campaign that isn't theirs gets their own.
    const as = await call(player, 'GET', `/api/worlds/${W}/map`, undefined, { 'x-atlas-campaign': otherCamp });
    expect(as.body.campaigns).toEqual([{ id: camp, name: 'The Lanterns' }]);
    expect(leaks(as.raw)).toEqual([]);
  });

  it('wiki pages, search and backlinks without GM-only pages', async () => {
    const pages = await asPlayer('GET', `/api/worlds/${W}/pages`);
    expect(pages.body.map((p: { title: string }) => p.title)).toEqual(['Open Lore']);
    expect((await asPlayer('GET', `/api/worlds/${W}/pages/${ids.secretPage}`)).status).toBe(404);
    const open = await asPlayer('GET', `/api/worlds/${W}/pages/${ids.openPage}`);
    expect(open.body.backlinks).toEqual([]);
    for (const q of ['secret', 'lantern', 'SECRET-PAGE', 'hidden']) {
      const hits = await asPlayer('GET', `/api/worlds/${W}/search?q=${encodeURIComponent(q)}`);
      expect(hits.body.every((h: { id: string }) => h.id !== ids.secretPage)).toBe(true);
      expect(leaks(hits.raw)).toEqual([]);
    }
    expect((await asGm('GET', `/api/worlds/${W}/search?q=secret`)).body[0].id).toBe(ids.secretPage);
    // Taking a GM-only page's title is refused without pointing at it.
    const dup = await asPlayer('POST', `/api/worlds/${W}/pages`, { title: 'secret-page-title' });
    expect(dup.status).toBe(409);
    expect(dup.body.page).toBeUndefined();
  });

  it('factions without meters, roll tables or the simulation’s history', async () => {
    const fs = await asPlayer('GET', `/api/worlds/${W}/factions`);
    expect(fs.body).toEqual([expect.objectContaining({ id: faction, name: 'The Wardens', description: 'Keepers of the road.', meters: [], signatureMeterId: null, wikiPageId: null, claims: { control: 1 } })]);
    expect((await asPlayer('GET', `/api/worlds/${W}/meters`)).body).toEqual([]);
    expect((await asPlayer('GET', `/api/worlds/${W}/factions/${faction}/meters/${ids.meter}/history`)).status).toBe(403);
    expect((await asPlayer('GET', `/api/worlds/${W}/roll-tables`)).status).toBe(403);
    expect((await asPlayer('GET', `/api/worlds/${W}/map/art`)).status).toBe(403);
    expect((await asPlayer('GET', `/api/worlds/${W}/map/model`)).status).toBe(403);
    expect((await asPlayer('GET', `/api/worlds/${W}/map/model/archive`)).status).toBe(403);
    expect((await asPlayer('GET', '/api/players')).status).toBe(403);
  });

  it('campaigns and the chronicle about what they can see', async () => {
    const cs = await asPlayer('GET', `/api/worlds/${W}/campaigns`);
    expect(cs.body.map((c: { id: string; notes: string }) => [c.id, c.notes])).toEqual([[camp, '']]);
    const ev = await asPlayer('GET', `/api/worlds/${W}/events?limit=500`);
    expect(ev.status).toBe(200);
    expect(leaks(ev.raw)).toEqual([]);
    const kinds = new Set(ev.body.map((e: { kind: string }) => e.kind));
    expect(kinds.has('meter.changed')).toBe(false);
    // Entries about explored ground are there.
    expect(ev.body.some((e: { summary: string }) => e.summary.includes('Lantern Ford'))).toBe(true);
    expect(ev.body.some((e: { summary: string }) => e.summary.includes('Open Lore'))).toBe(true);
    // Paging still fills a page.
    const page = await asPlayer('GET', `/api/worlds/${W}/events?limit=3`);
    expect(page.body).toHaveLength(3);
    const next = await asPlayer('GET', `/api/worlds/${W}/events?limit=3&before=${page.body[2].id}`);
    expect(next.body[0].id).toBeLessThan(page.body[2].id);
  });
});

/** A plausible URL for a route: its params filled with real ids where it matters. */
const urlFor = (route: string) => route
  .replace(':w', W).replace(':m', ids.meter)
  .replace(':id', route.includes('/pages/') ? ids.openPage : route.includes('/tokens/') ? ids.scouts : route.includes('/hexes/') ? R[0]
    : route.includes('/campaigns/') ? camp : route.includes('/factions/') ? faction : route.includes('/players/') ? playerId : crypto.randomUUID());

describe('what a player may change', () => {
  const mutating = Object.keys(ROUTE_ACCESS).filter((k) => !k.startsWith('GET '));

  it('lists every mutating route with live sync, and every route with an access rule', () => {
    expect(new Set(mutating)).toEqual(new Set(Object.keys(ROUTE_SCOPES)));
  });

  it.each(mutating.filter((k) => ROUTE_ACCESS[k] === 'gm'))('%s: 403 for players', async (key) => {
    const [method, route] = key.split(' ');
    const res = await asPlayer(method, urlFor(route), method === 'DELETE' ? undefined : {});
    expect(res.status).toBe(403);
  });

  it('turns the day over at midnight, but doesn’t move the clock', async () => {
    expect((await asPlayer('POST', `/api/worlds/${W}/day`, { advance: 1 })).status).toBe(403);
    expect((await asPlayer('POST', `/api/worlds/${W}/day`, { day: 40 })).status).toBe(403);
    expect((await asPlayer('POST', `/api/worlds/${W}/day`, { rollover: { from: 1 }, advance: 3 })).status).toBe(403);
    expect((await asPlayer('POST', `/api/worlds/${W}/day`, { rollover: { from: 1 } })).status).toBe(200);
  });

  it('writes party notes on explored hexes only, and nothing else on a hex', async () => {
    const ok = await asPlayer('PATCH', `/api/worlds/${W}/hexes/${R[0]}`, { partyNotes: 'We camped by the ford.' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ partyNotes: 'We camped by the ford.', notes: '' });
    expect(leaks(ok.raw)).toEqual([]);
    expect((await asGm('GET', `/api/worlds/${W}/map`)).body.hexes.find((h: { id: string }) => h.id === R[0])).toMatchObject({ partyNotes: 'We camped by the ford.', notes: 'SECRET-GM-NOTE' });
    expect((await asPlayer('PATCH', `/api/worlds/${W}/hexes/${F[0]}`, { partyNotes: 'peek' })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/hexes/${R[0]}`, { notes: 'mine now' })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/hexes/${R[0]}`, { terrain: 'swamp' })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/hexes/${R[0]}`, { partyNotes: 'x', name: 'Mine' })).status).toBe(403);
  });

  it('moves their party marker within explored hexes, and no other marker', async () => {
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.party}`, { hexId: R[8] })).status).toBe(200);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.party}`, { hexId: F[4] })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.party}`, { name: 'Renamed' })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.party}`, { hexId: R[9], visibleToPlayers: false })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { hexId: R[8] })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.otherParty}`, { hexId: R[8] })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.hidden}`, { hexId: R[8] })).status).toBe(404);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/tokens/${ids.fogged}`, { hexId: R[8] })).status).toBe(404);
  });

  it('creates and edits pages everyone sees; can’t delete, hide or reach GM-only ones', async () => {
    const made = await asPlayer('POST', `/api/worlds/${W}/pages`, { title: 'Session 1' });
    expect(made.status).toBe(200);
    expect(made.body.gmOnly).toBe(false);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/pages/${made.body.id}`, { title: 'Session one' })).status).toBe(200);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/pages/${ids.openPage}`, { category: 'Place' })).status).toBe(200);
    expect((await asPlayer('POST', `/api/worlds/${W}/pages`, { title: 'Sneaky', gmOnly: true })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/pages/${made.body.id}`, { gmOnly: true })).status).toBe(403);
    expect((await asPlayer('PATCH', `/api/worlds/${W}/pages/${ids.secretPage}`, { title: 'Found it' })).status).toBe(404);
    expect((await asPlayer('DELETE', `/api/worlds/${W}/pages/${made.body.id}`)).status).toBe(403);
    // The GM hides a page; players lose it.
    expect((await asGm('PATCH', `/api/worlds/${W}/pages/${made.body.id}`, { gmOnly: true })).body.gmOnly).toBe(true);
    expect((await asPlayer('GET', `/api/worlds/${W}/pages/${made.body.id}`)).status).toBe(404);
    await asGm('PATCH', `/api/worlds/${W}/pages/${made.body.id}`, { gmOnly: false });
  });
});

describe('route access', () => {
  it('refuses to boot with a route that says nothing about who may use it', async () => {
    const f = Fastify();
    await expect(f.register(async (api) => {
      accessGate(api, null as never);
      api.get('/api/worlds/:w/unlisted', async () => ({}));
    })).rejects.toThrow('has no ROUTE_ACCESS entry');
  });
});

// ---------------------------------------------------------------- live
type Client = { ws: WebSocket; msgs: ServerMsg[]; all: string[]; next: (pred: (m: ServerMsg) => boolean, ms?: number) => Promise<ServerMsg>; send: (m: unknown) => void; close: () => void };
function connect(cookie: string): Promise<Client> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live`, { headers: { cookie, origin: base } });
  const msgs: ServerMsg[] = [];
  const all: string[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; done: (m: ServerMsg) => void }[] = [];
  ws.on('message', (raw) => {
    all.push(raw.toString());
    const m = JSON.parse(raw.toString()) as ServerMsg;
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.done(m); }
  });
  const next = (pred: (m: ServerMsg) => boolean, ms = 3000) => new Promise<ServerMsg>((resolve, reject) => {
    const seen = msgs.find(pred);
    if (seen) { msgs.splice(msgs.indexOf(seen), 1); return resolve(seen); }
    const t = setTimeout(() => reject(new Error('no matching message')), ms);
    waiters.push({ pred, done: (m) => { clearTimeout(t); msgs.splice(msgs.indexOf(m), 1); resolve(m); } });
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, msgs, all, next, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}
const quiet = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const isChange = (m: ServerMsg) => m.t === 'change' && m.world === W;
const patchesOf = (m: ServerMsg) => (m.t === 'change' ? m.patches ?? [] : []);

describe('live sync for players', () => {
  it('filters every change and drag a player socket hears', async () => {
    const p = await connect(player);
    const g = await connect(gm);
    p.send({ t: 'sub', world: W });
    g.send({ t: 'sub', world: W });
    await p.next((m) => m.t === 'subbed' && m.world === W);
    await g.next((m) => m.t === 'subbed' && m.world === W);
    // Presence shows the player by display name, as a player.
    const pres = await g.next((m) => m.t === 'presence' && m.viewers.length === 2);
    expect(pres.t === 'presence' && pres.viewers.find((v) => v.role === 'player')?.name).toBe('Ana');

    // Paint across explored and fogged hexes: only the explored ones arrive.
    await asGm('POST', `/api/worlds/${W}/hexes/paint`, { hexIds: [R[10], F[5]], terrain: 'swamp' });
    expect(patchesOf(await p.next(isChange))).toEqual([{ op: 'hexes', ids: [R[10]], set: { terrain: 'swamp' } }]);
    // A GM note on an explored hex comes without the note; edits on fogged hexes don't come at all.
    await asGm('PATCH', `/api/worlds/${W}/hexes/${R[10]}`, { notes: 'SECRET-LIVE note' });
    const hexPatch = patchesOf(await p.next(isChange))[0];
    expect(hexPatch).toMatchObject({ op: 'hex', hex: { id: R[10], notes: '' } });
    await asGm('PATCH', `/api/worlds/${W}/hexes/${R[7]}`, { name: 'Linked' });
    expect(patchesOf(await p.next(isChange))[0]).toMatchObject({ op: 'hex', hex: { id: R[7], wikiPageId: null } });
    await asGm('PATCH', `/api/worlds/${W}/hexes/${F[5]}`, { name: 'SECRET-LIVE fog', notes: 'SECRET-LIVE' });
    await asGm('POST', `/api/worlds/${W}/claims/control`, { hexIds: [F[6]], factionId: faction, note: 'SECRET-LIVE' });
    // Hidden markers and markers in the fog: nothing, not even their drags.
    const hidden2 = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'unit', name: 'SECRET-LIVE hidden', hexId: R[11], visibleToPlayers: false })).body.id;
    const fogged2 = (await asGm('POST', `/api/worlds/${W}/tokens`, { kind: 'unit', name: 'SECRET-LIVE fogged', hexId: F[7] })).body.id;
    g.send({ t: 'drag', token: hidden2, x: 10, y: 10 });
    g.send({ t: 'drag', token: ids.hidden, x: 12, y: 10 });
    g.send({ t: 'drag', token: fogged2, x: 12, y: 10, end: true, to: null });
    // A marker players see: its drag and move arrive; walking into the fog takes it off their map.
    g.send({ t: 'drag', token: ids.scouts, x: 20, y: 20 });
    expect(await p.next((m) => m.t === 'drag')).toMatchObject({ token: ids.scouts });
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { hexId: F[8] });
    expect(patchesOf(await p.next((m) => isChange(m) && patchesOf(m).length > 0))).toEqual([{ op: 'tokenGone', id: ids.scouts }]);
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { hexId: R[2] });
    expect(patchesOf(await p.next((m) => isChange(m) && patchesOf(m).length > 0))[0]).toMatchObject({ op: 'token', token: { id: ids.scouts, hexId: R[2], data: {} } });
    // Hiding a marker takes it away too.
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { visibleToPlayers: false });
    expect(patchesOf(await p.next((m) => isChange(m) && patchesOf(m).length > 0))).toEqual([{ op: 'tokenGone', id: ids.scouts }]);
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.scouts}`, { visibleToPlayers: true });
    await p.next((m) => isChange(m) && patchesOf(m).some((x) => x.op === 'token'));

    // GM-only pages: not a word. The GM's other screens hear of them.
    await asGm('POST', `/api/worlds/${W}/pages`, { title: 'SECRET-LIVE page', gmOnly: true });
    await g.next(isChange);
    await asGm('PATCH', `/api/worlds/${W}/pages/${ids.secretPage}`, { category: 'Plot' });
    await g.next(isChange);
    // Roll tables and meters: the GM's alone.
    await asGm('POST', `/api/worlds/${W}/roll-tables`, { name: 'SECRET-LIVE table' });
    await asGm('POST', `/api/worlds/${W}/factions/${faction}/meters/${ids.meter}`, { value: 30, cause: 'SECRET-LIVE' });
    await quiet(300);
    const heard = p.msgs.filter((m) => m.t === 'change');
    expect(heard.every((m) => m.t === 'change' && !m.scopes.some((s) => ['rolls', 'mh', 'meters'].includes(s)))).toBe(true);
    expect(p.msgs.filter((m) => m.t === 'drag')).toEqual([]);
    expect(leaks(p.all.join('\n'))).toEqual([]);
    expect(p.all.some((x) => x.includes(hidden2) || x.includes(fogged2))).toBe(false);
    p.close(); g.close();
  });

  it('shows fog revealed and hidden by the GM live, and streams the player’s own moves and notes to the GM', async () => {
    const p = await connect(player);
    const g = await connect(gm);
    p.send({ t: 'sub', world: W });
    g.send({ t: 'sub', world: W });
    await p.next((m) => m.t === 'subbed' && m.world === W);
    await g.next((m) => m.t === 'subbed' && m.world === W);

    // Another party's fog: nothing. Their own: the map is read again, through the new fog.
    await asGm('POST', `/api/worlds/${W}/campaigns/${otherCamp}/fog`, { hexIds: [F[9]], explored: true });
    await asGm('POST', `/api/worlds/${W}/campaigns/${camp}/fog`, { hexIds: [F[1]], explored: true });
    const reveal = await p.next(isChange);
    expect(reveal.t === 'change' && reveal.scopes).toContain('map');
    expect(patchesOf(reveal)).toEqual([{ op: 'fog', campaignId: camp, hexIds: [F[1]], explored: true }]);
    const now = (await asPlayer('GET', `/api/worlds/${W}/map`)).body;
    expect(now.tokens.some((t: { id: string }) => t.id === ids.fogged)).toBe(true);
    // Once explored, the marker there is theirs to see move.
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.fogged}`, { name: 'Now seen' });
    expect(patchesOf(await p.next(isChange))[0]).toMatchObject({ op: 'token', token: { id: ids.fogged, name: 'Now seen' } });
    await asGm('POST', `/api/worlds/${W}/campaigns/${camp}/fog`, { hexIds: [F[1]], explored: false });
    const hide = await p.next(isChange);
    expect(hide.t === 'change' && hide.scopes).toContain('map');
    expect((await asPlayer('GET', `/api/worlds/${W}/map`)).body.tokens.some((t: { id: string }) => t.id === ids.fogged)).toBe(false);
    await asGm('PATCH', `/api/worlds/${W}/tokens/${ids.fogged}`, { name: 'SECRET-LIVE again' });

    // The player's party marker: their drag reaches the GM, then the move; other markers' drags don't go out.
    p.send({ t: 'drag', token: ids.party, x: 5, y: 5 });
    expect(await g.next((m) => m.t === 'drag')).toMatchObject({ token: ids.party });
    p.send({ t: 'drag', token: ids.otherParty, x: 5, y: 5 });
    p.send({ t: 'drag', token: ids.hidden, x: 5, y: 5 });
    const moved = await call(player, 'PATCH', `/api/worlds/${W}/tokens/${ids.party}`, { hexId: R[9] }, { 'x-atlas-client': 'player-tab' });
    expect(moved.status).toBe(200);
    const hasPatch = (op: string, id: string) => (m: ServerMsg) => isChange(m) && patchesOf(m).some((x) => x.op === op && ((x as { token?: { id: string }; hex?: { id: string } }).token ?? (x as { hex?: { id: string } }).hex)?.id === id);
    expect(patchesOf(await g.next(hasPatch('token', ids.party)))[0]).toMatchObject({ op: 'token', token: { id: ids.party, hexId: R[9] } });
    await call(player, 'PATCH', `/api/worlds/${W}/hexes/${R[9]}`, { partyNotes: 'Wolves at night.' });
    expect(patchesOf(await g.next(hasPatch('hex', R[9])))[0]).toMatchObject({ op: 'hex', hex: { id: R[9], partyNotes: 'Wolves at night.' } });
    await quiet();
    expect(g.msgs.filter((m) => m.t === 'drag')).toEqual([]);
    // (The fogged marker was seen while its hex was explored; nothing after it went back into the fog.)
    expect(leaks(p.all.join('\n')).filter((x) => x !== ids.fogged)).toEqual([]);
    p.close(); g.close();
  });

  it('restarts a player’s screens when their campaigns change, and signs out a removed player', async () => {
    const p = await connect(player);
    p.send({ t: 'sub', world: W });
    await p.next((m) => m.t === 'subbed' && m.world === W);
    const restarted = new Promise<number>((r) => p.ws.on('close', (code) => r(code)));
    await asGm('PUT', `/api/players/${playerId}/campaigns`, { campaignIds: [camp, otherWorldCamp] });
    expect(await restarted).toBe(4409);
    expect((await asPlayer('GET', '/api/worlds')).body.map((w: { id: string }) => w.id).sort()).toEqual([W, OTHER].sort());

    // A world the player isn't in can't be watched.
    await asGm('PUT', `/api/players/${playerId}/campaigns`, { campaignIds: [camp] });
    const q = await connect(player);
    q.send({ t: 'sub', world: OTHER });
    expect(await q.next((m) => m.t === 'subbed')).toMatchObject({ world: null });
    q.send({ t: 'sub', world: W });
    await q.next((m) => m.t === 'subbed' && m.world === W);

    const closed = new Promise<number>((r) => q.ws.on('close', (code) => r(code)));
    expect((await asGm('DELETE', `/api/players/${playerId}`)).status).toBe(200);
    expect(await closed).toBe(4401);
    expect((await asPlayer('GET', '/api/auth/me')).status).toBe(401);
    expect((await asPlayer('GET', `/api/worlds/${W}/map`)).status).toBe(401);
    await expect(connect(player)).rejects.toThrow('status 401');
    expect((await asGm('GET', '/api/players')).body.players).toEqual([]);
  });

  it('signs a player out everywhere when the GM resets their password', async () => {
    const made = (await asGm('POST', '/api/players', { displayName: 'Bo', username: 'bo', password: 'bo-password-1', campaignIds: [camp] })).body;
    expect(made.password).toBeUndefined();
    const bo = await login('bo', 'bo-password-1');
    const s = await connect(bo);
    const closed = new Promise<number>((r) => s.ws.on('close', (code) => r(code)));
    const reset = await asGm('POST', `/api/players/${made.player.id}/password`, {});
    expect(reset.body.password).toMatch(/^[a-z2-9-]{14}$/);
    expect(await closed).toBe(4401);
    expect((await call(bo, 'GET', '/api/auth/me')).status).toBe(401);
    await login('bo', reset.body.password);
  });
});
