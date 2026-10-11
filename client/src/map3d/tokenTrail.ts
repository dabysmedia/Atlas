type Point = { x: number; y: number };

/** Rounded, gently irregular ink strokes anchored to the actual visited hexes. */
export function trailStrokes(points: readonly Point[], seed: string): Point[][] {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const phase = (hash >>> 0) / 0xffffffff * Math.PI * 2;
  const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const tangent = (index: number): Point => {
    const p = points[index], before = points[index - 1] ?? p, after = points[index + 1] ?? p;
    const length = distance(before, after);
    // Limit corner handles so the display route stays close to the visited hexes.
    const reach = Math.min(index ? distance(before, p) : Infinity, index < points.length - 1 ? distance(p, after) : Infinity) * 0.3;
    return length > 0 ? { x: (after.x - before.x) / length * reach, y: (after.y - before.y) / length * reach } : { x: 0, y: 0 };
  };
  return points.slice(1).map((b, index) => {
    const a = points[index], length = distance(a, b), start = tangent(index), end = tangent(index + 1);
    const amplitude = Math.min(1.5, length * 0.018);
    return Array.from({ length: 25 }, (_, step) => {
      if (step === 0) return { ...a };
      if (step === 24) return { ...b };
      const t = step / 24, u = 1 - t;
      // The ink offset and its derivative vanish at each visit, keeping joins smooth.
      const wobble = amplitude * Math.sin(Math.PI * t) ** 2 * Math.sin(2 * Math.PI * t + phase);
      const x = u ** 3 * a.x + 3 * u ** 2 * t * (a.x + start.x) + 3 * u * t ** 2 * (b.x - end.x) + t ** 3 * b.x;
      const y = u ** 3 * a.y + 3 * u ** 2 * t * (a.y + start.y) + 3 * u * t ** 2 * (b.y - end.y) + t ** 3 * b.y;
      return { x: x - (length ? (b.y - a.y) / length * wobble : 0), y: y + (length ? (b.x - a.x) / length * wobble : 0) };
    });
  });
}
