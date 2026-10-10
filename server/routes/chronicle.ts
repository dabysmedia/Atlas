import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { events } from '../db/schema.js';
import { logEvent } from '../history.js';
import { eventContext, eventSeen } from '../access.js';
import { getWorld, Uuid } from './worlds.js';

export function chronicleRoutes(app: FastifyInstance, db: Db) {
  /** Newest first, paged by id. `kind` filters by prefix (e.g. "meter", "claim"). */
  const Query = z.object({
    before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    kind: z.string().max(40).optional(), campaignId: Uuid.optional(),
  });
  app.get('/api/worlds/:w/events', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const q = Query.parse(req.query);
    const where: SQL[] = [eq(events.worldId, w.id)];
    if (q.before) where.push(lt(events.id, q.before));
    if (q.kind) where.push(or(eq(events.kind, q.kind), like(events.kind, `${q.kind.replace(/[%_]/g, '')}.%`))!);
    if (q.campaignId) where.push(eq(events.campaignId, q.campaignId));
    if (!req.view) return db.select().from(events).where(and(...where)).orderBy(desc(events.id)).limit(q.limit);
    // A player reads the entries about what they can see (see eventSeen), a page at a time all the same.
    const ctx = await eventContext(db, req.view);
    const out: (typeof events.$inferSelect)[] = [];
    let before = q.before;
    for (let round = 0; round < 20 && out.length < q.limit; round++) {
      const batch = await db.select().from(events).where(and(...where, ...(before ? [lt(events.id, before)] : [])))
        .orderBy(desc(events.id)).limit(500);
      out.push(...batch.filter((e) => eventSeen(e, ctx)));
      if (batch.length < 500) break;
      before = batch[batch.length - 1].id;
    }
    return out.slice(0, q.limit);
  });

  /** A GM's own chronicle line. History is append-only; corrections are new entries. */
  const Note = z.object({ summary: z.string().trim().min(1).max(2000), gameDay: z.number().int().min(1).optional(), campaignId: Uuid.nullable().optional() });
  app.post('/api/worlds/:w/events', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = Note.parse(req.body);
    return logEvent(db, { worldId: w.id, kind: 'note', summary: body.summary, gameDay: body.gameDay, campaignId: body.campaignId ?? null });
  });
}
