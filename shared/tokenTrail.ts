/** Recent display visits only; the persisted movement log stays complete. */
export function recentTokenTrail<T>(visits: readonly { hexId: string | null }[], resolve: (id: string) => T | undefined): { point: T; opacity: number }[] {
  const recent: T[] = [];
  // Stop at a repositioning/drawer break or a missing hex rather than drawing an invented route.
  for (let i = visits.length - 1; i >= 0 && recent.length < 5; i--) {
    const id = visits[i].hexId;
    const point = id ? resolve(id) : undefined;
    if (point === undefined) break;
    recent.push(point);
  }
  return recent.map((point, age) => ({ point, opacity: 0.85 * (1 - age / 4) })).reverse();
}
