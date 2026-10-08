import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { sessions, users } from './db/schema.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const COOKIE = 'atlas_session';
const SESSION_DAYS = 90;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Single-owner account, defined by ADMIN_USERNAME / ADMIN_PASSWORD.
 * On boot the account is created, or its password re-synced if the env value changed,
 * so changing the Railway variable is how the owner changes their password.
 */
export async function ensureOwner(db: Db, username: string, password: string) {
  const existing = await db.query.users.findFirst({ where: eq(users.username, username) });
  if (!existing) {
    await db.insert(users).values({ username, passwordHash: await hashPassword(password) });
    return 'created';
  }
  if (!(await verifyPassword(password, existing.passwordHash))) {
    await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, existing.id));
    await db.delete(sessions).where(eq(sessions.userId, existing.id));
    return 'password-updated';
  }
  return 'unchanged';
}

declare module 'fastify' {
  interface FastifyRequest { userId?: string }
}

export function registerAuth(app: FastifyInstance, db: Db, opts: { secureCookies: boolean }) {
  const cookieOpts = {
    path: '/', httpOnly: true, sameSite: 'lax' as const, secure: opts.secureCookies,
    maxAge: SESSION_DAYS * 86400,
  };

  app.decorate('requireUser', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE];
    if (!token) return reply.code(401).send({ error: 'unauthenticated' });
    const row = await db.query.sessions.findFirst({
      where: and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())),
    });
    if (!row) return reply.code(401).send({ error: 'unauthenticated' });
    req.userId = row.userId;
    // Rolling session: refresh when more than a day has passed since issue.
    if (Date.now() - row.createdAt.getTime() > 86400_000) {
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
      await db.update(sessions).set({ createdAt: new Date(), expiresAt }).where(eq(sessions.tokenHash, row.tokenHash));
      reply.setCookie(COOKIE, token, cookieOpts);
    }
  });

  const Login = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) });

  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = Login.parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(users.username, body.username.trim()) });
    // Verify against a dummy hash when the user is unknown so timing doesn't reveal usernames.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return reply.code(401).send({ error: 'Wrong username or password.' });
    const token = crypto.randomBytes(32).toString('base64url');
    await db.insert(sessions).values({
      tokenHash: sha256(token), userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000),
    });
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    reply.setCookie(COOKIE, token, cookieOpts);
    return { username: user.username };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    await app.requireUser(req, reply);
    if (reply.sent) return;
    const user = await db.query.users.findFirst({ where: eq(users.id, req.userId!) });
    return { username: user?.username };
  });
}

const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
