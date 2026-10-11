import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations } from './db/index.js';
import { registerAuth, ensureOwner, sessionUser, COOKIE } from './auth.js';
import { LiveHub, LocalBus, liveRoutes } from './live.js';
import { HttpError } from './history.js';
import { worldRoutes } from './routes/worlds.js';
import { wikiRoutes } from './routes/wiki.js';
import { mapRoutes, modelRoutes } from './routes/map.js';
import { factionRoutes } from './routes/factions.js';
import { chronicleRoutes } from './routes/chronicle.js';
import { seedDemoWorld, upgradeDemo } from './worlds.js';
import { recoverRemovedIsland, seedNewWorldOnce, upgradeNewWorldIsland } from './lore/newworld.js';
import { worlds } from './db/schema.js';
import { pieceRoutes } from './routes/pieces.js';
import { accessFor, forbidden } from './tokenAccess.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { databaseUrl: string; secureCookies?: boolean; logger?: boolean }) {
  const { db, pool } = createDb(opts.databaseUrl);
  await runMigrations(db);

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });
  // One process, so the hub's bus is in-process (see server/live.ts for running several).
  const live = new LiveHub(new LocalBus(), {
    stillSignedIn: async (token) => !!(await sessionUser(db, token)),
    canView: async (who, world) => who.role === 'player' ? !!await accessFor(db, who.userId, world) : !!(await db.query.worlds.findFirst({ where: eq(worlds.id, world), columns: { id: true } })),
  });
  app.addHook('onClose', async () => { live.close(); await pool.end(); });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerAuth(app, db, { secureCookies: opts.secureCookies ?? false, onSignOut: (token) => live.closeSession(token) });

  // Everything else under /api requires the owner's session.
  await app.register(async (api) => {
    api.addHook('preHandler', app.requireUser);
    api.addHook('preHandler', async req => {
      if (req.userRole !== 'player') return;
      const path = req.routeOptions.url ?? '';
      if (req.method === 'GET' && (path === '/api/live' || path === '/api/worlds')) return;
      const world = (req.params as { w?: string }).w;
      if (!world || !await accessFor(db, req.userId!, world)) throw forbidden();
      const read = new Set(['/api/worlds/:w', '/api/worlds/:w/map', '/api/worlds/:w/map/art', '/api/worlds/:w/map/model', '/api/worlds/:w/token-models/:id', '/api/worlds/:w/campaigns/:id/fog']);
      if (req.method === 'GET' && read.has(path)) return;
      if (req.method === 'POST' && (path === '/api/worlds/:w/tokens/:id/move' || path === '/api/worlds/:w/tokens/:id/deploy')) return;
      throw forbidden();
    });
    // First, so every mutating route below is held to broadcasting its changes.
    liveRoutes(api, live, {
      user: async (req) => {
        const token = req.cookies[COOKIE];
        const u = await sessionUser(db, token);
        return u && token ? { name: u.username, token } : null;
      },
      token: (req) => req.cookies[COOKIE],
    });
    worldRoutes(api, db);
    wikiRoutes(api, db);
    mapRoutes(api, db);
    modelRoutes(api, db);
    pieceRoutes(api, db);
    factionRoutes(api, db);
    chronicleRoutes(api, db);
  });

  const clientDir = path.resolve(here, '../client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientDir, wildcard: false, maxAge: '1y', immutable: true, index: false });
    const indexHtml = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8');
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.header('cache-control', 'no-cache').type('text/html').send(indexHtml);
    });
  }
  return { app, db, live };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const { app, db } = await buildApp({ databaseUrl, secureCookies: process.env.NODE_ENV === 'production', logger: true });

  const username = process.env.ADMIN_USERNAME || 'gm';
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
    app.log.info(`owner account: ${await ensureOwner(db, username, password)}`);
  } else {
    app.log.warn('ADMIN_PASSWORD is not set; no one can sign in until it is.');
  }
  // First boot: give the owner something to look at.
  if (process.env.SEED_DEMO !== 'false' && (await db.$count(worlds)) === 0) {
    await seedDemoWorld(db);
    app.log.info('seeded demo world');
  } else if (process.env.SEED_DEMO !== 'false') {
    for (const note of await upgradeDemo(db)) app.log.info(note);
  }
  // The owner's own setting, imported once. Deleting it keeps it deleted; "New world" can import it again.
  if (process.env.SEED_LORE !== 'false') {
    const note = await seedNewWorldOnce(db);
    if (note) app.log.info(note);
    for (const n of await upgradeNewWorldIsland(db)) app.log.info(n);
    for (const n of await recoverRemovedIsland(db)) app.log.info(n);
  }
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
