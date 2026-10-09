import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { campaignFog, campaigns, claims, factions, hexes, mapArt, mapModel, maps, settlements, tokens, type ArtPlacement } from '../db/schema.js';
import { badRequest, logEvent, notFound, worldDay } from '../history.js';
import { getWorld, Uuid } from './worlds.js';
import { gridBounds, hexLabel, type Orientation } from '../../shared/hex.js';
import { imageSize } from '../imagesize.js';
import { fitModelPlacement } from '../placement.js';

type P = { w: string; id: string };

export async function rootMap(db: Db, worldId: string) {
  const m = await db.query.maps.findFirst({ where: and(eq(maps.worldId, worldId), isNull(maps.parentHexId)) });
  if (!m) throw notFound('Map');
  return m;
}

/** Hexes must belong to the world's map; returns them, rejecting foreign ids. */
async function worldHexes(db: Db, worldId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await db.select({ id: hexes.id, q: hexes.q, r: hexes.r, mapId: hexes.mapId, layout: maps.layout })
    .from(hexes).innerJoin(maps, eq(maps.id, hexes.mapId))
    .where(and(eq(maps.worldId, worldId), inArray(hexes.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest('Some hexes are not on this world’s map.');
  return rows.map((r) => ({ ...r, label: hexLabel(r.q, r.r, r.layout.orientation) }));
}

const HexIds = z.array(Uuid).min(1).max(20_000);

const artMeta = { version: mapArt.version, width: mapArt.width, height: mapArt.height, mime: mapArt.mime, placement: mapArt.placement, updatedAt: mapArt.updatedAt };

/** Default placement: the art covers the whole grid, centered, keeping its aspect ratio. */
export function coverPlacement(layout: { cols: number; rows: number; orientation: Orientation }, width: number, height: number): ArtPlacement {
  const b = gridBounds(layout.cols, layout.rows, layout.orientation);
  const gw = b.maxX - b.minX, gh = b.maxY - b.minY;
  const s = Math.max(gw / width, gh / height);
  const w = width * s, h = height * s;
  return { x: b.minX - (w - gw) / 2, y: b.minY - (h - gh) / 2, w, h, opacity: 1 };
}

export const MAX_ART_BYTES = 25 * 1024 * 1024;
export const MAX_MODEL_BYTES = 40 * 1024 * 1024;

const modelMeta = { version: mapModel.version, name: mapModel.name, placement: mapModel.placement, size: sql<number>`octet_length(${mapModel.bytes})`.as('size'), updatedAt: mapModel.updatedAt };

export function mapRoutes(app: FastifyInstance, db: Db) {
  /** Everything the map view needs in one round trip. Fog comes separately per campaign. */
  app.get('/api/worlds/:w/map', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const [hexRows, claimRows, tokenRows, settlementRows, factionRows, campaignRows, artRows, modelRows] = await Promise.all([
      db.select({
        id: hexes.id, q: hexes.q, r: hexes.r, terrain: hexes.terrain, state: hexes.state, name: hexes.name,
        notes: hexes.notes, wikiPageId: hexes.wikiPageId, data: hexes.data,
      }).from(hexes).where(eq(hexes.mapId, map.id)),
      db.select({ id: claims.id, hexId: claims.hexId, factionId: claims.factionId, kind: claims.kind, sinceDay: claims.sinceDay, note: claims.note })
        .from(claims).innerJoin(hexes, eq(hexes.id, claims.hexId)).where(eq(hexes.mapId, map.id)),
      db.select().from(tokens).where(eq(tokens.mapId, map.id)),
      db.select().from(settlements).where(eq(settlements.worldId, w.id)),
      db.select({ id: factions.id, name: factions.name, color: factions.color }).from(factions).where(eq(factions.worldId, w.id)),
      db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.worldId, w.id)),
      db.select(artMeta).from(mapArt).where(eq(mapArt.mapId, map.id)),
      db.select(modelMeta).from(mapModel).where(eq(mapModel.mapId, map.id)),
    ]);
    return { map: { ...map, art: artRows[0] ?? null, model: modelRows[0] ?? null }, hexes: hexRows, claims: claimRows, tokens: tokenRows, settlements: settlementRows, factions: factionRows, campaigns: campaignRows };
  });

  const HexPatch = z.object({
    terrain: z.string().min(1).max(40).optional(),
    state: z.string().min(1).max(40).optional(),
    name: z.string().max(200).optional(),
    notes: z.string().max(100_000).optional(),
    wikiPageId: Uuid.nullable().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  });
  app.patch('/api/worlds/:w/hexes/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const [hex] = await worldHexes(db, w.id, [Uuid.parse(id)]);
    const body = HexPatch.parse(req.body);
    const before = await db.query.hexes.findFirst({ where: eq(hexes.id, hex.id) });
    const [row] = await db.update(hexes).set({ ...body, updatedAt: new Date() }).where(eq(hexes.id, hex.id)).returning();
    // Note edits are frequent autosaves; log the structural changes only.
    const changed = (['terrain', 'state', 'name'] as const).filter((k) => body[k] !== undefined && body[k] !== before?.[k]);
    if (changed.length) {
      await logEvent(db, {
        worldId: w.id, kind: 'hex.edited',
        summary: `Hex ${hex.label}: ${changed.map((k) => `${k} ${before?.[k] || '–'} → ${body[k] || '–'}`).join(', ')}`,
        payload: { hexId: hex.id, from: Object.fromEntries(changed.map((k) => [k, before?.[k]])), to: Object.fromEntries(changed.map((k) => [k, body[k]])) },
      });
    }
    return row;
  });

  /** Brush painting: set terrain or state on many hexes as one action and one event. */
  const Paint = z.object({ hexIds: HexIds, terrain: z.string().min(1).max(40).optional(), state: z.string().min(1).max(40).optional() });
  app.post('/api/worlds/:w/hexes/paint', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = Paint.parse(req.body);
    if (!body.terrain && !body.state) throw badRequest('Nothing to paint.');
    const ids = [...new Set(body.hexIds)];
    await worldHexes(db, w.id, ids);
    const set: Partial<typeof hexes.$inferInsert> = { updatedAt: new Date() };
    if (body.terrain) set.terrain = body.terrain;
    if (body.state) set.state = body.state;
    await db.update(hexes).set(set).where(inArray(hexes.id, ids));
    const label = body.terrain
      ? `${w.terrainTypes.find((t) => t.key === body.terrain)?.name ?? body.terrain}`
      : `${w.hexStates.find((s) => s.key === body.state)?.name ?? body.state}`;
    await logEvent(db, {
      worldId: w.id, kind: 'hex.painted', summary: `Painted ${ids.length} hex${ids.length === 1 ? '' : 'es'} ${label}`,
      payload: { hexIds: ids, terrain: body.terrain, state: body.state },
    });
    return { ok: true, count: ids.length };
  });

  /**
   * Set (or clear, with factionId null) the controlling faction on hexes.
   * This is the primary way borders change; every call is one chronicle event.
   */
  const Control = z.object({ hexIds: HexIds, factionId: Uuid.nullable(), note: z.string().max(500).optional() });
  app.post('/api/worlds/:w/claims/control', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = Control.parse(req.body);
    const ids = [...new Set(body.hexIds)];
    const hexRows = await worldHexes(db, w.id, ids);
    let faction: { id: string; name: string } | undefined;
    if (body.factionId) {
      faction = await db.query.factions.findFirst({ where: and(eq(factions.id, body.factionId), eq(factions.worldId, w.id)), columns: { id: true, name: true } });
      if (!faction) throw notFound('Faction');
    }
    const day = await worldDay(db, w.id);
    const result = await db.transaction(async (tx) => {
      const prior = await tx.select({ hexId: claims.hexId, factionId: claims.factionId, sinceDay: claims.sinceDay }).from(claims)
        .where(and(inArray(claims.hexId, ids), eq(claims.kind, 'control')));
      await tx.delete(claims).where(and(inArray(claims.hexId, ids), eq(claims.kind, 'control')));
      if (faction) {
        await tx.insert(claims).values(ids.map((hexId) => {
          const was = prior.find((p) => p.hexId === hexId);
          return { hexId, factionId: faction!.id, kind: 'control', sinceDay: was?.factionId === faction!.id ? was.sinceDay : day, note: body.note ?? '' };
        }));
      }
      const changed = ids.filter((id) => (prior.find((p) => p.hexId === id)?.factionId ?? null) !== (faction?.id ?? null));
      if (changed.length) {
        const coords = hexRows.filter((h) => changed.includes(h.id)).slice(0, 6).map((h) => h.label).join(' ');
        await logEvent(tx, {
          worldId: w.id, gameDay: day, kind: 'claim.changed',
          summary: faction
            ? `${faction.name} takes control of ${changed.length} hex${changed.length === 1 ? '' : 'es'} (${coords}${changed.length > 6 ? ' …' : ''})`
            : `Control cleared on ${changed.length} hex${changed.length === 1 ? '' : 'es'} (${coords}${changed.length > 6 ? ' …' : ''})`,
          payload: { hexIds: changed, factionId: faction?.id ?? null, prior: prior.filter((p) => changed.includes(p.hexId)) },
        });
      }
      return tx.select().from(claims).where(inArray(claims.hexId, ids));
    });
    return result;
  });

  /** Non-control claims (contested, influence) and per-claim notes, from the hex inspector. */
  const ClaimBody = z.object({ hexId: Uuid, factionId: Uuid, kind: z.enum(['contested', 'influence']), note: z.string().max(500).optional() });
  app.post('/api/worlds/:w/claims', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = ClaimBody.parse(req.body);
    const [hex] = await worldHexes(db, w.id, [body.hexId]);
    const faction = await db.query.factions.findFirst({ where: and(eq(factions.id, body.factionId), eq(factions.worldId, w.id)) });
    if (!faction) throw notFound('Faction');
    const day = await worldDay(db, w.id);
    const [row] = await db.insert(claims).values({ ...body, note: body.note ?? '', sinceDay: day }).onConflictDoNothing().returning();
    if (row) await logEvent(db, { worldId: w.id, gameDay: day, kind: 'claim.changed', summary: `${faction.name} lays a ${body.kind} claim on hex ${hex.label}`, payload: { claimId: row.id, hexId: hex.id } });
    return row ?? null;
  });

  app.delete('/api/worlds/:w/claims/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const claim = await db.query.claims.findFirst({ where: eq(claims.id, Uuid.parse(id)) });
    if (!claim) throw notFound('Claim');
    const [hex] = await worldHexes(db, w.id, [claim.hexId]);
    const faction = await db.query.factions.findFirst({ where: eq(factions.id, claim.factionId) });
    await db.delete(claims).where(eq(claims.id, claim.id));
    await logEvent(db, { worldId: w.id, kind: 'claim.changed', summary: `${faction?.name ?? 'A faction'} drops its ${claim.kind} claim on hex ${hex.label}`, payload: { claim } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- fog (per campaign, shared by its party)
  app.get('/api/worlds/:w/campaigns/:id/fog', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const camp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, Uuid.parse(id)), eq(campaigns.worldId, w.id)) });
    if (!camp) throw notFound('Campaign');
    const rows = await db.select({ hexId: campaignFog.hexId }).from(campaignFog).where(eq(campaignFog.campaignId, camp.id));
    return rows.map((r) => r.hexId);
  });

  const FogPaint = z.object({ hexIds: HexIds, explored: z.boolean() });
  app.post('/api/worlds/:w/campaigns/:id/fog', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const camp = await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, Uuid.parse(id)), eq(campaigns.worldId, w.id)) });
    if (!camp) throw notFound('Campaign');
    const body = FogPaint.parse(req.body);
    const ids = [...new Set(body.hexIds)];
    await worldHexes(db, w.id, ids);
    const day = await worldDay(db, w.id);
    if (body.explored) {
      await db.insert(campaignFog).values(ids.map((hexId) => ({ campaignId: camp.id, hexId, sinceDay: day }))).onConflictDoNothing();
    } else {
      await db.delete(campaignFog).where(and(eq(campaignFog.campaignId, camp.id), inArray(campaignFog.hexId, ids)));
    }
    await logEvent(db, {
      worldId: w.id, gameDay: day, campaignId: camp.id, kind: body.explored ? 'fog.revealed' : 'fog.hidden',
      summary: `${camp.name}: ${body.explored ? 'revealed' : 're-fogged'} ${ids.length} hex${ids.length === 1 ? '' : 'es'}`,
      payload: { hexIds: ids },
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- tokens
  const TokenKind = z.enum(['party', 'city', 'outpost', 'unit', 'character', 'marker']);
  const TokenCreate = z.object({
    kind: TokenKind, name: z.string().trim().min(1).max(120), hexId: Uuid.nullable().optional(),
    factionId: Uuid.nullable().optional(), campaignId: Uuid.nullable().optional(), color: z.string().max(20).nullable().optional(),
    visibleToPlayers: z.boolean().optional(),
  });
  app.post('/api/worlds/:w/tokens', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const body = TokenCreate.parse(req.body);
    const map = await rootMap(db, w.id);
    if (body.hexId) await worldHexes(db, w.id, [body.hexId]);
    let settlementId: string | undefined;
    if (body.kind === 'city' || body.kind === 'outpost') {
      const [s] = await db.insert(settlements).values({
        worldId: w.id, name: body.name, size: body.kind === 'outpost' ? 'outpost' : 'town', factionId: body.factionId ?? null,
      }).returning();
      settlementId = s.id;
    }
    const [row] = await db.insert(tokens).values({ ...body, worldId: w.id, mapId: map.id, settlementId }).returning();
    await logEvent(db, { worldId: w.id, kind: 'token.created', summary: `${cap(body.kind)} "${body.name}" placed`, payload: { tokenId: row.id, hexId: body.hexId } });
    return row;
  });

  const TokenPatch = TokenCreate.partial().extend({ data: z.record(z.string(), z.unknown()).optional() });
  app.patch('/api/worlds/:w/tokens/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const tok = await db.query.tokens.findFirst({ where: and(eq(tokens.id, Uuid.parse(id)), eq(tokens.worldId, w.id)) });
    if (!tok) throw notFound('Token');
    const body = TokenPatch.parse(req.body);
    if (body.hexId) await worldHexes(db, w.id, [body.hexId]);
    const [row] = await db.update(tokens).set({ ...body, updatedAt: new Date() }).where(eq(tokens.id, tok.id)).returning();
    if (body.hexId !== undefined && body.hexId !== tok.hexId) {
      const [from, to] = await Promise.all([tok.hexId, body.hexId].map(async (h) => (h ? (await worldHexes(db, w.id, [h]))[0] : undefined)));
      await logEvent(db, {
        worldId: w.id, kind: 'token.moved', campaignId: tok.campaignId,
        summary: `${tok.name} moved ${from ? from.label : 'off-map'} → ${to ? to.label : 'off-map'}`,
        payload: { tokenId: tok.id, from: tok.hexId, to: body.hexId },
      });
    }
    if (body.name && tok.settlementId) await db.update(settlements).set({ name: body.name }).where(eq(settlements.id, tok.settlementId));
    return row;
  });

  app.delete('/api/worlds/:w/tokens/:id', async (req) => {
    const { w: wid, id } = req.params as P;
    const w = await getWorld(db, wid);
    const tok = await db.query.tokens.findFirst({ where: and(eq(tokens.id, Uuid.parse(id)), eq(tokens.worldId, w.id)) });
    if (!tok) throw notFound('Token');
    // Removing a settlement token removes the settlement (it cascades to the token).
    if (tok.settlementId) await db.delete(settlements).where(eq(settlements.id, tok.settlementId));
    else await db.delete(tokens).where(eq(tokens.id, tok.id));
    await logEvent(db, { worldId: w.id, kind: 'token.removed', summary: `${cap(tok.kind)} "${tok.name}" removed`, payload: { token: tok } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- map art
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_ART_BYTES }, (_req, body, done) => done(null, body));

  /** Upload or replace the art under the grid. A new image starts covering the whole grid. */
  app.put('/api/worlds/:w/map/art', { bodyLimit: MAX_ART_BYTES }, async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Send the image file as the request body.');
    const info = imageSize(body);
    if (!info) throw badRequest('That file is not a PNG, JPEG, WebP or GIF image.');
    if (info.width < 64 || info.height < 64 || info.width > 16384 || info.height > 16384) throw badRequest('Images must be between 64 and 16384 pixels on each side.');
    const placement = coverPlacement(map.layout, info.width, info.height);
    const prev = await db.query.mapArt.findFirst({ where: eq(mapArt.mapId, map.id), columns: { version: true } });
    const values = { mime: info.mime, bytes: body, width: info.width, height: info.height, placement, updatedAt: new Date() };
    const [row] = await db.insert(mapArt).values({ mapId: map.id, ...values, version: 1 })
      .onConflictDoUpdate({ target: mapArt.mapId, set: { ...values, version: (prev?.version ?? 0) + 1 } })
      .returning(artMeta);
    await logEvent(db, { worldId: w.id, kind: 'map.art', summary: `${prev ? 'Replaced' : 'Added'} the map art (${info.width}×${info.height})`, payload: { version: row.version } });
    return row;
  });

  app.get('/api/worlds/:w/map/art', async (req, reply) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const art = await db.query.mapArt.findFirst({ where: eq(mapArt.mapId, map.id) });
    if (!art) throw notFound('Map art');
    const v = (req.query as { v?: string }).v;
    // Versioned URLs never change content, so the browser can keep them for good.
    reply.header('cache-control', v && Number(v) === art.version ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    reply.header('etag', `"art-${map.id}-${art.version}"`);
    return reply.type(art.mime).send(art.bytes);
  });

  const Placement = z.object({
    x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive(),
    opacity: z.number().min(0).max(1),
  }).partial();
  app.patch('/api/worlds/:w/map/art', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const art = await db.query.mapArt.findFirst({ where: eq(mapArt.mapId, map.id), columns: { placement: true, width: true, height: true } });
    if (!art) throw notFound('Map art');
    const body = req.body as { placement?: unknown; reset?: boolean };
    const placement = body.reset ? coverPlacement(map.layout, art.width, art.height) : { ...art.placement, ...Placement.parse(body.placement ?? {}) };
    const [row] = await db.update(mapArt).set({ placement, updatedAt: new Date() }).where(eq(mapArt.mapId, map.id)).returning(artMeta);
    return row;
  });

  app.delete('/api/worlds/:w/map/art', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const gone = await db.delete(mapArt).where(eq(mapArt.mapId, map.id)).returning({ v: mapArt.version });
    if (gone.length) await logEvent(db, { worldId: w.id, kind: 'map.art', summary: 'Removed the map art' });
    return { ok: true };
  });
}

export function modelRoutes(app: FastifyInstance, db: Db) {
  app.addContentTypeParser(['model/gltf-binary', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_MODEL_BYTES }, (_req, body, done) => done(null, body));

  /** Upload or replace the 3D terrain model (binary glTF). Large raw exports go through scripts/bake-model.mjs first. */
  app.put('/api/worlds/:w/map/model', { bodyLimit: MAX_MODEL_BYTES }, async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 20) throw badRequest('Send the .glb file as the request body.');
    if (body.readUInt32LE(0) !== 0x46546c67 || body.readUInt32LE(4) !== 2) throw badRequest('That file is not a binary glTF 2.0 (.glb) model.');
    const name = String((req.headers['x-file-name'] as string | undefined) ?? 'model.glb').slice(0, 200);
    const placement = fitModelPlacement(map.layout);
    const prev = await db.query.mapModel.findFirst({ where: eq(mapModel.mapId, map.id), columns: { version: true } });
    const values = { bytes: body, name, placement, updatedAt: new Date() };
    const [row] = await db.insert(mapModel).values({ mapId: map.id, ...values, version: 1 })
      .onConflictDoUpdate({ target: mapModel.mapId, set: { ...values, version: (prev?.version ?? 0) + 1 } })
      .returning(modelMeta);
    await logEvent(db, { worldId: w.id, kind: 'map.model', summary: `${prev ? 'Replaced' : 'Added'} the 3D terrain model (${(body.length / 1e6).toFixed(1)} MB)`, payload: { version: row.version } });
    return row;
  });

  app.get('/api/worlds/:w/map/model', async (req, reply) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const m = await db.query.mapModel.findFirst({ where: eq(mapModel.mapId, map.id) });
    if (!m) throw notFound('Model');
    const v = (req.query as { v?: string }).v;
    reply.header('cache-control', v && Number(v) === m.version ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    reply.header('etag', `"model-${map.id}-${m.version}"`);
    return reply.type('model/gltf-binary').send(m.bytes);
  });

  const MPlacement = z.object({
    x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive(),
    heightScale: z.number().min(0.05).max(10),
  }).partial();
  app.patch('/api/worlds/:w/map/model', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const m = await db.query.mapModel.findFirst({ where: eq(mapModel.mapId, map.id), columns: { placement: true } });
    if (!m) throw notFound('Model');
    const body = req.body as { placement?: unknown; reset?: boolean };
    const placement = body.reset ? fitModelPlacement(map.layout) : { ...m.placement, ...MPlacement.parse(body.placement ?? {}) };
    const [row] = await db.update(mapModel).set({ placement, updatedAt: new Date() }).where(eq(mapModel.mapId, map.id)).returning(modelMeta);
    return row;
  });

  app.delete('/api/worlds/:w/map/model', async (req) => {
    const w = await getWorld(db, (req.params as P).w);
    const map = await rootMap(db, w.id);
    const gone = await db.delete(mapModel).where(eq(mapModel.mapId, map.id)).returning({ v: mapModel.version });
    if (gone.length) await logEvent(db, { worldId: w.id, kind: 'map.model', summary: 'Removed the 3D terrain model' });
    return { ok: true };
  });
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
