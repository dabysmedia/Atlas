import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from './db/index.js';
import { events, meterChanges, meterDefinitions, meterValues, worlds } from './db/schema.js';

export async function worldDay(tx: DbOrTx, worldId: string): Promise<number> {
  const w = await tx.query.worlds.findFirst({ where: eq(worlds.id, worldId), columns: { currentDay: true } });
  if (!w) throw notFound('World');
  return w.currentDay;
}

export async function logEvent(tx: DbOrTx, e: {
  worldId: string; kind: string; summary: string; payload?: unknown;
  gameDay?: number; campaignId?: string | null; actor?: 'gm' | 'sim' | 'system';
}) {
  const gameDay = e.gameDay ?? await worldDay(tx, e.worldId);
  const [row] = await tx.insert(events).values({
    worldId: e.worldId, kind: e.kind, summary: e.summary, payload: e.payload ?? {},
    gameDay, campaignId: e.campaignId ?? null, actor: e.actor ?? 'gm',
  }).returning();
  return row;
}

/**
 * The one way meter values change: clamps to the definition's range, writes the
 * value, appends to meter_changes, and logs a chronicle event.
 */
export async function setMeter(tx: DbOrTx, p: {
  worldId: string; factionId: string; factionName: string; meterId: string;
  value: number; cause: string; gameDay?: number; source?: 'gm' | 'sim' | 'cascade';
}) {
  const def = await tx.query.meterDefinitions.findFirst({ where: eq(meterDefinitions.id, p.meterId) });
  if (!def || def.worldId !== p.worldId) throw notFound('Meter');
  let value = p.value;
  if (def.min != null) value = Math.max(def.min, value);
  if (def.max != null) value = Math.min(def.max, value);
  const prev = await tx.query.meterValues.findFirst({
    where: and(eq(meterValues.factionId, p.factionId), eq(meterValues.meterId, p.meterId)),
  });
  const gameDay = p.gameDay ?? await worldDay(tx, p.worldId);
  await tx.insert(meterValues).values({ factionId: p.factionId, meterId: p.meterId, value })
    .onConflictDoUpdate({ target: [meterValues.factionId, meterValues.meterId], set: { value, updatedAt: new Date() } });
  const [change] = await tx.insert(meterChanges).values({
    worldId: p.worldId, factionId: p.factionId, meterId: p.meterId,
    oldValue: prev?.value ?? null, newValue: value, cause: p.cause, gameDay, source: p.source ?? 'gm',
  }).returning();
  const delta = prev ? value - prev.value : null;
  await logEvent(tx, {
    worldId: p.worldId, gameDay, kind: 'meter.changed', actor: p.source === 'sim' ? 'sim' : 'gm',
    summary: `${p.factionName} ${def.name} ${prev ? `${fmt(prev.value)} → ${fmt(value)}` : `set to ${fmt(value)}`}${p.cause ? `: ${p.cause}` : ''}`,
    payload: { factionId: p.factionId, meterId: p.meterId, oldValue: prev?.value ?? null, newValue: value, delta, changeId: change.id },
  });
  return { value, change };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string) => new HttpError(400, msg);
