/** Authored presentation lives beside the canonical hex, never in generated map data. */
export const RESOURCE_KINDS = ['mineral', 'plant', 'wildlife', 'water', 'arcane', 'other'] as const;
export type HexResource = {
  id: string; name: string; kind: typeof RESOURCE_KINDS[number]; availability: string; notes: string;
};
export type HexPresentation = {
  hexId: string; heroId: string | null; heroFocus: number; lore: string;
  resources: HexResource[]; revision: number;
};
export const emptyHexPresentation = (hexId: string): HexPresentation => ({
  hexId, heroId: null, heroFocus: 50, lore: '', resources: [], revision: 0,
});
