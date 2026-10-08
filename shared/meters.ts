export type BandTone = 'good' | 'neutral' | 'warn' | 'bad' | 'dire';
/** A band starts at `min` and runs up to the next band's min. A value below every band falls in the lowest band. */
export type MeterBand = { label: string; min: number; tone: BandTone };

export function bandFor(bands: MeterBand[], value: number): MeterBand | undefined {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((b) => value >= b.min) ?? sorted[sorted.length - 1];
}

/** Low bands are the ones that trigger roll tables. */
export const isLowTone = (t: BandTone | undefined) => t === 'warn' || t === 'bad' || t === 'dire';
