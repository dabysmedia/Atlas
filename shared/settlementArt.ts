import { isSettlementKind } from './settlements.js';

export const SETTLEMENT_ART_STYLES = [
  { key: 'mendoza', label: 'Casa de Mendoza', aliases: ['mendoza'] },
  { key: 'dupont', label: 'Company DuPont', aliases: ['dupont'] },
  { key: 'qadir', label: 'The Qadir Ascendancy', aliases: ['qadir'] },
  { key: 'nhalkesh', label: 'The Nhal’Kesh', aliases: ['nhalkesh'] },
  { key: 'aelari', label: 'The Aelari', aliases: ['aelari', 'aldari'] },
  { key: 'canopy', label: 'Existing trees (Canopy People)', aliases: ['canopy'] },
  { key: 'flesh', label: 'The Flesh-Shapers', aliases: ['fleshshapers'] },
] as const;
export const SETTLEMENT_ART_KEYS = ['mendoza', 'dupont', 'qadir', 'nhalkesh', 'aelari', 'canopy', 'flesh', 'generic'] as const;
export type SettlementArtStyle = typeof SETTLEMENT_ART_KEYS[number];
export type SettlementArtFaction = { name: string; settlementArtStyle?: string | null };

/** Explicit architecture survives a faction rename. Null selects from the known lore names. */
export function settlementArtStyleFor(faction?: SettlementArtFaction | null): Exclude<SettlementArtStyle, 'generic'> | null {
  if (!faction || faction.settlementArtStyle === 'generic') return null;
  const explicit = SETTLEMENT_ART_STYLES.find(s => s.key === faction.settlementArtStyle);
  if (explicit) return explicit.key;
  const normalized = faction.name.normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');
  const matches = SETTLEMENT_ART_STYLES.filter(s => s.aliases.some(alias => normalized.includes(alias)));
  return matches.length === 1 ? matches[0].key : null;
}

export function settlementArtUrl(faction: SettlementArtFaction | null | undefined, kind: string) {
  const style = settlementArtStyleFor(faction);
  return style && style !== 'canopy' && isSettlementKind(kind) ? `/settlements/${style}/${kind}.webp` : null;
}

/** Canopy homes are already represented by the map's trees. Keep their hexes and inspection. */
export function settlementUsesExistingTrees(faction?: SettlementArtFaction | null) {
  return settlementArtStyleFor(faction) === 'canopy';
}
