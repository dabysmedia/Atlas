import type { MapData } from '../types';
/** A settlement is the hex's primary designation; only settlements visible in the map response participate. */
export function settlementAtHex(data: Pick<MapData,'settlements'|'tokens'>, hexId: string) {
  const settlement=data.settlements.find(s=>s.hexIds.includes(hexId));
  if (!settlement) return undefined;
  const token=data.tokens.find(t=>t.settlementId===settlement.id);
  return token ? {settlement,token} : undefined;
}
