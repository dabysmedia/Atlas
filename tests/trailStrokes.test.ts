import { expect, it } from 'vitest';
import { trailStrokes } from '../client/src/map3d/tokenTrail';

it('rounds turns with matching directions while staying anchored to visits', () => {
  const points = [{ x:0,y:0 },{ x:80,y:0 },{ x:80,y:80 }];
  const strokes = trailStrokes(points, 'scout');
  expect(strokes[0][0]).toEqual(points[0]);
  expect(strokes[0].at(-1)).toEqual(points[1]);
  expect(strokes[1][0]).toEqual(points[1]);
  expect(strokes[1].at(-1)).toEqual(points[2]);
  const before = strokes[0].at(-2)!, after = strokes[1][1];
  const incoming = { x:80-before.x,y:-before.y }, outgoing = { x:after.x-80,y:after.y };
  const alignment = (incoming.x*outgoing.x+incoming.y*outgoing.y) / (Math.hypot(incoming.x,incoming.y)*Math.hypot(outgoing.x,outgoing.y));
  expect(alignment).toBeGreaterThan(0.98);
  expect(points).toEqual([{ x:0,y:0 },{ x:80,y:0 },{ x:80,y:80 }]);
});

it('adds restrained, deterministic irregularity to straight runs', () => {
  const points = [{ x:0,y:0 },{ x:80,y:0 },{ x:160,y:0 }];
  const strokes = trailStrokes(points, 'scout');
  expect(strokes).toEqual(trailStrokes(points, 'scout'));
  expect(strokes).not.toEqual(trailStrokes(points, 'party'));
  expect(strokes.flat().some(p=>Math.abs(p.y)>0.3)).toBe(true);
  expect(strokes.flat().every(p=>Math.abs(p.y)<=1.5)).toBe(true);
});

it('handles backtracking and repeated visits without invalid coordinates', () => {
  expect(trailStrokes([], 'scout')).toEqual([]);
  const strokes = trailStrokes([{ x:0,y:0 },{ x:80,y:0 },{ x:0,y:0 },{ x:0,y:0 }], 'scout');
  expect(strokes.flat().every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
});
