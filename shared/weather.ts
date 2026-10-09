/**
 * Weather on a world: one kind of weather per in-game day, set by the DM or rolled. The world
 * stores the kind, whether each new day rolls fresh weather on its own, the day it was set for,
 * and when it changed, so every open map eases into the new sky together.
 *
 * `look` is what the 3D map draws, each value 0..1:
 * - cover: share of the sky under cloud
 * - dark: how grey the clouds are (0 white, 1 storm-black)
 * - rain: none to cloudburst
 * - lightning: how often it strikes
 * - fog: extra low fog and mist (1 is thick rolling fog)
 * - wind: still to gale (drives cloud drift, wave height and rain slant)
 * - sun: how much direct sun or moonlight gets through
 */
export type WeatherLook = { cover: number; dark: number; rain: number; lightning: number; fog: number; wind: number; sun: number };

export const WEATHER = {
  clear: { label: 'Clear', note: 'Open sky, sharp shadows', chance: 14, look: { cover: 0.06, dark: 0, rain: 0, lightning: 0, fog: 0, wind: 0.2, sun: 1 } },
  fair: { label: 'Fair', note: 'Scattered fair-weather cloud', chance: 26, look: { cover: 0.3, dark: 0.05, rain: 0, lightning: 0, fog: 0.05, wind: 0.3, sun: 0.95 } },
  overcast: { label: 'Overcast', note: 'A low grey lid, flat light', chance: 16, look: { cover: 0.93, dark: 0.35, rain: 0, lightning: 0, fog: 0.18, wind: 0.35, sun: 0.3 } },
  fog: { label: 'Thick fog', note: 'Fog rolls in off the sea', chance: 8, look: { cover: 0.7, dark: 0.2, rain: 0, lightning: 0, fog: 1, wind: 0.12, sun: 0.35 } },
  drizzle: { label: 'Drizzle', note: 'Fine rain from a grey sky', chance: 10, look: { cover: 0.9, dark: 0.42, rain: 0.25, lightning: 0, fog: 0.3, wind: 0.3, sun: 0.26 } },
  rain: { label: 'Rain', note: 'Steady rain', chance: 11, look: { cover: 0.96, dark: 0.58, rain: 0.55, lightning: 0, fog: 0.3, wind: 0.45, sun: 0.2 } },
  downpour: { label: 'Heavy rain', note: 'Sheets of rain, poor visibility', chance: 6, look: { cover: 1, dark: 0.72, rain: 0.85, lightning: 0.08, fog: 0.42, wind: 0.6, sun: 0.13 } },
  thunderstorm: { label: 'Thunderstorm', note: 'Lightning, driving rain, high seas', chance: 5, look: { cover: 1, dark: 0.92, rain: 0.95, lightning: 1, fog: 0.3, wind: 0.85, sun: 0.08 } },
  gale: { label: 'Gale', note: 'Howling wind, torn cloud, whitecaps', chance: 4, look: { cover: 0.62, dark: 0.4, rain: 0.04, lightning: 0, fog: 0.1, wind: 1, sun: 0.6 } },
} as const satisfies Record<string, { label: string; note: string; chance: number; look: WeatherLook }>;

export type WeatherKind = keyof typeof WEATHER;
export const WEATHER_KINDS = Object.keys(WEATHER) as WeatherKind[];

/** What a world stores. `auto`: roll fresh weather whenever a new day begins. */
export type Weather = { kind: WeatherKind; auto: boolean; day: number; at: string };

export const DEFAULT_WEATHER = (day: number): Weather => ({ kind: 'fair', auto: false, day, at: new Date().toISOString() });

export function weatherLook(kind: WeatherKind | string | null | undefined): WeatherLook {
  return (WEATHER as Record<string, { look: WeatherLook }>)[kind ?? '']?.look ?? WEATHER.fair.look;
}

/** Weather that tends to follow each kind, so a rolled week reads like real weather rather than noise. */
const NEAR: Record<WeatherKind, WeatherKind[]> = {
  clear: ['fair'],
  fair: ['clear', 'overcast', 'gale'],
  overcast: ['fair', 'drizzle', 'fog'],
  fog: ['overcast', 'drizzle', 'fair'],
  drizzle: ['overcast', 'rain', 'fog'],
  rain: ['drizzle', 'downpour', 'overcast'],
  downpour: ['rain', 'thunderstorm'],
  thunderstorm: ['downpour', 'rain', 'gale'],
  gale: ['fair', 'overcast', 'thunderstorm'],
};

/** Roll a day's weather: weighted by how common each kind is, leaning toward yesterday's. */
export function rollWeather(prev?: WeatherKind | null, rnd: () => number = Math.random): WeatherKind {
  const weights = WEATHER_KINDS.map((k) => WEATHER[k].chance * (!prev ? 1 : k === prev ? 2.2 : NEAR[prev]?.includes(k) ? 1.6 : 1));
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < WEATHER_KINDS.length; i++) {
    r -= weights[i];
    if (r < 0) return WEATHER_KINDS[i];
  }
  return WEATHER_KINDS[WEATHER_KINDS.length - 1];
}
