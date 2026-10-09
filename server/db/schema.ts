/**
 * Campaign Atlas data model.
 *
 * Everything below a world is scoped by world_id and cascades on world delete,
 * so two worlds never share a row. Values the future simulation will consume
 * (hexes, claims, meters, tokens, settlements, events) are plain rows the GM can
 * read and hand-edit; nothing is derived-only except faction borders, which are
 * computed from control claims at render time.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, integer, timestamp, jsonb, boolean, real,
  uniqueIndex, index, primaryKey, bigserial, customType, check,
} from 'drizzle-orm/pg-core';
import type { MeterBand } from '../../shared/meters.js';

export type { MeterBand };

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const id = () => uuid('id').primaryKey().defaultRandom();
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const worldRef = () => uuid('world_id').notNull().references(() => worlds.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------- auth
export const users = pgTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: created(),
});

export const sessions = pgTable('sessions', {
  // sha256 of the cookie token; the raw token never touches the database
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: created(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------- worlds
export type TerrainType = { key: string; name: string; color: string; glyph?: string };
export type HexStateType = { key: string; name: string; color?: string };

export const worlds = pgTable('worlds', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** World clock in in-game days. Meter changes and events stamp this. */
  currentDay: integer('current_day').notNull().default(1),
  /** Per-world palettes so a GM can tailor terrain and hex states without migrations. */
  terrainTypes: jsonb('terrain_types').$type<TerrainType[]>().notNull(),
  hexStates: jsonb('hex_states').$type<HexStateType[]>().notNull(),
  accent: text('accent').notNull().default('#c8a24a'),
  /** Time of day on the 3D map: the hour (0-24) at an instant, and how fast it runs (see shared/daylight.ts). */
  daylight: jsonb('daylight').$type<{ hour: number; speed: string; at: string }>(),
  /** Which bundled demo produced this world, if any (lets a later release upgrade an untouched demo). */
  demo: text('demo'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

export const campaigns = pgTable('campaigns', {
  id: id(),
  worldId: worldRef(),
  name: text('name').notNull(),
  system: text('system').notNull().default(''),
  status: text('status').notNull().default('active'), // active | paused | finished
  notes: text('notes').notNull().default(''),
  createdAt: created(),
}, (t) => [index('campaigns_world_idx').on(t.worldId)]);

// ---------------------------------------------------------------- wiki
export const wikiPages = pgTable('wiki_pages', {
  id: id(),
  worldId: worldRef(),
  title: text('title').notNull(),
  category: text('category').notNull().default('Lore'),
  /** ProseMirror JSON document. */
  content: jsonb('content').notNull().default({ type: 'doc', content: [] }),
  /** Plain text extracted from content, for search and previews. */
  contentText: text('content_text').notNull().default(''),
  search: tsvector('search').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')`,
  ),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index('wiki_world_idx').on(t.worldId),
  uniqueIndex('wiki_world_title_uq').on(t.worldId, sql`lower(${t.title})`),
  index('wiki_search_idx').using('gin', t.search),
  index('wiki_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
]);

/** Outgoing links, rebuilt on every save, used for backlinks. */
export const wikiLinks = pgTable('wiki_links', {
  fromPageId: uuid('from_page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
  toPageId: uuid('to_page_id').notNull().references(() => wikiPages.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.fromPageId, t.toPageId] }), index('wiki_links_to_idx').on(t.toPageId)]);

// ---------------------------------------------------------------- maps & hexes
export type MapLayout = { orientation: 'flat' | 'pointy'; cols: number; rows: number };

/**
 * A hex map. A world has one root map today (parent_hex_id null). Later zoom
 * levels (inside-a-hex, boots-on-the-ground) hang child maps off a hex here.
 */
export const maps = pgTable('maps', {
  id: id(),
  worldId: worldRef(),
  name: text('name').notNull(),
  layout: jsonb('layout').$type<MapLayout>().notNull(),
  parentHexId: uuid('parent_hex_id'),
  createdAt: created(),
}, (t) => [index('maps_world_idx').on(t.worldId)]);

/** Where the art sits under the grid, in map world units (hex circumradius = 40). */
export type ArtPlacement = { x: number; y: number; w: number; h: number; opacity: number };

/**
 * Painted art under a map's hex grid. Stored in Postgres so it survives redeploys
 * without a volume; `version` busts caches when the image is replaced.
 */
export const mapArt = pgTable('map_art', {
  mapId: uuid('map_id').primaryKey().references(() => maps.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  bytes: bytea('bytes').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  placement: jsonb('placement').$type<ArtPlacement>().notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: updated(),
});

/** Where a 3D model sits: its footprint (x and z in -1..1) maps onto this world rectangle; height scales with it. */
export type ModelPlacement = { x: number; y: number; w: number; h: number; heightScale: number };
/** A 3D terrain model under the grid (web-weight GLB). Purely visual: hexes stay the source of truth. */
export const mapModel = pgTable('map_model', {
  mapId: uuid('map_id').primaryKey().references(() => maps.id, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
  name: text('name').notNull().default('model.glb'),
  placement: jsonb('placement').$type<ModelPlacement>().notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: updated(),
});

/**
 * Models taken off a map: removed or replaced models land here instead of being deleted, so one
 * removed by accident can be put back. Each keeps the version it had, so restoring never reuses one.
 */
export const mapModelArchive = pgTable('map_model_archive', {
  id: id(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
  name: text('name').notNull(),
  placement: jsonb('placement').$type<ModelPlacement>().notNull(),
  version: integer('version').notNull(),
  reason: text('reason').notNull(), // 'removed' | 'replaced'
  archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('map_model_archive_map_idx').on(t.mapId)]);

/**
 * Every hex on a map is a row (dense), keyed by axial coordinates.
 * Controlling faction lives in `claims`; fog lives in `campaign_fog`.
 */
export const hexes = pgTable('hexes', {
  id: id(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  q: integer('q').notNull(),
  r: integer('r').notNull(),
  terrain: text('terrain').notNull().default('unknown'),
  state: text('state').notNull().default('wild'),
  name: text('name').notNull().default(''),
  notes: text('notes').notNull().default(''),
  wikiPageId: uuid('wiki_page_id').references(() => wikiPages.id, { onDelete: 'set null' }),
  /** Free-form bag for values the simulation will want (resources, danger, weather). */
  data: jsonb('data').notNull().default({}),
  updatedAt: updated(),
}, (t) => [uniqueIndex('hexes_map_qr_uq').on(t.mapId, t.q, t.r)]);

/** Party fog, shared by everyone in a campaign. Absence of a row = unexplored. */
export const campaignFog = pgTable('campaign_fog', {
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  hexId: uuid('hex_id').notNull().references(() => hexes.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('explored'), // explored (room for 'rumored', 'visible')
  sinceDay: integer('since_day'),
}, (t) => [primaryKey({ columns: [t.campaignId, t.hexId] })]);

// ---------------------------------------------------------------- factions & meters
export const factions = pgTable('factions', {
  id: id(),
  worldId: worldRef(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#8a6d3b'),
  description: text('description').notNull().default(''),
  /** Emblem key from the client's small sigil set (null shows the plain diamond). */
  sigil: text('sigil'),
  /** Exactly one signature meter per faction (null until the GM picks one). */
  signatureMeterId: uuid('signature_meter_id').references(() => meterDefinitions.id, { onDelete: 'set null' }),
  wikiPageId: uuid('wiki_page_id').references(() => wikiPages.id, { onDelete: 'set null' }),
  createdAt: created(),
}, (t) => [index('factions_world_idx').on(t.worldId)]);


/**
 * Meter definitions are per world.
 *  - core: applies to every faction (Morale)
 *  - resource: applies to every faction, usually unbounded (Treasury)
 *  - signature: applies only to the factions that pick it as their signature
 */
export const meterDefinitions = pgTable('meter_definitions', {
  id: id(),
  worldId: worldRef(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // core | signature | resource
  min: real('min'),
  max: real('max'),
  defaultValue: real('default_value').notNull().default(0),
  bands: jsonb('bands').$type<MeterBand[]>().notNull().default([]),
  description: text('description').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [
  uniqueIndex('meter_def_world_key_uq').on(t.worldId, t.key),
  check('meter_kind_ck', sql`${t.kind} in ('core','signature','resource')`),
]);

export const meterValues = pgTable('meter_values', {
  factionId: uuid('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
  meterId: uuid('meter_id').notNull().references(() => meterDefinitions.id, { onDelete: 'cascade' }),
  value: real('value').notNull(),
  updatedAt: updated(),
}, (t) => [primaryKey({ columns: [t.factionId, t.meterId] })]);

/** Append-only: every meter change with cause and in-game day. */
export const meterChanges = pgTable('meter_changes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  worldId: worldRef(),
  factionId: uuid('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
  meterId: uuid('meter_id').notNull().references(() => meterDefinitions.id, { onDelete: 'cascade' }),
  oldValue: real('old_value'),
  newValue: real('new_value').notNull(),
  cause: text('cause').notNull(),
  gameDay: integer('game_day').notNull(),
  source: text('source').notNull().default('gm'), // gm | sim | cascade
  createdAt: created(),
}, (t) => [index('meter_changes_faction_idx').on(t.factionId, t.meterId, t.id)]);

/**
 * Faction claims over hexes. One 'control' claim per hex decides its controlling
 * faction (and so its border); other kinds are recorded but don't paint borders.
 */
export const claims = pgTable('claims', {
  id: id(),
  hexId: uuid('hex_id').notNull().references(() => hexes.id, { onDelete: 'cascade' }),
  factionId: uuid('faction_id').notNull().references(() => factions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('control'), // control | contested | influence
  sinceDay: integer('since_day'),
  note: text('note').notNull().default(''),
}, (t) => [
  uniqueIndex('claims_one_control_uq').on(t.hexId).where(sql`${t.kind} = 'control'`),
  uniqueIndex('claims_hex_faction_kind_uq').on(t.hexId, t.factionId, t.kind),
  index('claims_faction_idx').on(t.factionId),
]);

// ---------------------------------------------------------------- tokens & settlements
/**
 * Anything with a position on a hex. City/outpost tokens point at a settlement
 * row that holds the place's details.
 */
export const tokens = pgTable('tokens', {
  id: id(),
  worldId: worldRef(),
  mapId: uuid('map_id').notNull().references(() => maps.id, { onDelete: 'cascade' }),
  hexId: uuid('hex_id').references(() => hexes.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(), // party | city | outpost | unit | character | marker
  name: text('name').notNull(),
  factionId: uuid('faction_id').references(() => factions.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  settlementId: uuid('settlement_id').references(() => settlements.id, { onDelete: 'cascade' }),
  color: text('color'),
  icon: text('icon'),
  visibleToPlayers: boolean('visible_to_players').notNull().default(true),
  data: jsonb('data').notNull().default({}),
  updatedAt: updated(),
}, (t) => [index('tokens_map_idx').on(t.mapId)]);

export const settlements = pgTable('settlements', {
  id: id(),
  worldId: worldRef(),
  name: text('name').notNull(),
  size: text('size').notNull().default('town'), // hamlet | village | town | city | metropolis | outpost
  population: integer('population'),
  factionId: uuid('faction_id').references(() => factions.id, { onDelete: 'set null' }),
  wikiPageId: uuid('wiki_page_id').references(() => wikiPages.id, { onDelete: 'set null' }),
  notes: text('notes').notNull().default(''),
  data: jsonb('data').notNull().default({}),
  createdAt: created(),
}, (t) => [index('settlements_world_idx').on(t.worldId)]);

// ---------------------------------------------------------------- roll tables
/** A faction's table for a meter band (e.g. Morale: Fractured). */
export const rollTables = pgTable('roll_tables', {
  id: id(),
  worldId: worldRef(),
  factionId: uuid('faction_id').references(() => factions.id, { onDelete: 'cascade' }),
  meterId: uuid('meter_id').references(() => meterDefinitions.id, { onDelete: 'cascade' }),
  band: text('band'),
  name: text('name').notNull(),
  createdAt: created(),
}, (t) => [index('roll_tables_world_idx').on(t.worldId)]);

export const rollTableEntries = pgTable('roll_table_entries', {
  id: id(),
  tableId: uuid('table_id').notNull().references(() => rollTables.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('event'), // event | status | calamity
  title: text('title').notNull(),
  text: text('text').notNull().default(''),
  weight: integer('weight').notNull().default(1),
  /** GM-seeded entries are canon; AI drafts stay false until a GM approves them. */
  approved: boolean('approved').notNull().default(true),
  source: text('source').notNull().default('gm'), // gm | ai
  createdAt: created(),
}, (t) => [
  index('roll_entries_table_idx').on(t.tableId),
  check('roll_entry_weight_ck', sql`${t.weight} > 0`),
]);

// ---------------------------------------------------------------- history
/** Append-only world chronicle. A trigger rejects UPDATE and direct DELETE. */
export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  worldId: worldRef(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  gameDay: integer('game_day').notNull(),
  kind: text('kind').notNull(), // e.g. hex.edited, claim.changed, meter.changed, token.moved, note
  summary: text('summary').notNull(),
  payload: jsonb('payload').notNull().default({}),
  actor: text('actor').notNull().default('gm'), // gm | sim | system
  createdAt: created(),
}, (t) => [index('events_world_idx').on(t.worldId, t.id)]);

/** Install-wide markers, e.g. which one-time seeds have already run (so deleting a seeded world doesn't bring it back). */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: updated(),
});
