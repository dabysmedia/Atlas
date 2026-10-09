/**
 * Weather over the island: a drifting deck of clouds, the shadows they throw, and low mist that
 * rolls through the valleys, thickest over swamp and jungle and at dawn, and everywhere in fog.
 *
 * Clouds live on a square tile that repeats around the map and slides with the wind. Where there is
 * cloud comes from one density field on that tile: clusters of puffs plus broad noise. The weather's
 * cover picks a threshold on the field (from its measured distribution, so a cover of 0.3 really
 * clouds 30% of the sky), and everything reads that same thresholded field: the cumulus puffs (one
 * instanced draw of soft billboards, each shown as far as the field is cloudy where it sits), a flat
 * deck layer that fills in between them as the cover closes, and the shadows on the ground and sea,
 * offset along the light. So a shadow always sits under its cloud at every cover; where the cloud
 * parts for the camera coming down, or a gale shreds it, its shadow goes with it. Mist is
 * exponential height fog with its density taken from a biome map and two layers of noise moving with
 * the wind, integrated along the view ray; borders and labels drawn on the map show through it.
 */
import * as THREE from 'three';
import type { HeightField } from './heightfield';
import type { Lighting } from './sky';
import { FLASH_COLOR, lum, liftTo } from './sky';
import type { WeatherLook } from '../../../shared/weather';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** How readily mist gathers over each kind of ground (by terrain key; unknown keys get a middling value). */
export function mistWeight(terrain: string) {
  const t = terrain.toLowerCase();
  if (/swamp|marsh|bog|fen|mire/.test(t)) return 1;
  if (/jungle|rainforest/.test(t)) return 0.85;
  if (/forest|wood|grove/.test(t)) return 0.7;
  if (/deep|abyss/.test(t)) return 0.12;
  if (/water|ocean|sea|lake|coast|river|reef|shallow/.test(t)) return 0.28;
  if (/grass|plain|farm|meadow|field|hill/.test(t)) return 0.4;
  if (/mountain|peak|cliff|volcan/.test(t)) return 0.22;
  if (/desert|sand|dune|waste|badland/.test(t)) return 0.08;
  return 0.35;
}

/** GLSL shared by the ground, the sea and the clouds: noise, cloud cover and shadow, mist, lightning. */
export const ATMOS_GLSL = /* glsl */`
uniform float uAtmTime, uAtmOn, uCloudShadow, uMistDensity, uMistHeight, uSeaY;
uniform vec2 uWind, uCloudOff, uMistOff;
uniform vec2 uCloudNear; // view depths over which cloud parts as the camera comes down
uniform vec4 uCloudTile; // origin x, origin z, size, cloud base altitude
uniform vec4 uCloudCov; // field threshold low, high; how torn; density where cloud is thickest
uniform vec4 uTornM; // wind-aligned stretch for torn cloud, as a 2x2 matrix
uniform sampler2D uCloudMap, uMistMap, uAtmOverlay; // the overlay is the map drawn on the ground
uniform vec4 uAtmOvRect;
uniform vec4 uMistRect, uMistFx; // fx: how much fog lies over everything, opacity cap, layer height scale, thinning over the sea
uniform vec3 uAtmKeyDir, uMistColor, uFlashCol;
uniform vec4 uFlash; // lightning: x, z, reach, brightness
float atmHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float atmNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(atmHash(i), atmHash(i + vec2(1, 0)), u.x), mix(atmHash(i + vec2(0, 1)), atmHash(i + vec2(1, 1)), u.x), u.y);
}
float atmFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * atmNoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 3.1; a *= 0.5; }
  return s;
}
/** The cloud field at this point of the deck (r: density, g: fine detail), torn by a gale. */
vec2 cloudFieldAt(vec2 p) {
  vec2 q = (p - uCloudOff - uCloudTile.xy) / uCloudTile.z;
  vec2 f = texture2D(uCloudMap, q).rg;
  if (uCloudCov.z > 0.0) f.r -= uCloudCov.z * (texture2D(uCloudMap, mat2(uTornM.xy, uTornM.zw) * q).b - 0.38) * 0.5;
  return f;
}
/** How much cloud there is overhead at this point of the cloud deck (0 open sky .. 1 solid cloud). */
float cloudCoverAt(vec2 p) {
  return uAtmOn * smoothstep(uCloudCov.x, uCloudCov.y, cloudFieldAt(p).r);
}
/** Where a gale shreds the cloud into streaks (1 whole); the puffs read the same mask per pixel. */
vec2 cloudTearUv(vec2 p) { return mat2(uTornM.xy, uTornM.zw) * (p - uCloudOff - uCloudTile.xy) / uCloudTile.z * 2.0; }
float cloudTearAt(vec2 p) {
  return uCloudCov.z > 0.0 ? mix(1.0, smoothstep(0.4, 0.56, texture2D(uCloudMap, cloudTearUv(p)).b), uCloudCov.z * 0.9) : 1.0;
}
/** How far cloud at this point of the deck is drawn: it parts where the camera comes down through it. */
float cloudNearFade(vec2 p) {
  return smoothstep(uCloudNear.x, uCloudNear.y, -(viewMatrix * vec4(p.x, uCloudTile.w, p.y, 1.0)).z);
}
/** 1 in sunlight, lower under a cloud: the cloud as drawn, shredded in a gale and gone where it has parted for the camera. */
float cloudShadowAt(vec3 wp) {
  if (uCloudShadow <= 0.0 || uAtmOn < 0.5) return 1.0;
  vec3 L = uAtmKeyDir;
  vec2 p = wp.xz + L.xz / max(L.y, 0.25) * (uCloudTile.w - wp.y);
  // A softer edge than the cloud's own, as light spreads past it on the way down.
  float m = 0.5 * (uCloudCov.x + uCloudCov.y), hw = 1.5 * (uCloudCov.y - uCloudCov.x);
  float c = smoothstep(m - hw, m + hw, cloudFieldAt(p).r) * cloudTearAt(p);
  return 1.0 - uCloudShadow * c * cloudNearFade(p);
}
/** Lightning light falling on this point (0 when no flash). */
float flashAt(vec3 wp) {
  if (uFlash.w <= 0.0) return 0.0;
  vec2 d = (wp.xz - uFlash.xy) / uFlash.z;
  return uFlash.w * exp(-dot(d, d));
}
/** How much rolling mist lies between the eye and this point (0..1). */
float mistAt(vec3 wp, vec3 eye) {
  if (uAtmOn < 0.5 || uMistDensity <= 0.0) return 0.0;
  vec2 muv = (wp.xz - uMistRect.xy) / uMistRect.zw;
  vec2 mm = (muv.x < 0.0 || muv.y < 0.0 || muv.x > 1.0 || muv.y > 1.0) ? vec2(0.1, 0.0) : texture2D(uMistMap, muv).rg;
  float biome = mm.x; // mm.y: land (1) or sea (0)
  // Fog weather lies on everything, the open sea included.
  biome = mix(biome, 0.75, uMistFx.x);
  if (uMistDensity * biome < 0.004) return 0.0;
  vec2 q = (wp.xz - uMistOff) * 0.0021;
  float roll = atmFbm(q) * 0.62 + atmFbm(q * 2.7 + vec2(5.2, 1.3) + uAtmTime * 0.012) * 0.38;
  roll = smoothstep(0.3, 0.78, roll);
  roll = mix(roll, 0.45 + 0.55 * roll, uMistFx.x * 0.8);
  float rho = uMistDensity * biome * (0.04 + 1.7 * roll);
  float H = uMistHeight * uMistFx.z;
  float h0 = max(wp.y - uSeaY, 0.0), h1 = max(eye.y - uSeaY, 0.0);
  float len = length(eye - wp), dh = h1 - h0;
  // Optical depth through an exponential layer: density rho/H at sea level, falling off with height H.
  float od = abs(dh) > 0.5 ? rho * len / dh * (exp(-h0 / H) - exp(-h1 / H)) : rho / H * len * exp(-h0 / H);
  // Fog lies thinner on the water, so the coastline and the borders drawn on the sea still read.
  // (Land and sea come from the mist map, not the height here, which the waves raise.)
  float cap = uMistFx.y * (1.0 - uMistFx.w * (1.0 - mm.y));
  float m = clamp(1.0 - exp(-od), 0.0, cap);
  if (m < 0.02) return m;
  // Borders and labels drawn on the map, land or sea, show through it; through fog weather almost
  // wholly, as the fog is pale and so are many of the labels.
  vec2 ouv = (wp.xz - uAtmOvRect.xy) / uAtmOvRect.zw;
  float ova = (ouv.x < 0.0 || ouv.y < 0.0 || ouv.x > 1.0 || ouv.y > 1.0) ? 0.0 : texture2D(uAtmOverlay, ouv).a;
  return m * (1.0 - mix(0.5, 0.9, uMistFx.x) * ova);
}
`;

/**
 * For the clouds: how strongly the map drawn on the ground below a point (borders, labels) shows
 * there, read from the draped overlay where the view ray meets the ground, blurred into a soft halo.
 */
const MAP_UV_GLSL = /* glsl */`
uniform sampler2D uOverlay; uniform vec4 uOverlayRect; uniform float uGroundY;
vec2 groundUv(vec3 wp) {
  vec3 d = wp - cameraPosition;
  vec3 g = cameraPosition + d * ((cameraPosition.y - uGroundY) / max(cameraPosition.y - wp.y, 1e-3));
  return (g.xz - uOverlayRect.xy) / uOverlayRect.zw;
}
`;
const MAP_SHOW_GLSL = MAP_UV_GLSL + /* glsl */`
float mapShowAt(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  // Lines and lettering rather than the broad territory washes: what stands out from its blurred
  // surroundings, plus anything solid.
  float a = texture2D(uOverlay, uv, 1.0).a, blur = texture2D(uOverlay, uv, 4.5).a;
  return max(smoothstep(0.04, 0.24, a - blur), smoothstep(0.6, 0.9, blur));
}
`;

type Puff = { x: number; y: number; z: number; size: number; seed: number; shade: number };

/** The weather the sky shows this frame. */
export type SkyWeather = { look: WeatherLook; flash: number; flashX: number; flashZ: number; flashR: number };

const FIELD = 512;

export class Atmosphere {
  readonly uniforms = {
    uAtmTime: { value: 0 }, uAtmOn: { value: 1 }, uCloudShadow: { value: 0.4 }, uMistDensity: { value: 0.5 }, uMistHeight: { value: 20 },
    uSeaY: { value: 0 }, uWind: { value: new THREE.Vector2(9, 4) }, uCloudNear: { value: new THREE.Vector2(0, 1) },
    uCloudOff: { value: new THREE.Vector2() }, uMistOff: { value: new THREE.Vector2() },
    uCloudTile: { value: new THREE.Vector4(0, 0, 1, 100) }, uCloudMap: { value: null as THREE.Texture | null },
    uCloudCov: { value: new THREE.Vector4(0.6, 0.7, 0, 0) }, uTornM: { value: new THREE.Vector4(1, 0, 0, 1) },
    uMistMap: { value: null as THREE.Texture | null }, uMistRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uMistFx: { value: new THREE.Vector4(0, 0.72, 1, 0) },
    uAtmKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uMistColor: { value: new THREE.Color() },
    uFlash: { value: new THREE.Vector4(0, 0, 1, 0) }, uFlashCol: { value: FLASH_COLOR.clone() },
    uAtmOverlay: { value: null as THREE.Texture | null }, uAtmOvRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
  /** Puffs and the deck under them. */
  readonly clouds = new THREE.Group();
  protected puffs: THREE.Mesh;
  protected deck: THREE.Mesh;
  protected cloudMat: THREE.ShaderMaterial;
  protected deckMat: THREE.ShaderMaterial;
  protected cloudMapTex: THREE.DataTexture | null = null;
  protected mistTex: THREE.CanvasTexture | null = null;
  protected puffTex = puffAtlas();
  protected fieldSig = '';
  /** The field's distribution: quant[i] is the density that a share i/(n-1) of the tile lies below. */
  protected quant = new Float32Array(65);
  protected span = 1;
  /** How thick fog weather lies, relative to the mist's usual layer: down in the valleys, below the ridges. */
  protected fogScale = 1;
  protected amb = new THREE.Color();
  protected tmp = new THREE.Color();
  protected mapShow: { uOverlay: { value: THREE.Texture | null }; uOverlayRect: { value: THREE.Vector4 }; uGroundY: { value: number } };
  on = true;

  constructor() {
    const shared = {
      uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() },
      uOverlay: { value: null as THREE.Texture | null }, uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uGroundY: { value: 0 },
    };
    this.mapShow = shared;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uPuffs: { value: this.puffTex }, uOpacity: { value: 1 }, uMapShow: { value: 0.6 }, uThinOut: { value: 0 }, uRim: { value: new THREE.Color() }, uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uStretch: { value: 1 },
      }]),
      transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        ${ATMOS_GLSL}
        ${MAP_UV_GLSL}
        attribute vec3 aPos; attribute vec3 aMeta; // size, seed, shade
        uniform float uStretch, uThinOut;
        varying vec2 vUv, vTornUv, vMapUv; varying float vAlpha, vShade, vSeed; varying vec3 vWp;
        void main() {
          vec3 c = aPos;
          c.y += uCloudTile.w;
          c.xz = uCloudTile.xy + mod(c.xz + uCloudOff - uCloudTile.xy, uCloudTile.z);
          vec2 e = (c.xz - uCloudTile.xy) / uCloudTile.z;
          float edge = smoothstep(0.0, 0.1, e.x) * smoothstep(1.0, 0.9, e.x) * smoothstep(0.0, 0.1, e.y) * smoothstep(1.0, 0.9, e.y);
          // A puff shows as far as the cloud field is cloudy where it sits, and grows with it.
          float cov = cloudCoverAt(c.xz);
          vec4 mvPosition = modelViewMatrix * vec4(c, 1.0);
          float a = aMeta.y * 6.2831853 + uAtmTime * 0.004 * (aMeta.y - 0.5);
          vec2 r = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
          // A gale draws the puffs out along the wind.
          if (uStretch > 1.0) {
            vec2 w = (viewMatrix * vec4(uWind.x, 0.0, uWind.y, 0.0)).xy;
            w = length(w) > 1e-4 ? normalize(w) : vec2(1.0, 0.0);
            vec2 wn = vec2(-w.y, w.x);
            r = w * dot(r, w) * uStretch + wn * dot(r, wn) / sqrt(uStretch);
          }
          vec2 off = r * aMeta.x * (0.4 + 0.6 * cov);
          mvPosition.xy += off;
          // Where this corner lies on the deck, for shredding torn cloud (the view's inverse rotation is its transpose).
          vec3 corner = c + transpose(mat3(viewMatrix)) * vec3(off, 0.0);
          vTornUv = cloudTearUv(corner.xz);
          vMapUv = groundUv(corner);
          // Clouds part as the camera comes down through them.
          vAlpha = edge * smoothstep(0.12, 0.7, cov) * smoothstep(uCloudNear.x, uCloudNear.y, -mvPosition.z);
          vAlpha *= smoothstep(uThinOut - 0.1, uThinOut + 0.1, fract(aMeta.y * 13.7));
          vUv = position.xy + 0.5; vShade = aMeta.z; vSeed = aMeta.y; vWp = c;
          gl_Position = projectionMatrix * mvPosition;
          // Puffs with nothing to show cost no pixels.
          if (vAlpha < 0.004) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        ${ATMOS_GLSL}
        ${MAP_SHOW_GLSL}
        uniform sampler2D uPuffs; uniform float uOpacity, uMapShow; uniform vec3 uLit, uShade, uRim, uKeyDir;
        varying vec2 vUv, vTornUv, vMapUv; varying float vAlpha, vShade, vSeed; varying vec3 vWp;
        void main() {
          vec2 cell = vec2(floor(vSeed * 3.99), 0.0);
          cell.y = floor(cell.x / 2.0); cell.x = mod(cell.x, 2.0);
          vec4 t = texture2D(uPuffs, (vUv + cell) * 0.5);
          float a = t.a * vAlpha * uOpacity;
          // A gale shreds the puffs into streaks along the wind.
          if (uCloudCov.z > 0.0) a *= mix(1.0, smoothstep(0.4, 0.56, texture2D(uCloudMap, vTornUv).b), uCloudCov.z * 0.9);
          // Borders and labels on the map below stay readable through the cloud.
          a *= 1.0 - uMapShow * mapShowAt(vMapUv);
          if (a < 0.004) discard;
          // t.r: how much of the puff faces up into the light; vShade: how high in its cloud it sits.
          float lit = clamp(t.r * 0.75 + vShade * 0.45, 0.0, 1.0);
          vec3 V = normalize(cameraPosition - vWp);
          float rim = pow(max(dot(-V, uKeyDir), 0.0), 6.0) * (1.0 - t.a) * 2.0;
          vec3 col = mix(uShade, uLit, lit) + uRim * rim;
          // Lightning lights the cloud from inside, most where it is thick.
          col += uFlashCol * flashAt(vWp) * (0.5 + 0.9 * t.a);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.deckMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uOpacity: { value: 0 }, uMapShow: { value: 0.6 }, uSolid: { value: 0 }, uDeckRim: { value: new THREE.Vector4(0, 0, 1, 2) } }]),
      transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        varying vec3 vWp; varying float vDepth;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWp = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          vDepth = -mvPosition.z; // affine over the plane, so it interpolates exactly
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        ${ATMOS_GLSL}
        ${MAP_SHOW_GLSL}
        uniform float uOpacity, uMapShow, uSolid; uniform vec3 uLit, uShade; uniform vec4 uDeckRim;
        varying vec3 vWp; varying float vDepth;
        void main() {
          // Parts as the camera comes down, and fades out far past the map, where the plane ends.
          float vFade = smoothstep(uCloudNear.x, uCloudNear.y, vDepth) * (1.0 - smoothstep(uDeckRim.z, uDeckRim.w, length(vWp.xz - uDeckRim.xy)));
          if (vFade < 0.004) discard;
          vec2 f = cloudFieldAt(vWp.xz);
          float cov = smoothstep(uCloudCov.x, uCloudCov.y, f.r);
          if (cov < 0.004) discard;
          // Thicker toward the middle of a cloud; a step toward the light that climbs into thicker
          // cloud means this side is in its own shade.
          // Body: thickest in the middle of a cloud; a closed deck is a quilt of cells instead.
          float thick = mix(smoothstep(uCloudCov.x, uCloudCov.w, f.r), smoothstep(0.2, 0.8, f.g * 0.75 + f.r * 0.4), uSolid);
          // Lumpy cells: a step toward the light that climbs into thicker cloud means this side is
          // in its own shade.
          vec2 t = cloudFieldAt(vWp.xz + uAtmKeyDir.xz * uCloudTile.z * 0.006);
          float relief = clamp(0.5 + (f.r + 0.35 * f.g - t.r - 0.35 * t.g) * 5.0, 0.0, 1.0);
          float lit = cameraPosition.y > vWp.y
            ? clamp(0.12 + 0.55 * relief + 0.3 * f.g + 0.12 * thick, 0.0, 1.0)
            : clamp(0.36 + 0.3 * f.g - 0.32 * thick, 0.0, 1.0);
          vec3 col = mix(uShade, uLit, lit);
          col += uFlashCol * flashAt(vWp) * (0.45 + 0.6 * thick);
          // Thin places in the deck let the map through, and so do its borders and labels.
          float a = cov * uOpacity * vFade * mix(0.25, 1.0, thick * thick) * mix(0.5, 1.2, f.g);
          gl_FragColor = vec4(col, a * (1.0 - uMapShow * mapShowAt(groundUv(vWp))));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(this.cloudMat.uniforms, this.uniforms, shared);
    Object.assign(this.deckMat.uniforms, this.uniforms, shared);
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.puffs = new THREE.Mesh(geo, this.cloudMat);
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 5;
    this.deck = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.deckMat);
    this.deck.frustumCulled = false;
    this.deck.renderOrder = 4;
    this.clouds.add(this.deck, this.puffs);
  }

  /** Lay out clouds and the mist map for a ground. */
  build(hf: HeightField, sea: number, bounds: { minX: number; minY: number; maxX: number; maxY: number },
    hexes: { cx: number; cy: number; terrain: string }[], hexSize: number) {
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minY + bounds.maxY) / 2;
    const relief = Math.max(hf.maxH - sea, hexSize);
    const T = span * 2.6;
    const alt = sea + Math.max(relief * 1.25, span * 0.055);
    this.span = span;
    this.uniforms.uSeaY.value = sea;
    const mistH = this.uniforms.uMistHeight.value = Math.max(6, relief * 0.13);
    // Fog fills the land up to about its middle height, whatever the tallest peak.
    const land: number[] = [];
    for (let k = 0; k < hf.data.length; k += 7) if (hf.data[k] > sea + 0.5) land.push(hf.data[k] - sea);
    land.sort((a, b) => a - b);
    this.fogScale = clamp((land.length ? land[land.length >> 1] : mistH) * 0.9, 6, mistH * 1.5) / mistH;
    // Puffs sit at heights above the base, so a change of relief (painting mountains) only moves the base.
    this.uniforms.uCloudTile.value.set(cx - T / 2, cz - T / 2, T, alt);
    this.uniforms.uWind.value.set(span * 0.0032, span * 0.0014);
    this.deck.position.set(cx, alt, cz);
    this.deck.scale.set(span * 9, 1, span * 9);
    (this.deckMat.uniforms.uDeckRim.value as THREE.Vector4).set(cx, cz, span * 2.4, span * 4.4);
    // Torn cloud: the streak noise is read stretched along the wind.
    const wa = Math.atan2(this.uniforms.uWind.value.y, this.uniforms.uWind.value.x);
    const ca = Math.cos(wa), sa = Math.sin(wa);
    this.uniforms.uTornM.value.set(ca * 0.7, -sa * 2.6, sa * 0.7, ca * 2.6);

    // Clouds: clusters of puffs and the field they make, seeded by the map's size so a world always
    // gets the same sky. Only the mist below depends on the terrain, so painting hexes doesn't
    // rebuild the sky (the field takes a noticeable moment to make).
    const sig = `${Math.round(span)}|${cx.toFixed(1)},${cz.toFixed(1)}`;
    if (sig !== this.fieldSig) {
      this.fieldSig = sig;
      let seed = Math.round(span) * 7919 + 101;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed & 0xffffff) / 0x1000000; };
      const puffs: Puff[] = [];
      for (let c = 0; c < 84; c++) {
        const ox = rnd() * T, oz = rnd() * T;
        const R = span * (0.05 + rnd() * 0.08);
        const n = 14 + Math.floor(rnd() * 14);
        const thick = R * (0.28 + rnd() * 0.25);
        for (let i = 0; i < n; i++) {
          const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd());
          const h = rnd();
          // Fuller in the middle and on top; a flat base.
          const sx = Math.cos(a) * d * R * 1.15, sz = Math.sin(a) * d * R * 0.8;
          const y = thick * h * (1 - d * 0.6);
          puffs.push({ x: cx - T / 2 + ox + sx, y, z: cz - T / 2 + oz + sz, size: R * (0.55 + rnd() * 0.6) * (1 - d * 0.35), seed: rnd(), shade: h * 0.7 + (1 - d) * 0.3 });
        }
      }
      const pos = new Float32Array(puffs.length * 3), meta = new Float32Array(puffs.length * 3);
      puffs.forEach((p, i) => { pos.set([p.x, p.y, p.z], i * 3); meta.set([p.size, p.seed, p.shade], i * 3); });
      const geo = this.puffs.geometry as THREE.InstancedBufferGeometry;
      geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
      geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(meta, 3));
      geo.instanceCount = puffs.length;
      this.cloudMapTex?.dispose();
      this.cloudMapTex = this.cloudField(puffs, cx - T / 2, cz - T / 2, T, rnd);
      this.uniforms.uCloudMap.value = this.cloudMapTex;
    }

    // Mist: each hex's readiness for mist, softly blended into its neighbours.
    const pad = hexSize * 4;
    const rx = bounds.minX - pad, rz = bounds.minY - pad, rw = bounds.maxX - bounds.minX + pad * 2, rh = bounds.maxY - bounds.minY + pad * 2;
    const M = 512, mh = Math.max(64, Math.round((M * rh) / rw));
    const mc = document.createElement('canvas');
    mc.width = M; mc.height = mh;
    const m = mc.getContext('2d')!;
    m.fillStyle = 'rgb(26,26,26)'; m.fillRect(0, 0, M, mh);
    const s = M / rw, r = hexSize * 1.7 * s;
    for (const h of hexes) {
      const w = Math.round(mistWeight(h.terrain) * 255), x = (h.cx - rx) * s, y = (h.cy - rz) * s;
      const gr = m.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${w},${w},${w},0.85)`); gr.addColorStop(1, `rgba(${w},${w},${w},0)`);
      m.fillStyle = gr; m.beginPath(); m.arc(x, y, r, 0, Math.PI * 2); m.fill();
    }
    // Green: how far each point is land, from the ground's height, so mistAt can tell land from sea
    // without the waves' height fooling it.
    const img = m.getImageData(0, 0, M, mh), px = img.data;
    for (let j = 0; j < mh; j++) for (let i = 0; i < M; i++) {
      const g = hf.at(rx + (i + 0.5) / s, rz + (j + 0.5) / s) - sea;
      px[(j * M + i) * 4 + 1] = Math.round(clamp((g - 1.5) / 2.5, 0, 1) * 255);
    }
    m.putImageData(img, 0, 0);
    this.mistTex?.dispose();
    const mt = new THREE.CanvasTexture(mc);
    mt.colorSpace = THREE.NoColorSpace;
    this.mistTex = mt;
    this.uniforms.uMistMap.value = mt;
    this.uniforms.uMistRect.value.set(rx, rz, rw, rh);
  }

  /**
   * The cloud field on the repeating tile. Red: density, the puff clusters (as the shadows always
   * were) over broad noise, so clusters come first as the cover opens and the noise fills the gaps
   * as it closes. Green: fine detail for the deck. Blue: streaky noise for torn cloud.
   */
  protected cloudField(puffs: Puff[], ox: number, oz: number, T: number, rnd: () => number) {
    const N = FIELD;
    const cl = new Float32Array(N * N);
    for (const p of puffs) {
      const u = ((p.x - ox) / T) * N, v = ((p.z - oz) / T) * N, r = (p.size / T) * N * 0.6;
      const r0 = Math.floor(-r), r1 = Math.ceil(r);
      for (let j = r0; j <= r1; j++) for (let i = r0; i <= r1; i++) {
        const x = Math.floor(u) + i, y = Math.floor(v) + j;
        const d = Math.hypot(x + 0.5 - u, y + 0.5 - v) / r;
        if (d >= 1) continue;
        cl[(((y % N) + N) % N) * N + (((x % N) + N) % N)] += 0.4 * (1 - d);
      }
    }
    const broad = new Float32Array(N * N), fine = new Float32Array(N * N), torn = new Float32Array(N * N);
    for (const [p, a] of [[3, 0.5], [6, 0.26], [12, 0.13], [24, 0.07], [48, 0.04]]) periodicNoise(N, p, p, rnd, broad, a);
    for (const [p, a] of [[32, 0.5], [64, 0.3], [128, 0.2]]) periodicNoise(N, p, p, rnd, fine, a);
    for (const [p, a] of [[12, 0.45], [24, 0.28], [48, 0.17], [96, 0.1]]) periodicNoise(N, p, p, rnd, torn, a);
    const norm = (f: Float32Array) => {
      let lo = Infinity, hi = -Infinity;
      for (const v of f) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      for (let k = 0; k < f.length; k++) f[k] = (f[k] - lo) / Math.max(1e-6, hi - lo);
    };
    norm(broad); norm(fine); norm(torn);
    const data = new Uint8Array(N * N * 4);
    // Density is stored in 256 steps, so its distribution is exactly a 256-bin histogram.
    const hist = new Uint32Array(256);
    for (let k = 0; k < N * N; k++) {
      const d = Math.round((0.58 * smooth(0.08, 0.7, cl[k]) + 0.42 * broad[k]) * 255);
      hist[d]++;
      data[k * 4] = d; data[k * 4 + 1] = fine[k] * 255; data[k * 4 + 2] = torn[k] * 255; data[k * 4 + 3] = 255;
    }
    for (let i = 0, b = 0, below = hist[0]; i < this.quant.length; i++) {
      const rank = Math.round((i / (this.quant.length - 1)) * (N * N - 1));
      while (below <= rank && b < 255) below += hist[++b];
      this.quant[i] = b / 255;
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** How far out the camera is: 0 close in, 1 at the whole-island view. */
  farness(camDist: number) { return 1 - smooth(1.5, 0.6, camDist / this.span); }

  /** The draped map overlay, so its borders and labels can show through the clouds. */
  setOverlay(tex: THREE.Texture | null, rect: THREE.Vector4) {
    this.mapShow.uOverlay.value = this.uniforms.uAtmOverlay.value = tex;
    this.mapShow.uOverlayRect.value = this.uniforms.uAtmOvRect.value = rect;
  }

  /** The field density below which a share `f` of the tile lies. */
  protected quantile(f: number) {
    const q = this.quant, x = clamp(f, 0, 1) * (q.length - 1), i = Math.min(q.length - 2, Math.floor(x));
    return q[i] + (q[i + 1] - q[i]) * (x - i);
  }

  /** Follow the time of day, the weather and the camera. `dt` is seconds since the last frame. */
  update(now: number, dt: number, L: Lighting, camDist: number, zoom: number, groundY: number, wx: SkyWeather) {
    const u = this.uniforms, w = wx.look;
    this.mapShow.uGroundY.value = groundY;
    u.uAtmTime.value = now / 1000;
    u.uAtmOn.value = this.on ? 1 : 0;
    u.uAtmKeyDir.value.copy(L.keyDir);
    // Cloud and mist drift with the wind, integrated so a change of wind never jumps them.
    const gust = 0.4 + 0.6 * (w.wind / 0.3) ** 1.5;
    u.uCloudOff.value.addScaledVector(u.uWind.value, gust * dt);
    u.uMistOff.value.addScaledVector(u.uWind.value, 1.6 * (0.3 + 0.7 * gust) * dt);
    // Cover picks the threshold on the field: the share of sky under cloud is the cover. A full
    // cover drops the threshold below the whole field, for an unbroken deck.
    // A clear sky keeps only a few small clouds.
    const c = w.cover, ce = c * (0.4 + 0.6 * smooth(0.04, 0.3, c)), soft = 0.07 + 0.05 * c;
    const mid = this.quantile(1 - ce) - smooth(0.9, 1, c) * 0.3;
    // Only a gale tears the cloud; a storm's deck stays whole.
    u.uCloudCov.value.set(mid - soft * 0.5, mid + soft * 0.5, smooth(0.86, 1, w.wind), this.quantile(0.97));

    const h = L.hour;
    // Mist pools before dawn and lifts by late morning; a little returns in the evening. Rain hazes
    // the air; fog weather fills the valleys and lies on the sea, the peaks standing out of it.
    const dd = Math.min(Math.abs(h - 6.2), 24 - Math.abs(h - 6.2));
    const dawn = Math.exp(-(dd ** 2) / 4.5);
    const evening = Math.exp(-((h - 20.5) ** 2) / 6);
    const usual = (0.12 + 0.65 * dawn + 0.3 * evening + 0.22 * L.night) * (1 + 0.3 * w.rain) + 0.12 * w.rain;
    // From the whole-island view fog lies lighter, so the map under it still reads. Fog weather and
    // the usual dawn mist don't stack: whichever is thicker lies there.
    const nearIn = smooth(1.5, 0.6, camDist / this.span);
    const fogW = w.fog * w.fog;
    u.uMistDensity.value = this.on ? Math.max(usual, fogW) * (1 - 0.55 * fogW * (1 - nearIn)) : 0;
    // The cap keeps the land faintly readable through the thickest fog; on the water fog lies
    // thinner still, so the coastline and the borders over the sea hold.
    u.uMistFx.value.set(fogW, 0.72 + 0.02 * w.fog - 0.2 * fogW * (1 - nearIn), (1 + 0.4 * w.rain) * (1 + (this.fogScale - 1) * w.fog), 0.4 * fogW);
    // In fog the drama is low down: the cloud above thins (and so do its shadows) to let it show.
    const veil = 1 - 0.8 * w.fog;
    u.uCloudShadow.value = this.on ? L.cloudShadow * veil : 0;
    const amb = this.amb.copy(L.hemiSky).multiplyScalar(L.hemiIntensity);
    u.uMistColor.value.copy(amb).multiplyScalar(0.75).add(this.tmp.copy(L.keyColor).multiplyScalar(0.16 * Math.max(L.keyDir.y, 0.2)));
    u.uMistColor.value.lerp(L.horizon, 0.35);
    u.uFlash.value.set(wx.flashX, wx.flashZ, wx.flashR, this.on ? wx.flash : 0);

    const cu = this.cloudMat.uniforms;
    cu.uKeyDir.value.copy(L.keyDir);
    // Rain cloud is grey through; storm cloud is slate, darkest underneath.
    const dark = w.dark;
    // Cloud tops stand above the weather in full sun; storm cloud still reads dark from above.
    cu.uLit.value.copy(L.keyAbove).multiplyScalar(0.42 * (1 - 0.8 * dark)).add(this.tmp.copy(amb).multiplyScalar(0.8)).multiplyScalar(1 - 0.6 * dark);
    cu.uShade.value.copy(amb).multiplyScalar(0.62).lerp(L.horizon, 0.25).multiplyScalar(1 - 0.65 * dark);
    // Cloud never reads darker than the lit ground under it, so a storm by night veils the map
    // rather than blacking it out.
    const ground = 0.1 * (lum(amb) + lum(L.keyColor) * Math.max(L.keyDir.y, 0.2));
    liftTo(cu.uShade.value, ground); liftTo(cu.uLit.value, ground * 1.3);
    cu.uRim.value.copy(L.keyColor).multiplyScalar(0.35);
    cu.uStretch.value = 1 + 0.6 * smooth(0.86, 1, w.wind);
    // The deck shows from far out and parts as the camera comes down; it never sits on the hexcrawl.
    // Closer in than the whole-island view, the cloud over the place looked at clears and the sky
    // stays in the distance, so the map stays usable under any weather.
    // The cloud shadows part with it (cloudShadowAt reads the same depths).
    u.uCloudNear.value.set(camDist * (0.5 + 0.32 * nearIn), camDist * (0.85 + 0.4 * nearIn));
    // Seen from far above, a heavy sky veils the island without hiding the map drawn on it; by
    // night, when the map has least light to show by, storm cloud veils it less.
    const thin = (1 - smooth(2.4, 4.2, zoom) * 0.6) * veil * (1 - 0.5 * L.night * dark);
    // Cumulus for fair skies; under a full deck they sink into it, though a storm keeps its towers.
    cu.uOpacity.value = this.on ? 0.9 * thin * (1 - 0.35 * smooth(0.4, 0.8, c) - 0.4 * smooth(0.85, 1, c) + 0.25 * w.lightning) : 0;
    // The flat deck only fills in once the sky is closing; clear and fair skies are cumulus alone.
    this.deckMat.uniforms.uOpacity.value = this.on ? thin * (0.3 + 0.32 * smooth(0.3, 0.9, c)) * smooth(0.32, 0.5, c) : 0;
    this.deckMat.uniforms.uSolid.value = smooth(0.7, 1, c);
    // Under a closing deck fewer cumulus stand out of it (a storm keeps more of its towers).
    cu.uThinOut.value = 0.7 * smooth(0.75, 1, c) * (1 - 0.5 * w.lightning);
    this.clouds.visible = this.on && c > 0.005;
    this.deck.visible = this.deckMat.uniforms.uOpacity.value > 0.004;
  }

  dispose() {
    this.cloudMapTex?.dispose(); this.mistTex?.dispose(); this.puffTex.dispose();
    this.puffs.geometry.dispose(); this.cloudMat.dispose();
    this.deck.geometry.dispose(); this.deckMat.dispose();
  }
}

/** Add periodic value noise (px by py cells across the tile) into a square N×N field. */
function periodicNoise(N: number, px: number, py: number, rnd: () => number, out: Float32Array, amp: number) {
  const lat = new Float32Array(px * py);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  // The column lookups are the same on every row.
  const X0 = new Int32Array(N), X1 = new Int32Array(N), UX = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    const fx = (x / N) * px, ix = Math.floor(fx), tx = fx - ix;
    X0[x] = ix % px; X1[x] = (ix + 1) % px; UX[x] = tx * tx * (3 - 2 * tx);
  }
  for (let y = 0; y < N; y++) {
    const fy = (y / N) * py, iy = Math.floor(fy), ty = fy - iy, uy = ty * ty * (3 - 2 * ty);
    const r0 = (iy % py) * px, r1 = ((iy + 1) % py) * px, row = y * N;
    for (let x = 0; x < N; x++) {
      const ux = UX[x], x0 = X0[x], x1 = X1[x];
      const a = lat[r0 + x0], b = lat[r0 + x1], c = lat[r1 + x0], d = lat[r1 + x1];
      out[row + x] += amp * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
    }
  }
}

/** Four soft cumulus puffs in a 2×2 atlas. Alpha is density; red is how much faces up into the light. */
function puffAtlas() {
  const S = 256, cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(S * 2, S * 2);
  const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (x: number, y: number) => { let s = 0, a = 0.5; for (let i = 0; i < 5; i++) { s += a * noise(x, y); x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; a *= 0.5; } return s; };
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S, oy = Math.floor(v / 2) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = x / S - 0.5, py = y / S - 0.5;
      const r = Math.hypot(px, py * 1.15) * 2;
      const n = fbm(px * 5 + v * 11.3, py * 5 + v * 4.7);
      const d = clamp((1 - r) * 1.4 + (n - 0.5) * 1.3, 0, 1);
      const alpha = smooth(0.05, 0.75, d) * smooth(1.0, 0.75, r);
      // Lit from above: the upper part of the puff and its bumps catch more light.
      const up = clamp(0.5 - py * 1.4 + (n - 0.5) * 0.8, 0, 1);
      const k = ((oy + y) * S * 2 + ox + x) * 4;
      img.data[k] = up * 255; img.data[k + 1] = n * 255; img.data[k + 2] = 0; img.data[k + 3] = alpha * 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.premultiplyAlpha = false;
  return t;
}
