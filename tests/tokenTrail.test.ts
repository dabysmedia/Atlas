import { describe, it, expect } from 'vitest';
import { recentTokenTrail } from '../shared/tokenTrail';
const visits = (...ids: (string | null)[]) => ids.map(hexId => ({ hexId }));
const resolve = (id: string) => id === 'missing' ? undefined : id;
describe('recent token trail', () => {
  it('shows only the latest five visits with a continuous age fade without changing history', () => {
    const history = visits('a', 'b', 'c', 'd', 'e', 'f', 'g');
    const trail = recentTokenTrail(history, resolve);
    expect(trail.map(v => v.point)).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(trail.map(v => v.opacity)).toEqual([0, 0.2125, 0.425, 0.6375, 0.85]);
    expect(history).toHaveLength(7);
  });
  it('keeps ordered revisits and fades shorter trails by age', () => {
    expect(recentTokenTrail(visits('a', 'b', 'a'), resolve)).toEqual([
      { point: 'a', opacity: 0.425 }, { point: 'b', opacity: 0.6375 }, { point: 'a', opacity: 0.85 },
    ]);
  });
  it('does not connect across drawer/repositioning breaks or missing hexes', () => {
    expect(recentTokenTrail(visits('a', null, 'b', 'c'), resolve).map(v => v.point)).toEqual(['b', 'c']);
    expect(recentTokenTrail(visits('a', 'missing', 'c'), resolve).map(v => v.point)).toEqual(['c']);
    expect(recentTokenTrail(visits('a', null), resolve)).toEqual([]);
    expect(recentTokenTrail([], resolve)).toEqual([]);
  });
});
