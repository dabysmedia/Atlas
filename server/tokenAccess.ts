import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from './db/index.js';
import { campaignFog, playerAccess, tokens } from './db/schema.js';
export const forbidden = () => Object.assign(new Error('GM access required, or this token is not yours.'), { statusCode: 403 });
export const accessFor = (db: Db, userId: string, worldId: string) => db.query.playerAccess.findFirst({ where: and(eq(playerAccess.userId, userId), eq(playerAccess.worldId, worldId)) });
export async function visibleTokens(db: Db, req: FastifyRequest, worldId: string, rows: typeof tokens.$inferSelect[]) {
  if (req.userRole !== 'player') return rows;
  const access = await accessFor(db, req.userId!, worldId);
  if (!access) throw forbidden();
  const explored = access.campaignId ? new Set((await db.select().from(campaignFog).where(eq(campaignFog.campaignId, access.campaignId))).map(h => h.hexId)) : null;
  return rows.filter(t => t.visibleToPlayers && (t.factionId === access.factionId || !!t.hexId && (!explored || explored.has(t.hexId))));
}
