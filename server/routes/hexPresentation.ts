import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { campaignFog, hexArtwork, hexPresentations, hexes, maps, wikiPages } from '../db/schema.js';
import { badRequest, logEvent, notFound } from '../history.js';
import { changed } from '../live.js';
import { imageSize } from '../imagesize.js';
import { accessFor } from '../tokenAccess.js';
import { getWorld, Uuid } from './worlds.js';
import { emptyHexPresentation, RESOURCE_KINDS } from '../../shared/hexPresentation.js';

async function worldHex(db: Db, world: string, id: string) {
  const [row] = await db.select({ hex: hexes }).from(hexes).innerJoin(maps, eq(maps.id, hexes.mapId))
    .where(and(eq(maps.worldId, world), eq(hexes.id, Uuid.parse(id))));
  if (!row) throw notFound('Hex');
  return row.hex;
}
async function readable(db: Db, req: FastifyRequest, world: string, hexId: string) {
  if (req.userRole !== 'player') return;
  const access = await accessFor(db, req.userId!, world);
  if (!access || access.campaignId && !await db.query.campaignFog.findFirst({
    where: and(eq(campaignFog.campaignId, access.campaignId), eq(campaignFog.hexId, hexId)),
  })) throw notFound('Hex details');
}
const Resource = z.object({
  id: Uuid, name: z.string().trim().min(1).max(120), kind: z.enum(RESOURCE_KINDS),
  availability: z.string().trim().max(120), notes: z.string().max(2000),
});
const HexFields = z.object({
  name: z.string().max(200).optional(), terrain: z.string().min(1).max(40).optional(),
  state: z.string().min(1).max(40).optional(), notes: z.string().max(100000).optional(),
  wikiPageId: Uuid.nullable().optional(),
}).strict();
const Save = z.object({
  revision: z.number().int().min(0), heroId: Uuid.nullable(), heroFocus: z.number().int().min(0).max(100),
  lore: z.string().max(100000), resources: z.array(Resource).max(50),
  hex: HexFields.optional(), expectedHex: HexFields.optional(),
}).strict();
const conflict = () => Object.assign(new Error('This hex changed on another screen. Cancel to load the latest details before saving.'), { statusCode: 409 });

export function hexPresentationRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/worlds/:w/hexes/:id/presentation', async req => {
    const { w, id } = req.params as { w: string; id: string };
    const world = (await getWorld(db, w)).id, hex = await worldHex(db, world, id);
    await readable(db, req, world, hex.id);
    return await db.query.hexPresentations.findFirst({ where: eq(hexPresentations.hexId, hex.id) }) ?? emptyHexPresentation(hex.id);
  });
  app.patch('/api/worlds/:w/hexes/:id/presentation', async req => {
    const { w, id } = req.params as { w: string; id: string }, world = await getWorld(db, w);
    const selected = await worldHex(db, world.id, id), body = Save.parse(req.body);
    if (new Set(body.resources.map(r => r.id)).size !== body.resources.length) throw badRequest('Resource entries must be distinct.');
    if (body.hex?.terrain && !world.terrainTypes.some(t => t.key === body.hex!.terrain)) throw badRequest('Choose a terrain from this world.');
    if (body.hex?.state && !world.hexStates.some(s => s.key === body.hex!.state)) throw badRequest('Choose a state from this world.');
    return db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hex-details:${world.id}`}))`);
      const old = await tx.query.hexPresentations.findFirst({ where: eq(hexPresentations.hexId, selected.id) });
      if ((old?.revision ?? 0) !== body.revision) throw conflict();
      if (body.heroId && !await tx.query.hexArtwork.findFirst({ where: and(eq(hexArtwork.id, body.heroId), eq(hexArtwork.worldId, world.id)) })) throw badRequest('Choose artwork from this world.');
      if (body.hex?.wikiPageId && !await tx.query.wikiPages.findFirst({ where: and(eq(wikiPages.id, body.hex.wikiPageId), eq(wikiPages.worldId, world.id)) })) throw badRequest('Choose a wiki page from this world.');
      const keys = Object.keys(body.hex ?? {}) as (keyof z.infer<typeof HexFields>)[];
      if (keys.length) {
        // Lock the canonical row too: a paint/rename cannot race this editor's comparison.
        await tx.execute(sql`select id from hexes where id = ${selected.id} for update`);
        const current = (await tx.query.hexes.findFirst({ where: eq(hexes.id, selected.id) }))!;
        if (keys.some(key => !Object.hasOwn(body.expectedHex ?? {}, key) || current[key] !== body.expectedHex?.[key])) throw conflict();
        const [row] = await tx.update(hexes).set({ ...body.hex, updatedAt: new Date() }).where(eq(hexes.id, selected.id)).returning();
        changed(req, { patches: [{ op: 'hex', hex: row }] });
      }
      const values = { heroId: body.heroId, heroFocus: body.heroFocus, lore: body.lore, resources: body.resources, revision: body.revision + 1, updatedAt: new Date() };
      const [saved] = await tx.insert(hexPresentations).values({ worldId: world.id, hexId: selected.id, ...values })
        .onConflictDoUpdate({ target: hexPresentations.hexId, set: values }).returning();
      await logEvent(tx, { worldId: world.id, kind: 'hex.details.updated', summary: `Updated details for ${body.hex?.name || selected.name || 'hex'}`, payload: { hexId: selected.id } });
      return saved;
    });
  });
  app.post('/api/worlds/:w/hex-artwork', { bodyLimit: 8 * 1024 * 1024 }, async req => {
    const world = (await getWorld(db, (req.params as { w: string }).w)).id, bytes = req.body;
    if (!Buffer.isBuffer(bytes)) throw badRequest('Upload PNG, JPEG, WebP or GIF artwork.');
    const size = imageSize(bytes);
    if (!size || size.width < 1 || size.height < 1 || size.width * size.height > 24000000) throw badRequest('Upload artwork up to 8 MB and 24 megapixels.');
    const name = z.string().trim().min(1).max(120).parse((req.query as { name?: string }).name ?? 'Hex artwork');
    const [row] = await db.insert(hexArtwork).values({ worldId: world, name, mime: size.mime, bytes }).returning({ id: hexArtwork.id, name: hexArtwork.name });
    return row;
  });
  app.get('/api/worlds/:w/hex-artwork/:id', async (req, reply) => {
    const { w, id } = req.params as { w: string; id: string }, world = (await getWorld(db, w)).id;
    const art = await db.query.hexArtwork.findFirst({ where: and(eq(hexArtwork.worldId, world), eq(hexArtwork.id, Uuid.parse(id))) });
    if (!art) throw notFound('Artwork');
    if (req.userRole === 'player') {
      const uses = await db.select({ hexId: hexPresentations.hexId }).from(hexPresentations).where(and(eq(hexPresentations.worldId, world), eq(hexPresentations.heroId, id)));
      let allowed = false;
      for (const use of uses) { try { await readable(db, req, world, use.hexId); allowed = true; break; } catch { /* Try another visible reference. */ } }
      if (!allowed) throw notFound('Artwork');
    }
    return reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff').type(art.mime).send(art.bytes);
  });
}
