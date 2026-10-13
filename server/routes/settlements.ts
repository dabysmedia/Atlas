import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { factions, hexes, settlements, settlementHexes, tokens, wikiPages } from '../db/schema.js';
import { badRequest, HttpError, logEvent } from '../history.js';
import { changed } from '../live.js';
import { getWorld, Uuid } from './worlds.js';
import { rootMap } from './map.js';
import { connectedFootprint, defaultProfile, ProfileSchema, profileFor, SETTLEMENT_KEYS, tierFor, TIERS } from '../../shared/settlements.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Serialize footprint and capital checks across creation and edits, including older token endpoints. */
export async function lockSettlements(db: Tx, worldId: string) { await db.execute(sql`select pg_advisory_xact_lock(hashtext(${worldId}))`); }
export async function validateFootprint(db: Tx, worldId: string, ids: string[], except?: string) {
  const map = await rootMap(db,worldId);
  const rows = await db.select({id:hexes.id,q:hexes.q,r:hexes.r}).from(hexes).where(and(eq(hexes.mapId,map.id),inArray(hexes.id,ids)));
  if (rows.length !== ids.length) throw badRequest('Choose hexes on this world map.');
  if (!connectedFootprint(rows)) throw badRequest('Settlement hexes must form a connected area.');
  const occupied = await db.select().from(settlementHexes).where(and(inArray(settlementHexes.hexId,ids),except ? ne(settlementHexes.settlementId,except) : undefined));
  if (occupied.length) throw badRequest('A selected hex already belongs to another settlement.');
}
const Create = z.object({
  name:z.string().trim().min(1).max(120), type:z.enum(SETTLEMENT_KEYS), size:z.enum(TIERS).optional(),
  factionId:Uuid, hexIds:z.array(Uuid).min(1).max(500), anchorHexId:Uuid.optional(),
  population:z.number().int().min(0).max(2_000_000_000).nullable().optional(), visibleToPlayers:z.boolean().optional(),
});
const Patch = z.object({
  revision:z.number().int().positive().optional(), name:z.string().trim().min(1).max(120).optional(), size:z.enum(TIERS).optional(),
  population:z.number().int().min(0).max(2_000_000_000).nullable().optional(), factionId:Uuid.nullable().optional(),
  wikiPageId:Uuid.nullable().optional(), notes:z.string().max(20_000).optional(), profile:ProfileSchema.optional(),
  hexIds:z.array(Uuid).min(1).max(500).optional(), anchorHexId:Uuid.optional(),
});
async function refs(db: Tx, worldId: string, factionId?: string | null, pageId?: string | null) {
  if (factionId && !await db.query.factions.findFirst({where:and(eq(factions.id,factionId),eq(factions.worldId,worldId))})) throw badRequest('Choose a ruling faction in this world.');
  if (pageId && !await db.query.wikiPages.findFirst({where:and(eq(wikiPages.id,pageId),eq(wikiPages.worldId,worldId))})) throw badRequest('Choose a wiki page in this world.');
}
export function settlementRoutes(app: FastifyInstance, db: Db) {
  app.post('/api/worlds/:w/settlements',async req => {
    const w = await getWorld(db,(req.params as {w:string}).w), body=Create.parse(req.body), ids=[...new Set(body.hexIds)];
    const anchor=body.anchorHexId ?? ids[0];
    if (!ids.includes(anchor)) throw badRequest('The marker must be inside the settlement footprint.');
    const result=await db.transaction(async tx => {
      await lockSettlements(tx,w.id); await refs(tx,w.id,body.factionId); await validateFootprint(tx,w.id,ids);
      const map=await rootMap(tx,w.id);
      const [settlement]=await tx.insert(settlements).values({worldId:w.id,name:body.name,size:body.size ?? tierFor(body.type),population:body.population ?? null,factionId:body.factionId,data:{profile:{...defaultProfile(body.type),foundedDay:w.currentDay}}}).returning();
      await tx.insert(settlementHexes).values(ids.map(hexId=>({settlementId:settlement.id,hexId})));
      const [token]=await tx.insert(tokens).values({worldId:w.id,mapId:map.id,hexId:anchor,kind:body.type,name:body.name,factionId:body.factionId,settlementId:settlement.id,visibleToPlayers:body.visibleToPlayers ?? true}).returning();
      await logEvent(tx,{worldId:w.id,kind:'settlement.founded',summary:`Founded ${body.name} across ${ids.length} hex${ids.length===1?'':'es'}`,payload:{settlementId:settlement.id,hexIds:ids,factionId:body.factionId}});
      return {settlement:{...settlement,hexIds:ids},token};
    });
    changed(req,{scopes:['map']}); return result;
  });
  app.patch('/api/worlds/:w/settlements/:id',async req => {
    const {w:wid,id}=req.params as {w:string;id:string}, w=await getWorld(db,wid), body=Patch.parse(req.body);
    if ((body.profile || body.hexIds || body.anchorHexId) && body.revision === undefined) throw badRequest('Reload the settlement before editing it.');
    const row=await db.transaction(async tx => {
      await lockSettlements(tx,w.id);
      const before=await tx.query.settlements.findFirst({where:and(eq(settlements.id,Uuid.parse(id)),eq(settlements.worldId,w.id))});
      if (!before) throw new HttpError(404,'Settlement not found.');
      if (body.revision !== undefined && body.revision !== before.revision) throw new HttpError(409,'This settlement changed on another screen. Reload before saving.');
      await refs(tx,w.id,body.factionId,body.wikiPageId);
      const profile=body.profile ?? profileFor(before), factionId=body.factionId === undefined ? before.factionId : body.factionId;
      if (profile.capital) {
        if (!factionId) throw badRequest('A capital must have a ruling faction.');
        const peers=await tx.select().from(settlements).where(and(eq(settlements.factionId,factionId),ne(settlements.id,id)));
        if (peers.some(s=>profileFor(s).capital)) throw badRequest('This faction already has a capital. Unmark it before choosing another.');
      }
      const footprint=await tx.select().from(settlementHexes).where(eq(settlementHexes.settlementId,id));
      const ids=body.hexIds ? [...new Set(body.hexIds)] : footprint.map(h=>h.hexId);
      if (body.hexIds) await validateFootprint(tx,w.id,ids,id);
      const token=await tx.query.tokens.findFirst({where:eq(tokens.settlementId,id)});
      const anchor=body.anchorHexId ?? (token?.hexId && ids.includes(token.hexId) ? token.hexId : ids[0]);
      if (anchor && !ids.includes(anchor)) throw badRequest('The marker must be inside the settlement footprint.');
      if (body.hexIds) { await tx.delete(settlementHexes).where(eq(settlementHexes.settlementId,id)); await tx.insert(settlementHexes).values(ids.map(hexId=>({settlementId:id,hexId}))); }
      const {revision:_,profile:__,hexIds:___,anchorHexId:____,...fields}=body;
      const [updated]=await tx.update(settlements).set({...fields,data:{...(before.data as object),profile},revision:before.revision+1}).where(eq(settlements.id,id)).returning();
      await tx.update(tokens).set({name:updated.name,factionId:updated.factionId,kind:profile.type,...(anchor?{hexId:anchor}:{}),updatedAt:new Date()}).where(eq(tokens.settlementId,id));
      await logEvent(tx,{worldId:w.id,kind:'settlement.edited',summary:`Updated ${updated.name}`,payload:{settlementId:id,revision:updated.revision,hexIds:ids,factionId:updated.factionId}});
      return {...updated,hexIds:ids};
    });
    changed(req,{scopes:['map']}); return row;
  });
}
