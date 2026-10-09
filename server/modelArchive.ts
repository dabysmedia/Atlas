/**
 * 3D models are never thrown away: removing or replacing one moves it to `map_model_archive`, and
 * an archived model can be put back. Versions only ever grow per map, so the browser's cached copy
 * of one model is never mistaken for another.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './db/index.js';
import { mapModel, mapModelArchive, type ModelPlacement } from './db/schema.js';

export const archiveMeta = {
  id: mapModelArchive.id, name: mapModelArchive.name, version: mapModelArchive.version, reason: mapModelArchive.reason,
  archivedAt: mapModelArchive.archivedAt, size: sql<number>`octet_length(${mapModelArchive.bytes})`.as('size'),
};

/** Move the map's current model into the archive. Returns the archived row's id, or null if there was none. */
export async function archiveModel(tx: DbOrTx, mapId: string, reason: 'removed' | 'replaced') {
  const [m] = await tx.delete(mapModel).where(eq(mapModel.mapId, mapId)).returning();
  if (!m) return null;
  const [a] = await tx.insert(mapModelArchive).values({ mapId, bytes: m.bytes, name: m.name, placement: m.placement, version: m.version, reason })
    .returning({ id: mapModelArchive.id });
  return a.id;
}

/** One past the highest version this map has ever had, live or archived. */
export async function nextModelVersion(tx: DbOrTx, mapId: string) {
  const res = await tx.execute(sql`select greatest(
    coalesce((select max(version) from map_model where map_id = ${mapId}), 0),
    coalesce((select max(version) from map_model_archive where map_id = ${mapId}), 0))::int as v`);
  const v = Number((res.rows[0] as { v: number }).v);
  return v + 1;
}

/** Put a model on the map, archiving whatever was there. */
export async function installModel(tx: DbOrTx, mapId: string, m: { bytes: Buffer; name: string; placement: ModelPlacement }) {
  await archiveModel(tx, mapId, 'replaced');
  const version = await nextModelVersion(tx, mapId);
  await tx.insert(mapModel).values({ mapId, bytes: m.bytes, name: m.name, placement: m.placement, version, updatedAt: new Date() });
  return version;
}

export async function listArchive(tx: DbOrTx, mapId: string) {
  return tx.select(archiveMeta).from(mapModelArchive).where(eq(mapModelArchive.mapId, mapId)).orderBy(desc(mapModelArchive.archivedAt));
}

/** Bring an archived model back onto the map; the one there now (if any) takes its place in the archive. */
export async function restoreModel(tx: DbOrTx, mapId: string, archiveId: string) {
  const [a] = await tx.delete(mapModelArchive).where(and(eq(mapModelArchive.id, archiveId), eq(mapModelArchive.mapId, mapId))).returning();
  if (!a) return null;
  const version = await installModel(tx, mapId, { bytes: a.bytes, name: a.name, placement: a.placement });
  return { name: a.name, version };
}
