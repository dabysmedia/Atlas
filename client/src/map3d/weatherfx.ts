/**
 * The day's weather as the 3D map shows it: the look eased from one kind to the next, ground that
 * wets in rain and dries after, rain falling around the camera, and lightning.
 *
 * Rain is one instanced draw of streaks in a box that travels with the view. Drops sit on a lattice
 * fixed in the world that repeats every box width, so panning moves past them rather than dragging
 * them along, and they wrap at the box's faded edges. The box, the streak length and the fall speed
 * all scale with the camera's distance, so rain reads at every zoom: long fast streaks close in, a
 * fine slanted veil from the overview. Streaks are expanded in screen space so they never thin to
 * nothing.
 *
 * Lightning comes at random intervals. A strike is one flash, sometimes followed a third of a second
 * later by a weaker one: each lights the cloud from inside near the strike and the ground under
 * it, and only the first lifts the sky and ambient light, a little. Kept brief, local and moderate
 * so it never strobes the screen; with reduced motion asked for it is a single slow glow. Often a
 * bolt shows too, a jagged branching line from the cloud base to the ground or sea, drawn as glowing
 * screen-space ribbons. Its clock advances by at most a twentieth of a second a frame, so a slow
 * machine sees each flash over a few frames instead of missing it.
 */
import * as THREE from 'three';
import { weatherLook, type WeatherKind, type WeatherLook } from '../../../shared/weather';
import { FLASH_COLOR } from './sky';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const FIELDS = ['cover', 'dark', 'rain', 'lightning', 'fog', 'wind', 'sun'] as const;
const CLEAR: WeatherLook = { ...weatherLook('clear'), cover: 0 };
/** One lightning flash, `ds` seconds in: up in a fiftieth of a second, dying away over about a fifth. */
const pulse = (ds: number) => (ds < 0 ? 0 : smooth(0, 0.02, ds) * Math.exp(-ds / 0.08));

/** Seconds a change of weather takes to ease in; seconds of rain to soak the ground; to dry it. */
const EASE_S = 8, SOAK_S = 20, DRY_S = 60;
const RAIN_MAX = 14000;
const BOLT_MAX = 160;

/** What the frame needs from the view to place rain and lightning. */
export type WeatherView = {
  camera: THREE.PerspectiveCamera;
  camDist: number;
  /** The ground point looked at. */
  target: THREE.Vector3;
  sea: number;
  cloudBase: number;
  /** Pixel size of the drawing buffer. */
  width: number; height: number;
  /** A ground point (x, height, z) under a random spot near the middle of the view, for a strike. */
  strikePoint: (out: THREE.Vector3) => THREE.Vector3 | null;
};

export class WeatherFx {
  kind: WeatherKind | null = null;
  /** The look being drawn this frame (eased between kinds; clear when weather is turned off). */
  readonly look: WeatherLook = { ...weatherLook('fair') };
  protected from: WeatherLook = { ...weatherLook('fair') };
  protected to: WeatherLook = { ...weatherLook('fair') };
  protected eased: WeatherLook = { ...weatherLook('fair') };
  protected t0 = -Infinity;
  /** 0 dry .. 1 soaked. */
  wet = 0;
  protected lastNow = 0;

  // Lightning, on its own clock (seconds).
  protected clock = 0;
  protected nextStrike = 6;
  protected strikeAt = -10;
  /** The second, weaker flash of a strike: seconds after the first, and its strength (0 none). */
  protected secondAt = 0;
  protected secondAmp = 0;
  /** This strike is a single slow glow (reduced motion). */
  protected soft = false;
  protected boltOn = false;
  protected forced = false;
  protected reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /** Brightness of the current flash in the cloud and on the ground near the strike (0 none), and where it is. */
  flash = 0;
  /** How much the current flash lifts the whole sky and the ambient light (first flash only; 0 none). */
  flashWide = 0;
  readonly flashPos = new THREE.Vector3();
  flashReach = 1;

  readonly rain: THREE.Mesh;
  readonly bolt: THREE.Mesh;
  protected rainMat: THREE.ShaderMaterial;
  protected boltMat: THREE.ShaderMaterial;
  protected fall = 0;
  protected drift = new THREE.Vector2();
  protected v3 = new THREE.Vector3();
  protected v3b = new THREE.Vector3();
  protected boltA: Float32Array;
  protected boltB: Float32Array;
  protected boltW: Float32Array;
  protected wind = new THREE.Vector2(1, 0.4).normalize();

  constructor() {
    // Rain: a unit quad per drop, x across the streak, y from head (0) to tail (1).
    const rg = new THREE.InstancedBufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    rg.setIndex([0, 2, 1, 2, 3, 1]);
    const seeds = new Float32Array(RAIN_MAX * 4);
    let s = 12345;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s & 0xffffff) / 0x1000000; };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    rg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    rg.instanceCount = 0;
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uBox: { value: new THREE.Vector4() }, uBase: { value: 0 }, uFall: { value: 0 }, uDrift: { value: new THREE.Vector2() },
        uDir: { value: new THREE.Vector3(0, -1, 0) }, uLen: { value: 1 }, uWidth: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
        uNearFade: { value: new THREE.Vector2(0, 1) }, uColor: { value: new THREE.Color() }, uAlpha: { value: 0.3 },
        uMinLen: { value: 2.5 },
      }]),
      transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute vec4 aSeed;
        uniform vec4 uBox; // min x, min z, width, height
        uniform float uBase, uFall, uLen, uWidth, uAlpha, uMinLen;
        uniform vec2 uDrift, uRes, uNearFade;
        uniform vec3 uDir;
        varying float vA, vX, vY;
        void main() {
          // Drops on a world lattice repeating every box width, so they stay put as the box moves.
          vec3 p;
          p.xz = uBox.xy + mod(aSeed.xz * uBox.z + uDrift - uBox.xy, uBox.z);
          float h = mod(aSeed.y * uBox.w - uFall * (1.0 + 0.1 * floor(aSeed.w * 4.0)), uBox.w);
          p.y = uBase + h;
          vec2 e = (p.xz - uBox.xy) / uBox.z;
          e = min(e, 1.0 - e);
          float fade = smoothstep(0.0, 0.16, e.x) * smoothstep(0.0, 0.16, e.y) * smoothstep(0.0, 0.08, h / uBox.w) * smoothstep(1.0, 0.8, h / uBox.w);
          float len = uLen * (0.6 + 0.8 * aSeed.w);
          vec4 a = viewMatrix * vec4(p, 1.0), b = viewMatrix * vec4(p - uDir * len, 1.0);
          // Drops right at the lens would be huge smears.
          fade *= smoothstep(uNearFade.x, uNearFade.y, -a.z);
          vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
          vec2 sa = ca.xy / ca.w * uRes, sb = cb.xy / cb.w * uRes;
          vec2 d = sb - sa;
          float l = length(d);
          vec2 dir = l > 1e-3 ? d / l : vec2(0.0, 1.0);
          vec4 c = mix(ca, cb, position.y);
          c.xy += vec2(-dir.y, dir.x) * position.x * uWidth / uRes * c.w;
          // A streak shorter than a couple of pixels still shows as a short dash.
          c.xy += dir * (position.y - 0.5) * max(0.0, uMinLen - l) / uRes * c.w;
          vA = fade * uAlpha * (0.45 + 0.55 * fract(aSeed.w * 7.13));
          vX = position.x * 2.0; vY = position.y;
          gl_Position = (vA < 0.002) ? vec4(0.0, 0.0, 2.0, 1.0) : c;
          vec4 mvPosition = a;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying float vA, vX, vY;
        void main() {
          float a = vA * (1.0 - vX * vX) * smoothstep(0.0, 0.25, vY) * smoothstep(1.0, 0.55, vY);
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.rain = new THREE.Mesh(rg, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 3;
    this.rain.visible = false;

    // The bolt: one instanced ribbon per segment, A to B, with a width in pixels and a brightness.
    const bg = new THREE.InstancedBufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
    bg.setIndex([0, 2, 1, 2, 3, 1]);
    this.boltA = new Float32Array(BOLT_MAX * 3); this.boltB = new Float32Array(BOLT_MAX * 3); this.boltW = new Float32Array(BOLT_MAX * 2);
    bg.setAttribute('aA', new THREE.InstancedBufferAttribute(this.boltA, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aB', new THREE.InstancedBufferAttribute(this.boltB, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aW', new THREE.InstancedBufferAttribute(this.boltW, 2).setUsage(THREE.DynamicDrawUsage));
    bg.instanceCount = 0;
    this.boltMat = new THREE.ShaderMaterial({
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: FLASH_COLOR.clone() }, uBright: { value: 0 }, uGlow: { value: 10 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aA, aB; attribute vec2 aW; // width scale, brightness
        uniform vec2 uRes; uniform float uGlow;
        varying float vX, vB;
        void main() {
          vec4 ca = projectionMatrix * viewMatrix * vec4(aA, 1.0), cb = projectionMatrix * viewMatrix * vec4(aB, 1.0);
          vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes;
          vec2 dir = length(d) > 1e-3 ? normalize(d) : vec2(0.0, 1.0);
          vec4 c = mix(ca, cb, position.y);
          float w = uGlow * aW.x;
          c.xy += (vec2(-dir.y, dir.x) * position.x + dir * (position.y - 0.5) * 0.12) * w / uRes * c.w;
          vX = position.x; vB = aW.y;
          gl_Position = c;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uBright;
        varying float vX, vB;
        void main() {
          float x = abs(vX);
          // A thin hot core inside a soft violet-blue glow.
          float core = smoothstep(0.11, 0.02, x), glow = exp(-x * x * 9.0);
          vec3 col = vec3(0.92, 0.95, 1.0) * core * 1.5 + uColor * glow * 0.42;
          gl_FragColor = vec4(col * vB * uBright, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.bolt = new THREE.Mesh(bg, this.boltMat);
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 6;
    this.bolt.visible = false;
  }

  /** The weather to show. The first call and `snap` jump straight to it; later changes ease in. */
  set(kind: WeatherKind, snap: boolean, now: number) {
    const first = this.kind === null;
    if (kind === this.kind && !snap) return;
    this.kind = kind;
    Object.assign(this.from, this.eased);
    Object.assign(this.to, weatherLook(kind));
    this.t0 = first || snap ? -Infinity : now;
    if (first || snap) { Object.assign(this.eased, this.to); this.wet = smooth(0.05, 0.5, this.to.rain); this.strikeAt = -10; }
    // A storm doesn't keep you waiting long for its first flash.
    if (this.to.lightning > 0.01) this.nextStrike = this.clock + 2 + Math.random() * 3;
  }

  /** Force a strike with a visible bolt on the next frame (for screenshots and tests). */
  strike() { this.forced = true; }

  /** Ease the look, wet or dry the ground, and step the lightning; returns the look to draw. */
  step(now: number, on: boolean) {
    const real = this.lastNow ? clamp((now - this.lastNow) / 1000, 0, 5) : 0;
    this.lastNow = now;
    const t = smooth(0, 1, (now - this.t0) / (EASE_S * 1000));
    for (let i = 0; i < FIELDS.length; i++) { const k = FIELDS[i]; this.eased[k] = this.from[k] + (this.to[k] - this.from[k]) * t; }
    Object.assign(this.look, on ? this.eased : CLEAR);
    // Ground soaks over ~20 s of steady rain (less in drizzle), and dries more slowly.
    const soak = on ? smooth(0.05, 0.5, this.look.rain) : 0;
    this.wet = soak > this.wet ? Math.min(soak, this.wet + real / SOAK_S) : Math.max(soak, this.wet - real / DRY_S);
    this.clock += Math.min(real, 0.05);
    return this.look;
  }

  /** Strike when it's time, and work out this frame's flash. */
  lightning(v: WeatherView, on: boolean) {
    const w = this.look, now = this.clock;
    // Lightning needs the storm's cloud: none from a sky still closing in as a storm eases in.
    const rate = w.lightning * smooth(0.8, 1, w.cover);
    if (rate <= 0.01) this.nextStrike = Math.max(this.nextStrike, now + 2);
    if (this.forced || (on && rate > 0.01 && now >= this.nextStrike)) {
      const forced = this.forced;
      this.forced = false;
      // ~4-15 s apart in a full storm, rarer as the lightning dies down.
      this.nextStrike = now + (4 + Math.random() * 11) / Math.max(0.05, rate);
      const at = v.strikePoint(this.v3);
      if (at) {
        this.strikeAt = now;
        this.flashPos.copy(at);
        this.flashReach = v.camDist * (0.085 + Math.random() * 0.035);
        this.soft = !!this.reduceMotion?.matches;
        // Now and then a weaker return stroke a third of a second later; never a rapid flicker.
        const two = !this.soft && Math.random() < 0.6;
        this.secondAt = 0.28 + Math.random() * 0.14;
        this.secondAmp = two ? 0.45 + Math.random() * 0.25 : 0;
        this.boltOn = forced || Math.random() < 0.65;
        if (this.boltOn) this.buildBolt(at, v);
      }
    }
    const s = now - this.strikeAt;
    let f: number, wide: number;
    if (this.soft) { f = 0.7 * smooth(0, 0.2, s) * Math.exp(-Math.max(0, s - 0.2) / 0.45); wide = 0; } else { f = pulse(s) + this.secondAmp * pulse(s - this.secondAt); wide = pulse(s); }
    const live = on && s < (this.soft ? 2 : 1);
    this.flash = live ? clamp(f, 0, 1) : 0;
    this.flashWide = live ? clamp(wide, 0, 1) : 0;
    const showBolt = live && this.boltOn && s < (this.soft ? 1.2 : 0.2 + (this.secondAmp > 0 ? this.secondAt : 0));
    this.bolt.visible = showBolt && this.flash > 0.04;
    if (this.bolt.visible) {
      // Seen from above the cloud, the bolt is under it, dimmed by the deck like the rain.
      this.bolt.renderOrder = v.camera.position.y > v.cloudBase ? 3 : 6;
      this.boltMat.uniforms.uBright.value = this.soft ? clamp(f * 1.4, 0, 0.9) : clamp(f * 1.3, 0.25, 1.2);
      this.boltMat.uniforms.uRes.value.set(v.width / 2, v.height / 2);
      this.boltMat.uniforms.uGlow.value = clamp(10 * Math.sqrt(1200 / Math.max(200, v.camDist)), 5, 16) * (v.width > 2200 ? 1.6 : 1);
    }
  }

  /** A jagged channel from the cloud base down to the strike point, with a few forks. */
  protected buildBolt(ground: THREE.Vector3, v: WeatherView) {
    const H = Math.max(v.cloudBase - ground.y, v.camDist * 0.04);
    const top = this.v3b.set(ground.x + (Math.random() - 0.5) * H * 0.5, ground.y + H, ground.z + (Math.random() - 0.5) * H * 0.5);
    let n = 0;
    const A = this.boltA, B = this.boltB, W = this.boltW;
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, bright: number) => {
      if (n >= BOLT_MAX) return;
      A[n * 3] = ax; A[n * 3 + 1] = ay; A[n * 3 + 2] = az; B[n * 3] = bx; B[n * 3 + 1] = by; B[n * 3 + 2] = bz;
      W[n * 2] = width; W[n * 2 + 1] = bright;
      n++;
    };
    // Walk down in steps, each kicked sideways; forks peel off and die out.
    const walk = (x: number, y: number, z: number, tx: number, ty: number, tz: number, steps: number, width: number, bright: number, forks: number) => {
      const jag = Math.hypot(tx - x, ty - y, tz - z) / steps;
      for (let i = 0; i < steps; i++) {
        const k = 1 / (steps - i);
        const nx = x + (tx - x) * k + (i < steps - 1 ? (Math.random() - 0.5) * jag * 1.4 : 0);
        const ny = y + (ty - y) * k + (i < steps - 1 ? (Math.random() - 0.5) * jag * 0.3 : 0);
        const nz = z + (tz - z) * k + (i < steps - 1 ? (Math.random() - 0.5) * jag * 1.4 : 0);
        seg(x, y, z, nx, ny, nz, width, bright);
        if (forks > 0 && i > 1 && i < steps - 3 && Math.random() < 0.22) {
          const len = (y - ty) * (0.3 + Math.random() * 0.35);
          const a = Math.random() * Math.PI * 2;
          walk(nx, ny, nz, nx + Math.cos(a) * len * 0.7, ny - len, nz + Math.sin(a) * len * 0.7, 6 + Math.floor(Math.random() * 6), width * 0.55, bright * 0.6, forks - 1);
        }
        x = nx; y = ny; z = nz;
      }
    };
    walk(top.x, top.y, top.z, ground.x, ground.y, ground.z, 26, 1, 1, 2);
    const g = this.bolt.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = n;
    for (const name of ['aA', 'aB', 'aW']) (g.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Rain around this frame's view, lit with `color`. */
  placeRain(v: WeatherView, color: THREE.Color, on: boolean) {
    const w = this.look;
    const amount = on ? w.rain : 0;
    const g = this.rain.geometry as THREE.InstancedBufferGeometry;
    // Light rain is many fine drops rather than a few: the count goes with the square root.
    g.instanceCount = Math.round(RAIN_MAX * clamp(Math.sqrt(amount) * smooth(0, 0.12, amount), 0, 1));
    this.rain.visible = g.instanceCount > 0;
    if (!this.rain.visible) return;
    const u = this.rainMat.uniforms;
    const D = v.camDist, cam = v.camera.position;
    // The box: around the part of the ground in view, pulled toward the camera so near rain shows
    // in a tilted view; from the sea up to the cloud base (or around the camera when it is lower).
    const S = D * 1.15;
    const cx = v.target.x + (cam.x - v.target.x) * 0.35, cz = v.target.z + (cam.z - v.target.z) * 0.35;
    const H = Math.max(v.cloudBase - v.sea, D * 0.05);
    u.uBox.value.set(cx - S / 2, cz - S / 2, S, H);
    u.uBase.value = v.sea;
    // Streaks: long and fast close in, short dashes from far out; heavier rain, longer streaks.
    const len = Math.min(D * 0.016, H * 0.45) * (0.4 + 0.75 * amount);
    const dt = this.dtc();
    // Wrapped where the drop pattern repeats (each drop falls at 1, 1.1, 1.2 or 1.3 times the speed),
    // so it never grows past float precision.
    this.fall = (this.fall + len * 14 * dt) % (H * 10);
    // Slant with the wind; a gale drives it nearly sideways. Seen from straight above a falling
    // streak would shrink to a dot, so the view from overhead leans it a little more.
    const down = -v.camera.getWorldDirection(this.v3b).y;
    const slant = 0.12 + 0.75 * w.wind * w.wind + 0.45 * smooth(0.75, 0.98, down);
    this.drift.x = (this.drift.x + this.wind.x * slant * len * 14 * dt) % S; this.drift.y = (this.drift.y + this.wind.y * slant * len * 14 * dt) % S;
    u.uFall.value = this.fall;
    u.uDrift.value.copy(this.drift);
    u.uDir.value.set(this.wind.x * slant, -1, this.wind.y * slant).normalize();
    u.uLen.value = len;
    // Even drizzle shows: no streak thinner than a pixel or fainter than about half. From high over
    // the island the streaks would be specks, so they keep a few pixels' length and a little more
    // weight, and rain shows as a slanting veil whose density tells drizzle from a downpour.
    const far = smooth(3, 10, D / Math.max(v.cloudBase - v.sea, 1));
    const hi = v.width > 2200 ? 1.5 : 1;
    u.uWidth.value = (1.2 + 0.5 * smooth(0.2, 0.9, amount) + 0.4 * far) * hi;
    u.uMinLen.value = (2.5 + far * (3.5 + 2.5 * amount)) * hi;
    u.uRes.value.set(v.width / 2, v.height / 2);
    u.uNearFade.value.set(D * 0.12, D * 0.3);
    u.uAlpha.value = Math.min(0.85, (0.45 + 0.15 * amount) * (1 + 0.3 * far));
    u.uColor.value.copy(color);
    // Drawn before the clouds when looking down on them, after when under them; the bolt too. From
    // the whole-island view the deck is only a veil, and the rain falls through it.
    this.rain.renderOrder = cam.y > v.cloudBase && far < 0.5 ? 3 : 6;
  }

  protected lastClock = 0;
  /** Seconds of the weather clock since the last call. */
  protected dtc() { const d = this.clock - this.lastClock; this.lastClock = this.clock; return clamp(d, 0, 0.05); }

  /** Wind direction on the ground (unit, world x/z). */
  setWind(x: number, z: number) { this.wind.set(x, z).normalize(); }
}
