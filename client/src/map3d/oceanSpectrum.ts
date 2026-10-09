/**
 * The ocean's wave spectrum, built once on the CPU and evolved on the GPU (ocean.ts).
 *
 * A JONSWAP wind sea running with the cloud wind, plus a weak swell from off to one side, spread
 * about their headings by a cos^2s law that is narrow at the spectral peak and broad for short
 * waves, as measured at sea. The wavenumbers are split across a few square tiles ("cascades") of
 * incommensurate sizes: each owns one band, so no energy is counted twice, the long waves get a
 * big coarse tile and the ripples a small fine one, and no two tiles repeat in step. Amplitudes
 * come from a seeded generator, so the same sea comes back on every load.
 *
 * Two sea states share those random numbers: a fair day, and a gale whose waves are longer, higher
 * and shorter-crested. The GPU blends their amplitudes mode by mode as the wind rises, so the sea
 * builds smoothly from one to the other.
 *
 * Units are world units (a hex is 40 across) and seconds. Read with the close views in mind, a
 * world unit is about a metre: the fair sea reads as texture and glitter from the whole-island
 * view and as real waves at the coast.
 */

/** Gravity in world units per s²: a little above Earth's so the sea looks lively from the air. */
export const OCEAN_G = 15;
/** The wind's heading on the map (radians from +x toward +z): the clouds' drift (atmosphere.ts). */
export const WIND_ANGLE = Math.atan2(0.0014, 0.0032);
/** The wave height (uWaves) the gale spectrum stands for. */
export const GALE_WAVES = 2.2;

export type Cascade = {
  L: number; // tile size, world units
  kLo: number; kHi: number; // the band of wavenumbers this tile owns
  rot: number; // tile heading off the wind, radians: tiles of different cascades never line up
};
export type OceanSpec = {
  N: number;
  cascades: Cascade[];
  kp: number; // fair-day wind-sea peak wavenumber
  hs: number; // significant wave height of the fair sea
};

// Wind sea and swell: peak wavelength, significant height, peak enhancement, heading off the wind
// (radians) and the widest spreading exponent (higher is longer-crested).
type Sea = { lp: number; hs: number; gamma: number; dir: number; smax: number };
const FAIR: Sea[] = [
  { lp: 42, hs: 1.1, gamma: 3.3, dir: 0, smax: 9 },
  { lp: 125, hs: 0.38, gamma: 5, dir: 0.66, smax: 14 },
];
// 2.2 times the fair sea's height, on waves nearly twice as long and steeper.
const GALE: Sea[] = [
  { lp: 74, hs: 2.5, gamma: 3.3, dir: 0, smax: 5 },
  { lp: 150, hs: 0.55, gamma: 5, dir: 0.5, smax: 10 },
];

/**
 * Tile sizes. Each band edge sits about six fundamentals into the next, smaller tile (so its
 * directions are well sampled there) and below half the bigger tile's Nyquist (so its waves span
 * four texels or more there). Low quality halves the resolution and drops the finest tile; its
 * slope variance is carried as a constant instead.
 */
export function oceanSpec(low: boolean): OceanSpec {
  const kp = (2 * Math.PI) / FAIR[0].lp;
  const hs = Math.hypot(FAIR[0].hs, FAIR[1].hs);
  if (low) {
    const N = 128, L = [1013, 163.7];
    const k0 = 0.2;
    return { N, kp, hs, cascades: [{ L: L[0], kLo: 0, kHi: k0, rot: 0 }, { L: L[1], kLo: k0, kHi: (Math.PI * N) / L[1], rot: 0.29 }] };
  }
  const N = 256, L = [1500, 151.7, 17.3];
  const k0 = 0.25, k1 = 2.65;
  return {
    N, kp, hs,
    cascades: [
      { L: L[0], kLo: 0, kHi: k0, rot: 0 },
      { L: L[1], kLo: k0, kHi: k1, rot: 0.29 },
      { L: L[2], kLo: k1, kHi: (Math.PI * N) / L[2], rot: -0.37 },
    ],
  };
}

/**
 * How the sea state follows the wave height W (uWaves): below a fair day the fair spectrum calms,
 * the ripples first so the swell remains (the gain per wavenumber, relative to the fair peak kp);
 * from fair to gale the two spectra blend (t); past a gale the gale spectrum grows.
 * The GPU applies the same law (ocean.ts).
 */
export function seaMix(W: number) {
  const w = Math.max(W, 1e-3);
  return { t: Math.min(1, Math.max(0, (w - 1) / (GALE_WAVES - 1))), scale: Math.max(1, w / GALE_WAVES), calm: Math.min(1, w) };
}
/** The calming gain for wave height W < 1 at wavenumber k (1 for W ≥ 1). */
export function calmGain(k: number, kp: number, W: number) {
  if (W >= 1) return 1;
  const w = Math.max(W, 1e-3), r = Math.min(5, Math.max(0.2, k / kp));
  return w * r ** (0.65 * Math.log(w));
}

/** Γ(s+1)/Γ(s+½) by its asymptotic series: good to 1e-5 for the s ≥ 2 used here. */
const gammaRatio = (s: number) => Math.sqrt(s) * (1 + 1 / (8 * s) + 1 / (128 * s * s) - 5 / (1024 * s * s * s));

const jonswap = (w: number, wp: number, gamma: number) => {
  const sig = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) ** 2) / (2 * sig * sig * wp * wp));
  const q = (wp / w) ** 2;
  return (OCEAN_G * OCEAN_G) / w ** 5 * Math.exp(-1.25 * q * q) * (r > 1e-7 ? gamma ** r : 1);
};

/** A sea state ready to evaluate: each component's peak frequency and JONSWAP scale. */
function prepare(seas: Sea[]) {
  return seas.map((s) => {
    const wp = Math.sqrt((OCEAN_G * 2 * Math.PI) / s.lp);
    let m0 = 0;
    const n = 4000, w0 = wp * 0.3, w1 = wp * 40;
    for (let i = 0; i < n; i++) { const w = w0 + ((i + 0.5) / n) * (w1 - w0); m0 += jonswap(w, wp, s.gamma) * ((w1 - w0) / n); }
    return { ...s, wp, alpha: (s.hs / 4) ** 2 / m0 };
  });
}
const STATES = { fair: prepare(FAIR), gale: prepare(GALE) };
type State = keyof typeof STATES;

/**
 * Directional wavenumber spectrum Ψ(k, θ) with θ measured from the wind, so that ∫Ψ d²k is the
 * height variance. Mitsuyasu spreading: s peaks at the spectral peak and falls away on both sides,
 * held at 2 or more so short waves keep the upwind/crosswind slope ratio seen at sea.
 */
export function psi(k: number, theta: number, state: State = 'fair'): number {
  if (k <= 0) return 0;
  const w = Math.sqrt(OCEAN_G * k);
  const dwdk = OCEAN_G / (2 * w);
  const seas = STATES[state];
  let sum = 0;
  for (let i = 0; i < seas.length; i++) {
    const s = seas[i], wp = s.wp;
    if (i > 0 && w > wp * 4) continue; // a swell carries no chop of its own
    let S = s.alpha * jonswap(w, wp, s.gamma);
    if (i > 0) S *= Math.exp(-((w / (wp * 2.2)) ** 4));
    const sp = Math.max(2, s.smax * (w < wp ? (w / wp) ** 5 : (w / wp) ** -2.5));
    const Q = gammaRatio(sp) / (2 * Math.sqrt(Math.PI));
    const D = Q * Math.abs(Math.cos((theta - s.dir) / 2)) ** (2 * sp);
    sum += (S * dwdk * D) / k;
  }
  return sum;
}

/** Seeded uniform generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Band = { su2: number; sv2: number; m0: number; kSlope: number };

/**
 * Initial amplitudes for every cascade, stacked in one N×(N·cascades) RGBA float atlas per sea
 * state, in FFT order (index n is wavenumber n below N/2, n−N above). Each texel holds h0(k) and
 * conj(h0(−k)). The k axes are the tile's own: the tile lies at (wind + rot), so the wind blows
 * at −rot in it. Also returns each band's slope variance along and across the wind, and the
 * wavenumber its slopes are centred on.
 */
export function buildSpectrum(spec: OceanSpec, seed = 1777) {
  const { N, cascades } = spec;
  const out = { fair: new Float32Array(N * N * cascades.length * 4), gale: new Float32Array(N * N * cascades.length * 4) };
  const bands: Record<State, Band[]> = { fair: [], gale: [] };
  const xr = new Float32Array(N * N), xi = new Float32Array(N * N), amp = new Float32Array(N * N);
  cascades.forEach((c, ci) => {
    const rand = rng(seed + ci * 7919);
    const dk = (2 * Math.PI) / c.L;
    // Box–Muller; always drawn for every texel so the sequence doesn't depend on band edges.
    for (let i = 0; i < N * N; i++) {
      const u1 = Math.max(rand(), 1e-12), u2 = rand();
      const r = Math.sqrt(-2 * Math.log(u1));
      xr[i] = r * Math.cos(2 * Math.PI * u2); xi[i] = r * Math.sin(2 * Math.PI * u2);
    }
    for (const state of ['fair', 'gale'] as State[]) {
      let su2 = 0, sv2 = 0, m0 = 0, kw = 0;
      for (let m = 0; m < N; m++) for (let n = 0; n < N; n++) {
        const kx = (n < N / 2 ? n : n - N) * dk, kz = (m < N / 2 ? m : m - N) * dk;
        const k = Math.hypot(kx, kz);
        const i = m * N + n;
        if (k < c.kLo || k >= c.kHi || k === 0) { amp[i] = 0; continue; }
        const th = Math.atan2(kz, kx) + c.rot;
        const P = psi(k, th, state) * dk * dk;
        amp[i] = Math.sqrt(P) / 2;
        m0 += P;
        // Slope variance in the wind's frame: along (cos θ) and across (sin θ).
        su2 += P * (k * Math.cos(th)) ** 2; sv2 += P * (k * Math.sin(th)) ** 2;
        kw += P * k ** 3;
      }
      const data = out[state], base = ci * N * N * 4;
      for (let m = 0; m < N; m++) for (let n = 0; n < N; n++) {
        const i = m * N + n, j = ((N - m) % N) * N + ((N - n) % N), o = base + i * 4;
        data[o] = xr[i] * amp[i]; data[o + 1] = xi[i] * amp[i]; data[o + 2] = xr[j] * amp[j]; data[o + 3] = -xi[j] * amp[j];
      }
      bands[state].push({ su2, sv2, m0, kSlope: kw / Math.max(su2 + sv2, 1e-12) });
    }
  });
  return { data: out.fair, gale: out.gale, bands };
}

/**
 * Slope variance (along, across the wind) of waves too short for the finest tile: ripples down to
 * a few centimetres, which only ever show as the width of the sun's glitter.
 */
export function unresolvedSlopeVariance(kFrom: number, state: State = 'fair', kTo = 600) {
  let su2 = 0, sv2 = 0;
  const nk = 200, nt = 72;
  for (let i = 0; i < nk; i++) {
    const k0 = kFrom * (kTo / kFrom) ** (i / nk), k1 = kFrom * (kTo / kFrom) ** ((i + 1) / nk), k = (k0 + k1) / 2;
    for (let j = 0; j < nt; j++) {
      const th = -Math.PI + ((j + 0.5) / nt) * 2 * Math.PI;
      const P = psi(k, th, state) * k * (k1 - k0) * ((2 * Math.PI) / nt);
      su2 += P * (k * Math.cos(th)) ** 2; sv2 += P * (k * Math.sin(th)) ** 2;
    }
  }
  return [su2, sv2] as [number, number];
}

/**
 * The eight fields the GPU transforms (height, horizontal displacement x/z, slope x/z, and the
 * displacement's derivatives xx/zz/xz), at one texel of one cascade at time t, by direct sum over
 * every mode of a fair sea: a reference for checking the GPU FFT.
 */
export function directFields(spec: OceanSpec, data: Float32Array, ci: number, x: number, y: number, t: number) {
  const { N } = spec, c = spec.cascades[ci];
  const dk = (2 * Math.PI) / c.L;
  const out = new Float64Array(8);
  const base = ci * N * N * 4;
  for (let m = 0; m < N; m++) for (let n = 0; n < N; n++) {
    const o = base + (m * N + n) * 4;
    if (data[o] === 0 && data[o + 1] === 0 && data[o + 2] === 0 && data[o + 3] === 0) continue;
    const kx = (n < N / 2 ? n : n - N) * dk, kz = (m < N / 2 ? m : m - N) * dk;
    const k = Math.hypot(kx, kz);
    const w = Math.sqrt(OCEAN_G * k) * t;
    const cw = Math.cos(w), sw = Math.sin(w);
    // h = h0 e^{−iωt} + conj(h0(−k)) e^{iωt}
    const hr = data[o] * cw + data[o + 1] * sw + data[o + 2] * cw - data[o + 3] * sw;
    const hi = data[o + 1] * cw - data[o] * sw + data[o + 3] * cw + data[o + 2] * sw;
    const ph = (2 * Math.PI * (n * x + m * y)) / N;
    const er = Math.cos(ph), ei = Math.sin(ph);
    // Real part of F(k)·e^{ik·x} for each field's multiplier F/h.
    const re = (fr: number, fi: number) => (hr * fr - hi * fi) * er - (hr * fi + hi * fr) * ei;
    const ik = 1 / k;
    out[0] += re(1, 0);
    out[1] += re(0, kx * ik);
    out[2] += re(0, kz * ik);
    out[3] += re(0, kx);
    out[4] += re(0, kz);
    out[5] += re(-kx * kx * ik, 0);
    out[6] += re(-kz * kz * ik, 0);
    out[7] += re(-kx * kz * ik, 0);
  }
  return out;
}
