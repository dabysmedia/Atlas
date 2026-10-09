/**
 * The living sky: where the sun and moon stand at an hour, and the light, haze and sky colors that
 * follow from the sun's height. One key light plays the sun by day and the moon by night; they
 * hand over at twilight while both are near zero, so the switch never shows.
 *
 * The sun rises in the east (+x, screen right), passes to the north (-z, screen top) and sets in
 * the west. Light from the top of the map keeps relief reading the right way up from above.
 */
import * as THREE from 'three';
import type { WeatherLook } from '../../../shared/weather';

export type Lighting = {
  hour: number;
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  keyDir: THREE.Vector3;
  keyColor: THREE.Color; // linear, intensity folded in
  keyAbove: THREE.Color; // the key light above the clouds (cloud tops see it undimmed)
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  zenith: THREE.Color;
  horizon: THREE.Color; // also the haze color
  exposure: number;
  fogK: number; // fog density times camera distance
  night: number; // 0 by day, 1 deep night
  overlayGlow: number; // how much draped overlays light themselves (readable at night)
  sunUp: boolean;
  cloudShadow: number; // how much a cloud overhead takes from the key light (0..1)
};

type Key = { e: number; key: [number, number, number]; keyI: number; zen: [number, number, number]; hor: [number, number, number]; sky: [number, number, number]; gnd: [number, number, number]; hemi: number; fog: number; exp: number };

// Keyframes by sun elevation (sin of the angle above the horizon). Colors are sRGB.
const KEYS: Key[] = [
  { e: -0.45, key: [0.6, 0.7, 1.0], keyI: 1.15, zen: [0.012, 0.022, 0.06], hor: [0.06, 0.09, 0.17], sky: [0.22, 0.3, 0.52], gnd: [0.05, 0.06, 0.1], hemi: 0.8, fog: 0.3, exp: 1.15 },
  { e: -0.14, key: [0.6, 0.66, 0.98], keyI: 0.7, zen: [0.06, 0.08, 0.2], hor: [0.32, 0.25, 0.4], sky: [0.38, 0.36, 0.56], gnd: [0.08, 0.07, 0.1], hemi: 0.65, fog: 0.36, exp: 1.08 },
  { e: 0.0, key: [1.0, 0.5, 0.2], keyI: 1.6, zen: [0.22, 0.24, 0.44], hor: [0.98, 0.56, 0.26], sky: [0.72, 0.54, 0.52], gnd: [0.22, 0.15, 0.11], hemi: 0.95, fog: 0.42, exp: 1.0 },
  { e: 0.16, key: [1.0, 0.7, 0.4], keyI: 2.3, zen: [0.32, 0.44, 0.7], hor: [0.96, 0.72, 0.5], sky: [0.66, 0.66, 0.76], gnd: [0.32, 0.25, 0.18], hemi: 1.1, fog: 0.36, exp: 1.0 },
  { e: 0.45, key: [1.0, 0.93, 0.82], keyI: 2.9, zen: [0.24, 0.45, 0.78], hor: [0.66, 0.76, 0.86], sky: [0.56, 0.66, 0.82], gnd: [0.3, 0.27, 0.22], hemi: 0.9, fog: 0.28, exp: 1.0 },
  { e: 1.0, key: [1.0, 0.97, 0.92], keyI: 3.0, zen: [0.2, 0.42, 0.8], hor: [0.64, 0.76, 0.88], sky: [0.56, 0.68, 0.86], gnd: [0.3, 0.28, 0.22], hemi: 0.95, fog: 0.26, exp: 1.0 },
];
// Mornings run cooler and pinker than evenings, with a little more mist.
const DAWN = { key: [1.0, 0.66, 0.56], hor: [0.94, 0.7, 0.68], fog: 0.06 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as [number, number, number];
const srgb = (c: number[], k = 1) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).multiplyScalar(k);

/** Sunrise at 6, sunset at 19: thirteen hours of day (it is a tropical island), eleven of night. */
export const SUNRISE = 6, SUNSET = 19;
function arcAngle(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= SUNRISE && h <= SUNSET) return ((h - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI;
  return Math.PI + (((h - SUNSET + 24) % 24) / (24 - SUNSET + SUNRISE)) * Math.PI;
}

export function sunDirAt(hour: number) {
  const a = arcAngle(hour);
  return new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.93, -(Math.sin(a) * 0.42 + 0.12)).normalize();
}

export function lightingAt(hour: number): Lighting {
  const sunDir = sunDirAt(hour);
  const am = arcAngle(hour) - Math.PI; // the moon crosses the night sky as the sun crosses the day
  const moonDir = new THREE.Vector3(Math.cos(am), Math.sin(am) * 0.8, -(Math.sin(am) * 0.35 + 0.2)).normalize();
  const e = sunDir.y;
  let i = 0;
  while (i < KEYS.length - 2 && e > KEYS[i + 1].e) i++;
  const A = KEYS[i], B = KEYS[i + 1];
  const t = smooth(A.e, B.e, e);
  const morning = hour > 2 && hour < 12 ? smooth(0.5, 0.05, e) * smooth(-0.3, -0.05, e) : 0;
  let keyC = lerp3(A.key, B.key, t), hor = lerp3(A.hor, B.hor, t);
  keyC = lerp3(keyC, DAWN.key, morning * 0.6);
  hor = lerp3(hor, DAWN.hor, morning * 0.55);
  const sunI = smooth(-0.035, 0.03, e);
  const moonI = smooth(-0.035, -0.2, e);
  const sunUp = e > -0.035;
  const keyI = (A.keyI + (B.keyI - A.keyI) * t) * (sunUp ? sunI : moonI);
  const night = smooth(-0.02, -0.3, e);
  // Shadows lengthen as the light drops, but the light itself never grazes lower than ~21°, so
  // valleys fall into shade at golden hour without the whole island going dark.
  const keyDir = (sunUp ? sunDir : moonDir).clone();
  const MIN_Y = 0.36;
  if (keyDir.y < MIN_Y) { const f = Math.sqrt((1 - MIN_Y ** 2) / Math.max(1e-6, keyDir.x ** 2 + keyDir.z ** 2)); keyDir.set(keyDir.x * f, MIN_Y, keyDir.z * f); }
  return {
    hour, sunDir, moonDir, sunUp,
    keyDir,
    keyColor: srgb(keyC, keyI),
    keyAbove: srgb(keyC, keyI),
    hemiSky: srgb(lerp3(A.sky, B.sky, t)),
    hemiGround: srgb(lerp3(A.gnd, B.gnd, t)),
    hemiIntensity: A.hemi + (B.hemi - A.hemi) * t,
    zenith: srgb(lerp3(A.zen, B.zen, t)),
    horizon: srgb(hor),
    exposure: A.exp + (B.exp - A.exp) * t,
    fogK: A.fog + (B.fog - A.fog) * t + morning * DAWN.fog,
    night,
    overlayGlow: 0.1 + night * 0.38,
    cloudShadow: (sunUp ? 0.5 : 0.25) * smooth(0, 0.25, keyDir.y),
  };
}

// Scratch colors for weatherLight, so a frame allocates nothing.
const grey = new THREE.Color(), tint = new THREE.Color(), flashC = new THREE.Color();
const NEUTRAL = new THREE.Color(1, 1, 1), STORM = new THREE.Color(0.78, 0.93, 1.0);
/** Lightning: a cold blue-white. */
export const FLASH_COLOR = new THREE.Color(0.72, 0.8, 1.0);
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
export const addScaled = (c: THREE.Color, d: THREE.Color, s: number) => { c.r += d.r * s; c.g += d.g * s; c.b += d.b * s; return c; };
/** Pull a color toward a grey of the same brightness, tinted. */
const greyOut = (c: THREE.Color, t: number, k = 1) => { const l = lum(c) * k; c.lerp(grey.setRGB(l * tint.r, l * tint.g, l * tint.b), t); };

/**
 * Weather over the light, in place. Cloud takes the direct sun (patchy under broken cloud, an even
 * dimming under a full deck), lifts the ambient share, and greys the sky; storm cloud is darker and
 * a little blue-green. Rain and fog thicken the haze. A lightning flash briefly lifts sky and ambient.
 */
export function weatherLight(L: Lighting, w: WeatherLook, flash = 0) {
  const c = w.cover, k = w.dark;
  // Shadows under broken cloud; under a full deck the sun is simply dimmed. The key is scaled so the
  // light reaching the ground on average is the look's share of sun.
  L.cloudShadow *= 1 - 0.85 * smooth(0.72, 1, c);
  const keyK = clamp(w.sun / Math.max(0.05, 1 - L.cloudShadow * c), 0, 1);
  // By night the moon is the map's only light, so cloud takes much less of it: the map still reads.
  L.keyColor.multiplyScalar(keyK + (1 - keyK) * 0.6 * L.night);
  tint.copy(NEUTRAL).lerp(STORM, k);
  greyOut(L.hemiSky, c * 0.75);
  greyOut(L.hemiGround, c * 0.5);
  L.hemiSky.multiplyScalar(1 - 0.3 * k * c);
  L.hemiGround.multiplyScalar(1 - 0.25 * k * c);
  L.hemiIntensity *= 1 + 0.55 * c * (1 - 0.3 * k);
  // An overcast sky is brighter overhead than at the horizon, and grey right across.
  // Haze under a lid of cloud loses the low sun's color, and fog is pale through.
  greyOut(L.horizon, Math.min(1, c * 0.95 + 0.25 * w.fog), 1 - 0.1 * c);
  const hl = lum(L.horizon);
  greyOut(L.zenith, c * 0.9);
  L.zenith.lerp(grey.setRGB(hl * tint.r, hl * tint.g, hl * tint.b).multiplyScalar(1.12), c * 0.75);
  const dim = 1 - 0.62 * k * c;
  L.horizon.multiplyScalar(dim); L.zenith.multiplyScalar(dim * (1 - 0.12 * k));
  L.exposure *= 1 - 0.08 * c - 0.05 * k;
  L.fogK *= 1 + 0.5 * w.rain + 0.4 * w.fog;
  L.overlayGlow += 0.14 * c * k;
  if (flash > 0) {
    flashC.copy(FLASH_COLOR).multiplyScalar(flash);
    addScaled(L.hemiSky, flashC, 0.45); L.hemiIntensity += flash * 0.35;
    addScaled(L.zenith, flashC, 0.16); addScaled(L.horizon, flashC, 0.1);
  }
}

/** Names for the hours, for the clock. */
export function partOfDay(hour: number) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 4.8) return 'Night';
  if (h < 6.9) return 'Dawn';
  if (h < 11) return 'Morning';
  if (h < 14) return 'Noon';
  if (h < 17.4) return 'Afternoon';
  if (h < 18.6) return 'Golden hour';
  if (h < 19.9) return 'Dusk';
  return 'Night';
}

/** A dome behind everything: sky gradient, sun and moon discs, a few stars at night; cloud hides the discs and stars. */
export function makeSkyDome() {
  const uniforms = {
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() },
    uSunColor: { value: new THREE.Color() }, uNight: { value: 0 }, uCover: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uZenith, uHorizon, uSunDir, uMoonDir, uSunColor;
      uniform float uNight, uCover;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, max(d.y, 0.0)));
        // Through broken cloud the discs still show; a full deck hides them, leaving a faint glow.
        float clear = 1.0 - smoothstep(0.4, 0.88, uCover);
        float s = max(dot(d, uSunDir), 0.0);
        c += uSunColor * (smoothstep(0.9993, 0.9997, s) * 6.0 * clear + pow(s, 48.0) * 0.25 * (0.3 + 0.7 * clear)) * (1.0 - uNight);
        float m = max(dot(d, uMoonDir), 0.0);
        c += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99955, 0.9998, m) * 1.6 * clear + pow(m, 90.0) * 0.08) * uNight;
        vec3 q = floor(d * 420.0);
        c += vec3(step(0.9985, hash(q)) * uNight * smoothstep(0.05, 0.3, d.y) * 0.9 * clear);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}
