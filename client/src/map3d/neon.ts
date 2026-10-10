/**
 * Faction borders in 3D: glowing lines that lie just above the terrain, following every ridge and
 * valley, instead of strokes painted into the draped overlay.
 *
 * Every line (territory borders, contested and influence rings) is one merged ribbon mesh drawn in
 * a single call. Each point of a line is stored twice, once per side; the vertex shader spreads the
 * pair to a fixed width on screen, so the lines stay fine up close and readable from far out, and
 * the fragment shader draws a hot core, a thin dark rim and a soft halo from the distance across.
 * The halo adds light (premultiplied blending: the core covers, the glow adds), so no post pass.
 *
 * Depth: the lines test against the terrain, so ridges hide them, but are pulled toward the camera
 * along the view ray by a few pixels' worth of distance (which moves nothing on screen), so the
 * halo on a slope doesn't clip and the core never z-fights the ground it lies on.
 */
import * as THREE from 'three';

/** 0 = territory border, 1 = contested ring (rival colors take turns), 2 = influence ring. */
export type NeonKind = 0 | 1 | 2;
export type NeonLine = {
  pts: { x: number; y: number }[];
  closed: boolean;
  color: string;
  kind: NeonKind;
  /** Contested: this line's turn among `of` rivals sharing the ring. */
  turn?: number; of?: number;
  /** Which side of travel the territory is on: 1 = left of (-dy, dx), -1 = right, 0 = neither. */
  inside?: number;
};

const VERT = /* glsl */`
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec3 aColor;
attribute vec3 aStyle;
attribute vec2 aIn;
attribute float aSide;
attribute float aDist;
uniform vec2 uRes;
uniform float uHalf, uShift, uBias;
varying vec3 vColor;
varying vec3 vStyle;
varying float vAcross, vDist, vHalf;
vec2 scr(vec4 c) { return c.xy / c.w * 0.5 * uRes; }
void main() {
  mat4 pm = projectionMatrix * modelViewMatrix;
  vec4 c = pm * vec4(position, 1.0);
  vColor = aColor; vStyle = aStyle; vAcross = aSide; vDist = aDist;
  float half_ = uHalf * (aStyle.x > 1.5 ? 0.7 : aStyle.x > 0.5 ? 0.85 : 1.0);
  vHalf = half_;
  if (c.w <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec4 p = pm * vec4(aPrev, 1.0), n = pm * vec4(aNext, 1.0);
  vec2 cs = scr(c);
  vec2 d1 = cs - scr(p), d2 = scr(n) - cs;
  float l1 = length(d1), l2 = length(d2);
  d1 = l1 > 1e-4 ? d1 / l1 : (l2 > 1e-4 ? d2 / l2 : vec2(1.0, 0.0));
  d2 = l2 > 1e-4 ? d2 / l2 : d1;
  vec2 t = d1 + d2;
  t = dot(t, t) > 1e-6 ? normalize(t) : d1;
  vec2 nrm = vec2(-t.y, t.x);
  // Mitre gentle bends; at a hairpin (a line climbing straight at the camera over a ridge) a full
  // mitre would spike, so it fades back to a plain join and the halo doesn't double up.
  float miter = mix(1.0, 1.0 / max(dot(nrm, vec2(-d1.y, d1.x)), 0.5), smoothstep(-0.2, 0.5, dot(d1, d2)));
  // Neighbouring territories share their border: each line steps a little toward its own side.
  float s = 0.0;
  if (dot(aIn, aIn) > 0.0) s = sign(dot(nrm, scr(pm * vec4(position + vec3(aIn.x, 0.0, aIn.y), 1.0)) - cs));
  vec2 off = nrm * (aSide * half_ * miter + s * uShift);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xyz *= 1.0 - uBias;
  vec4 cc = projectionMatrix * mv;
  cc.xy += off / (0.5 * uRes) * cc.w;
  gl_Position = cc;
}
`;

const FRAG = /* glsl */`
uniform float uTime, uCore, uFlowLen, uDashLen, uInfl, uCont, uOpacity, uGlow, uAdd;
varying vec3 vColor;
varying vec3 vStyle;
varying float vAcross, vDist, vHalf;
void main() {
  float px = abs(vAcross) * vHalf;
  float on = 1.0, inten = 1.0, flow = 1.0;
  if (vStyle.x > 1.5) {
    // Influence: a faint dotted ring, only once the view is close enough to tell hexes apart.
    float f = fract(vDist / uDashLen * 1.5);
    on = smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.3, 0.38, f));
    inten = 0.6 * uInfl;
  } else if (vStyle.x > 0.5) {
    // Contested: the rivals' colors take turns round the ring, which pulses.
    float k = mod(floor(vDist / uDashLen), vStyle.z);
    float f = fract(vDist / uDashLen);
    on = (abs(k - vStyle.y) < 0.5 ? 1.0 : 0.0) * smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.94, 1.0, f));
    inten = (0.85 + 0.3 * sin(uTime * 3.4)) * uCont;
  } else {
    // Energy running along the border: a bright pulse with a fading tail.
    float f = fract(vDist / uFlowLen - uTime * 0.11);
    flow = 0.8 + 0.75 * pow(f, 10.0) + 0.25 * pow(f, 3.0);
  }
  float core = 1.0 - smoothstep(uCore - 0.55, uCore + 0.55, px);
  float edge = 1.0 - smoothstep(vHalf * 0.7, vHalf, px);
  float g = px / vHalf;
  float glow = (exp(-g * g * 10.0) * 0.75 + exp(-g * 4.0) * 0.35) * edge;
  // A white-hot thread down the middle of a saturated tube.
  float thread = 1.0 - smoothstep(0.0, uCore, px);
  vec3 tube = mix(vColor, vec3(1.0), 0.08 + 0.4 * thread * thread);
  float k = on * inten;
  vec3 rgb = (tube * core * 1.25 * flow + vColor * glow * uGlow * flow) * k;
  // A whisper of dark just outside the core keeps the line crisp on bright ground.
  float rim = (1.0 - smoothstep(uCore + 0.5, uCore + 2.6, px)) * 0.28;
  float a = max(core * 0.9, rim) * k * (1.0 - uAdd);
  gl_FragColor = vec4(rgb * uOpacity, a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ATTRS: [string, number][] = [['position', 3], ['aPrev', 3], ['aNext', 3], ['aColor', 3], ['aStyle', 3], ['aIn', 2], ['aSide', 1], ['aDist', 1]];

export class NeonBorders {
  readonly uniforms = {
    uRes: { value: new THREE.Vector2(1, 1) }, uHalf: { value: 8 }, uShift: { value: 1.6 }, uBias: { value: 0.006 },
    uTime: { value: 0 }, uCore: { value: 1.1 }, uFlowLen: { value: 400 }, uDashLen: { value: 10 }, uInfl: { value: 1 }, uCont: { value: 1 },
    uOpacity: { value: 1 }, uGlow: { value: 1 }, uAdd: { value: 0 },
  };
  /** The lines, then their glow again over the clouds and rain (see the constructor). */
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  protected through: THREE.Mesh;
  /** How strongly the lines shine through cloud and rain drawn over them. */
  readonly throughU = { uOpacity: { value: 0.32 }, uGlow: { value: 0.8 }, uAdd: { value: 1 } };
  protected tmp = new THREE.Color();

  constructor() {
    const blend = {
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    } as const;
    const geo = new THREE.BufferGeometry();
    // Under the clouds, so a cloud drifting over a border veils it as it would the ground...
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, ...blend }));
    this.mesh.renderOrder = 3;
    // ...and a purely additive second pass after the clouds and rain, so the light still shows
    // through them like a lamp through mist and the lines stay readable in any weather.
    this.through = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, ...this.throughU }, vertexShader: VERT, fragmentShader: FRAG, ...blend }));
    this.through.renderOrder = 8;
    for (const m of [this.mesh, this.through]) { m.frustumCulled = false; this.group.add(m); }
  }

  /**
   * Rebuild the merged ribbon. `height` gives the height a line stands at over a world point
   * (already lifted clear of the ground); `step` is the longest stretch between samples, so the
   * line follows the relief between them.
   */
  build(lines: NeonLine[], height: (x: number, y: number, tx: number, ty: number) => number, step: number) {
    // Resample each line into points at most `step` apart.
    const runs: { xs: number[]; ys: number[]; line: NeonLine }[] = [];
    let total = 0;
    for (const line of lines) {
      const P = line.pts;
      if (P.length < 2) continue;
      const xs: number[] = [], ys: number[] = [];
      const n = line.closed ? P.length : P.length - 1;
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
        for (let j = 0; j < k; j++) { xs.push(a.x + ((b.x - a.x) * j) / k); ys.push(a.y + ((b.y - a.y) * j) / k); }
      }
      // Closed lines end where they began; open ones on their last point.
      const end = line.closed ? P[0] : P[P.length - 1];
      xs.push(end.x); ys.push(end.y);
      runs.push({ xs, ys, line });
      total += xs.length;
    }
    const buf = Object.fromEntries(ATTRS.map(([k, n]) => [k, new Float32Array(total * 2 * n)])) as Record<string, Float32Array>;
    const index = new Uint32Array(Math.max(0, (total - runs.length) * 6));
    let v = 0, ii = 0;
    const col = this.tmp;
    for (const { xs, ys, line } of runs) {
      const n = xs.length;
      // Neon wants a lit color: keep the faction's hue, lift dark or greyed ones.
      col.set(line.color);
      const hsl = col.getHSL({ h: 0, s: 0, l: 0 });
      col.setHSL(hsl.h, Math.max(hsl.s, 0.72), clamp(hsl.l, 0.56, 0.68));
      const raw = new Float32Array(n), env = new Float32Array(n), hy = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const j0 = i > 0 ? i - 1 : line.closed ? n - 2 : 0, j1 = i < n - 1 ? i + 1 : line.closed ? 1 : n - 1;
        const tx = xs[j1] - xs[j0], ty = ys[j1] - ys[j0], tl = Math.hypot(tx, ty) || 1;
        raw[i] = height(xs[i], ys[i], tx / tl, ty / tl);
      }
      // Ease the profile over ridges: a running max then a running mean over the same reach stays
      // on or above every sample but loses the sawtooth that folds the ribbon over itself on screen.
      const K = 2, m = line.closed ? n - 1 : n;
      const at = line.closed ? (i: number) => ((i % m) + m) % m : (i: number) => Math.max(0, Math.min(n - 1, i));
      for (let i = 0; i < m; i++) { let e = -Infinity; for (let k = -K; k <= K; k++) e = Math.max(e, raw[at(i + k)]); env[i] = e; }
      for (let i = 0; i < m; i++) { let s = 0; for (let k = -K; k <= K; k++) s += env[at(i + k)]; hy[i] = Math.max(raw[i], s / (2 * K + 1)); }
      if (line.closed) hy[n - 1] = hy[0];
      let dist = 0;
      const base = v;
      for (let i = 0; i < n; i++) {
        if (i) dist += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
        const ip = i > 0 ? i - 1 : line.closed ? n - 2 : 0, inx = i < n - 1 ? i + 1 : line.closed ? 1 : n - 1;
        const tx = xs[inx] - xs[ip], ty = ys[inx] - ys[ip], tl = Math.hypot(tx, ty) || 1;
        const s = line.inside ?? 0;
        for (const side of [-1, 1]) {
          set3(buf.position, v, xs[i], hy[i], ys[i]);
          set3(buf.aPrev, v, xs[ip], hy[ip], ys[ip]);
          set3(buf.aNext, v, xs[inx], hy[inx], ys[inx]);
          set3(buf.aColor, v, col.r, col.g, col.b);
          set3(buf.aStyle, v, line.kind, line.turn ?? 0, line.of ?? 1);
          buf.aIn[v * 2] = (-ty / tl) * s; buf.aIn[v * 2 + 1] = (tx / tl) * s;
          buf.aSide[v] = side;
          buf.aDist[v] = dist;
          v++;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        // Counter-clockwise on screen (side -1 is right of travel); folds at sharp turns face away and drop out.
        index[ii++] = a; index[ii++] = a + 2; index[ii++] = a + 1;
        index[ii++] = a + 1; index[ii++] = a + 2; index[ii++] = a + 3;
      }
    }
    const geo = new THREE.BufferGeometry();
    for (const [k, n] of ATTRS) geo.setAttribute(k, new THREE.BufferAttribute(buf[k], n));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.through.geometry = geo;
    return total;
  }

  /**
   * Per frame: sizes in drawing-buffer pixels (`pr` = its pixels per CSS pixel), time, and how
   * many world units a CSS pixel spans at the point looked at (sets the pulse spacing).
   */
  update(now: number, res: THREE.Vector2, pr: number, worldPerPx: number, pixAngle: number) {
    const u = this.uniforms;
    u.uRes.value.copy(res);
    u.uHalf.value = 8 * pr;
    u.uCore.value = Math.max(0.75, 1.15 * pr);
    u.uShift.value = 1.7 * pr;
    // Pull toward the camera by about four halo widths' worth of distance (see the header).
    u.uBias.value = Math.min(0.03, 8 * 4 * pixAngle);
    u.uTime.value = (now / 1000) % 3600;
    // Pulse spacing in powers of two of world distance, so zooming doesn't make the pattern crawl.
    u.uFlowLen.value = 2 ** Math.round(Math.log2(260 * worldPerPx));
    // Hex rings only once hexes are big enough on screen to ring: contested first, influence later.
    u.uCont.value = smooth(2.6, 1.5, worldPerPx);
    u.uInfl.value = smooth(1.6, 0.9, worldPerPx);
  }

  dispose() { this.mesh.geometry.dispose(); for (const m of [this.mesh, this.through]) (m.material as THREE.Material).dispose(); }
}

function set3(a: Float32Array, i: number, x: number, y: number, z: number) { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; }
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
