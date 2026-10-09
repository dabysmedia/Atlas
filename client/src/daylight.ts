import { useEffect, useState } from 'react';
import { hoursNow, type Daylight } from '../../shared/daylight';

/** A manual day change on the clock: the 3D map answers by running the light once round the clock. */
const sweepSubs = new Set<() => void>();
export const daySweep = {
  emit() { sweepSubs.forEach((f) => f()); },
  subscribe(f: () => void) { sweepSubs.add(f); return () => { sweepSubs.delete(f); }; },
};

/** The current hour (0–24), refreshed often enough for a clock. */
export function useHour(d: Daylight | null | undefined, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!d || d.speed === 'paused') return;
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [d, everyMs]);
  void now;
  return d ? hoursNow(d) : 10;
}

export function formatHour(h: number) {
  const x = ((h % 24) + 24) % 24;
  const hh = Math.floor(x), mm = Math.floor((x - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
