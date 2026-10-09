import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { createDb, runMigrations } from './db/index.js';
import { registerAuth, ensureOwner } from './auth.js';
import { HttpError } from './history.js';
import { worldRoutes } from './routes/worlds.js';
import { wikiRoutes } from './routes/wiki.js';
import { mapRoutes } from './routes/map.js';
import { factionRoutes } from './routes/factions.js';
import { chronicleRoutes } from './routes/chronicle.js';
import { seedDemoWorld, upgradeDemo } from './worlds.js';
import { seedNewWorldOnce } from './lore/newworld.js';
import { worlds } from './db/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp(opts: { databaseUrl: string; secureCookies?: boolean; logger?: boolean }) {
  const { db, pool } = createDb(opts.databaseUrl);
  await runMigrations(db);

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });
  app.addHook('onClose', async () => { await pool.end(); });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerAuth(app, db, { secureCookies: opts.secureCookies ?? false });

  // Everything else under /api requires the owner's session.
  await app.register(async (api) => {
    api.addHook('preHandler', app.requireUser);
    worldRoutes(api, db);
    wikiRoutes(api, db);
    mapRoutes(api, db);
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
  return { app, db };
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
  }
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
