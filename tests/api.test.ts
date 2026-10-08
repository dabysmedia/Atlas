/**
 * API integration tests against a real Postgres (TEST_DATABASE_URL).
 * Each run starts from an empty schema so results don't depend on prior runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/index';
import { ensureOwner } from '../server/auth';
import { seedDemoWorld } from '../server/worlds';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/atlas_test';
let app: FastifyInstance;
let cookie = '';

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
    app = (await boot()).app;
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

describe('history', () => {
  it('is append-only', async () => {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    await expect(c.query("update events set summary = 'rewritten'")).rejects.toThrow(/append-only/);
    await expect(c.query('delete from meter_changes')).rejects.toThrow(/append-only/);
    await c.end();
  });
});
