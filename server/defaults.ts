import type { HexStateType, TerrainType } from './db/schema.js';
import type { MeterBand } from '../shared/meters.js';

export const DEFAULT_TERRAIN: TerrainType[] = [
  { key: 'unknown', name: 'Uncharted', color: '#2a2f38', glyph: 'none' },
  { key: 'plains', name: 'Plains', color: '#a8b46a', glyph: 'grass' },
  { key: 'forest', name: 'Forest', color: '#4f7a46', glyph: 'trees' },
  { key: 'hills', name: 'Hills', color: '#9c8a5a', glyph: 'hills' },
  { key: 'mountains', name: 'Mountains', color: '#7d7468', glyph: 'peaks' },
  { key: 'swamp', name: 'Swamp', color: '#5d6b4a', glyph: 'reeds' },
  { key: 'desert', name: 'Desert', color: '#d6bd7e', glyph: 'dunes' },
  { key: 'tundra', name: 'Tundra', color: '#c9d3d6', glyph: 'none' },
  { key: 'water', name: 'Lake / Sea', color: '#3f6f8f', glyph: 'waves' },
  { key: 'deep', name: 'Deep Ocean', color: '#24475f', glyph: 'waves' },
  { key: 'jungle', name: 'Jungle', color: '#2f6b3d', glyph: 'trees' },
  { key: 'wasteland', name: 'Wasteland', color: '#6e5a52', glyph: 'none' },
];

export const DEFAULT_HEX_STATES: HexStateType[] = [
  { key: 'wild', name: 'Wild' },
  { key: 'settled', name: 'Settled', color: '#e2c275' },
  { key: 'contested', name: 'Contested', color: '#d9822b' },
  { key: 'ruined', name: 'Ruined', color: '#8e7f74' },
  { key: 'blighted', name: 'Blighted', color: '#8a4fa3' },
];

/** Morale's five states come from the spec; the 0-100 scale and cut points are a default the GM can edit. */
export const MORALE_BANDS: MeterBand[] = [
  { label: 'Inspired', min: 80, tone: 'good' },
  { label: 'Stable', min: 60, tone: 'neutral' },
  { label: 'Strained', min: 40, tone: 'warn' },
  { label: 'Fractured', min: 20, tone: 'bad' },
  { label: 'Collapsing', min: 0, tone: 'dire' },
];

/** Placeholder band names for signature meters; each world's GM renames them per faction identity. */
export const SIGNATURE_BANDS: MeterBand[] = [
  { label: 'Ascendant', min: 80, tone: 'good' },
  { label: 'Steady', min: 50, tone: 'neutral' },
  { label: 'Eroding', min: 25, tone: 'warn' },
  { label: 'Broken', min: 0, tone: 'dire' },
];

