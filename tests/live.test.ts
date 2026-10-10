/**
 * Live sync over real sockets: the app listens on a free port and test clients connect like browsers do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../server/index';
import { ensureOwner } from '../server/auth';
import { seedDemoWorld } from '../server/worlds';
import { LiveHub, LocalBus, liveRoutes, SOCKETS_PER_SESSION, type ServerMsg } from '../server/live';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/atlas_test';
let app: FastifyInstance;
let live: LiveHub;
let cookie = '';
let base = '';
let worldA = '';
let worldB = '';

/** A socket that keeps every message, and waits for the one a test expects. */
type Client = { ws: WebSocket; msgs: ServerMsg[]; next: (pred: (m: ServerMsg) => boolean, ms?: number) => Promise<ServerMsg>; send: (m: unknown) => void; close: () => void };
function connect(opts: { cookie?: string; origin?: string; client?: string } = {}): Promise<Client> {
  const headers: Record<string, string> = {};
  if (opts.cookie ?? cookie) headers.cookie = opts.cookie ?? cookie;
  if (opts.origin !== '') headers.origin = opts.origin ?? base;
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live${opts.client ? `?client=${opts.client}` : ''}`, { headers });
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; done: (m: ServerMsg) => void }[] = [];
  ws.on('message', (raw) => {
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
    ws.on('open', () => resolve({ ws, msgs, next, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const call = async (method: string, url: string, body?: unknown, client?: string) => {
  const res = await app.inject({
    method: method as 'GET', url,
    headers: { cookie, ...(client ? { 'x-atlas-client': client } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};
const login = async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'test-password-123' } });
  return String(res.headers['set-cookie']).split(';')[0];
};
const quiet = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const isChange = (world: string) => (m: ServerMsg) => m.t === 'change' && m.world === world;

beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await c.end();
  const built = await buildApp({ databaseUrl: URL });
  app = built.app;
  live = built.live;
  await ensureOwner(built.db, 'gm', 'test-password-123');
  worldA = (await seedDemoWorld(built.db)).id;
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
  worldB = (await call('POST', '/api/worlds', { name: 'Elsewhere', cols: 6, rows: 5 })).body.id;
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => { await app?.close(); });

describe('live socket', () => {
  it('refuses anyone not signed in', async () => {
    await expect(connect({ cookie: 'atlas_session=nope' })).rejects.toThrow('status 401');
    await expect(connect({ cookie: '' })).rejects.toThrow('status 401');
  });

  it('refuses a socket opened from another site', async () => {
    await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow('status 403');
  });

  it('greets a signed-in screen and shows who is viewing a world', async () => {
    const a = await connect();
    const hello = await a.next((m) => m.t === 'hello');
    expect(hello.t === 'hello' && hello.you.name).toBe('gm');
    a.send({ t: 'sub', world: worldA });
    await a.next((m) => m.t === 'presence' && m.viewers.length === 1);
    const b = await connect();
    b.send({ t: 'sub', world: worldA });
    // Both screens hear the second arrive.
    await a.next((m) => m.t === 'presence' && m.viewers.length === 2);
    await b.next((m) => m.t === 'presence' && m.viewers.length === 2);
    b.close();
    await a.next((m) => m.t === 'presence' && m.viewers.length === 1);
    a.close();
  });
});

describe('broadcasts', () => {
  it('reach only the screens on the changed world, except the tab that made the change', async () => {
    const a = await connect();
    const b = await connect();
    const self = await connect({ client: 'tab-1' });
    a.send({ t: 'sub', world: worldA });
    b.send({ t: 'sub', world: worldB });
    self.send({ t: 'sub', world: worldA });
    await a.next((m) => m.t === 'presence');
    await b.next((m) => m.t === 'presence');
    await self.next((m) => m.t === 'presence');
    const f = (await call('GET', `/api/worlds/${worldA}/factions`)).body[0];
    expect((await call('PATCH', `/api/worlds/${worldA}/factions/${f.id}`, { name: 'Renamed Company' }, 'tab-1')).status).toBe(200);
    const m = await a.next(isChange(worldA));
    expect(m).not.toHaveProperty('origin');
    // The map only needs the faction's name and color, so it is patched rather than refetched.
    expect(m.t === 'change' && m.scopes).toContain('factions');
    expect(m.t === 'change' && m.scopes).not.toContain('map');
    expect(m.t === 'change' && m.patches).toEqual([{ op: 'faction', faction: { id: f.id, name: 'Renamed Company', color: f.color } }]);
    await quiet();
    expect(b.msgs.filter((x) => x.t === 'change')).toHaveLength(0);
    expect(self.msgs.filter((x) => x.t === 'change')).toHaveLength(0);
    self.close();
    // A change to the world list still reaches screens on other worlds, without the rows.
    await call('POST', `/api/worlds/${worldA}/day`, { advance: 1 });
    const other = await b.next((x) => x.t === 'change' && x.world === worldA);
    expect(other).toMatchObject({ scopes: ['worlds'] });
    expect(other.t === 'change' && other.patches).toBeUndefined();
    a.close(); b.close();
  });

  it('send changed map rows for paint, claims, markers and fog', async () => {
    const a = await connect();
    a.send({ t: 'sub', world: worldA });
    await a.next((m) => m.t === 'presence');
    const map = (await call('GET', `/api/worlds/${worldA}/map`)).body;
    const ids = map.hexes.slice(0, 3).map((h: { id: string }) => h.id);

    await call('POST', `/api/worlds/${worldA}/hexes/paint`, { hexIds: ids, terrain: 'swamp' });
    let m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches).toEqual([{ op: 'hexes', ids, set: { terrain: 'swamp' } }]);
    expect(m.t === 'change' && m.scopes).not.toContain('map');

    const faction = map.factions[0];
    await call('POST', `/api/worlds/${worldA}/claims/control`, { hexIds: ids, factionId: faction.id });
    m = await a.next(isChange(worldA));
    const claims = m.t === 'change' ? m.patches![0] : null;
    expect(claims).toMatchObject({ op: 'claims', hexIds: ids });
    expect(claims?.op === 'claims' && claims.claims.filter((c) => c.kind === 'control' && c.factionId === faction.id)).toHaveLength(3);

    const tok = (await call('POST', `/api/worlds/${worldA}/tokens`, { kind: 'unit', name: 'Scouts', hexId: ids[0] })).body;
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches?.[0]).toMatchObject({ op: 'token', token: { id: tok.id, hexId: ids[0] } });
    await call('PATCH', `/api/worlds/${worldA}/tokens/${tok.id}`, { hexId: ids[1] });
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches?.[0]).toMatchObject({ op: 'token', token: { id: tok.id, hexId: ids[1] } });
    await call('DELETE', `/api/worlds/${worldA}/tokens/${tok.id}`);
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches).toEqual([{ op: 'tokenGone', id: tok.id }]);

    // Settlements come with their own row, so the map is refetched instead.
    await call('POST', `/api/worlds/${worldA}/tokens`, { kind: 'outpost', name: 'Watch', hexId: ids[2] });
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.scopes).toContain('map');

    const camp = map.campaigns[0];
    await call('POST', `/api/worlds/${worldA}/campaigns/${camp.id}/fog`, { hexIds: ids, explored: true });
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches).toEqual([{ op: 'fog', campaignId: camp.id, hexIds: ids, explored: true }]);
    a.close();
  });

  it('carry the world clock and weather as a patch, and wiki edits as scopes', async () => {
    const a = await connect();
    a.send({ t: 'sub', world: worldA });
    await a.next((m) => m.t === 'presence');
    await call('PATCH', `/api/worlds/${worldA}/weather`, { kind: 'fog' });
    let m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches?.[0]).toMatchObject({ op: 'world', world: { weather: { kind: 'fog' } } });
    await call('PATCH', `/api/worlds/${worldA}/daylight`, { hour: 7, speed: 'paused' });
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches?.[0]).toMatchObject({ op: 'world', world: { daylight: { hour: 7, speed: 'paused' } } });
    const day = (await call('POST', `/api/worlds/${worldA}/day`, { advance: 1 })).body.currentDay;
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.patches?.[0]).toMatchObject({ op: 'world', world: { currentDay: day }, sweep: true });

    const page = (await call('POST', `/api/worlds/${worldA}/pages`, { title: 'Live page' })).body;
    await a.next(isChange(worldA));
    await call('PATCH', `/api/worlds/${worldA}/pages/${page.id}`, { title: 'Live page, edited' });
    m = await a.next(isChange(worldA));
    expect(m.t === 'change' && m.scopes).toEqual(expect.arrayContaining(['pages', 'page', 'search']));
    // A refused change says nothing.
    await call('PATCH', `/api/worlds/${worldA}/pages/${page.id}`, { title: '' });
    await quiet();
    expect(a.msgs.filter((x) => x.t === 'change')).toHaveLength(0);
    a.close();
  });

  it('relay a marker drag to the others on the world, not back to the dragger', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    a.send({ t: 'sub', world: worldA });
    b.send({ t: 'sub', world: worldA });
    c.send({ t: 'sub', world: worldB });
    await b.next((m) => m.t === 'presence' && m.viewers.length === 2);
    const token = crypto.randomUUID();
    a.send({ t: 'drag', token, x: 120.5, y: 64 });
    expect(await b.next((m) => m.t === 'drag')).toMatchObject({ token, x: 120.5, y: 64, world: worldA });
    a.send({ t: 'drag', token, x: 130, y: 70, end: true, to: null });
    expect(await b.next((m) => m.t === 'drag')).toMatchObject({ end: true });
    // Nonsense is dropped.
    a.send({ t: 'drag', token: 'x', x: 'far', y: 1 });
    await quiet();
    expect(a.msgs.filter((m) => m.t === 'drag')).toHaveLength(0);
    expect(b.msgs.filter((m) => m.t === 'drag')).toHaveLength(0);
    expect(c.msgs.filter((m) => m.t === 'drag')).toHaveLength(0);
    a.close(); b.close(); c.close();
  });

  it('close the sockets of a session as it signs out', async () => {
    const other = await login();
    const a = await connect({ cookie: other });
    const keep = await connect();
    const closed = new Promise<number>((r) => a.ws.on('close', (code) => r(code)));
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: other } });
    expect(await closed).toBe(4401);
    await quiet(100);
    expect(keep.ws.readyState).toBe(WebSocket.OPEN);
    keep.close();
  });

  it("can't be kept from a tab by naming its id from another session", async () => {
    const victim = await connect({ client: 'victim-tab' });
    victim.send({ t: 'sub', world: worldA });
    await victim.next((m) => m.t === 'presence');
    const other = await login();
    const res = await app.inject({ method: 'POST', url: `/api/worlds/${worldA}/events`, headers: { cookie: other, 'x-atlas-client': 'victim-tab', 'content-type': 'application/json' }, payload: JSON.stringify({ summary: 'Spoofed' }) });
    expect(res.statusCode).toBeLessThan(300);
    await victim.next(isChange(worldA));
    victim.close();
  });

  it("reach every screen in the order the changes were saved", async () => {
    const a = await connect();
    a.send({ t: 'sub', world: worldA });
    await a.next((m) => m.t === 'presence');
    const map = (await call('GET', `/api/worlds/${worldA}/map`)).body;
    const [h1, h2] = map.hexes.slice(10, 12).map((h: { id: string }) => h.id);
    const tok = (await call('POST', `/api/worlds/${worldA}/tokens`, { kind: 'unit', name: 'Racer', hexId: h1 })).body;
    await a.next(isChange(worldA));
    // Moves sent all at once, each before the last has answered.
    await Promise.all(Array.from({ length: 12 }, (_, i) => call('PATCH', `/api/worlds/${worldA}/tokens/${tok.id}`, { hexId: i % 2 ? h2 : h1 })));
    const moves: { seq: number; hexId: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const m = await a.next(isChange(worldA));
      if (m.t === 'change') moves.push({ seq: m.seq, hexId: (m.patches![0] as { token: { hexId: string } }).token.hexId });
    }
    expect(moves.map((x) => x.seq)).toEqual([...moves.map((x) => x.seq)].sort((x, y) => x - y));
    const saved = (await call('GET', `/api/worlds/${worldA}/map`)).body.tokens.find((t: { id: string }) => t.id === tok.id);
    expect(moves.at(-1)!.hexId).toBe(saved.hexId);
    await call('DELETE', `/api/worlds/${worldA}/tokens/${tok.id}`);
    a.close();
  });

  it('tell a screen where its subscription began, and every read where it began', async () => {
    const a = await connect();
    a.send({ t: 'sub', world: worldA });
    const subbed = await a.next((m) => m.t === 'subbed');
    const before = await app.inject({ method: 'GET', url: `/api/worlds/${worldA}/map`, headers: { cookie } });
    expect(Number(before.headers['x-atlas-seq'])).toBe(subbed.t === 'subbed' ? subbed.seq : -1);
    await call('POST', `/api/worlds/${worldA}/events`, { summary: 'Counted' });
    const m = await a.next(isChange(worldA));
    const after = await app.inject({ method: 'GET', url: `/api/worlds/${worldA}/map`, headers: { cookie } });
    expect(Number(after.headers['x-atlas-seq'])).toBe(m.t === 'change' ? m.seq : -1);
    // A world that doesn't exist can't be watched.
    a.send({ t: 'sub', world: crypto.randomUUID() });
    expect(await a.next((x) => x.t === 'subbed')).toMatchObject({ world: null });
    a.close();
  });
});

describe('limits', () => {
  it("keep one screen's let-gos and subscriptions from flooding the rest", async () => {
    const a = await connect();
    const b = await connect();
    a.send({ t: 'sub', world: worldA });
    b.send({ t: 'sub', world: worldA });
    await b.next((m) => m.t === 'presence' && m.viewers.length === 2);
    await quiet(200);
    b.msgs.length = 0;
    const token = crypto.randomUUID();
    for (let i = 0; i < 200; i++) a.send({ t: 'drag', token, x: i, y: 0, end: true, to: null });
    for (let i = 0; i < 200; i++) a.send({ t: 'sub', world: i % 2 ? worldB : worldA });
    await quiet(600);
    expect(b.msgs.filter((m) => m.t === 'drag').length).toBeLessThanOrEqual(10);
    expect(b.msgs.filter((m) => m.t === 'presence').length).toBeLessThanOrEqual(10);
    a.close(); b.close();
  });

  it('let one session hold only so many sockets, the oldest making way', async () => {
    const other = await login();
    const socks = [];
    for (let i = 0; i < SOCKETS_PER_SESSION; i++) socks.push(await connect({ cookie: other }));
    const closed = new Promise<void>((r) => socks[0].ws.on('close', () => r()));
    const extra = await connect({ cookie: other });
    await closed;
    expect(socks.slice(1).every((s) => s.ws.readyState === WebSocket.OPEN)).toBe(true);
    [...socks, extra].forEach((s) => s.close());
  });
});

describe('route coverage', () => {
  it('refuses to boot with a mutating route that says nothing about what it changes', async () => {
    const f = Fastify();
    const hub = new LiveHub(new LocalBus());
    await expect(f.register(async (api) => {
      liveRoutes(api, hub, { user: async () => null, token: () => undefined });
      api.post('/api/worlds/:w/unlisted', async () => ({}));
    })).rejects.toThrow('has no ROUTE_SCOPES entry');
    hub.close();
  });
});
