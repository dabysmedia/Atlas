import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { worlds } from '../db/schema.js';
import { logEvent, notFound } from '../history.js';
import { createWorld, deleteWorld, seedDemoWorld } from '../worlds.js';
import { seedNewWorld } from '../lore/newworld.js';
import { DAY_SPEEDS, DEFAULT_DAYLIGHT, hoursNow, type Daylight, type DaySpeed } from '../../shared/daylight.js';

export const Uuid = z.uuid();

export async function getWorld(db: Db, id: string) {
  const w = await db.query.worlds.findFirst({ where: eq(worlds.id, Uuid.parse(id)) });
  if (!w) throw notFound('World');
  return w;
}

const Terrain = z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(60), color: z.string().max(20), glyph: z.string().max(20).optional() });
const HexState = z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(60), color: z.string().max(20).optional() });

export function worldRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/worlds', async () => {
    const rows = await db.execute(sql`
      select w.id, w.name, w.description, w.accent, w.current_day as "currentDay", w.updated_at as "updatedAt", w.created_at as "createdAt",
        (select count(*)::int from wiki_pages p where p.world_id = w.id) as "pageCount",
        (select count(*)::int from factions f where f.world_id = w.id) as "factionCount",
        (select count(*)::int from campaigns c where c.world_id = w.id) as "campaignCount",
        (select count(*)::int from hexes h join maps m on m.id = h.map_id where m.world_id = w.id) as "hexCount",
        (select coalesce(json_agg(t), '[]') from (
           select h.terrain, count(*)::int as n from hexes h join maps m on m.id = h.map_id
           where m.world_id = w.id and m.parent_hex_id is null group by h.terrain order by n desc limit 5) t) as "terrainMix",
        (select a.version from map_art a join maps m on m.id = a.map_id
           where m.world_id = w.id and m.parent_hex_id is null limit 1) as "artVersion",
        w.terrain_types as "terrainTypes"
      from worlds w order by w.sort_order, w.created_at`);
    return rows.rows;
  });

  app.get('/api/worlds/:w', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    // Start the sky running the first time anyone opens the world.
    if (!w.daylight) {
      const daylight = DEFAULT_DAYLIGHT();
      await db.update(worlds).set({ daylight }).where(eq(worlds.id, w.id));
      return { ...w, daylight };
    }
    return w;
  });

  /** Set the time of day and/or how fast it runs (a per-world DM setting). */
  const DaylightBody = z.object({ hour: z.number().min(0).max(24).optional(), speed: z.enum(Object.keys(DAY_SPEEDS) as [DaySpeed, ...DaySpeed[]]).optional() });
  app.patch('/api/worlds/:w/daylight', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = DaylightBody.parse(req.body);
    const cur = (w.daylight as Daylight | null) ?? DEFAULT_DAYLIGHT();
    const daylight: Daylight = { hour: body.hour ?? hoursNow(cur) % 24, speed: body.speed ?? cur.speed, at: new Date().toISOString() };
    await db.update(worlds).set({ daylight }).where(eq(worlds.id, w.id));
    return { daylight };
  });

  const Create = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    template: z.enum(['blank', 'demo', 'newworld']).default('blank'),
    cols: z.number().int().min(4).max(200).optional(),
    rows: z.number().int().min(4).max(200).optional(),
    orientation: z.enum(['flat', 'pointy']).optional(),
  });
  app.post('/api/worlds', async (req) => {
    const body = Create.parse(req.body);
    if (body.template === 'demo') {
      const w = await seedDemoWorld(db);
      if (body.name !== w.name) await db.update(worlds).set({ name: body.name }).where(eq(worlds.id, w.id));
      return getWorld(db, w.id);
    }
    if (body.template === 'newworld') {
      const w = await seedNewWorld(db, { name: body.name });
      return getWorld(db, w.id);
    }
    const { world } = await db.transaction((tx) => createWorld(tx, body));
    return world;
  });

  const Patch = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    accent: z.string().max(20).optional(),
    terrainTypes: z.array(Terrain).min(1).max(64).optional(),
    hexStates: z.array(HexState).min(1).max(64).optional(),
  });
  app.patch('/api/worlds/:w', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = Patch.parse(req.body);
    const [row] = await db.update(worlds).set({ ...body, updatedAt: new Date() }).where(eq(worlds.id, w.id)).returning();
    if (body.name && body.name !== w.name) await logEvent(db, { worldId: w.id, kind: 'world.renamed', summary: `World renamed from "${w.name}" to "${body.name}"` });
    return row;
  });

  /** Move the world clock. Setting a day backwards is allowed (GM correction) and logged. */
  const Day = z.object({
    day: z.number().int().min(1).max(10_000_000).optional(), advance: z.number().int().min(-1000).max(1000).optional(),
    /** Sent when the running day cycle passes midnight; only the first tab to send it for a given day counts. */
    rollover: z.object({ from: z.number().int() }).optional(),
  });
  app.post('/api/worlds/:w/day', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = Day.parse(req.body);
    if (body.rollover && body.rollover.from !== w.currentDay) return { currentDay: w.currentDay, daylight: w.daylight };
    const day = body.rollover ? w.currentDay + 1 : Math.max(1, body.day ?? w.currentDay + (body.advance ?? 1));
    let daylight = w.daylight as Daylight | null;
    if (body.rollover && daylight) daylight = { ...daylight, hour: Math.max(0, hoursNow(daylight) - 24) % 24, at: new Date().toISOString() };
    await db.transaction(async (tx) => {
      await tx.update(worlds).set({ currentDay: day, daylight, updatedAt: new Date() }).where(eq(worlds.id, w.id));
      await logEvent(tx, { worldId: w.id, gameDay: day, kind: 'day.changed', summary: day > w.currentDay ? `Day ${day} dawns` : `Clock set back to day ${day}`, payload: { from: w.currentDay, to: day, ...(body.rollover ? { rollover: true } : {}) }, actor: body.rollover ? 'system' : 'gm' });
    });
    return { currentDay: day, daylight };
  });

  app.post('/api/worlds/reorder', async (req) => {
    const ids = z.array(Uuid).parse((req.body as { ids: unknown }).ids);
    await db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.update(worlds).set({ sortOrder: i }).where(eq(worlds.id, id));
    });
    return { ok: true };
  });

  app.delete('/api/worlds/:w', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    await deleteWorld(db, w.id);
    return { ok: true };
  });
}
