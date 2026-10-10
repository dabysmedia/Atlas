/**
 * Who may do what. The GM (the owner) sees and changes everything. A player sees the worlds of the campaigns they
 * belong to, through their party's fog (campaign_fog), and changes only a few things there: their party marker,
 * party notes on explored hexes, and wiki pages that aren't GM-only.
 *
 * Two halves, kept together so the HTTP routes and live sync (server/live.ts) apply the same rules:
 *  - ROUTE_ACCESS says, for every route under /api, whether players may call it at all. A 'gm' route refuses them
 *    here, before its handler runs; a 'player' route lets them in and its handler decides what they see or may
 *    change. Registering a route that isn't listed stops the server at boot, so a new route can't forget to say.
 *  - The filters below turn rows into what a player may see. Fogged hexes become blank "unknown" hexes (so the grid
 *    stays whole) and nothing on them (claims, markers, settlements) is sent; GM notes, hidden markers, GM-only
 *    pages and the simulation's numbers never leave the server.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { campaignFog, campaignMembers, campaigns, tokens, wikiPages } from './db/schema.js';

export type Access = 'gm' | 'player';

export const ROUTE_ACCESS: Record<string, Access> = {
  'GET /api/live': 'player',
  // worlds and the world clock (players' screens may only turn the day over at midnight, see POST .../day)
  'GET /api/worlds': 'player',
  'GET /api/worlds/:w': 'player',
  'POST /api/worlds': 'gm',
  'POST /api/worlds/reorder': 'gm',
  'PATCH /api/worlds/:w': 'gm',
  'DELETE /api/worlds/:w': 'gm',
  'PATCH /api/worlds/:w/daylight': 'gm',
  'PATCH /api/worlds/:w/weather': 'gm',
  'POST /api/worlds/:w/weather/roll': 'gm',
  'POST /api/worlds/:w/day': 'player',
  // wiki: players read and write pages that aren't GM-only; only the GM deletes or hides them
  'GET /api/worlds/:w/pages': 'player',
  'GET /api/worlds/:w/pages/:id': 'player',
  'GET /api/worlds/:w/search': 'player',
  'POST /api/worlds/:w/pages': 'player',
  'PATCH /api/worlds/:w/pages/:id': 'player',
  'DELETE /api/worlds/:w/pages/:id': 'gm',
  // map: players read it through their fog, write party notes and move their party marker
  'GET /api/worlds/:w/map': 'player',
  'PATCH /api/worlds/:w/hexes/:id': 'player',
  'POST /api/worlds/:w/hexes/paint': 'gm',
  'POST /api/worlds/:w/claims/control': 'gm',
  'POST /api/worlds/:w/claims': 'gm',
  'DELETE /api/worlds/:w/claims/:id': 'gm',
  'GET /api/worlds/:w/campaigns/:id/fog': 'player',
  'POST /api/worlds/:w/campaigns/:id/fog': 'gm',
  'POST /api/worlds/:w/tokens': 'gm',
  'PATCH /api/worlds/:w/tokens/:id': 'player',
  'DELETE /api/worlds/:w/tokens/:id': 'gm',
  // map art and the 3D model show the whole map, fog or not: the GM's alone
  'PUT /api/worlds/:w/map/art': 'gm',
  'GET /api/worlds/:w/map/art': 'gm',
  'PATCH /api/worlds/:w/map/art': 'gm',
  'DELETE /api/worlds/:w/map/art': 'gm',
  'PUT /api/worlds/:w/map/model': 'gm',
  'GET /api/worlds/:w/map/model': 'gm',
  'PATCH /api/worlds/:w/map/model': 'gm',
  'DELETE /api/worlds/:w/map/model': 'gm',
  'GET /api/worlds/:w/map/model/archive': 'gm',
  'POST /api/worlds/:w/map/model/archive/:id/restore': 'gm',
  // factions: players see names, colors and descriptions; meters, their history and roll tables are the GM's
  'GET /api/worlds/:w/factions': 'player',
  'POST /api/worlds/:w/factions': 'gm',
  'PATCH /api/worlds/:w/factions/:id': 'gm',
  'DELETE /api/worlds/:w/factions/:id': 'gm',
  'GET /api/worlds/:w/meters': 'player',
  'POST /api/worlds/:w/meters': 'gm',
  'PATCH /api/worlds/:w/meters/:id': 'gm',
  'DELETE /api/worlds/:w/meters/:id': 'gm',
  'POST /api/worlds/:w/factions/:id/meters/:m': 'gm',
  'GET /api/worlds/:w/factions/:id/meters/:m/history': 'gm',
  'GET /api/worlds/:w/roll-tables': 'gm',
  'POST /api/worlds/:w/roll-tables': 'gm',
  'PATCH /api/worlds/:w/roll-tables/:id': 'gm',
  'DELETE /api/worlds/:w/roll-tables/:id': 'gm',
  'POST /api/worlds/:w/roll-tables/:id/entries': 'gm',
  'PATCH /api/worlds/:w/roll-entries/:id': 'gm',
  'DELETE /api/worlds/:w/roll-entries/:id': 'gm',
  'POST /api/worlds/:w/roll-tables/:id/roll': 'gm',
  'GET /api/worlds/:w/campaigns': 'player',
  'POST /api/worlds/:w/campaigns': 'gm',
  'PATCH /api/worlds/:w/campaigns/:id': 'gm',
  'DELETE /api/worlds/:w/campaigns/:id': 'gm',
  'PATCH /api/worlds/:w/settlements/:id': 'gm',
  // chronicle: players read the entries about what they can see
  'GET /api/worlds/:w/events': 'player',
  'POST /api/worlds/:w/events': 'gm',
  // accounts: the GM manages players; everyone keeps their own name and password
  'GET /api/players': 'gm',
  'POST /api/players': 'gm',
  'PATCH /api/players/:id': 'gm',
  'POST /api/players/:id/password': 'gm',
  'PUT /api/players/:id/campaigns': 'gm',
  'DELETE /api/players/:id': 'gm',
  'PATCH /api/account': 'player',
  'POST /api/account/password': 'player',
};

/** A route as ROUTE_ACCESS and ROUTE_SCOPES name it (HEAD answers like GET). */
export const routeKey = (req: FastifyRequest) => `${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url}`;

/** A player's look at one world: the campaign they view it as, and (fetched on first use) what that party has explored. */
export type PlayerView = {
  userId: string;
  worldId: string;
  campaignId: string;
  /** Every campaign of theirs in this world, oldest first: the parties they can choose to view as. */
  campaigns: { id: string; name: string }[];
  revealed: () => Promise<Set<string>>;
  /** GM-only pages of the world, so links to them can be left out. */
  hiddenPages: () => Promise<Set<string>>;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for players on a world's routes; absent for the GM, who sees everything. */
    view?: PlayerView;
  }
}

const Id = z.uuid();
const once = <T>(f: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= f()); };

export const revealedHexes = async (db: Db, campaignId: string) =>
  new Set((await db.select({ id: campaignFog.hexId }).from(campaignFog).where(eq(campaignFog.campaignId, campaignId))).map((r) => r.id));
export const gmOnlyPages = async (db: Db, worldId: string) =>
  new Set((await db.select({ id: wikiPages.id }).from(wikiPages).where(and(eq(wikiPages.worldId, worldId), eq(wikiPages.gmOnly, true)))).map((r) => r.id));

/** A player's campaigns in a world, oldest first (none: the world isn't theirs to see). */
export const playerCampaigns = (db: Db, userId: string, worldId: string) =>
  db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns)
    .innerJoin(campaignMembers, eq(campaignMembers.campaignId, campaigns.id))
    .where(and(eq(campaignMembers.userId, userId), eq(campaigns.worldId, worldId)))
    .orderBy(asc(campaigns.createdAt), asc(campaigns.id));

/**
 * How a player sees a world: as the campaign they asked for (x-atlas-campaign) if it is theirs, else their first.
 * Null when they belong to no campaign there, which their screens show as "not found".
 */
export async function playerView(db: Db, userId: string, worldId: string, want?: string | null): Promise<PlayerView | null> {
  if (!Id.safeParse(worldId).success) return null;
  const mine = await playerCampaigns(db, userId, worldId);
  if (!mine.length) return null;
  const campaignId = (want && mine.find((c) => c.id === want)?.id) || mine[0].id;
  return {
    userId, worldId, campaignId, campaigns: mine,
    revealed: once(() => revealedHexes(db, campaignId)),
    hiddenPages: once(() => gmOnlyPages(db, worldId)),
  };
}

/**
 * The gate, registered in the signed-in /api scope before any route: every route must be listed in ROUTE_ACCESS
 * (checked at boot), players are refused the GM's routes, and on a world's routes a player gets their view of it,
 * or "not found" for a world that isn't theirs.
 */
export function accessGate(app: FastifyInstance, db: Db) {
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      if (!(`${m} ${r.url}` in ROUTE_ACCESS)) throw new Error(`Access: ${m} ${r.url} has no ROUTE_ACCESS entry`);
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user || req.user.role === 'gm') return;
    if (ROUTE_ACCESS[routeKey(req)] !== 'player') return reply.code(403).send({ error: 'Only the GM can do that.' });
    const w = (req.params as { w?: string }).w;
    if (w === undefined) return;
    const view = await playerView(db, req.user.id, w, req.headers['x-atlas-campaign'] as string | undefined);
    if (!view) return reply.code(404).send({ error: 'World not found' });
    req.view = view;
  });
}

// ---------------------------------------------------------------- what a player may see

type HexLike = { id: string; q: number; r: number; wikiPageId?: string | null };

/** A hex the party hasn't explored: its place on the grid and nothing else. */
export const foggedHex = (h: { id: string; q: number; r: number }) => ({
  id: h.id, q: h.q, r: h.r, terrain: 'unknown', state: 'wild', name: '', notes: '', partyNotes: '', wikiPageId: null, data: {}, fogged: true,
});

/** A hex as a player sees it: explored ones without GM notes or the simulation's data bag, the rest fogged. */
export function seenHex<H extends HexLike>(h: H, revealed: Set<string>, hidden: Set<string>) {
  if (!revealed.has(h.id)) return foggedHex(h);
  return { ...h, notes: '', data: {}, wikiPageId: h.wikiPageId && hidden.has(h.wikiPageId) ? null : h.wikiPageId ?? null };
}

/** Markers players see: shown to them, and standing on a hex their party has explored. */
export const tokenSeen = (t: { visibleToPlayers: boolean; hexId: string | null }, revealed: Set<string>) =>
  t.visibleToPlayers && !!t.hexId && revealed.has(t.hexId);
export const seenToken = <T extends object>(t: T) => ({ ...t, data: {} });
export const seenClaim = <C extends object>(c: C) => ({ ...c, note: '' });
export const seenSettlement = <S extends { wikiPageId: string | null }>(s: S, hidden: Set<string>) =>
  ({ ...s, notes: '', data: {}, wikiPageId: s.wikiPageId && hidden.has(s.wikiPageId) ? null : s.wikiPageId });

/** A player moves their party's marker: a party marker of their campaign (or of none). */
export const mayMoveToken = (t: { kind: string; campaignId: string | null }, campaignId: string) =>
  t.kind === 'party' && (t.campaignId === null || t.campaignId === campaignId);

/** Scopes only the GM's screens need (the client maps scopes onto its cache in client/src/live.ts). */
export const GM_SCOPES = new Set(['rolls', 'mh', 'meters', 'modelArchive', 'players']);

/**
 * Whether a chronicle entry is about things this player can see. The chronicle has no GM-only entries of its own,
 * but its lines name what they record (a fogged hex's terrain, a hidden marker, a GM-only page, a meter's value),
 * so a player reads the entries about what is visible to them and the rest stay the GM's. Unknown kinds stay
 * the GM's too, so a new kind of entry can't leak by default.
 */
export function eventSeen(e: { kind: string; campaignId: string | null; payload: unknown }, v: {
  campaignId: string; revealed: Set<string>; pages: Set<string>; tokens: Map<string, { visibleToPlayers: boolean; hexId: string | null }>;
}) {
  if (e.campaignId && e.campaignId !== v.campaignId) return false;
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : typeof x === 'string' ? [x] : []);
  const allSeen = (xs: string[]) => xs.length > 0 && xs.every((x) => v.revealed.has(x));
  switch (e.kind) {
    case 'note': case 'day.changed': case 'weather.changed': case 'world.renamed':
    case 'campaign.created': case 'faction.created': case 'faction.deleted':
    case 'fog.revealed': case 'fog.hidden':
      return true;
    case 'wiki.created': return typeof p.pageId === 'string' && v.pages.has(p.pageId);
    case 'hex.edited': return allSeen(ids(p.hexId));
    case 'hex.painted': return allSeen(ids(p.hexIds));
    case 'claim.changed': {
      const claim = p.claim as { hexId?: string } | undefined;
      return allSeen([...ids(p.hexIds), ...ids(p.hexId), ...ids(claim?.hexId)]);
    }
    case 'token.created': case 'token.moved': {
      const t = typeof p.tokenId === 'string' ? v.tokens.get(p.tokenId) : undefined;
      return !!t && t.visibleToPlayers && allSeen([...ids(p.hexId), ...ids(p.from), ...ids(p.to)]);
    }
    case 'token.removed': {
      const t = p.token as { visibleToPlayers?: boolean; hexId?: string | null } | undefined;
      return !!t?.visibleToPlayers && allSeen(ids(t.hexId));
    }
  }
  return false;
}

/** What eventSeen needs to know about a world, for one player's view of it. */
export async function eventContext(db: Db, view: PlayerView) {
  const [revealed, pages, toks] = await Promise.all([
    view.revealed(),
    db.select({ id: wikiPages.id }).from(wikiPages).where(and(eq(wikiPages.worldId, view.worldId), eq(wikiPages.gmOnly, false))),
    db.select({ id: tokens.id, visibleToPlayers: tokens.visibleToPlayers, hexId: tokens.hexId }).from(tokens).where(eq(tokens.worldId, view.worldId)),
  ]);
  return { campaignId: view.campaignId, revealed, pages: new Set(pages.map((p) => p.id)), tokens: new Map(toks.map((t) => [t.id, t])) };
}

/** Everything the live hub keeps per player socket to filter what it hears (see LiveHub.forPlayer). */
export type PlayerLive = {
  campaign: string;
  revealed: Set<string>;
  tokens: Map<string, { hexId: string | null; visibleToPlayers: boolean; kind: string; campaignId: string | null }>;
};

export async function playerLive(db: Db, userId: string, worldId: string, want: string | null): Promise<PlayerLive | null> {
  const view = await playerView(db, userId, worldId, want);
  if (!view) return null;
  const [revealed, toks] = await Promise.all([
    view.revealed(),
    db.select({ id: tokens.id, hexId: tokens.hexId, visibleToPlayers: tokens.visibleToPlayers, kind: tokens.kind, campaignId: tokens.campaignId })
      .from(tokens).where(eq(tokens.worldId, worldId)),
  ]);
  return { campaign: view.campaignId, revealed, tokens: new Map(toks.map(({ id, ...t }) => [id, t])) };
}

/** Members of campaigns (to restart their screens when a campaign goes away). */
export async function membersOf(db: Db, campaignIds: string[]) {
  if (!campaignIds.length) return [];
  const rows = await db.selectDistinct({ userId: campaignMembers.userId }).from(campaignMembers).where(inArray(campaignMembers.campaignId, campaignIds));
  return rows.map((r) => r.userId);
}
