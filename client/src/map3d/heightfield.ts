/**
 * A height grid over a world rectangle (world units = the 2D map's pixels; y is up in the 3D scene).
 * It is the single source for picking, token footing, label anchoring and the sea's depth, so all of
 * them agree with each other and with the terrain mesh drawn from (or rasterized into) it.
 */
import * as THREE from 'three';
import { HEX_SIZE, pixelToHex, hexToPixel, key, type Orientation } from '../../../shared/hex';

export const SEABED = -80;

export class HeightField {
  constructor(
    readonly minX: number, readonly minY: number, readonly w: number, readonly h: number,
    readonly nx: number, readonly ny: number, readonly data: Float32Array,
  ) {}
  maxH = 0;
  minH = 0;

  static empty(minX: number, minY: number, w: number, h: number, nx: number, ny: number) {
    return new HeightField(minX, minY, w, h, nx, ny, new Float32Array(nx * ny).fill(SEABED));
  }

  updateRange() {
    let lo = Infinity, hi = -Infinity;
    for (const v of this.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.minH = lo; this.maxH = hi;
    return this;
  }

  /** Bilinear height at a world point; the seabed outside the grid. */
  at(x: number, y: number): number {
    const fx = ((x - this.minX) / this.w) * (this.nx - 1), fy = ((y - this.minY) / this.h) * (this.ny - 1);
    if (fx < 0 || fy < 0 || fx > this.nx - 1 || fy > this.ny - 1) return SEABED;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(this.nx - 1, x0 + 1), y1 = Math.min(this.ny - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0, d = this.data, n = this.nx;
    const a = d[y0 * n + x0], b = d[y0 * n + x1], c = d[y1 * n + x0], e = d[y1 * n + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  /**
   * First hit of a ray with the surface max(terrain, sea). March in steps a fraction of a cell,
   * then bisect. Returns null when the ray never comes down to the land or sea.
   */
  raycast(o: THREE.Vector3, d: THREE.Vector3, sea: number): THREE.Vector3 | null {
    const top = Math.max(this.maxH, sea) + 1;
    let t = 0;
    if (o.y > top) { if (d.y >= 0) return null; t = (top - o.y) / d.y; }
    const surf = (tt: number) => {
      const x = o.x + d.x * tt, z = o.z + d.z * tt;
      return o.y + d.y * tt - Math.max(this.at(x, z), sea);
    };
    const cell = Math.min(this.w / this.nx, this.h / this.ny);
    const horiz = Math.hypot(d.x, d.z) || 1e-6;
    const step = Math.max(0.5, cell * 0.5) / Math.max(horiz, Math.abs(d.y) * 0.25);
    let prev = t, prevS = surf(t);
    if (prevS <= 0) return new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    for (let i = 0; i < 20000; i++) {
      const nt = prev + step;
      const s = surf(nt);
      if (s <= 0) {
        let a = prev, b = nt;
        for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (surf(m) > 0) a = m; else b = m; }
        return new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
      }
      if (o.y + d.y * nt < Math.min(this.minH, sea) - 1) break;
      prev = nt; prevS = s;
    }
    void prevS;
    return null;
  }

  /** A half-float single-channel texture of the grid, for shaders (the sea reads its depth from it). */
  texture(): THREE.DataTexture {
    const half = new Uint16Array(this.data.length);
    for (let i = 0; i < this.data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(this.data[i]);
    const t = new THREE.DataTexture(half, this.nx, this.ny, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }
}

/** Rasterize a mesh's top surface (world space) into a height field: the highest triangle wins. */
export function rasterizeMesh(geom: THREE.BufferGeometry, matrix: THREE.Matrix4, hf: HeightField) {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  const v = new THREE.Vector3();
  const n = pos.count;
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  const sx = (hf.nx - 1) / hf.w, sz = (hf.ny - 1) / hf.h;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    X[i] = (v.x - hf.minX) * sx; Y[i] = v.y; Z[i] = (v.z - hf.minY) * sz;
  }
  const tri = idx ? idx.count : n;
  const I = (k: number) => (idx ? idx.getX(k) : k);
  const N = hf.nx, M = hf.ny, D = hf.data;
  for (let t = 0; t < tri; t += 3) {
    const a = I(t), b = I(t + 1), c = I(t + 2);
    const ax = X[a], az = Z[a], bx = X[b], bz = Z[b], cx = X[c], cz = Z[c];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), x1 = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx)));
    const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), z1 = Math.min(M - 1, Math.floor(Math.max(az, bz, cz)));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * Y[a] + l2 * Y[b] + l3 * Y[c];
      const k = z * N + x;
      if (y > D[k]) D[k] = y;
    }
  }
  return hf.updateRange();
}

/** How high each terrain type stands when a world has no model: relief raised from the hexes. */
const RELIEF: Record<string, { h: number; rough: number }> = {
  deep: { h: -70, rough: 0 }, water: { h: -16, rough: 0 }, swamp: { h: 2, rough: 1 }, plains: { h: 7, rough: 2 },
  desert: { h: 9, rough: 4 }, tundra: { h: 8, rough: 3 }, wasteland: { h: 8, rough: 5 }, forest: { h: 12, rough: 4 },
  jungle: { h: 12, rough: 4 }, unknown: { h: 5, rough: 1 }, hills: { h: 48, rough: 16 }, mountains: { h: 125, rough: 55 },
};

/** Smooth relief from hex terrain: per-cell heights, blurred into slopes, with noise on rough ground. */
export function reliefFromHexes(hexes: { q: number; r: number; terrain: string }[], o: Orientation, bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  const pad = HEX_SIZE * 3;
  const minX = bounds.minX - pad, minY = bounds.minY - pad, w = bounds.maxX - bounds.minX + pad * 2, h = bounds.maxY - bounds.minY + pad * 2;
  const cell = Math.max(8, Math.sqrt((w * h) / 160_000));
  const nx = Math.round(w / cell) + 1, ny = Math.round(h / cell) + 1;
  const hf = HeightField.empty(minX, minY, w, h, nx, ny);
  const byKey = new Map(hexes.map((x) => [key(x.q, x.r), x]));
  const base = new Float32Array(nx * ny), rough = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = minX + (i / (nx - 1)) * w, y = minY + (j / (ny - 1)) * h;
    const a = pixelToHex(x, y, HEX_SIZE, o);
    const hx = byKey.get(key(a.q, a.r));
    const r = RELIEF[hx?.terrain ?? 'deep'] ?? RELIEF.unknown;
    base[j * nx + i] = r.h; rough[j * nx + i] = r.rough;
  }
  const blur = (src: Float32Array, rad: number) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, c = 0;
      for (let k = -rad; k <= rad; k++) { const ii = i + k; if (ii >= 0 && ii < nx) { s += src[j * nx + ii]; c++; } }
      tmp[j * nx + i] = s / c;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, c = 0;
      for (let k = -rad; k <= rad; k++) { const jj = j + k; if (jj >= 0 && jj < ny) { s += tmp[jj * nx + i]; c++; } }
      out[j * nx + i] = s / c;
    }
    return out;
  };
  const r0 = Math.max(1, Math.round((HEX_SIZE * 0.55) / cell));
  const smooth = blur(blur(base, r0), r0);
  const rs = blur(rough, r0);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = minX + (i / (nx - 1)) * w, y = minY + (j / (ny - 1)) * h;
    const k = j * nx + i;
    hf.data[k] = smooth[k] + rs[k] * ridgeNoise(x / (HEX_SIZE * 1.6), y / (HEX_SIZE * 1.6));
  }
  void hexToPixel;
  return hf.updateRange();
}

// Small, dependency-free value noise with ridges, for mountain texture on generated relief.
function hash(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function ridgeNoise(x: number, y: number) {
  let s = 0, amp = 0.6, f = 1;
  for (let o = 0; o < 4; o++) { s += amp * (1 - Math.abs(vnoise(x * f, y * f) * 2 - 1)); amp *= 0.5; f *= 2.1; }
  return s - 0.55;
}
