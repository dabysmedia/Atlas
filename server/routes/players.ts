import crypto from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { campaignMembers, campaigns, users, worlds } from '../db/schema.js';
import { COOKIE, endSessions, hashPassword, verifyPassword } from '../auth.js';
import { badRequest, HttpError, notFound } from '../history.js';
import { changed, type LiveHub } from '../live.js';
import { Uuid } from './worlds.js';

type P = { id: string };

/** Easy to read out at the table: no 0/O or 1/l/I. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePassword() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

const Username = z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_.-]+$/u, 'Usernames use letters, digits, dots, dashes and underscores.');
const DisplayName = z.string().trim().min(1).max(60);
const Password = z.string().min(10, 'Passwords need at least 10 characters.').max(500);

const playerCols = { id: users.id, username: users.username, displayName: users.displayName, createdAt: users.createdAt };

/**
 * Player accounts. The GM adds players (with a password they set, or one generated and shown once to pass on),
 * resets passwords, removes players and chooses their campaigns; a player's campaigns decide which worlds they see
 * (server/access.ts). Everyone keeps their own display name; players keep their own password (the GM's is
 * ADMIN_PASSWORD).
 */
export function playerRoutes(app: FastifyInstance, db: Db, live: LiveHub) {
  async function getPlayer(id: string) {
    const p = Uuid.safeParse(id).success ? await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.role, 'player')) }) : undefined;
    if (!p) throw notFound('Player');
    return p;
  }
  /** Usernames are unique regardless of case, so signing in never has to guess. */
  async function checkUsername(name: string, except?: string) {
    const taken = await db.query.users.findFirst({
      where: and(sql`lower(${users.username}) = lower(${name})`, ...(except ? [ne(users.id, except)] : [])), columns: { id: true },
    });
    if (taken) throw new HttpError(409, 'That username is taken.');
  }

  /** Every player, with their campaigns and whether they are on now, and every campaign to choose from. */
  app.get('/api/players', async () => {
    const [players, members, camps] = await Promise.all([
      db.select(playerCols).from(users).where(eq(users.role, 'player')).orderBy(asc(users.createdAt)),
      db.select().from(campaignMembers),
      db.select({ id: campaigns.id, name: campaigns.name, worldId: campaigns.worldId, worldName: worlds.name })
        .from(campaigns).innerJoin(worlds, eq(worlds.id, campaigns.worldId)).orderBy(asc(worlds.sortOrder), asc(worlds.createdAt), asc(campaigns.createdAt)),
    ]);
    const online = live.online();
    return {
      players: players.map((p) => ({
        ...p, online: online.has(p.id), campaignIds: members.filter((m) => m.userId === p.id).map((m) => m.campaignId),
      })),
      campaigns: camps,
    };
  });

  const Create = z.object({ displayName: DisplayName, username: Username, password: Password.optional(), campaignIds: z.array(Uuid).max(200).optional() });
  app.post('/api/players', async (req) => {
    const body = Create.parse(req.body);
    await checkUsername(body.username);
    const password = body.password ?? generatePassword();
    const [row] = await db.insert(users).values({
      username: body.username, displayName: body.displayName, role: 'player', passwordHash: await hashPassword(password),
    }).returning(playerCols);
    if (body.campaignIds?.length) await setCampaigns(row.id, body.campaignIds);
    // A generated password is shown to the GM this once, to pass on; it isn't stored anywhere readable.
    return { player: row, ...(body.password ? {} : { password }) };
  });

  const Patch = z.object({ displayName: DisplayName.optional(), username: Username.optional() });
  app.patch('/api/players/:id', async (req) => {
    const p = await getPlayer((req.params as P).id);
    const body = Patch.parse(req.body);
    if (body.username && body.username !== p.username) await checkUsername(body.username, p.id);
    const [row] = await db.update(users).set(body).where(eq(users.id, p.id)).returning(playerCols);
    if (body.displayName !== undefined) live.rename(p.id, row.displayName || row.username);
    return row;
  });

  /** A new password (set, or generated and shown once): the player is signed out everywhere. */
  app.post('/api/players/:id/password', async (req) => {
    const p = await getPlayer((req.params as P).id);
    const body = z.object({ password: Password.optional() }).parse(req.body ?? {});
    const password = body.password ?? generatePassword();
    await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, p.id));
    await endSessions(db, p.id);
    changed(req, { signOut: [p.id] });
    return { ok: true, ...(body.password ? {} : { password }) };
  });

  async function setCampaigns(userId: string, ids: string[]) {
    const want = [...new Set(ids)];
    const found = want.length ? await db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.id, want)) : [];
    if (found.length !== want.length) throw badRequest('Some of those campaigns don’t exist.');
    await db.transaction(async (tx) => {
      await tx.delete(campaignMembers).where(eq(campaignMembers.userId, userId));
      if (want.length) await tx.insert(campaignMembers).values(want.map((campaignId) => ({ campaignId, userId })));
    });
  }

  /** The campaigns a player belongs to (all of them, replacing the old set). Their screens start over to match. */
  app.put('/api/players/:id/campaigns', async (req) => {
    const p = await getPlayer((req.params as P).id);
    const body = z.object({ campaignIds: z.array(Uuid).max(200) }).parse(req.body);
    await setCampaigns(p.id, body.campaignIds);
    changed(req, { restart: [p.id] });
    return { ok: true, campaignIds: [...new Set(body.campaignIds)] };
  });

  /** Remove a player: their account and sessions go, and their open screens sign out at once. */
  app.delete('/api/players/:id', async (req) => {
    const p = await getPlayer((req.params as P).id);
    await db.delete(users).where(eq(users.id, p.id));
    changed(req, { signOut: [p.id] });
    return { ok: true };
  });

  // ---------------------------------------------------------------- one's own account
  app.patch('/api/account', async (req) => {
    const body = z.object({ displayName: z.string().trim().max(60) }).parse(req.body);
    const [row] = await db.update(users).set({ displayName: body.displayName }).where(eq(users.id, req.user!.id))
      .returning({ username: users.username, displayName: users.displayName });
    live.rename(req.user!.id, row.displayName || row.username);
    return { ...row, name: row.displayName || row.username };
  });

  /** A player changes their own password (knowing the current one); their other sessions sign out. */
  app.post('/api/account/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (req.user!.role === 'gm') throw badRequest('The GM’s password is ADMIN_PASSWORD: change it there and redeploy.');
    const body = z.object({ current: z.string().min(1).max(500), password: Password }).parse(req.body);
    const me = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!me || !(await verifyPassword(body.current, me.passwordHash))) throw new HttpError(403, 'That isn’t your current password.');
    await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, me.id));
    const token = req.cookies[COOKIE];
    await endSessions(db, me.id, token);
    changed(req, { signOut: [me.id] });
    return { ok: true };
  });
}
