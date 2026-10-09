/**
 * API integration tests against a real Postgres (TEST_DATABASE_URL).
 * Each run starts from an empty schema so results don't depend on prior runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/index';
import { ensureOwner } from '../server/auth';
import { deflateSync } from 'node:zlib';
import { seedDemoWorld, upgradeDemo, DEMO_VERSION } from '../server/worlds';
import { seedNewWorldOnce, FIXES, LORE_FILE } from '../server/lore/newworld';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { wikiPages, wikiLinks } from '../server/db/schema';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/atlas_test';
let app: FastifyInstance;
let cookie = '';
let db: Awaited<ReturnType<typeof buildApp>>['db'];

async function boot() {
  const built = await buildApp({ databaseUrl: URL });
  return built;
}

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as 'GET', url, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await c.end();
  const built = await boot();
  app = built.app;
  db = built.db;
  await ensureOwner(built.db, 'gm', 'test-password-123');
  await seedDemoWorld(built.db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
afterAll(async () => { await app?.close(); });

describe('auth', () => {
  it('rejects anonymous API calls and bad passwords', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/worlds' });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
  });
  it('keeps a session', async () => {
    expect((await call('GET', '/api/auth/me')).body.username).toBe('gm');
  });
});

describe('worlds', () => {
  it('keeps two worlds fully separate', async () => {
    const a = (await call('POST', '/api/worlds', { name: 'Alpha', cols: 6, rows: 5 })).body;
    const b = (await call('POST', '/api/worlds', { name: 'Beta', cols: 6, rows: 5 })).body;
    await call('POST', `/api/worlds/${a.id}/pages`, { title: 'Only in Alpha' });
    expect((await call('GET', `/api/worlds/${b.id}/pages`)).body).toHaveLength(0);
    expect((await call('GET', `/api/worlds/${b.id}/search?q=alpha`)).body).toHaveLength(0);
    // A hex from Alpha can't be edited through Beta.
    const alphaMap = (await call('GET', `/api/worlds/${a.id}/map`)).body;
    const res = await call('PATCH', `/api/worlds/${b.id}/hexes/${alphaMap.hexes[0].id}`, { terrain: 'forest' });
    expect(res.status).toBe(400);
    // Rename and delete
    expect((await call('PATCH', `/api/worlds/${a.id}`, { name: 'Alpha Prime' })).body.name).toBe('Alpha Prime');
    expect((await call('DELETE', `/api/worlds/${a.id}`)).status).toBe(200);
    expect((await call('GET', `/api/worlds/${a.id}`)).status).toBe(404);
    expect((await call('GET', `/api/worlds/${b.id}/map`)).body.hexes).toHaveLength(30);
  });
});

describe('wiki', () => {
  it('creates, links, backlinks and finds pages', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Wiki World', cols: 4, rows: 4 })).body;
    const target = (await call('POST', `/api/worlds/${w.id}/pages`, { title: 'Duke Harrow' })).body;
    const src = (await call('POST', `/api/worlds/${w.id}/pages`, { title: 'Iron Coast' })).body;
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Ruled by ' }, { type: 'wikiLink', attrs: { pageId: target.id, label: 'Duke Harrow' } },
      { type: 'text', text: ', who loathes seafarers.' },
    ] }] };
    expect((await call('PATCH', `/api/worlds/${w.id}/pages/${src.id}`, { content })).status).toBe(200);
    const t = (await call('GET', `/api/worlds/${w.id}/pages/${target.id}`)).body;
    expect(t.backlinks.map((b: { id: string }) => b.id)).toEqual([src.id]);
    const hits = (await call('GET', `/api/worlds/${w.id}/search?q=loath`)).body;
    expect(hits[0].id).toBe(src.id);
    expect((await call('GET', `/api/worlds/${w.id}/search?q=duke`)).body[0].id).toBe(target.id);
    // Duplicate titles are refused with a pointer to the existing page.
    const dup = await call('POST', `/api/worlds/${w.id}/pages`, { title: 'duke harrow' });
    expect(dup.status).toBe(409);
    expect(dup.body.page.id).toBe(target.id);
  });
});

describe('hexes', () => {
  it('persists edits across a server restart', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Persist', cols: 4, rows: 4 })).body;
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    const hex = map.hexes[4];
    await call('PATCH', `/api/worlds/${w.id}/hexes/${hex.id}`, { terrain: 'mountains', state: 'ruined', notes: 'Old watchtower' });
    await app.close();
    const rebooted = await boot();
    app = rebooted.app; db = rebooted.db;
    const again = (await call('GET', `/api/worlds/${w.id}/map`)).body.hexes.find((h: { id: string }) => h.id === hex.id);
    expect(again).toMatchObject({ terrain: 'mountains', state: 'ruined', notes: 'Old watchtower' });
  });

  it('derives control from claims and logs the change', async () => {
    const worlds = (await call('GET', '/api/worlds')).body;
    const demo = worlds.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const map = (await call('GET', `/api/worlds/${demo.id}/map`)).body;
    const f = map.factions[0];
    const free = map.hexes.find((h: { id: string }) => !map.claims.some((c: { hexId: string }) => c.hexId === h.id));
    const claims = (await call('POST', `/api/worlds/${demo.id}/claims/control`, { hexIds: [free.id], factionId: f.id })).body;
    expect(claims).toHaveLength(1);
    const events = (await call('GET', `/api/worlds/${demo.id}/events?kind=claim&limit=1`)).body;
    expect(events[0].summary).toContain(f.name);
  });
});

describe('meters', () => {
  it('records every change with cause and day, and clamps to range', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const factions = (await call('GET', `/api/worlds/${demo.id}/factions`)).body;
    const meters = (await call('GET', `/api/worlds/${demo.id}/meters`)).body;
    const morale = meters.find((m: { key: string }) => m.key === 'morale');
    const f = factions[0];
    const res = (await call('POST', `/api/worlds/${demo.id}/factions/${f.id}/meters/${morale.id}`, { delta: 500, cause: 'Miracle at the shrine' })).body;
    expect(res.value).toBe(100);
    expect(res.band.label).toBe('Inspired');
    const hist = (await call('GET', `/api/worlds/${demo.id}/factions/${f.id}/meters/${morale.id}/history`)).body;
    expect(hist[0]).toMatchObject({ newValue: 100, cause: 'Miracle at the shrine', gameDay: 142 });
    // A faction can't set another faction's signature meter.
    const other = factions[1];
    const wrong = await call('POST', `/api/worlds/${demo.id}/factions/${f.id}/meters/${other.signatureMeterId}`, { value: 10 });
    expect(wrong.status).toBe(400);
  });

  it('rolls only approved entries', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const tables = (await call('GET', `/api/worlds/${demo.id}/roll-tables`)).body;
    const t = tables[0];
    const draft = t.entries.find((e: { approved: boolean }) => !e.approved);
    expect(draft.source).toBe('ai');
    for (let i = 0; i < 40; i++) {
      const r = (await call('POST', `/api/worlds/${demo.id}/roll-tables/${t.id}/roll`, {})).body;
      expect(r.entry.approved).toBe(true);
    }
  });
});

/** A real (tiny, solid color) PNG so the upload path sees genuine image bytes. */
function png(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x40);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('map art', () => {
  it('uploads, covers the grid, aligns, serves and removes', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Painted', cols: 6, rows: 4 })).body;
    const bad = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.from('not an image at all, honest, just text padding') });
    expect(bad.statusCode).toBe(400);
    const img = png(300, 200);
    const up = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: img });
    expect(up.statusCode).toBe(200);
    const art = JSON.parse(up.body);
    expect(art).toMatchObject({ version: 1, width: 300, height: 200, mime: 'image/png' });
    // Covers the grid: 6 flat hexes wide is 40 * (1.5 * 5 + 2) = 380 units; the art keeps its 3:2 aspect.
    expect(art.placement.w).toBeGreaterThanOrEqual(380);
    expect(art.placement.w / art.placement.h).toBeCloseTo(1.5, 5);
    const moved = (await call('PATCH', `/api/worlds/${w.id}/map/art`, { placement: { x: 12, y: -8, opacity: 0.6 } })).body;
    expect(moved.placement).toMatchObject({ x: 12, y: -8, opacity: 0.6, w: art.placement.w });
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(map.map.art).toMatchObject({ version: 1, placement: { x: 12 } });
    const got = await app.inject({ method: 'GET', url: `/api/worlds/${w.id}/map/art?v=1`, headers: { cookie } });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(got.rawPayload, img)).toBe(0);
    const again = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: png(100, 100) });
    expect(JSON.parse(again.body).version).toBe(2);
    expect((await call('DELETE', `/api/worlds/${w.id}/map/art`)).status).toBe(200);
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.art).toBeNull();
    // Another world can't see this world's art.
    const other = (await call('POST', '/api/worlds', { name: 'Bare', cols: 4, rows: 4 })).body;
    expect((await app.inject({ method: 'GET', url: `/api/worlds/${other.id}/map/art`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('seeds the demo with art whose terrain matches the painting', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const map = (await call('GET', `/api/worlds/${demo.id}/map`)).body;
    expect(map.map.art.width).toBeGreaterThan(1000);
    const kinds = new Set(map.hexes.map((h: { terrain: string }) => h.terrain));
    for (const k of ['deep', 'water', 'plains', 'forest', 'hills', 'mountains', 'wasteland']) expect(kinds).toContain(k);
    const cities = map.tokens.filter((t: { kind: string }) => t.kind === 'city');
    expect(cities.map((t: { name: string }) => t.name).sort()).toEqual(['Cinderhold', 'Port Halvard']);
    for (const c of cities) expect(['water', 'deep']).not.toContain(map.hexes.find((h: { id: string }) => h.id === c.hexId).terrain);
    expect(map.claims.filter((c: { kind: string }) => c.kind === 'contested').length).toBeGreaterThanOrEqual(2);
  });

  it('upgrades an untouched older demo in place and keeps an edited one', async () => {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    const fresh = await seedDemoWorld(db, { name: 'Old Demo A' });
    const edited = await seedDemoWorld(db, { name: 'Old Demo B' });
    await c.query(`update worlds set demo = 'reach-v1' where id in ($1, $2)`, [fresh.id, edited.id]);
    // Pretend both were seeded long ago, and the GM later wrote a note in B.
    await c.query(`alter table events disable trigger user`);
    await c.query(`update events set created_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table events enable trigger user`);
    await c.query(`update hexes set updated_at = now() - interval '2 days' from maps where maps.id = hexes.map_id and maps.world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`update wiki_pages set updated_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table meter_changes disable trigger user`);
    await c.query(`update meter_changes set created_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table meter_changes enable trigger user`);
    await c.query(`update worlds set created_at = now() - interval '2 days', updated_at = now() - interval '2 days' where id in ($1, $2)`, [fresh.id, edited.id]);
    await call('POST', `/api/worlds/${edited.id}/events`, { summary: 'The GM was here' });
    const notes = await upgradeDemo(db);
    expect(notes).toHaveLength(2);
    const rows = (await c.query(`select name, demo from worlds where name like 'Old Demo%' order by name`)).rows;
    await c.end();
    expect(rows).toEqual([
      { name: 'Old Demo A', demo: DEMO_VERSION },
      { name: 'Old Demo B', demo: 'reach-v1-kept' },
      { name: 'Old Demo B (painted)', demo: DEMO_VERSION },
    ]);
    expect(await upgradeDemo(db)).toHaveLength(0);
  });
});

describe('lore import', () => {
  it('imports The New World as linked pages, seven factions and an unclaimed island, and can be re-imported', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'The New World', template: 'newworld' })).body;
    const pages = await db.select().from(wikiPages).where(eq(wikiPages.worldId, w.id));
    const byTitle = new Map(pages.map((p) => [p.title, p]));
    for (const title of ['The New World', 'Core Setting', 'Geography of the Island', 'Casa de Mendoza', 'Company DuPont', 'The Qadir Ascendancy',
      'The Nhal’Kesh', 'The Flesh-Shapers', 'The Aelari', 'The Canopy People', 'The Mage City Within the Mountain', 'The Precursor Mages',
      'Still Intentionally Unresolved', 'Open Questions / Co-DM Discussion']) expect(byTitle.has(title), title).toBe(true);

    // Every line of the source lands on a page, word for word (bar the listed repairs).
    const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, '');
    const all = norm(pages.map((p) => p.contentText).join('\n'));
    const src = readFileSync(new globalThis.URL(`../server/assets/lore/${LORE_FILE}`, import.meta.url), 'utf8').split('\n');
    const missing = src.map((l, i) => ({ n: i + 1, text: (FIXES[i + 1] ? l.replace(FIXES[i + 1].from, FIXES[i + 1].to) : l).replace(/^#+\s*/, '').replace(/\*+$/, '').trim() }))
      .filter((l) => l.text && !all.includes(norm(l.text)));
    expect(missing).toEqual([]);

    // Open matters say so on the page rather than reading as canon.
    expect(byTitle.get('Still Intentionally Unresolved')!.contentText).toMatch(/Open by design/);
    expect(byTitle.get('The Canopy People')!.contentText).toMatch(/Unfinished in the source/);
    expect(byTitle.get('Open Questions / Co-DM Discussion')!.contentText).toMatch(/Discussion, not canon/);
    expect(byTitle.get('Core Setting')!.contentText).toMatch(/Unresolved in the source/);

    // Names link to their pages.
    const links = await db.select().from(wikiLinks).where(eq(wikiLinks.fromPageId, byTitle.get('The Flesh-Shapers')!.id));
    expect(links.map((l) => l.toPageId)).toContain(byTitle.get('The Nhal’Kesh')!.id);
    // A link keeps the source's wording ("College of Mages") rather than the target's title.
    expect(byTitle.get('Established Facts About the Precursor City')!.contentText).toContain('an apolitical College of Mages rather than');
    expect(JSON.stringify(byTitle.get('Established Facts About the Precursor City')!.content)).toContain('"text":"College of Mages"');

    const meters = (await call('GET', `/api/worlds/${w.id}/meters`)).body as { id: string; name: string; kind: string }[];
    const fs = (await call('GET', `/api/worlds/${w.id}/factions`)).body as { name: string; signatureMeterId: string; sigil: string; meters?: unknown }[];
    const sig = Object.fromEntries(fs.map((f) => [f.name, meters.find((m) => m.id === f.signatureMeterId)?.name]));
    expect(sig).toEqual({
      'Casa de Mendoza': 'Zeal', 'Company DuPont': 'Grandeur', 'The Qadir Ascendancy': 'Attunement', 'The Nhal’Kesh': 'Vigil',
      'The Flesh-Shapers': 'Transcendence', 'The Aelari': 'Communion', 'The Canopy People': 'Provisional',
    });
    expect(meters.filter((m) => m.kind !== 'signature').map((m) => m.name).sort()).toEqual(['Morale', 'Treasury']);

    // The island is painted terrain with nothing claimed or settled.
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(map.hexes.length).toBe(48 * 32);
    const terrains = new Set(map.hexes.map((h: { terrain: string }) => h.terrain));
    for (const k of ['deep', 'water', 'jungle', 'mountains']) expect(terrains.has(k)).toBe(true);
    expect(map.claims ?? []).toEqual([]);
    expect(map.tokens ?? []).toEqual([]);

    // Deletable, and importing again gives a fresh copy.
    expect((await call('DELETE', `/api/worlds/${w.id}`)).status).toBe(200);
    const again = (await call('POST', '/api/worlds', { name: 'The New World', template: 'newworld' })).body;
    expect((await call('GET', `/api/worlds/${again.id}/factions`)).body).toHaveLength(7);
  });

  it('seeds once on boot and stays deleted after the owner removes it', async () => {
    const note = await seedNewWorldOnce(db);
    expect(note).toMatch(/imported/);
    const list = (await call('GET', '/api/worlds')).body as { id: string; name: string }[];
    const seeded = list.find((x) => x.name === 'The New World')!;
    await call('DELETE', `/api/worlds/${seeded.id}`);
    expect(await seedNewWorldOnce(db)).toBeNull();
  });
});

describe('history', () => {
  it('is append-only', async () => {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    await expect(c.query("update events set summary = 'rewritten'")).rejects.toThrow(/append-only/);
    await expect(c.query('delete from meter_changes')).rejects.toThrow(/append-only/);
    await c.end();
  });
});
