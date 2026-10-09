import type { Daylight } from '../../shared/daylight';
import type { MeterBand } from '../../shared/meters';
export type { MeterBand };

export type TerrainType = { key: string; name: string; color: string; glyph?: string };
export type HexStateType = { key: string; name: string; color?: string };

export type WorldSummary = {
  id: string; name: string; description: string; accent: string; currentDay: number; updatedAt: string; createdAt: string;
  pageCount: number; factionCount: number; campaignCount: number; hexCount: number;
  terrainMix: { terrain: string; n: number }[]; terrainTypes: TerrainType[];
  artVersion: number | null;
};
export type World = {
  id: string; name: string; description: string; accent: string; currentDay: number;
  terrainTypes: TerrainType[]; hexStates: HexStateType[];
  daylight: Daylight;
};

export type PageIndex = { id: string; title: string; category: string; updatedAt: string };
export type Page = PageIndex & { content: unknown; contentText: string; backlinks: PageIndex[] };
export type SearchHit = PageIndex & { snippet: string; score: number };

export type Orientation = 'flat' | 'pointy';
export type MapLayout = { orientation: Orientation; cols: number; rows: number };
export type Hex = {
  id: string; q: number; r: number; terrain: string; state: string; name: string; notes: string;
  wikiPageId: string | null; data: Record<string, unknown>;
};
export type Claim = { id: string; hexId: string; factionId: string; kind: 'control' | 'contested' | 'influence'; sinceDay: number | null; note: string };
export type TokenKind = 'party' | 'city' | 'outpost' | 'unit' | 'character' | 'marker';
export type Token = {
  id: string; worldId: string; mapId: string; hexId: string | null; kind: TokenKind; name: string;
  factionId: string | null; campaignId: string | null; settlementId: string | null; color: string | null;
  icon: string | null; visibleToPlayers: boolean; data: Record<string, unknown>;
};
export type Settlement = {
  id: string; name: string; size: string; population: number | null; factionId: string | null; wikiPageId: string | null; notes: string;
};
export type FactionLite = { id: string; name: string; color: string };
export type CampaignLite = { id: string; name: string };
export type ArtPlacement = { x: number; y: number; w: number; h: number; opacity: number };
export type ModelPlacement = { x: number; y: number; w: number; h: number; heightScale: number };
/** The 3D terrain model under the grid. Purely visual: hexes stay the source of truth. */
export type MapModel = { version: number; name: string; placement: ModelPlacement; size: number; updatedAt: string };
export type MapArt = { version: number; width: number; height: number; mime: string; placement: ArtPlacement; updatedAt: string };
export type MapData = {
  map: { id: string; name: string; layout: MapLayout; art: MapArt | null; model: MapModel | null };
  hexes: Hex[]; claims: Claim[]; tokens: Token[]; settlements: Settlement[]; factions: FactionLite[]; campaigns: CampaignLite[];
};

export type MeterDef = {
  id: string; key: string; name: string; kind: 'core' | 'signature' | 'resource';
  min: number | null; max: number | null; defaultValue: number; bands: MeterBand[]; description: string; sortOrder: number;
};
export type FactionMeter = { meterId: string; value: number; isSet: boolean; updatedAt: string | null; band: MeterBand | null };
export type Faction = {
  id: string; name: string; color: string; sigil: string | null; description: string; signatureMeterId: string | null; wikiPageId: string | null;
  claims: Record<string, number>; meters: FactionMeter[];
};
export type MeterChange = {
  id: number; factionId: string; meterId: string; oldValue: number | null; newValue: number; cause: string; gameDay: number; source: string; createdAt: string;
};
export type RollEntry = { id: string; tableId: string; kind: 'event' | 'status' | 'calamity'; title: string; text: string; weight: number; approved: boolean; source: 'gm' | 'ai' };
export type RollTable = { id: string; name: string; factionId: string | null; meterId: string | null; band: string | null; entries: RollEntry[] };
export type Campaign = { id: string; name: string; system: string; status: string; notes: string; createdAt: string };
export type WorldEvent = {
  id: number; worldId: string; campaignId: string | null; gameDay: number; kind: string; summary: string;
  payload: Record<string, unknown>; actor: string; createdAt: string;
};
