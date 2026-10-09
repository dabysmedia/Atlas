import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../db/index.js';
import { worlds } from '../db/schema.js';
import { logEvent, notFound } from '../history.js';
import { createWorld, deleteWorld, seedDemoWorld } from '../worlds.js';
import { seedNewWorld } from '../lore/newworld.js';
import { DAY_SPEEDS, DEFAULT_DAYLIGHT, hoursNow, type Daylight, type DaySpeed } from '../../shared/daylight.js';
import { DEFAULT_WEATHER, WEATHER_KINDS, rollWeather, weatherSummary, type Weather, type WeatherKind } from '../../shared/weather.js';

export const Uuid = z.uuid();

export async function getWorld(db: Db, id: string) {
  const w = await db.query.worlds.findFirst({ where: eq(worlds.id, Uuid.parse(id)) });
  if (!w) throw notFound('World');
  return w;
}

/** A world's clock and weather, read under a row lock so changes racing each other apply one after another. */
async function lockClock(tx: Tx, id: string) {
  const [row] = await tx.select({ currentDay: worlds.currentDay, daylight: worlds.daylight, weather: worlds.weather }).from(worlds).where(eq(worlds.id, id)).for('update');
  if (!row) throw notFound('World');
  return { currentDay: row.currentDay, daylight: row.daylight as Daylight | null, weather: row.weather ?? DEFAULT_WEATHER(row.currentDay) };
}
type Clock = Awaited<ReturnType<typeof lockClock>>;

/** The stored clock is running and has passed midnight, so the next day is due. */
const midnightDue = (d: Daylight | null, now: Date): d is Daylight => !!d && d.speed !== 'paused' && hoursNow(d, now.getTime()) >= 24;

/**
 * Move a locked world clock to `day` and log it. Auto weather rolls once for a day it hasn't seen, however many days
 * pass. Going back keeps it, and so does coming forward again to the day it was rolled for (a misclick undone
 * shouldn't change the sky).
 */
async function moveDay(tx: Tx, worldId: string, cur: Clock, day: number, daylight: Daylight | null, now: Date, rollover = false) {
  const prev = cur.weather;
  const fresh = prev.auto && day > cur.currentDay && day > prev.day;
  const weather: Weather = fresh ? { ...prev, kind: rollWeather(prev.kind), day, at: now.toISOString() } : prev;
  const actor = rollover ? 'system' : 'gm';
  await tx.update(worlds).set({ currentDay: day, daylight, ...(fresh ? { weather } : {}), updatedAt: now }).where(eq(worlds.id, worldId));
  await logEvent(tx, { worldId, gameDay: day, kind: 'day.changed', summary: day > cur.currentDay ? `Day ${day} dawns` : `Clock set back to day ${day}`, payload: { from: cur.currentDay, to: day, ...(rollover ? { rollover: true } : {}) }, actor });
  if (fresh) await logEvent(tx, { worldId, gameDay: day, kind: 'weather.changed', summary: weatherSummary(weather.kind, prev.kind, true), payload: { from: prev.kind, to: weather.kind, rolled: true, auto: true }, actor });
  return { currentDay: day, daylight, weather };
}

/** Midnight on a running clock: the next day begins (one day, however long nobody looked), carrying the hours past midnight. */
const rollOver = (tx: Tx, worldId: string, cur: Clock, d: Daylight, now: Date) => moveDay(tx, worldId, cur, cur.currentDay + 1,
  { ...d, hour: Math.max(0, hoursNow(d, now.getTime()) - 24) % 24, at: now.toISOString() }, now, true);

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
    // Start the sky running, under fair weather, the first time anyone opens the world.
    if (!w.daylight || !w.weather) {
      const fill = { daylight: w.daylight ?? DEFAULT_DAYLIGHT(), weather: w.weather ?? DEFAULT_WEATHER(w.currentDay) };
      await db.update(worlds).set(fill).where(eq(worlds.id, w.id));
      return { ...w, ...fill };
    }
    return w;
  });

  /** Set the time of day and/or how fast it runs (a per-world DM setting). */
  const DaylightBody = z.object({ hour: z.number().min(0).max(24).optional(), speed: z.enum(Object.keys(DAY_SPEEDS) as [DaySpeed, ...DaySpeed[]]).optional() });
  app.patch('/api/worlds/:w/daylight', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = DaylightBody.parse(req.body);
    // Locked like the day, so a pause and a midnight rollover from another screen apply one after the other.
    return db.transaction(async (tx) => {
      let cur = await lockClock(tx, w.id);
      const now = new Date();
      // A pause or speed change in the moment after midnight, before any screen asked for the next day, starts it
      // first: pausing would otherwise stop the clock at 24:00 with the day (and its weather) never turned over.
      // Setting the hour is the DM placing the clock by hand, so it doesn't.
      if (body.hour === undefined && midnightDue(cur.daylight, now)) cur = { ...cur, ...(await rollOver(tx, w.id, cur, cur.daylight, now)) };
      const was = cur.daylight ?? DEFAULT_DAYLIGHT();
      const daylight: Daylight = { hour: body.hour ?? hoursNow(was, now.getTime()) % 24, speed: body.speed ?? was.speed, at: now.toISOString() };
      await tx.update(worlds).set({ daylight }).where(eq(worlds.id, w.id));
      return { daylight, currentDay: cur.currentDay, weather: cur.weather };
    });
  });

  /** Set today's weather by hand and/or whether each new day rolls its own (a per-world DM setting). */
  const WeatherBody = z.object({ kind: z.enum(WEATHER_KINDS as [WeatherKind, ...WeatherKind[]]).optional(), auto: z.boolean().optional() });
  app.patch('/api/worlds/:w/weather', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = WeatherBody.parse(req.body);
    const weather = await db.transaction(async (tx) => {
      const { currentDay, weather: cur } = await lockClock(tx, w.id);
      const changed = body.kind !== undefined && body.kind !== cur.kind;
      // Switching auto on makes the sky as it stands today's weather, so only a day after this one rolls.
      const day = body.kind ? currentDay : body.auto && !cur.auto ? Math.max(cur.day, currentDay) : cur.day;
      const next: Weather = { kind: body.kind ?? cur.kind, auto: body.auto ?? cur.auto, day, at: changed ? new Date().toISOString() : cur.at };
      await tx.update(worlds).set({ weather: next }).where(eq(worlds.id, w.id));
      if (changed) await logEvent(tx, { worldId: w.id, gameDay: currentDay, kind: 'weather.changed', summary: weatherSummary(next.kind, cur.kind), payload: { from: cur.kind, to: next.kind } });
      return next;
    });
    return { weather };
  });

  /** Roll today's weather from the table in shared/weather.ts, leaning toward what it was. */
  app.post('/api/worlds/:w/weather/roll', async (req) => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const weather = await db.transaction(async (tx) => {
      const { currentDay, weather: cur } = await lockClock(tx, w.id);
      // A roll that comes up the same keeps the sky as it is (no new `at`, so maps don't ease into it again).
      const kind = rollWeather(cur.kind);
      const next: Weather = { kind, auto: cur.auto, day: currentDay, at: kind === cur.kind ? cur.at : new Date().toISOString() };
      await tx.update(worlds).set({ weather: next }).where(eq(worlds.id, w.id));
      await logEvent(tx, { worldId: w.id, gameDay: currentDay, kind: 'weather.changed', summary: weatherSummary(kind, cur.kind), payload: { from: cur.kind, to: kind, rolled: true } });
      return next;
    });
    return { weather };
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
    return db.transaction(async (tx) => {
      // Locked, so two tabs passing midnight together roll the day (and its weather) over once.
      const cur = await lockClock(tx, w.id);
      const now = new Date();
      // A screen asks for midnight from its own copy of the clock, which may be stale (paused or set back elsewhere
      // since its last poll): only the stored clock, running and past midnight, starts the next day.
      if (body.rollover) return body.rollover.from === cur.currentDay && midnightDue(cur.daylight, now) ? rollOver(tx, w.id, cur, cur.daylight, now) : cur;
      return moveDay(tx, w.id, cur, Math.max(1, body.day ?? cur.currentDay + (body.advance ?? 1)), cur.daylight, now);
    });
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
