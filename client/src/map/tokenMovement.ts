import { distance } from '../../../shared/hex';
import { isNotableKind } from '../../../shared/markers';
import type { Hex, Token } from '../types';
export function canMoveToken(token: Token, player: boolean, factionId?: string | null) {
  return !isNotableKind(token.kind) && (!player || token.visibleToPlayers && token.factionId === factionId);
}
export function tokenDestinations(token: Token, hexes: Hex[]): Set<string> {
  const from = hexes.find(h => h.id === token.hexId);
  return new Set(from ? hexes.filter(h => distance(from, h) === 1).map(h => h.id) : []);
}
