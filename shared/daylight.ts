/**
 * Time of day on the 3D map. A world stores the hour at an instant and a speed; everyone computes
 * the current hour from that, so open tabs agree without polling. The day itself is the world clock
 * (worlds.current_day): when a running hour passes midnight the next day begins.
 */
export const DAY_SPEEDS = {
  paused: { label: 'Paused', hoursPerSecond: 0 },
  slow: { label: '1 day per 24 min', hoursPerSecond: 1 / 60 },
  brisk: { label: '1 day per 6 min', hoursPerSecond: 4 / 60 },
  fast: { label: '1 day per minute', hoursPerSecond: 24 / 60 },
} as const;
export type DaySpeed = keyof typeof DAY_SPEEDS;
export type Daylight = { hour: number; speed: DaySpeed; at: string };

export const DEFAULT_DAYLIGHT = (): Daylight => ({ hour: 10, speed: 'paused', at: new Date().toISOString() });

/** Hours since the anchor's midnight (may exceed 24 when a rollover is due). */
export function hoursNow(d: Daylight, now = Date.now()): number {
  const rate = DAY_SPEEDS[d.speed]?.hoursPerSecond ?? 0;
  return d.hour + Math.max(0, (now - Date.parse(d.at)) / 1000) * rate;
}
