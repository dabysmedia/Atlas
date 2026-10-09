import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  campaigns, claims, factions, meterChanges, meterDefinitions, meterValues, rollTableEntries, rollTables, settlements, tokens,
} from '../db/schema.js';
import { badRequest, logEvent, notFound, setMeter } from '../history.js';
import { bandFor } from '../../shared/meters.js';
import { getWorld, Uuid } from './worlds.js';

type P = { w: string; id: string; m: string };

const Band = z.object({ label: z.string().trim().min(1).max(40), min: z.number(), tone: z.enum(['good', 'neutral', 'warn', 'bad', 'dire']) });

async function getFaction(db: Db, worldId: string, id: string) {
  const f = await db.query.factions.findFirst({ where: and(eq(factions.id, Uuid.parse(id)), eq(factions.worldId, worldId)) });
  if (!f) throw notFound('Faction');
  return f;
}

/** Meters that apply to a faction: all core + resource meters, plus its one signature meter. */
function appliesTo(def: typeof meterDefinitions.$inferSelect, f: typeof factions.$inferSelect) {
  return def.kind !== 'signature' || def.id === f.signatureMeterId;
}

export function factionRoutes(app: FastifyInstance, db: Db) {
  // ---------------------------------------------------------------- factions
  app.get('/api/worlds/:w/factions', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const [fs, defs, vals, claimCounts] = await Promise.all([
      db.select().from(factions).where(eq(factions.worldId, w.id)).orderBy(asc(factions.createdAt)),
      db.select().from(meterDefinitions).where(eq(meterDefinitions.worldId, w.id)).orderBy(asc(meterDefinitions.sortOrder)),
      db.select({ factionId: meterValues.factionId, meterId: meterValues.meterId, value: meterValues.value, updatedAt: meterValues.updatedAt })
        .from(meterValues).innerJoin(factions, eq(factions.id, meterValues.factionId)).where(eq(factions.worldId, w.id)),
      db.select({ factionId: claims.factionId, kind: claims.kind, n: sql<number>`count(*)::int` })
        .from(claims).innerJoin(factions, eq(factions.id, claims.factionId)).where(eq(factions.worldId, w.id))
        .groupBy(claims.factionId, claims.kind),
    ]);
    return fs.map((f) => ({
      ...f,
      claims: Object.fromEntries(claimCounts.filter((c) => c.factionId === f.id).map((c) => [c.kind, c.n])),
      meters: defs.filter((d) => appliesTo(d, f)).map((d) => {
        const v = vals.find((x) => x.factionId === f.id && x.meterId === d.id);
        const value = v?.value ?? d.defaultValue;
        return { meterId: d.id, value, isSet: !!v, updatedAt: v?.updatedAt ?? null, band: d.bands.length ? bandFor(d.bands, value) ?? null : null };
      }),
    }));
  });

  const FactionBody = z.object({
    name: z.string().trim().min(1).max(120),
    color: z.string().max(20).optional(),
    description: z.string().max(5000).optional(),
    sigil: z.string().max(40).nullable().optional(),
    signatureMeterId: Uuid.nullable().optional(),
    wikiPageId: Uuid.nullable().optional(),
  });
  app.post('/api/worlds/:w/factions', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = FactionBody.parse(req.body);
    await checkSignature(db, w.id, body.signatureMeterId);
    const f = await db.transaction(async (tx) => {
      const [f] = await tx.insert(factions).values({ ...body, worldId: w.id }).returning();
      // Start every applicable meter at its default so values exist (and are traceable) from day one.
      const defs = await tx.select().from(meterDefinitions).where(eq(meterDefinitions.worldId, w.id));
      for (const d of defs.filter((d) => appliesTo(d, f))) {
        await setMeter(tx, { worldId: w.id, factionId: f.id, factionName: f.name, meterId: d.id, value: d.defaultValue, cause: 'Faction founded' });
      }
      await logEvent(tx, { worldId: w.id, kind: 'faction.created', summary: `Faction "${f.name}" founded`, payload: { factionId: f.id } });
      return f;
    });
    return f;
  });

  app.patch('/api/worlds/:w/factions/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const f = await getFaction(db, w.id, id);
    const body = FactionBody.partial().parse(req.body);
    await checkSignature(db, w.id, body.signatureMeterId);
    return db.transaction(async (tx) => {
      const [row] = await tx.update(factions).set(body).where(eq(factions.id, f.id)).returning();
      if (body.signatureMeterId && body.signatureMeterId !== f.signatureMeterId) {
        const def = await tx.query.meterDefinitions.findFirst({ where: eq(meterDefinitions.id, body.signatureMeterId) });
        const existing = await tx.query.meterValues.findFirst({ where: and(eq(meterValues.factionId, f.id), eq(meterValues.meterId, body.signatureMeterId)) });
        if (def && !existing) await setMeter(tx, { worldId: w.id, factionId: f.id, factionName: row.name, meterId: def.id, value: def.defaultValue, cause: `Adopted ${def.name} as signature` });
      }
      return row;
    });
  });

  app.delete('/api/worlds/:w/factions/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const f = await getFaction(db, w.id, id);
    await db.delete(factions).where(eq(factions.id, f.id));
    await logEvent(db, { worldId: w.id, kind: 'faction.deleted', summary: `Faction "${f.name}" removed`, payload: { factionId: f.id } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- meter definitions
  app.get('/api/worlds/:w/meters', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    return db.select().from(meterDefinitions).where(eq(meterDefinitions.worldId, w.id)).orderBy(asc(meterDefinitions.sortOrder));
  });

  const MeterDef = z.object({
    name: z.string().trim().min(1).max(60),
    key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/).optional(),
    kind: z.enum(['core', 'signature', 'resource']),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    defaultValue: z.number().optional(),
    bands: z.array(Band).max(12).optional(),
    description: z.string().max(2000).optional(),
  });
  app.post('/api/worlds/:w/meters', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = MeterDef.parse(req.body);
    const key = body.key ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const count = await db.$count(meterDefinitions, eq(meterDefinitions.worldId, w.id));
    const [row] = await db.insert(meterDefinitions).values({ ...body, key, worldId: w.id, sortOrder: count }).returning();
    return row;
  });

  app.patch('/api/worlds/:w/meters/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const body = MeterDef.partial().omit({ kind: true }).parse(req.body);
    const [row] = await db.update(meterDefinitions).set(body)
      .where(and(eq(meterDefinitions.id, Uuid.parse(id)), eq(meterDefinitions.worldId, w.id))).returning();
    if (!row) throw notFound('Meter');
    return row;
  });

  app.delete('/api/worlds/:w/meters/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const [row] = await db.delete(meterDefinitions).where(and(eq(meterDefinitions.id, Uuid.parse(id)), eq(meterDefinitions.worldId, w.id))).returning();
    if (!row) throw notFound('Meter');
    await logEvent(db, { worldId: w.id, kind: 'meter.deleted', summary: `Meter "${row.name}" removed from the world`, payload: { meter: row } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- meter values
  const SetValue = z.object({
    value: z.number().optional(), delta: z.number().optional(),
    cause: z.string().trim().max(500).default(''), gameDay: z.number().int().min(1).optional(),
  });
  app.post('/api/worlds/:w/factions/:id/meters/:m', async (req) => {
    const { w: wid, id, m } = req.params as P;
    const w = await getWorld(db, wid);
    const f = await getFaction(db, w.id, id);
    const body = SetValue.parse(req.body);
    if (body.value === undefined && body.delta === undefined) throw badRequest('Give a value or a delta.');
    const def = await db.query.meterDefinitions.findFirst({ where: and(eq(meterDefinitions.id, Uuid.parse(m)), eq(meterDefinitions.worldId, w.id)) });
    if (!def) throw notFound('Meter');
    if (!appliesTo(def, f)) throw badRequest(`${def.name} is not ${f.name}’s signature meter.`);
    return db.transaction(async (tx) => {
      const cur = await tx.query.meterValues.findFirst({ where: and(eq(meterValues.factionId, f.id), eq(meterValues.meterId, def.id)) });
      const value = body.value ?? (cur?.value ?? def.defaultValue) + body.delta!;
      const res = await setMeter(tx, {
        worldId: w.id, factionId: f.id, factionName: f.name, meterId: def.id, value,
        cause: body.cause || 'GM adjustment', gameDay: body.gameDay,
      });
      return { value: res.value, band: def.bands.length ? bandFor(def.bands, res.value) ?? null : null, change: res.change };
    });
  });

  /** Trace: every change to one meter on one faction, newest first. */
  app.get('/api/worlds/:w/factions/:id/meters/:m/history', async (req) => {
    const { w: wid, id, m } = req.params as P;
    const w = await getWorld(db, wid);
    const f = await getFaction(db, w.id, id);
    return db.select().from(meterChanges)
      .where(and(eq(meterChanges.factionId, f.id), eq(meterChanges.meterId, Uuid.parse(m))))
      .orderBy(desc(meterChanges.id)).limit(500);
  });

  // ---------------------------------------------------------------- roll tables
  app.get('/api/worlds/:w/roll-tables', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const tables = await db.select().from(rollTables).where(eq(rollTables.worldId, w.id)).orderBy(asc(rollTables.createdAt));
    const entries = tables.length
      ? await db.select().from(rollTableEntries).where(inArray(rollTableEntries.tableId, tables.map((t) => t.id))).orderBy(asc(rollTableEntries.createdAt))
      : [];
    return tables.map((t) => ({ ...t, entries: entries.filter((e) => e.tableId === t.id) }));
  });

  const TableBody = z.object({
    name: z.string().trim().min(1).max(120), factionId: Uuid.nullable().optional(), meterId: Uuid.nullable().optional(), band: z.string().max(40).nullable().optional(),
  });
  app.post('/api/worlds/:w/roll-tables', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = TableBody.parse(req.body);
    if (body.factionId) await getFaction(db, w.id, body.factionId);
    const [row] = await db.insert(rollTables).values({ ...body, worldId: w.id }).returning();
    return { ...row, entries: [] };
  });

  async function getTable(worldId: string, id: string) {
    const t = await db.query.rollTables.findFirst({ where: and(eq(rollTables.id, Uuid.parse(id)), eq(rollTables.worldId, worldId)) });
    if (!t) throw notFound('Roll table');
    return t;
  }

  app.patch('/api/worlds/:w/roll-tables/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const t = await getTable(w.id, id);
    const [row] = await db.update(rollTables).set(TableBody.partial().parse(req.body)).where(eq(rollTables.id, t.id)).returning();
    return row;
  });

  app.delete('/api/worlds/:w/roll-tables/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const t = await getTable(w.id, id);
    await db.delete(rollTables).where(eq(rollTables.id, t.id));
    return { ok: true };
  });

  const EntryBody = z.object({
    kind: z.enum(['event', 'status', 'calamity']).default('event'),
    title: z.string().trim().min(1).max(200), text: z.string().max(5000).default(''),
    weight: z.number().int().min(1).max(1000).default(1),
    /** Entries drafted by an AI start unapproved; GM entries are canon. */
    source: z.enum(['gm', 'ai']).default('gm'),
  });
  app.post('/api/worlds/:w/roll-tables/:id/entries', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const t = await getTable(w.id, id);
    const body = EntryBody.parse(req.body);
    const [row] = await db.insert(rollTableEntries).values({ ...body, tableId: t.id, approved: body.source === 'gm' }).returning();
    return row;
  });

  const EntryPatch = EntryBody.partial().omit({ source: true }).extend({ approved: z.boolean().optional() });
  app.patch('/api/worlds/:w/roll-entries/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const entry = await db.query.rollTableEntries.findFirst({ where: eq(rollTableEntries.id, Uuid.parse(id)) });
    if (!entry) throw notFound('Entry');
    const t = await getTable(w.id, entry.tableId);
    const body = EntryPatch.parse(req.body);
    const [row] = await db.update(rollTableEntries).set(body).where(eq(rollTableEntries.id, entry.id)).returning();
    if (body.approved === true && !entry.approved) {
      await logEvent(db, { worldId: w.id, kind: 'roll.approved', summary: `Approved "${entry.title}" on ${t.name}`, payload: { entryId: entry.id } });
    }
    return row;
  });

  app.delete('/api/worlds/:w/roll-entries/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const entry = await db.query.rollTableEntries.findFirst({ where: eq(rollTableEntries.id, Uuid.parse(id)) });
    if (!entry) throw notFound('Entry');
    await getTable(w.id, entry.tableId);
    await db.delete(rollTableEntries).where(eq(rollTableEntries.id, entry.id));
    return { ok: true };
  });

  /** Weighted roll among approved entries only; the result goes in the chronicle. */
  app.post('/api/worlds/:w/roll-tables/:id/roll', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const t = await getTable(w.id, id);
    const entries = await db.select().from(rollTableEntries).where(and(eq(rollTableEntries.tableId, t.id), eq(rollTableEntries.approved, true)));
    if (!entries.length) throw badRequest('This table has no approved entries to roll on.');
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let pick = Math.random() * total;
    const hit = entries.find((e) => (pick -= e.weight) < 0) ?? entries[entries.length - 1];
    const faction = t.factionId ? await db.query.factions.findFirst({ where: eq(factions.id, t.factionId) }) : undefined;
    const event = await logEvent(db, {
      worldId: w.id, kind: `roll.${hit.kind}`,
      summary: `${faction ? `${faction.name}: ` : ''}${hit.title} (rolled on ${t.name})`,
      payload: { tableId: t.id, entryId: hit.id, text: hit.text, roll: Math.ceil(total - pick), of: total },
    });
    return { entry: hit, event };
  });

  // ---------------------------------------------------------------- campaigns & settlements
  const CampaignBody = z.object({
    name: z.string().trim().min(1).max(120), system: z.string().max(80).optional(),
    status: z.enum(['active', 'paused', 'finished']).optional(), notes: z.string().max(20_000).optional(),
  });
  app.get('/api/worlds/:w/campaigns', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    return db.select().from(campaigns).where(eq(campaigns.worldId, w.id)).orderBy(asc(campaigns.createdAt));
  });
  app.post('/api/worlds/:w/campaigns', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = CampaignBody.parse(req.body);
    const [row] = await db.insert(campaigns).values({ ...body, worldId: w.id }).returning();
    await logEvent(db, { worldId: w.id, campaignId: row.id, kind: 'campaign.created', summary: `Campaign "${row.name}" begins` });
    return row;
  });
  app.patch('/api/worlds/:w/campaigns/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const [row] = await db.update(campaigns).set(CampaignBody.partial().parse(req.body))
      .where(and(eq(campaigns.id, Uuid.parse(id)), eq(campaigns.worldId, w.id))).returning();
    if (!row) throw notFound('Campaign');
    return row;
  });
  app.delete('/api/worlds/:w/campaigns/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const [row] = await db.delete(campaigns).where(and(eq(campaigns.id, Uuid.parse(id)), eq(campaigns.worldId, w.id))).returning();
    if (!row) throw notFound('Campaign');
    return { ok: true };
  });

  const SettlementPatch = z.object({
    name: z.string().trim().min(1).max(120).optional(), size: z.string().max(40).optional(),
    population: z.number().int().min(0).nullable().optional(), factionId: Uuid.nullable().optional(),
    wikiPageId: Uuid.nullable().optional(), notes: z.string().max(20_000).optional(),
  });
  app.patch('/api/worlds/:w/settlements/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const body = SettlementPatch.parse(req.body);
    const [row] = await db.update(settlements).set(body).where(and(eq(settlements.id, Uuid.parse(id)), eq(settlements.worldId, w.id))).returning();
    if (!row) throw notFound('Settlement');
    // Keep the map token in step with the settlement it represents.
    const tokenSet: Partial<typeof tokens.$inferInsert> = {};
    if (body.name) tokenSet.name = body.name;
    if (body.factionId !== undefined) tokenSet.factionId = body.factionId;
    if (Object.keys(tokenSet).length) await db.update(tokens).set(tokenSet).where(eq(tokens.settlementId, row.id));
    return row;
  });
}

async function checkSignature(db: Db, worldId: string, meterId: string | null | undefined) {
  if (!meterId) return;
  const def = await db.query.meterDefinitions.findFirst({ where: and(eq(meterDefinitions.id, meterId), eq(meterDefinitions.worldId, worldId)) });
  if (!def) throw notFound('Meter');
  if (def.kind !== 'signature') throw badRequest(`${def.name} is a ${def.kind} meter, not a signature meter.`);
}
