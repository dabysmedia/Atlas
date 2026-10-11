import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { campaigns, campaignFog, factions, hexes, playerAccess, tokenModels, tokens, users, wikiPages } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { badRequest, logEvent, notFound, worldDay } from '../history.js';
import { changed } from '../live.js';
import { distance, hexLabel } from '../../shared/hex.js';
import { accessFor, forbidden, visibleTokens } from '../tokenAccess.js';
import { getWorld, Uuid } from './worlds.js';
import { rootMap } from './map.js';

export async function validateTokenRefs(db: Db, worldId: string, body: { factionId?: string | null; campaignId?: string | null; modelId?: string | null; mainParty?: boolean; kind?: string; data?: unknown }) {
  if (body.factionId && !await db.query.factions.findFirst({ where: and(eq(factions.id, body.factionId), eq(factions.worldId, worldId)) })) throw badRequest('Faction must belong to this world.');
  if (body.campaignId && !await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, body.campaignId), eq(campaigns.worldId, worldId)) })) throw badRequest('Campaign must belong to this world.');
  if (body.modelId && !await db.query.tokenModels.findFirst({ where: and(eq(tokenModels.id, body.modelId), eq(tokenModels.worldId, worldId)) })) throw badRequest('Model must belong to this world.');
  const sheetId = (body.data as { sheetPageId?: string } | undefined)?.sheetPageId;
  if (sheetId && !await db.query.wikiPages.findFirst({ where: and(eq(wikiPages.id, Uuid.parse(sheetId)), eq(wikiPages.worldId, worldId)) })) throw badRequest('Token sheet must belong to this world.');
  if (body.mainParty && (!body.factionId || body.kind !== 'party')) throw badRequest('A main party must be a party token belonging to a faction.');
}

export function pieceRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/worlds/:w/players', async req => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    return db.select({ id: users.id, username: users.username, factionId: playerAccess.factionId, campaignId: playerAccess.campaignId }).from(playerAccess).innerJoin(users, eq(users.id, playerAccess.userId)).where(eq(playerAccess.worldId, w.id));
  });
  app.post('/api/worlds/:w/players', async req => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    const body = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(10).max(500), factionId: Uuid, campaignId: Uuid.nullable().optional() }).parse(req.body);
    await validateTokenRefs(db, w.id, body);
    if (await db.query.users.findFirst({ where: eq(users.username, body.username) })) throw badRequest('This username already exists. Choose another username.');
    const passwordHash = await hashPassword(body.password);
    return db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ username: body.username, passwordHash, role: 'player' }).returning({ id: users.id, username: users.username });
      await tx.insert(playerAccess).values({ userId: u.id, worldId: w.id, factionId: body.factionId, campaignId: body.campaignId });
      return u;
    });
  });
  app.delete('/api/worlds/:w/players/:id', async req => {
    const { w, id } = req.params as { w: string; id: string };
    await db.delete(playerAccess).where(and(eq(playerAccess.worldId, Uuid.parse(w)), eq(playerAccess.userId, Uuid.parse(id))));
    return { ok: true };
  });
  app.get('/api/worlds/:w/token-models', async req => {
    const w = await getWorld(db, (req.params as { w: string }).w);
    return db.select({ id: tokenModels.id, name: tokenModels.name, size: sql<number>`octet_length(${tokenModels.bytes})` }).from(tokenModels).where(eq(tokenModels.worldId, w.id));
  });
  app.post('/api/worlds/:w/token-models', { bodyLimit: 10 * 1024 * 1024 }, async req => {
    const w = await getWorld(db, (req.params as { w: string }).w), bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw badRequest('Upload a self-contained GLB model up to 10 MB.');
    const jsonLength = bytes.readUInt32LE(12);
    if (20 + jsonLength > bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw badRequest('Invalid GLB.');
    let doc; try { doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)); } catch { throw badRequest('Invalid GLB JSON.'); }
    if ([...(doc.buffers ?? []), ...(doc.images ?? [])].some((x: { uri?: string }) => x.uri && !x.uri.startsWith('data:'))) throw badRequest('GLB models must embed their buffers and textures.');
    const name = z.string().trim().min(1).max(120).parse((req.query as { name?: string }).name ?? 'miniature.glb');
    const [model] = await db.insert(tokenModels).values({ worldId: w.id, name, bytes }).returning({ id: tokenModels.id, name: tokenModels.name }); return model;
  });
  app.get('/api/worlds/:w/token-models/:id', async (req, reply) => {
    const { w, id } = req.params as { w: string; id: string };
    const model = await db.query.tokenModels.findFirst({ where: and(eq(tokenModels.worldId, Uuid.parse(w)), eq(tokenModels.id, Uuid.parse(id))) });
    if (!model) throw notFound('Model');
    if (req.userRole === 'player') {
      const rows = await db.select().from(tokens).where(and(eq(tokens.worldId, w), eq(tokens.modelId, id)));
      if (!(await visibleTokens(db, req, w, rows)).length) throw notFound('Model');
    }
    return reply.header('cache-control', 'private, no-store').type('model/gltf-binary').send(model.bytes);
  });
  app.post('/api/worlds/:w/tokens/:id/deploy', async req => {
    const { w, id } = req.params as { w: string; id: string };
    const body = z.object({ hexId: Uuid }).parse(req.body);
    const map = await rootMap(db, Uuid.parse(w));
    return db.transaction(async tx => {
      const [source] = await tx.select().from(tokens).where(and(eq(tokens.worldId, w), eq(tokens.id, Uuid.parse(id)))).for('update');
      if (!source) throw notFound('Token');
      if (req.userRole === 'player') {
        const access = await accessFor(db, req.userId!, w);
        if (!access || source.factionId !== access.factionId || !source.visibleToPlayers) throw forbidden();
      }
      if (source.mainParty || !source.factionId || !['party', 'unit', 'character', 'marker'].includes(source.kind)) throw badRequest('Deploy copies of faction pieces; the main party is unique.');
      const hex = await tx.query.hexes.findFirst({ where: and(eq(hexes.id, body.hexId), eq(hexes.mapId, map.id)) });
      if (!hex) throw badRequest('Hex must belong to this map.');
      await tx.select({ id: factions.id }).from(factions).where(eq(factions.id, source.factionId)).for('update');
      const data = source.data && typeof source.data === 'object' && !Array.isArray(source.data) ? source.data as Record<string, unknown> : {};
      const baseName = typeof data.drawerName === 'string' ? data.drawerName : source.name;
      const names = new Set((await tx.select({ name: tokens.name }).from(tokens).where(and(eq(tokens.worldId, w), eq(tokens.factionId, source.factionId)))).map(t => t.name));
      let number = 2, name = `${baseName.slice(0, 110)} #${number}`;
      while (names.has(name)) name = `${baseName.slice(0, 110)} #${++number}`;
      const day = await worldDay(tx, w);
      const [copy] = await tx.insert(tokens).values({
        worldId: w, mapId: map.id, factionId: source.factionId, campaignId: source.campaignId,
        kind: source.kind, name, hexId: hex.id, color: source.color, icon: source.icon,
        modelId: source.modelId, visibleToPlayers: source.visibleToPlayers,
        data: { ...data, drawerName: baseName, drawerSourceId: data.drawerSourceId ?? source.id },
        trail: [{ hexId: hex.id, day, at: new Date().toISOString() }],
      }).returning();
      await logEvent(tx, { worldId: w, campaignId: copy.campaignId, kind: 'token.created', actor: req.userRole ?? 'gm', summary: `${copy.name} deployed`, payload: { tokenId: copy.id, sourceTokenId: source.id, hexId: hex.id } });
      changed(req, { scopes: ['map'] });
      return copy;
    });
  });
  app.post('/api/worlds/:w/tokens/:id/move', async req => {
    const { w, id } = req.params as { w: string; id: string };
    const body = z.object({ path: z.array(Uuid).min(1).max(100), from: Uuid.nullable() }).parse(req.body);
    const map = await rootMap(db, Uuid.parse(w));
    return db.transaction(async tx => {
      const [tok] = await tx.select().from(tokens).where(and(eq(tokens.worldId, w), eq(tokens.id, Uuid.parse(id)))).for('update');
      if (!tok) throw notFound('Token');
      if (req.userRole === 'player') {
        const access = await accessFor(db, req.userId!, w);
        if (!access || tok.factionId !== access.factionId || !tok.visibleToPlayers || !['party', 'unit', 'character', 'marker'].includes(tok.kind)) throw forbidden();
      }
      if (tok.hexId !== body.from) throw Object.assign(new Error('The token moved on another screen. Refresh and try again.'), { statusCode: 409 });
      const positions = await tx.select().from(hexes).where(eq(hexes.mapId, map.id));
      const byId = new Map(positions.map(h => [h.id, h]));
      let previous = tok.hexId ? byId.get(tok.hexId) : undefined;
      const visits = [...tok.trail], day = await worldDay(tx, w);
      if (!visits.length && tok.hexId) visits.push({ hexId: tok.hexId, day, at: new Date().toISOString() });
      for (const hexId of body.path) {
        const h = byId.get(hexId); if (!h) throw badRequest('Hex must belong to this map.');
        if (previous && distance(previous, h) !== 1) throw badRequest('Choose adjacent hexes in travel order. Distant jumps cannot invent a trail.');
        visits.push({ hexId, day, at: new Date().toISOString() });
        await logEvent(tx, { worldId: w, campaignId: tok.campaignId, kind: 'token.moved', actor: req.userRole ?? 'gm', summary: `${tok.name} moved ${previous ? hexLabel(previous.q, previous.r, map.layout.orientation) : 'drawer'} → ${hexLabel(h.q, h.r, map.layout.orientation)}`, payload: { tokenId: tok.id, from: previous?.id ?? null, to: hexId } });
        previous = h;
      }
      const [row] = await tx.update(tokens).set({ hexId: body.path.at(-1), trail: visits, updatedAt: new Date() }).where(eq(tokens.id, tok.id)).returning();
      if (tok.mainParty && tok.campaignId) await tx.insert(campaignFog).values([...new Set([...(tok.hexId ? [tok.hexId] : []), ...body.path])].map(hexId => ({ campaignId: tok.campaignId!, hexId, sinceDay: day }))).onConflictDoNothing();
      changed(req, { scopes: ['map', 'fog'] }); return row;
    });
  });
}
