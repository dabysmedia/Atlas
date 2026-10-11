export type Interior = {
  id: string; worldId: string; hexId: string; name: string; mode: '2d' | '3d';
  cols: number; rows: number; entryX: number; entryY: number; visibleToPlayers: boolean;
  asset: { name: string; mime: string; version: number } | null;
};
export type InteriorPosition = { tokenId: string; worldId: string; interiorId: string; x: number; y: number; revision: number; updatedAt: string };
export type InteriorState = { interiors: Interior[]; positions: InteriorPosition[] };
export const interiorCell = (x: number, y: number, cols: number, rows: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < cols && y < rows;
