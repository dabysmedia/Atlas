/**
 * The sea's waves, simulated on the GPU the way film and games do it (Tessendorf): each frame the
 * spectrum of every cascade (oceanSpectrum.ts) is advanced to the current time, turned back into a
 * surface by an inverse FFT, and assembled into mipmapped textures that the sea samples:
 *
 *   displacement + foam: (dx, height, dz, foam)   the two cascades that move the surface
 *   slopes + moments:    (su, sv, su², sv²)       every cascade, in the wind's frame
 *
 * The second is LEAN mapping: averaging slopes and squared slopes together (as mipmapping does)
 * keeps the variance of the waves a pixel can't show, which is what widens the sun's glitter from
 * far away. Whitecaps start where the surface folds over (its Jacobian drops toward zero) and the
 * foam carries over from frame to frame, fading, so it lingers behind the crests that made it.
 *
 * The FFT is Stockham radix-2 with twiddles worked out in the shader, as in David Li's WebGL ocean:
 * log2 N horizontal then log2 N vertical passes between two half-float targets of three attachments,
 * six complex numbers a texel, each packing two real fields: height, displacement x/z and slope
 * x/z of the two long cascades, and slope x/z of the finest, whose waves only ever show as shading.
 * The Jacobian's derivatives are central differences of the transformed displacement, taken when
 * assembling: four lookups instead of four more transforms.
 */
import * as THREE from 'three';
import { OCEAN_G, buildSpectrum, calmGain, directFields, oceanSpec, seaMix, surfaceAt, unresolvedSlopeVariance, type Band, type OceanSpec } from './oceanSpectrum';

export type SeaState = { uWaves: THREE.IUniform<number>; uChop: THREE.IUniform<number>; uFoamAmt: THREE.IUniform<number> };

const head = (outs: number) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
${Array.from({ length: outs }, (_, i) => `layout(location = ${i}) out vec4 o${i};`).join('\n')}
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 mulI(vec2 a) { return vec2(-a.y, a.x); }
`;

// One triangle over the whole target.
const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Tessendorf's choppiness factor for the weather's chop setting (0..1); 1 at the default 0.5. */
export const CHOP_GLSL = 'float chopK(float c) { return 0.35 + 1.3 * c; }';

const EVOLVE = head(3) + /* glsl */`
uniform sampler2D uH0, uH0g;
uniform int uN, uNC;
uniform vec4 uDk;
uniform float uTime, uKp;
uniform vec3 uMix; // seaMix() in oceanSpectrum.ts: fair→gale blend, growth past a gale, calm below fair
// calmGain() in oceanSpectrum.ts: a dying wind takes the ripples first and leaves the swell.
float calmGain(float k) {
  if (uMix.z >= 1.0) return 1.0;
  float r = clamp(k / uKp, 0.2, 5.0);
  return uMix.z * pow(r, 0.65 * log(uMix.z));
}
// Cascade c's complex amplitude at this texel and time, and its wavevector.
vec2 wave(int c, ivec2 px, out vec2 k) {
  k = vec2(float(px.x < uN / 2 ? px.x : px.x - uN), float(px.y < uN / 2 ? px.y : px.y - uN)) * uDk[c];
  float kl = length(k);
  ivec2 q = ivec2(px.x, px.y + c * uN);
  // Fair and gale amplitudes share their random numbers, so blending them builds one sea into the other.
  vec4 h0 = mix(texelFetch(uH0, q, 0), texelFetch(uH0g, q, 0), uMix.x) * uMix.y;
  // Phase kept in [0, 2π) before sin/cos, which some GPUs evaluate poorly for big arguments.
  float ph = 6.28318530718 * fract(sqrt(${OCEAN_G.toFixed(1)} * kl) / 6.28318530718 * uTime);
  vec2 e = vec2(cos(ph), sin(ph));
  return (cmul(h0.xy, vec2(e.x, -e.y)) + cmul(h0.zw, e)) * calmGain(kl);
}
vec2 unit(vec2 k) { float l = dot(k, k); return l > 0.0 ? k * inversesqrt(l) : vec2(0.0); }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec2 k0, k1, k2 = vec2(0.0), h2 = vec2(0.0);
  vec2 h0 = wave(0, px, k0), h1 = wave(1, px, k1);
  if (uNC > 2) h2 = wave(2, px, k2);
  // Displacement is i·k/|k|·h, slope i·k·h; the second field of each pair rides on the imaginary axis.
  vec2 i0 = mulI(h0), i1 = mulI(h1), i2 = mulI(h2), u0 = unit(k0), u1 = unit(k1);
  o0 = vec4(h0 + mulI(i0 * u0.x), i0 * u0.y + mulI(i0 * k0.x)); // h, dx | dz, sx of cascade 0
  o1 = vec4(h1 + mulI(i1 * u1.x), i1 * u1.y + mulI(i1 * k1.x)); // the same of cascade 1
  o2 = vec4(i0 * k0.y + mulI(i1 * k1.y), i2 * k2.x + mulI(i2 * k2.y)); // sz of 0, sz of 1 | sx, sz of 2
}`;

const FFT = head(3) + /* glsl */`
uniform sampler2D uIn0, uIn1, uIn2;
uniform int uN, uSub;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  #ifdef HORIZONTAL
    int i = px.x;
  #else
    int i = px.y;
  #endif
  int half_ = uSub / 2;
  int e = (i / uSub) * half_ + i % half_;
  int o = e + uN / 2;
  #ifdef HORIZONTAL
    ivec2 pe = ivec2(e, px.y), po = ivec2(o, px.y);
  #else
    ivec2 pe = ivec2(px.x, e), po = ivec2(px.x, o);
  #endif
  float a = 6.28318530718 * float(i % uSub) / float(uSub);
  vec2 w = vec2(cos(a), sin(a));
  vec4 E = texelFetch(uIn0, pe, 0), O = texelFetch(uIn0, po, 0);
  o0 = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
  E = texelFetch(uIn1, pe, 0); O = texelFetch(uIn1, po, 0);
  o1 = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
  E = texelFetch(uIn2, pe, 0); O = texelFetch(uIn2, po, 0);
  o2 = vec4(E.xy + cmul(w, O.xy), E.zw + cmul(w, O.zw));
}`;

const ASSEMBLE = head(2) + CHOP_GLSL + /* glsl */`
uniform sampler2D uA, uB, uPrev;
uniform int uN;
uniform float uChop, uFoamAmt, uDt, uFoamK, uJSig, uInvDx, uSzSel;
uniform vec2 uRot;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int m = uN - 1;
  vec4 a = texelFetch(uA, px, 0); // h, dx, dz, sx
  vec2 b = texelFetch(uB, px, 0).xy;
  float sz = mix(b.x, b.y, uSzSel);
  // The displacement's derivatives, by central differences across the neighbouring texels.
  vec4 xp = texelFetch(uA, ivec2((px.x + 1) & m, px.y), 0), xm = texelFetch(uA, ivec2((px.x + m) & m, px.y), 0);
  vec4 zp = texelFetch(uA, ivec2(px.x, (px.y + 1) & m), 0), zm = texelFetch(uA, ivec2(px.x, (px.y + m) & m), 0);
  float dxx = (xp.y - xm.y) * uInvDx, dzz = (zp.z - zm.z) * uInvDx, dxz = 0.5 * (zp.y - zm.y + xp.z - xm.z) * uInvDx;
  float lam = chopK(uChop);
  float jxx = 1.0 + lam * dxx, jzz = 1.0 + lam * dzz, jxz = lam * dxz;
  float J = jxx * jzz - jxz * jxz;
  // Slope of the displaced surface: the height gradient through the inverse of the displacement's
  // Jacobian, so crests the chop sharpens are steeper on their faces.
  vec2 s = vec2(jzz * a.w - jxz * sz, jxx * sz - jxz * a.w) / max(J, 0.3);
  s *= min(1.0, 2.5 / max(length(s), 1e-6));
  s = vec2(uRot.x * s.x - uRot.y * s.y, uRot.y * s.x + uRot.x * s.y);
  // Whitecaps where the surface comes closest to folding: J below its present spread (uJSig, at
  // this wave height and chop) by a margin that shrinks as the weather makes whitecaps readier,
  // from a few in ten thousand of the steepest crests to about one in thirteen. Old foam
  // fades but lingers where the crest left it, so it trails behind.
  float sig = uJSig * lam;
  float thr = 1.0 - mix(3.6, 1.45, uFoamAmt) * sig;
  float inj = smoothstep(thr + 0.5 * sig, thr - 0.5 * sig, J) * uFoamK;
  float prev = texelFetch(uPrev, px, 0).w;
  float foam = max(prev * exp(-uDt / mix(1.2, 2.6, uFoamAmt)), inj);
  o0 = vec4(a.y, a.x, a.z, foam);
  o1 = vec4(s, s * s);
}`;

// The finest cascade: slopes only.
const SLOPES = head(1) + /* glsl */`
uniform sampler2D uB;
uniform vec2 uRot;
void main() {
  vec2 s = texelFetch(uB, ivec2(gl_FragCoord.xy), 0).zw;
  s *= min(1.0, 2.5 / max(length(s), 1e-6));
  s = vec2(uRot.x * s.x - uRot.y * s.y, uRot.y * s.x + uRot.x * s.y);
  o0 = vec4(s, s * s);
}`;

// How much each displacing cascade's folding turns to foam: the dominant waves break most.
const FOAM_K = [1, 0.8];
// The thresholds above are relative to the present sea, so a calm one would break as often as a
// fair one: below an ordinary fair day, whitecaps die away, and a glassy sea has none.
const breaking = (W: number) => { const x = Math.min(1, Math.max(0, (W - 0.7) / 0.4)); return x * x * (3 - 2 * x); };

export class OceanSim {
  /** Simulating on the GPU (float render targets); otherwise the textures hold one still frame. f32: the transform runs in float32. */
  readonly ok: boolean;
  readonly f32: boolean;
  spec: OceanSpec;
  protected data: Float32Array = new Float32Array(0);
  protected gale: Float32Array = new Float32Array(0);
  protected bands: { fair: Band[]; gale: Band[] } = { fair: [], gale: [] };
  protected cap = { fair: [0, 0], gale: [0, 0] };
  protected h0: THREE.DataTexture | null = null;
  protected h0g: THREE.DataTexture | null = null;
  protected scratch: THREE.WebGLRenderTarget[] = [];
  /** Per displacing cascade, two targets (displacement + foam, moments) that take turns, for the foam's memory. */
  protected outs: THREE.WebGLRenderTarget[][] = [];
  /** The finest cascade's slope moments. */
  protected fine: THREE.WebGLRenderTarget | null = null;
  /** Without float targets: a still frame of each cascade, baked on the CPU. */
  protected still: { disp: THREE.DataTexture | null; mom: THREE.DataTexture }[] = [];
  protected cur: number[] = [];
  protected lastT: number[] = [];
  /** The wave height each cascade was last simulated at (a skipped cascade keeps its old one). */
  readonly baked: number[] = [];
  protected fresh = true;
  protected scene = new THREE.Scene();
  protected cam = new THREE.Camera();
  protected quad: THREE.Mesh;
  protected evolve: THREE.RawShaderMaterial;
  protected fftH: THREE.RawShaderMaterial;
  protected fftV: THREE.RawShaderMaterial;
  protected assemble: THREE.RawShaderMaterial;
  protected slopes: THREE.RawShaderMaterial;
  protected fftPasses: { mat: THREE.RawShaderMaterial; sub: number }[] = [];
  protected mix = { t: 0, scale: 1, calm: 1 };
  // Statistics at the wave height last asked for, kept so a frame allocates nothing.
  protected statW = NaN;
  protected jSig = [0, 0, 0];
  protected capVar: [number, number] = [0, 0];
  protected statOut = { jSig: this.jSig, cap: this.capVar };

  /**
   * `noFloat` drops to the still sea. The transform runs in half floats, which halves its memory
   * traffic and costs about 0.5% of each field's RMS (verify() measures it); `precise` (tests)
   * runs it in float32 where the GPU can render to it.
   */
  constructor(protected gl: THREE.WebGLRenderer, protected sea: SeaState, low: boolean, noFloat = false, precise = false) {
    const ext = gl.extensions, f32 = ext.has('EXT_color_buffer_float');
    this.f32 = !noFloat && precise && f32;
    this.ok = !noFloat && (f32 || ext.has('EXT_color_buffer_half_float'));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false });
    this.evolve = mat(EVOLVE, { uH0: { value: null }, uH0g: { value: null }, uN: { value: 0 }, uNC: { value: 3 }, uDk: { value: new THREE.Vector4() }, uTime: { value: 0 }, uMix: { value: new THREE.Vector3(0, 1, 1) }, uKp: { value: 0 } });
    const fftU = () => ({ uIn0: { value: null }, uIn1: { value: null }, uIn2: { value: null }, uN: { value: 0 }, uSub: { value: 2 } });
    this.fftH = mat(FFT, fftU(), { HORIZONTAL: 1 });
    this.fftV = mat(FFT, fftU());
    this.assemble = mat(ASSEMBLE, {
      uA: { value: null }, uB: { value: null }, uPrev: { value: null }, uN: { value: 0 }, uChop: sea.uChop, uFoamAmt: sea.uFoamAmt,
      uDt: { value: 0 }, uFoamK: { value: 1 }, uJSig: { value: 0.05 }, uInvDx: { value: 1 }, uSzSel: { value: 0 }, uRot: { value: new THREE.Vector2(1, 0) },
    });
    this.slopes = mat(SLOPES, { uB: { value: null }, uRot: { value: new THREE.Vector2(1, 0) } });
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
    this.data = data; this.gale = gale;
    this.bands = bands;
    this.cap = { fair: unresolvedSlopeVariance(cascades[nc - 1].kHi, 'fair'), gale: unresolvedSlopeVariance(cascades[nc - 1].kHi, 'gale') };
    this.fresh = true;
    this.statW = NaN;
    this.baked.length = 0; this.cur.length = 0; this.lastT.length = 0;
    for (let c = 0; c < nc; c++) { this.baked.push(1); this.cur.push(0); this.lastT.push(0); }
    if (!this.ok) { this.bakeStill(); return; }
    const tex = (d: Float32Array) => { const t = new THREE.DataTexture(d, N, N * nc, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; return t; };
    this.h0 = tex(data); this.h0g = tex(gale);
    const type = this.f32 ? THREE.FloatType : THREE.HalfFloatType;
    const scratch = () => new THREE.WebGLRenderTarget(N, N, { count: 3, type, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.scratch = [scratch(), scratch()];
    const aniso = Math.min(low ? 2 : 8, this.gl.capabilities.getMaxAnisotropy()); // anisotropic taps are costly on weak GPUs
    const out = (count: number) => new THREE.WebGLRenderTarget(N, N, {
      count, type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, anisotropy: aniso,
    });
    this.outs = cascades.slice(0, 2).map(() => [out(2), out(2)]);
    this.fine = nc > 2 ? out(1) : null;
    const e = this.evolve.uniforms;
    e.uH0.value = this.h0; e.uH0g.value = this.h0g; e.uN.value = N; e.uNC.value = nc; e.uKp.value = spec.kp;
    (e.uDk.value as THREE.Vector4).set(...([0, 1, 2, 3].map((i) => (cascades[i] ? (2 * Math.PI) / cascades[i].L : 0)) as [number, number, number, number]));
    this.fftH.uniforms.uN.value = N; this.fftV.uniforms.uN.value = N; this.assemble.uniforms.uN.value = N;
    this.fftPasses = [];
    for (const m of [this.fftH, this.fftV]) for (let s = 2; s <= N; s *= 2) this.fftPasses.push({ mat: m, sub: s });
  }

  setQuality(low: boolean) { if ((this.spec.N < 256) !== low) this.build(low); }

  /**
   * At wave height W: each displacing band's spread of dxx + dzz (to first order, the Jacobian's),
   * and the slope variance (along, across the wind) of the waves finer than the finest tile.
   * Kept until W changes; the arrays are reused.
   */
  stats(W: number) {
    if (W === this.statW) return this.statOut;
    this.statW = W;
    const { t, scale } = seaMix(W, this.mix);
    const lerp = (a: number, b: number) => (a + (b - a) * t) * scale * scale;
    const { fair, gale } = this.bands;
    for (let c = 0; c < fair.length; c++) this.jSig[c] = Math.sqrt(lerp(fair[c].j2, gale[c].j2)) * calmGain(fair[c].kSlope, this.spec.kp, W);
    const k = calmGain(1e9, 1, W) ** 2;
    for (let i = 0; i < 2; i++) this.capVar[i] = lerp(this.cap.fair[i], this.cap.gale[i]) * k;
    return this.statOut;
  }

  protected pass(mat: THREE.Material, target: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    this.gl.setRenderTarget(target);
    this.gl.render(this.scene, this.cam);
  }

  /** Evolve and transform the cascades to time t (the finest only if `fine`); the result lands in scratch[0]. */
  protected transform(t: number, fine: boolean, W: number) {
    const e = this.evolve.uniforms;
    e.uTime.value = t;
    e.uNC.value = fine ? this.spec.cascades.length : Math.min(2, this.spec.cascades.length);
    const m = seaMix(W, this.mix);
    (e.uMix.value as THREE.Vector3).set(m.t, m.scale, m.calm);
    this.pass(this.evolve, this.scratch[0]);
    let src = 0;
    for (let i = 0; i < this.fftPasses.length; i++) {
      const { mat, sub } = this.fftPasses[i], u = mat.uniforms, from = this.scratch[src].textures;
      u.uIn0.value = from[0]; u.uIn1.value = from[1]; u.uIn2.value = from[2];
      u.uSub.value = sub;
      this.pass(mat, this.scratch[1 - src]);
      src = 1 - src;
    }
  }

  /** Assemble displacing cascade c from the transform in scratch[0] into its other target, which it returns. */
  protected assembleInto(c: number, t: number, W: number, jSig: number) {
    const { N, cascades } = this.spec, a = this.assemble.uniforms, out = this.scratch[0].textures;
    const from = this.outs[c][this.cur[c]], to = this.outs[c][1 - this.cur[c]];
    a.uA.value = out[c]; a.uB.value = out[2];
    a.uSzSel.value = c;
    a.uPrev.value = from.textures[0];
    a.uDt.value = this.fresh ? 0 : Math.min(2, Math.max(0, t - this.lastT[c]));
    a.uFoamK.value = FOAM_K[c] * breaking(W);
    a.uJSig.value = jSig;
    a.uInvDx.value = N / (2 * cascades[c].L);
    (a.uRot.value as THREE.Vector2).set(Math.cos(cascades[c].rot), Math.sin(cascades[c].rot));
    this.pass(this.assemble, to);
    return to;
  }

  /**
   * Advance the sea to time t (seconds), updating the first `active` cascades; the rest keep their
   * last state (their waves are below a pixel, and only their averaged slopes still show).
   */
  step(t: number, active: number) {
    if (!this.ok) return;
    const gl = this.gl;
    const { cascades } = this.spec, nc = cascades.length;
    const n = this.fresh ? nc : Math.max(1, Math.min(active, nc));
    const target = gl.getRenderTarget(), autoClear = gl.autoClear;
    gl.autoClear = false;
    const W = this.sea.uWaves.value, { jSig } = this.stats(W);
    try {
      this.transform(t, n > 2, W);
      for (let c = 0; c < Math.min(n, 2); c++) {
        this.assembleInto(c, t, W, jSig[c]);
        this.cur[c] = 1 - this.cur[c];
        this.lastT[c] = t; this.baked[c] = W;
      }
      const out = this.scratch[0].textures;
      if (n > 2 && this.fine) {
        const s = this.slopes.uniforms;
        s.uB.value = out[2];
        (s.uRot.value as THREE.Vector2).set(Math.cos(cascades[2].rot), Math.sin(cascades[2].rot));
        this.pass(this.slopes, this.fine);
        this.lastT[2] = t; this.baked[2] = W;
      }
      this.fresh = false;
    } finally {
      gl.setRenderTarget(target);
      gl.autoClear = autoClear;
    }
  }

  /** The textures the sea samples for cascade c: displacement + foam (the two long ones), and slope moments. */
  disp(c: number) { return this.ok ? (this.outs[c]?.[this.cur[c]].textures[0] ?? null) : (this.still[c]?.disp ?? null); }
  moments(c: number) { return this.ok ? (c < 2 ? (this.outs[c]?.[this.cur[c]].textures[1] ?? null) : (this.fine?.texture ?? null)) : (this.still[c]?.mom ?? null); }

  /**
   * Without float render targets: one still frame of every cascade from a CPU transform, with its
   * mip chain averaged on the CPU (half floats can be filtered but not mipmapped by the GPU here).
   * The sea drifts copies of it about, so it keeps a living texture without the simulation.
   */
  protected bakeStill() {
    const { N, cascades } = this.spec;
    this.still = cascades.map((cs, c) => {
      const f = surfaceAt(this.spec, this.data, c);
      const cr = Math.cos(cs.rot), sr = Math.sin(cs.rot);
      const mom = new Float32Array(N * N * 4), disp = new Float32Array(N * N * 4);
      for (let i = 0; i < N * N; i++) {
        let sx = f.sx[i], sz = f.sz[i];
        const l = Math.hypot(sx, sz);
        if (l > 2.5) { sx *= 2.5 / l; sz *= 2.5 / l; }
        const su = cr * sx - sr * sz, sv = sr * sx + cr * sz;
        mom.set([su, sv, su * su, sv * sv], i * 4);
        disp.set([f.dx[i], f.h[i], f.dz[i], 0], i * 4);
      }
      return { disp: c < 2 ? mipTexture(disp, N) : null, mom: mipTexture(mom, N) };
    });
  }

  /**
   * Check the GPU transform against a direct sum over every mode of the same spectrum, at a few
   * texels of each cascade, at wave height W (which blends the fair and gale spectra, or calms the
   * fair one). Returns the largest error, absolute and relative to each field's RMS. Then the same
   * for the assembled textures the sea reads (`assembled`): displacement, and the slope through the
   * inverse Jacobian of the displacement, rotated into the wind's frame, worked out on the CPU from
   * the direct sums at the texel and its four neighbours.
   */
  verify(t = 3.7, W = 1) {
    if (!this.ok) return { ok: false };
    const { N, cascades } = this.spec, nc = cascades.length;
    const gl = this.gl;
    const target = gl.getRenderTarget(), autoClear = gl.autoClear;
    gl.autoClear = false;
    this.transform(t, true, W);
    // Into each displacing cascade's spare target (the one shown stays as it was).
    const asmTo = cascades.slice(0, 2).map((_, c) => this.assembleInto(c, t, W, 0.05));
    gl.setRenderTarget(target); gl.autoClear = autoClear;
    this.fresh = true; // the next step redoes every cascade
    // The amplitudes the GPU evolved: fair and gale blended, grown or calmed, mode by mode.
    let data = this.data;
    if (W !== 1) {
      const m = seaMix(W, { t: 0, scale: 1, calm: 1 });
      data = new Float32Array(this.data.length);
      for (let c = 0; c < nc; c++) {
        const dk = (2 * Math.PI) / cascades[c].L;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const k = Math.hypot((x < N / 2 ? x : x - N) * dk, (y < N / 2 ? y : y - N) * dk), g = calmGain(k, this.spec.kp, W) * m.scale;
          const o = ((c * N + y) * N + x) * 4;
          for (let j = 0; j < 4; j++) data[o + j] = (this.data[o + j] + (this.gale[o + j] - this.data[o + j]) * m.t) * g;
        }
      }
    }
    const read = (x: number, y: number, att: number) => {
      if (this.f32) { const b = new Float32Array(4); gl.readRenderTargetPixels(this.scratch[0], x, y, 1, 1, b, undefined, att); return [...b]; }
      const b = new Uint16Array(4); gl.readRenderTargetPixels(this.scratch[0], x, y, 1, 1, b, undefined, att);
      return [...b].map((v) => THREE.DataUtils.fromHalfFloat(v));
    };
    // Where each cascade's fields landed: [attachment, channel] for h, dx, dz, sx, sz.
    const at = [
      [[0, 0], [0, 1], [0, 2], [0, 3], [2, 0]],
      [[1, 0], [1, 1], [1, 2], [1, 3], [2, 1]],
      [null, null, null, [2, 2], [2, 3]],
    ];
    const names = ['h', 'dx', 'dz', 'sx', 'sz'];
    const pts = [[0, 0], [17, 203], [128, 64], [255, 255], [91, 7], [200, 140]].map(([x, y]) => [x % N, y % N]);
    let maxAbs = 0, maxRel = 0, worst = '';
    const per: { cascade: number; field: string; rms: number; maxAbs: number }[] = [];
    for (let c = 0; c < nc; c++) {
      const rms = new Float64Array(5), err = new Float64Array(5);
      for (const [x, y] of pts) {
        const gpu = [read(x, y, 0), read(x, y, 1), read(x, y, 2)];
        const cpu = directFields(this.spec, data, c, x, y, t);
        for (let f = 0; f < 5; f++) {
          const w = at[c][f];
          if (!w) continue;
          rms[f] += cpu[f] ** 2 / pts.length; err[f] = Math.max(err[f], Math.abs(gpu[w[0]][w[1]] - cpu[f]));
        }
      }
      for (let f = 0; f < 5; f++) {
        if (!at[c][f]) continue;
        const r = Math.sqrt(rms[f]);
        per.push({ cascade: c, field: names[f], rms: +r.toPrecision(3), maxAbs: +err[f].toPrecision(3) });
        maxAbs = Math.max(maxAbs, err[f]);
        if (r > 0 && err[f] / r > maxRel) { maxRel = err[f] / r; worst = `${names[f]} of cascade ${c}`; }
      }
    }
    const readHalf = (rt: THREE.WebGLRenderTarget, x: number, y: number, att: number) => {
      const b = new Uint16Array(4); gl.readRenderTargetPixels(rt, x, y, 1, 1, b, undefined, att);
      return [...b].map((v) => THREE.DataUtils.fromHalfFloat(v));
    };
    const lam = 0.35 + 1.3 * this.sea.uChop.value; // chopK in CHOP_GLSL
    const anames = ['dx', 'h', 'dz', 'su', 'sv'];
    const assembled: { cascade: number; field: string; rms: number; maxAbs: number }[] = [];
    let asmAbs = 0, asmRel = 0;
    asmTo.forEach((rt, c) => {
      const inv = N / (2 * cascades[c].L), cr = Math.cos(cascades[c].rot), sr = Math.sin(cascades[c].rot);
      const rms = new Float64Array(5), err = new Float64Array(5), apts = pts.slice(0, 3);
      for (const [x, y] of apts) {
        const f = (i: number, j: number) => directFields(this.spec, data, c, (x + i + N) % N, (y + j + N) % N, t);
        const o = f(0, 0), xp = f(1, 0), xm = f(-1, 0), zp = f(0, 1), zm = f(0, -1);
        const jxx = 1 + lam * (xp[1] - xm[1]) * inv, jzz = 1 + lam * (zp[2] - zm[2]) * inv, jxz = lam * 0.5 * (zp[1] - zm[1] + xp[2] - xm[2]) * inv;
        const J = Math.max(jxx * jzz - jxz * jxz, 0.3);
        let sx = (jzz * o[3] - jxz * o[4]) / J, sz = (jxx * o[4] - jxz * o[3]) / J;
        const l = Math.hypot(sx, sz);
        if (l > 2.5) { sx *= 2.5 / l; sz *= 2.5 / l; }
        const cpu = [o[1], o[0], o[2], cr * sx - sr * sz, sr * sx + cr * sz];
        const g0 = readHalf(rt, x, y, 0), g1 = readHalf(rt, x, y, 1), gpu = [g0[0], g0[1], g0[2], g1[0], g1[1]];
        for (let i = 0; i < 5; i++) { rms[i] += cpu[i] ** 2 / apts.length; err[i] = Math.max(err[i], Math.abs(gpu[i] - cpu[i])); }
      }
      for (let i = 0; i < 5; i++) {
        const r = Math.sqrt(rms[i]);
        assembled.push({ cascade: c, field: anames[i], rms: +r.toPrecision(3), maxAbs: +err[i].toPrecision(3) });
        asmAbs = Math.max(asmAbs, err[i]);
        if (r > 0) asmRel = Math.max(asmRel, err[i] / r);
      }
    });
    return { ok: true, float32: this.f32, N, cascades: nc, W, texels: pts.length, maxAbs, maxRel, worst, per, asmAbs, asmRel, assembled };
  }

  protected disposeTargets() {
    this.h0?.dispose(); this.h0g?.dispose(); this.h0 = this.h0g = null;
    for (const t of this.scratch) t.dispose();
    for (const o of this.outs) for (const t of o) t.dispose();
    this.fine?.dispose(); this.fine = null;
    for (const s of this.still) { s.disp?.dispose(); s.mom.dispose(); }
    this.scratch = []; this.outs = []; this.still = [];
  }

  dispose() {
    this.disposeTargets();
    this.quad.geometry.dispose();
    for (const m of [this.evolve, this.fftH, this.fftV, this.assemble, this.slopes]) m.dispose();
  }
}

/** A repeating half-float RGBA texture from N×N data, with its mip chain averaged on the CPU. */
function mipTexture(data: Float32Array, N: number) {
  const half = (d: Float32Array) => { const h = new Uint16Array(d.length); for (let i = 0; i < d.length; i++) h[i] = THREE.DataUtils.toHalfFloat(d[i]); return h; };
  const mips: { data: Uint16Array; width: number; height: number }[] = [];
  let d = data, n = N;
  for (;;) {
    mips.push({ data: half(d), width: n, height: n });
    if (n === 1) break;
    const m = n / 2, e = new Float32Array(m * m * 4);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) for (let j = 0; j < 4; j++) {
      const s = (a: number, b: number) => d[((2 * y + b) * n + 2 * x + a) * 4 + j];
      e[(y * m + x) * 4 + j] = (s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1)) / 4;
    }
    d = e; n = m;
  }
  const t = new THREE.DataTexture(mips[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mipmaps = mips as unknown as THREE.CompressedTextureMipmap[];
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
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
