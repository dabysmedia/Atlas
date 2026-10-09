/**
 * The sea's waves, simulated on the GPU the way film and games do it (Tessendorf): each frame the
 * spectrum of every cascade (oceanSpectrum.ts) is advanced to the current time, turned back into a
 * surface by an inverse FFT, and assembled into two mipmapped textures that the sea samples:
 *
 *   displacement + foam: (dx, height, dz, foam)
 *   slopes + moments:    (su, sv, su², sv²), in the wind's frame
 *
 * The second is LEAN mapping: averaging slopes and squared slopes together (as mipmapping does)
 * keeps the variance of the waves a pixel can't show, which is what widens the sun's glitter from
 * far away. Whitecaps start where the surface folds over (its Jacobian drops toward zero) and the
 * foam carries over from frame to frame, fading, so it lingers behind the crests that made it.
 *
 * The FFT is Stockham radix-2 with twiddles worked out in the shader, as in David Li's WebGL ocean:
 * log2 N horizontal then log2 N vertical passes between two float targets. All cascades share one
 * atlas, stacked by rows, so each pass covers every cascade at once and draws only the rows of the
 * cascades in use. Each texel carries four complex numbers over two attachments: eight real fields
 * (height, displacement x/z, slope x/z, and the displacement's derivatives xx/zz/xz), packed two to
 * a complex transform.
 */
import * as THREE from 'three';
import { OCEAN_G, buildSpectrum, calmGain, directFields, oceanSpec, seaMix, unresolvedSlopeVariance, type Band, type OceanSpec } from './oceanSpectrum';

export type SeaState = { uWaves: THREE.IUniform<number>; uChop: THREE.IUniform<number>; uFoamAmt: THREE.IUniform<number> };

const HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 mulI(vec2 a) { return vec2(-a.y, a.x); }
`;

// One triangle over the target's bottom rows: uRows of its height.
const VERT = /* glsl */`
in vec3 position;
uniform float uRows;
void main() { gl_Position = vec4(position.x, -1.0 + (position.y + 1.0) * uRows, 0.0, 1.0); }
`;

/** Tessendorf's choppiness factor for the weather's chop setting (0..1); 1 at the default 0.5. */
export const CHOP_GLSL = 'float chopK(float c) { return 0.35 + 1.3 * c; }';

const EVOLVE = HEAD + /* glsl */`
uniform sampler2D uH0, uH0g;
uniform int uN;
uniform vec4 uDk;
uniform float uTime, uKp;
uniform vec3 uMix; // seaMix() in oceanSpectrum.ts: fair→gale blend, growth past a gale, calm below fair
// calmGain() in oceanSpectrum.ts: a dying wind takes the ripples first and leaves the swell.
float calmGain(float k) {
  if (uMix.z >= 1.0) return 1.0;
  float r = clamp(k / uKp, 0.2, 5.0);
  return uMix.z * pow(r, 0.65 * log(uMix.z));
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int c = px.y / uN;
  int n = px.x, m = px.y - c * uN;
  vec2 k = vec2(float(n < uN / 2 ? n : n - uN), float(m < uN / 2 ? m : m - uN)) * uDk[c];
  float kl = length(k);
  // Fair and gale amplitudes share their random numbers, so blending them builds one sea into the other.
  vec4 h0 = mix(texelFetch(uH0, px, 0), texelFetch(uH0g, px, 0), uMix.x) * uMix.y;
  // Phase kept in [0, 2π) before sin/cos, which some GPUs evaluate poorly for big arguments.
  float ph = 6.28318530718 * fract(sqrt(${OCEAN_G.toFixed(1)} * kl) / 6.28318530718 * uTime);
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = (cmul(h0.xy, vec2(e.x, -e.y)) + cmul(h0.zw, e)) * calmGain(kl);
  float ik = kl > 0.0 ? 1.0 / kl : 0.0;
  vec2 ih = mulI(h);
  vec2 dx = ih * (k.x * ik), dz = ih * (k.y * ik), sx = ih * k.x, sz = ih * k.y;
  vec2 dxx = -h * (k.x * k.x * ik), dzz = -h * (k.y * k.y * ik), dxz = -h * (k.x * k.y * ik);
  o0 = vec4(h + mulI(dx), dz + mulI(sx));
  o1 = vec4(sz + mulI(dxx), dzz + mulI(dxz));
}`;

const FFT = HEAD + /* glsl */`
uniform sampler2D uIn0, uIn1;
uniform int uN, uSub;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  #ifdef HORIZONTAL
    int i = px.x;
  #else
    int i = px.y % uN;
    int base = px.y - i;
  #endif
  int half_ = uSub / 2;
  int e = (i / uSub) * half_ + i % half_;
  int o = e + uN / 2;
  #ifdef HORIZONTAL
    ivec2 pe = ivec2(e, px.y), po = ivec2(o, px.y);
  #else
    ivec2 pe = ivec2(px.x, base + e), po = ivec2(px.x, base + o);
  #endif
  float a = 6.28318530718 * float(i % uSub) / float(uSub);
  vec2 w = vec2(cos(a), sin(a));
  vec4 E = texelFetch(uIn0, pe, 0), O = texelFetch(uIn0, po, 0);
  o0 = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
  E = texelFetch(uIn1, pe, 0); O = texelFetch(uIn1, po, 0);
  o1 = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
}`;

const ASSEMBLE = HEAD + CHOP_GLSL + /* glsl */`
uniform sampler2D uIn0, uIn1, uPrev;
uniform int uRow;
uniform float uChop, uFoamAmt, uDt, uFoamK, uJSig;
uniform vec2 uRot;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uIn0, px + ivec2(0, uRow), 0); // h, dx, dz, sx
  vec4 b = texelFetch(uIn1, px + ivec2(0, uRow), 0); // sz, dxx, dzz, dxz
  float lam = chopK(uChop);
  float jxx = 1.0 + lam * b.y, jzz = 1.0 + lam * b.z, jxz = lam * b.w;
  float J = jxx * jzz - jxz * jxz;
  // Slope of the displaced surface: the height gradient through the inverse of the displacement's
  // Jacobian, so crests the chop sharpens are steeper on their faces.
  vec2 s = vec2(jzz * a.w - jxz * b.x, jxx * b.x - jxz * a.w) / max(J, 0.3);
  s *= min(1.0, 2.5 / max(length(s), 1e-6));
  s = vec2(uRot.x * s.x - uRot.y * s.y, uRot.y * s.x + uRot.x * s.y);
  // Whitecaps where the surface comes closest to folding: J below its present spread (uJSig, at
  // this wave height and chop) by a margin that shrinks as the weather makes whitecaps readier,
  // from a few in ten thousand of the steepest crests to about one in fifty in a gale. Old foam
  // fades but lingers where the crest left it, so it trails behind.
  float sig = uJSig * lam;
  float thr = 1.0 - mix(3.6, 2.05, uFoamAmt) * sig;
  float inj = smoothstep(thr + 0.5 * sig, thr - 0.5 * sig, J) * uFoamK;
  float prev = texelFetch(uPrev, px, 0).w;
  float foam = max(prev * exp(-uDt / mix(1.2, 2.6, uFoamAmt)), inj);
  o0 = vec4(a.y, a.x, a.z, foam);
  o1 = vec4(s, s * s);
}`;

// How much each cascade's folding turns to foam: the dominant waves break; the ripples don't.
const FOAM_K = [1, 0.8, 0];
// The thresholds above are relative to the present sea, so a calm one would break as often as a
// fair one: below an ordinary fair day, whitecaps die away, and a glassy sea has none.
const breaking = (W: number) => { const x = Math.min(1, Math.max(0, (W - 0.7) / 0.4)); return x * x * (3 - 2 * x); };

export class OceanSim {
  readonly ok: boolean;
  readonly f32: boolean;
  spec: OceanSpec;
  protected data: Float32Array = new Float32Array(0);
  protected bands: { fair: Band[]; gale: Band[] } = { fair: [], gale: [] };
  protected cap = { fair: [0, 0], gale: [0, 0] };
  protected h0: THREE.DataTexture | null = null;
  protected h0g: THREE.DataTexture | null = null;
  protected scratch: THREE.WebGLRenderTarget[] = [];
  protected outs: THREE.WebGLRenderTarget[][] = [];
  protected cur: number[] = [];
  protected lastT: number[] = [];
  /** The wave height each cascade was last simulated at (a skipped cascade keeps its old one). */
  readonly baked: number[] = [];
  protected fresh = true;
  protected scene = new THREE.Scene();
  protected cam = new THREE.Camera();
  protected quad: THREE.Mesh;
  protected rows = { value: 1 };
  protected evolve: THREE.RawShaderMaterial;
  protected fftH: THREE.RawShaderMaterial;
  protected fftV: THREE.RawShaderMaterial;
  protected assemble: THREE.RawShaderMaterial;

  constructor(protected gl: THREE.WebGLRenderer, protected sea: SeaState, low: boolean) {
    const ext = gl.extensions;
    this.f32 = ext.has('EXT_color_buffer_float');
    this.ok = this.f32 || ext.has('EXT_color_buffer_half_float');
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader, uniforms: { ...uniforms, uRows: this.rows }, defines, depthTest: false, depthWrite: false });
    this.evolve = mat(EVOLVE, { uH0: { value: null }, uH0g: { value: null }, uN: { value: 0 }, uDk: { value: new THREE.Vector4() }, uTime: { value: 0 }, uMix: { value: new THREE.Vector3(0, 1, 1) }, uKp: { value: 0 } });
    const fftU = () => ({ uIn0: { value: null }, uIn1: { value: null }, uN: { value: 0 }, uSub: { value: 2 } });
    this.fftH = mat(FFT, fftU(), { HORIZONTAL: 1 });
    this.fftV = mat(FFT, fftU());
    this.assemble = mat(ASSEMBLE, {
      uIn0: { value: null }, uIn1: { value: null }, uPrev: { value: null }, uRow: { value: 0 }, uChop: sea.uChop, uFoamAmt: sea.uFoamAmt,
      uDt: { value: 0 }, uFoamK: { value: 1 }, uJSig: { value: 0.05 }, uRot: { value: new THREE.Vector2(1, 0) },
    });
    this.quad = new THREE.Mesh(geo, this.evolve);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.spec = oceanSpec(low);
    this.build(low);
  }

  /** Spectrum and targets for a quality level (the spectrum is the only CPU work, done here once). */
  protected build(low: boolean) {
    this.disposeTargets();
    const spec = (this.spec = oceanSpec(low));
    const { N, cascades } = spec, nc = cascades.length;
    const { data, gale, bands } = buildSpectrum(spec);
    this.data = data;
    this.bands = bands;
    this.cap = { fair: unresolvedSlopeVariance(cascades[nc - 1].kHi, 'fair'), gale: unresolvedSlopeVariance(cascades[nc - 1].kHi, 'gale') };
    this.fresh = true;
    this.baked.length = 0; this.cur.length = 0; this.lastT.length = 0;
    for (let c = 0; c < nc; c++) { this.baked.push(1); this.cur.push(0); this.lastT.push(0); }
    if (!this.ok) return;
    const tex = (d: Float32Array) => { const t = new THREE.DataTexture(d, N, N * nc, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; return t; };
    this.h0 = tex(data); this.h0g = tex(gale);
    const type = this.f32 ? THREE.FloatType : THREE.HalfFloatType;
    const scratch = () => new THREE.WebGLRenderTarget(N, N * nc, { count: 2, type, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.scratch = [scratch(), scratch()];
    const aniso = Math.min(low ? 2 : 8, this.gl.capabilities.getMaxAnisotropy()); // anisotropic taps are costly on weak GPUs
    const out = () => new THREE.WebGLRenderTarget(N, N, {
      count: 2, type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: aniso,
    });
    this.outs = cascades.map(() => [out(), out()]);
    const e = this.evolve.uniforms;
    e.uH0.value = this.h0; e.uH0g.value = this.h0g; e.uN.value = N; e.uKp.value = spec.kp;
    (e.uDk.value as THREE.Vector4).set(...([0, 1, 2, 3].map((i) => (cascades[i] ? (2 * Math.PI) / cascades[i].L : 0)) as [number, number, number, number]));
    this.fftH.uniforms.uN.value = N; this.fftV.uniforms.uN.value = N;
  }

  setQuality(low: boolean) { if ((this.spec.N < 256) !== low) this.build(low); }

  /**
   * At wave height W: each band's spread of the Jacobian (its RMS slope, to first order), and the
   * slope variance (along, across the wind) of the waves finer than the finest tile; with
   * `all`, of every wave (for a sea drawn without the simulation).
   */
  stats(W: number, all = false) {
    const { t, scale } = seaMix(W);
    const lerp = (a: number, b: number) => (a + (b - a) * t) * scale * scale;
    const jSig = this.bands.fair.map((f, c) => {
      const g = this.bands.gale[c];
      return Math.sqrt(lerp(f.su2 + f.sv2, g.su2 + g.sv2)) * calmGain(f.kSlope, this.spec.kp, W);
    });
    const k = calmGain(1e9, 1, W) ** 2;
    const cap = [0, 1].map((i) => {
      let v = lerp(this.cap.fair[i], this.cap.gale[i]) * k;
      if (all) this.bands.fair.forEach((f, c) => { const g = this.bands.gale[c]; v += lerp(i ? f.sv2 : f.su2, i ? g.sv2 : g.su2) * calmGain(f.kSlope, this.spec.kp, W) ** 2; });
      return v;
    }) as [number, number];
    return { jSig, cap };
  }

  protected pass(mat: THREE.Material, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.gl.setRenderTarget(target);
    this.gl.render(this.scene, this.cam);
  }

  /** Evolve and transform the first n cascades to time t; the result lands in scratch[0]. */
  protected transform(t: number, n: number, W: number) {
    const { N, cascades } = this.spec;
    this.rows.value = n / cascades.length;
    this.evolve.uniforms.uTime.value = t;
    const m = seaMix(W);
    (this.evolve.uniforms.uMix.value as THREE.Vector3).set(m.t, m.scale, m.calm);
    this.pass(this.evolve, this.scratch[0]);
    let src = 0;
    for (const m of [this.fftH, this.fftV]) for (let s = 2; s <= N; s *= 2) {
      m.uniforms.uIn0.value = this.scratch[src].textures[0]; m.uniforms.uIn1.value = this.scratch[src].textures[1];
      m.uniforms.uSub.value = s;
      this.pass(m, this.scratch[1 - src]);
      src = 1 - src;
    }
  }

  /**
   * Advance the sea to time t (seconds), updating the first `active` cascades; the rest keep their
   * last state (their waves are below a pixel, and only their averaged slopes still show).
   */
  step(t: number, active: number) {
    if (!this.ok) return;
    const gl = this.gl;
    const nc = this.spec.cascades.length;
    const n = this.fresh ? nc : Math.max(1, Math.min(active, nc));
    const target = gl.getRenderTarget(), autoClear = gl.autoClear;
    gl.autoClear = false;
    const W = this.sea.uWaves.value, { jSig } = this.stats(W);
    try {
      this.transform(t, n, W);
      const a = this.assemble.uniforms;
      a.uIn0.value = this.scratch[0].textures[0]; a.uIn1.value = this.scratch[0].textures[1];
      for (let c = 0; c < n; c++) {
        const from = this.outs[c][this.cur[c]], to = this.outs[c][1 - this.cur[c]];
        a.uPrev.value = from.textures[0];
        a.uRow.value = c * this.spec.N;
        a.uDt.value = this.fresh ? 0 : Math.min(2, Math.max(0, t - this.lastT[c]));
        a.uFoamK.value = (FOAM_K[c] ?? 0) * breaking(W);
        a.uJSig.value = jSig[c];
        const r = this.spec.cascades[c].rot;
        (a.uRot.value as THREE.Vector2).set(Math.cos(r), Math.sin(r));
        this.rows.value = 1;
        this.pass(this.assemble, to);
        this.cur[c] = 1 - this.cur[c];
        this.lastT[c] = t;
        this.baked[c] = W;
      }
      this.fresh = false;
    } finally {
      gl.setRenderTarget(target);
      gl.autoClear = autoClear;
    }
  }

  /** The textures the sea samples for cascade c: displacement + foam, and slope moments. */
  disp(c: number) { return this.outs[c]?.[this.cur[c]].textures[0] ?? null; }
  moments(c: number) { return this.outs[c]?.[this.cur[c]].textures[1] ?? null; }

  /**
   * Check the GPU transform against a direct sum over every mode of the same spectrum, at a few
   * texels of each cascade. Returns the largest error, absolute and relative to each field's RMS.
   */
  verify(t = 3.7) {
    if (!this.ok) return { ok: false };
    const { N, cascades } = this.spec, nc = cascades.length;
    const gl = this.gl;
    const target = gl.getRenderTarget(), autoClear = gl.autoClear;
    gl.autoClear = false;
    this.transform(t, nc, 1);
    gl.setRenderTarget(target); gl.autoClear = autoClear;
    this.fresh = true; // the next step redoes every cascade
    const names = ['h', 'dx', 'dz', 'sx', 'sz', 'dxx', 'dzz', 'dxz'];
    const read = (x: number, y: number, att: number) => {
      if (this.f32) { const b = new Float32Array(4); gl.readRenderTargetPixels(this.scratch[0], x, y, 1, 1, b, undefined, att); return [...b]; }
      const b = new Uint16Array(4); gl.readRenderTargetPixels(this.scratch[0], x, y, 1, 1, b, undefined, att);
      return [...b].map((v) => THREE.DataUtils.fromHalfFloat(v));
    };
    const pts = [[0, 0], [17, 203], [128, 64], [255, 255], [91, 7], [200, 140]].map(([x, y]) => [x % N, y % N]);
    let maxAbs = 0, maxRel = 0;
    const worst: Record<string, number> = {};
    const per: { cascade: number; field: string; rms: number; maxAbs: number }[] = [];
    for (let c = 0; c < nc; c++) {
      const rms = new Float64Array(8), err = new Float64Array(8);
      for (const [x, y] of pts) {
        const gpu = [...read(x, c * N + y, 0), ...read(x, c * N + y, 1)];
        const cpu = directFields(this.spec, this.data, c, x, y, t);
        for (let f = 0; f < 8; f++) { rms[f] += cpu[f] ** 2 / pts.length; err[f] = Math.max(err[f], Math.abs(gpu[f] - cpu[f])); }
      }
      for (let f = 0; f < 8; f++) {
        const r = Math.sqrt(rms[f]);
        per.push({ cascade: c, field: names[f], rms: +r.toPrecision(3), maxAbs: +err[f].toPrecision(3) });
        maxAbs = Math.max(maxAbs, err[f]);
        if (r > 0) { const rel = err[f] / r; if (rel > maxRel) { maxRel = rel; worst.cascade = c; worst.field = f; } }
      }
    }
    return { ok: true, float32: this.f32, N, cascades: nc, texels: pts.length, maxAbs, maxRel, worst: worst.field !== undefined ? `${names[worst.field]} of cascade ${worst.cascade}` : '', per };
  }

  protected disposeTargets() {
    this.h0?.dispose(); this.h0g?.dispose(); this.h0 = this.h0g = null;
    for (const t of this.scratch) t.dispose();
    for (const o of this.outs) for (const t of o) t.dispose();
    this.scratch = []; this.outs = [];
  }

  dispose() {
    this.disposeTargets();
    this.quad.geometry.dispose();
    for (const m of [this.evolve, this.fftH, this.fftV, this.assemble]) m.dispose();
  }
}

/**
 * A tileable foam pattern: the walls of two layers of cells (foam gathers in a lace of bubbles
 * around clear patches) over a soft density noise, equalized so that keeping the texels above
 * 1 − c covers just about a fraction c of the area. Whitecaps and shore foam threshold it by
 * how much foam there is, so thin foam is a lace and thick foam a sheet.
 */
export function foamTexture(S = 256) {
  let seed = 9187;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const cellWalls = (cells: number) => {
    const pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < pts.length; i++) pts[i] = rnd();
    const out = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = (x / S) * cells, py = (y / S) * cells;
      const cx = Math.floor(px), cy = Math.floor(py);
      let f1 = 9, f2 = 9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const k = (((gy + cells) % cells) * cells + ((gx + cells) % cells)) * 2;
        const d = Math.hypot(gx + pts[k] - px, gy + pts[k + 1] - py);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
      }
      out[y * S + x] = Math.exp(-(f2 - f1) * 7);
    }
    return out;
  };
  const a = cellWalls(7), b = cellWalls(17);
  const G = 8, grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const dens = (x: number, y: number) => {
    const fx = (x / S) * G, fy = (y / S) * G, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const g = (i: number, j: number) => grid[((j + G) % G) * G + ((i + G) % G)];
    const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
    return (g(ix, iy) * (1 - ux) + g(ix + 1, iy) * ux) * (1 - uy) + (g(ix, iy + 1) * (1 - ux) + g(ix + 1, iy + 1) * ux) * uy;
  };
  const v = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) v[y * S + x] = a[y * S + x] * 0.55 + b[y * S + x] * 0.35 + dens(x, y) * 0.45;
  // Equalize: each texel becomes its rank.
  const order = Array.from(v.keys()).sort((i, j) => v[i] - v[j]);
  const px = new Uint8Array(S * S);
  order.forEach((i, r) => { px[i] = Math.round((r / (order.length - 1)) * 255); });
  const t = new THREE.DataTexture(px, S, S, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
