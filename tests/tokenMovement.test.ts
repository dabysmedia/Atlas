import { describe, it, expect } from 'vitest';
import { canMoveToken, tokenDestinations } from '../client/src/map/tokenMovement';
import type { Hex, Token } from '../client/src/types';
const token = { kind: 'unit', hexId: 'center', factionId: 'own', visibleToPlayers: true } as Token;
const hexes = [{ id: 'center', q: 0, r: 0 }, ...[[1,0],[0,1],[-1,1],[-1,0],[0,-1],[1,-1],[2,0]].map(([q,r], i) => ({ id: String(i), q, r }))] as Hex[];
describe('token movement affordances', () => {
  it('offers exactly the existing neighboring hexes, never distant cells or the current hex', () => {
    expect([...tokenDestinations(token, hexes)]).toEqual(['0','1','2','3','4','5']);
    expect([...tokenDestinations(token, hexes.slice(0,3))]).toEqual(['0','1']);
    expect(tokenDestinations({ ...token, hexId: null }, hexes).size).toBe(0);
  });
  it('keeps player movement restricted to their visible faction pieces', () => {
    expect(canMoveToken(token, false)).toBe(true);
    expect(canMoveToken(token, true, 'own')).toBe(true);
    expect(canMoveToken(token, true, 'other')).toBe(false);
    expect(canMoveToken({ ...token, visibleToPlayers: false }, true, 'own')).toBe(false);
    expect(canMoveToken({ ...token, kind: 'city' }, false)).toBe(false);
  });
});
