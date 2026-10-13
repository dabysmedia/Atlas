/** Prepopulated choices, not campaign locations or lore. */
export const TOKEN_KINDS = [
  { kind: 'city', label: 'City' }, { kind: 'town', label: 'Town' }, { kind: 'village', label: 'Village' },
  { kind: 'hamlet', label: 'Hamlet' }, { kind: 'metropolis', label: 'Metropolis' }, { kind: 'military_base', label: 'Military base' },
  { kind: 'outpost', label: 'Outpost' }, { kind: 'dungeon', label: 'Dungeon' }, { kind: 'ruins', label: 'Ruins' },
  { kind: 'fortress', label: 'Fortress' }, { kind: 'tower', label: 'Tower' }, { kind: 'temple', label: 'Temple' },
  { kind: 'cave', label: 'Cave' }, { kind: 'mine', label: 'Mine' }, { kind: 'camp', label: 'Camp' },
  { kind: 'port', label: 'Port' }, { kind: 'landmark', label: 'Landmark' },
  { kind: 'party', label: 'Party' }, { kind: 'unit', label: 'Unit' },
  { kind: 'character', label: 'Character' }, { kind: 'marker', label: 'Marker' },
] as const;
export type TokenKind = typeof TOKEN_KINDS[number]['kind'];
export const TOKEN_KIND_KEYS = TOKEN_KINDS.map(t => t.kind);
export const isNotableKind = (kind: TokenKind) => !['party', 'unit', 'character', 'marker'].includes(kind);
export const settlementSize = (kind: TokenKind) => ({ city: 'city', town: 'town', village: 'village', outpost: 'outpost', hamlet: 'village', metropolis: 'metropolis', military_base: 'village' } as Partial<Record<TokenKind, string>>)[kind];
export const isMajorCity = (token: { kind: TokenKind; data: Record<string, unknown> }) => token.kind === 'city' && token.data.majorCity === true;
