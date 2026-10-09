/** The weather table: what a roll can give, how often, and how it leans on yesterday. */
import { describe, expect, it } from 'vitest';
import { WEATHER, WEATHER_KINDS, rollWeather, weatherLook, weatherSummary, type WeatherKind } from '../shared/weather';

/** A small seeded generator (mulberry32), so every run rolls the same weather. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tally(n: number, prev: WeatherKind | null, seed: number) {
  const rnd = seeded(seed);
  const counts = Object.fromEntries(WEATHER_KINDS.map((k) => [k, 0])) as Record<WeatherKind, number>;
  for (let i = 0; i < n; i++) counts[rollWeather(prev, rnd)]++;
  return counts;
}

const N = 40_000;
const total = WEATHER_KINDS.reduce((s, k) => s + WEATHER[k].chance, 0);

describe('rollWeather', () => {
  it('can give every kind, from any start', () => {
    for (const prev of [null, ...WEATHER_KINDS]) {
      const counts = tally(5_000, prev, 7);
      for (const k of WEATHER_KINDS) expect(counts[k], `${k} after ${prev}`).toBeGreaterThan(0);
    }
  });

  it('follows the table chances with no yesterday to lean on', () => {
    const counts = tally(N, null, 1234);
    for (const k of WEATHER_KINDS) {
      const want = WEATHER[k].chance / total;
      expect(Math.abs(counts[k] / N - want), k).toBeLessThan(0.012);
    }
    // Common weather is common and storms are rare.
    expect(counts.fair).toBeGreaterThan(counts.thunderstorm * 3);
  });

  it('leans toward yesterday and the weather that tends to follow it', () => {
    const base = tally(N, null, 99);
    for (const k of WEATHER_KINDS) {
      const after = tally(N, k, 99 + k.length);
      expect(after[k] / N, `${k} holds`).toBeGreaterThan((base[k] / N) * 1.3);
    }
    // Rain tends to follow drizzle more than it follows a clear day.
    expect(tally(N, 'drizzle', 5).rain).toBeGreaterThan(tally(N, 'clear', 5).rain * 1.3);
    // Yet the weather does move on: a fair day is never certain to stay fair.
    expect(tally(N, 'fair', 6).fair).toBeLessThan(N * 0.6);
  });

  it('maps the ends of the roll to the ends of the table', () => {
    expect(rollWeather(null, () => 0)).toBe(WEATHER_KINDS[0]);
    expect(rollWeather(null, () => 0.999999)).toBe(WEATHER_KINDS[WEATHER_KINDS.length - 1]);
    expect(WEATHER_KINDS).toContain(rollWeather('fog'));
  });
});

describe('weather words and looks', () => {
  it('tells the chronicle what happened', () => {
    expect(weatherSummary('thunderstorm', 'fair')).toBe('A thunderstorm rolls in');
    expect(weatherSummary('fog', 'clear')).toBe('Thick fog rolls in off the sea');
    expect(weatherSummary('clear', 'overcast')).toBe('The skies clear');
    expect(weatherSummary('fair', 'fog')).toBe('The fog lifts and the day turns fair');
    expect(weatherSummary('rain', 'rain')).toBe('The rain keeps falling');
    for (const to of WEATHER_KINDS) for (const from of [null, ...WEATHER_KINDS]) expect(weatherSummary(to, from)).toMatch(/^[A-Z].{8,}[a-z]$/);
  });

  it('falls back to fair for an unknown kind', () => {
    expect(weatherLook('thunderstorm').lightning).toBe(1);
    expect(weatherLook('blizzard')).toEqual(WEATHER.fair.look);
    expect(weatherLook(null)).toEqual(WEATHER.fair.look);
  });
});
