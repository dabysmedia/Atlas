/**
 * The sea. Its waves come from a spectral ocean simulated on the GPU (ocean.ts): a few tiles of
 * incommensurate sizes, each holding one band of a measured ocean spectrum, so the surface is a
 * random sea with no repeating pattern and no regular interference between a few wave trains.
 *
 * Around the point looked at, a dense grid follows the camera (sized to the view, snapped to its
 * own cells so it never swims) and is moved by the long waves, so close views have real 3D swell.
 * Past it a flat plane carries the same shading; the two meet where the grid's waves have died
 * away, so no seam shows. Shading is per pixel from the same textures: slopes and their variance
 * (mipmapped, so waves too small for a pixel widen the sun's glitter instead of aliasing), foam,
 * and crest height. Wave groups, gusts and glassy slicks vary the sea over hundreds of units.
 *
 * Color comes from depth (a distance-to-land shelf): pale turquoise over sand, teal over the reef,
 * blue, then ink navy far out. The surface reflects the sky and the clouds by a Fresnel term that
 * accounts for roughness, the sun or moon glitters on it by the slope distribution, light shines
 * through backlit crests, whitecaps break where the surface folds, foam lines roll in to the shore,
 * cloud shadows cross it, mist lies on it, and rain rings it.
 */
import * as THREE from 'three';
import type { HeightField } from './heightfield';
import type { Lighting } from './sky';
import { ATMOS_GLSL } from './atmosphere';
import { CHOP_GLSL, OceanSim, foamTexture, type SeaState } from './ocean';
import { OCEAN_G, WIND_ANGLE, oceanSpec } from './oceanSpectrum';

const GRID = 256, GRID_LOW = 128;

// Shared by the vertex and fragment shaders: cascade lookup, depth, and the sea's slow variations.
const SEA_GLSL = /* glsl */`
uniform sampler2D uDisp0, uDisp1, uDisp2, uDepth;
uniform vec4 uCasc[3]; // per cascade: tile heading (cos, sin), 1/size, height correction
uniform vec3 uCascOn;
uniform vec4 uDepthRect;
uniform vec2 uWindDir;
uniform float uTime, uWaves, uChop, uSimN, uGroupSpeed, uSimOn;
${CHOP_GLSL}
vec2 cuv(vec2 p, vec4 c) { return vec2(dot(p, c.xy), dot(p, vec2(-c.y, c.x))) * c.z; }
vec2 toWind(vec2 p) { return vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x))); }
float seaDepth(vec2 p) {
  vec2 duv = (p - uDepthRect.xy) / uDepthRect.zw;
  if (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) return 220.0;
  // Toward the edge of the measured ground it is open ocean; blend there so no seam shows.
  vec2 ed = abs(duv - 0.5) * 2.0;
  return mix(texture(uDepth, duv).r, 220.0, smoothstep(0.85, 1.0, max(ed.x, ed.y)));
}
// Wave groups: the long waves rise and fall in sets that drift downwind at their group speed.
float seaGroups(vec2 p) {
  vec2 q = toWind(p);
  q.x -= uTime * uGroupSpeed;
  float n = atmNoise(q * vec2(0.0021, 0.0015) + 3.7) * 0.6 + atmNoise(q * vec2(0.0067, 0.0046) + 11.2) * 0.4;
  return 0.3 + 1.4 * n;
}
// Short waves: rougher under gusts, and nearly gone in slicks, long glassy streaks along the wind.
float seaShort(vec2 p) {
  vec2 q = toWind(p);
  vec2 gq = q * vec2(0.0017, 0.0026) - vec2(uTime * 0.01, 0.0), sq = q * vec2(0.00045, 0.0031) + vec2(31.0, 7.0) - vec2(uTime * 0.003, 0.0);
  #ifdef LOW
    // Two octaves instead of four: the same gusts and slicks, softer edged.
    float g = atmNoise(gq) * 0.62 + atmNoise(gq * 2.1 + 3.1) * 0.31, sl = atmNoise(sq) * 0.62 + atmNoise(sq * 2.1 + 3.1) * 0.31;
  #else
    float g = atmFbm(gq), sl = atmFbm(sq);
  #endif
  return (0.35 + 1.3 * g) * (1.0 - 0.75 * smoothstep(0.56, 0.68, sl));
}
`;

export function makeWater(atmos: Record<string, THREE.IUniform>) {
  const wind = new THREE.Vector2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE));
  const uniforms = {
    ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    uTime: { value: 0 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uHemiSky: { value: new THREE.Color() }, uHemiGround: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uDepth: { value: null }, uDepthRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOverlay: { value: null }, uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uOverlayGlow: { value: 0.1 },
    uNight: { value: 0 }, uPixAngle: { value: 0.001 }, uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWaves: { value: 1 }, uChop: { value: 0.5 }, uFoamAmt: { value: 0.5 }, uRain: { value: 0 },
    uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
    uMom0: { value: null }, uMom1: { value: null }, uMom2: { value: null },
    uCasc: { value: [new THREE.Vector4(1, 0, 1, 1), new THREE.Vector4(1, 0, 1, 1), new THREE.Vector4(1, 0, 1, 1)] },
    uCascOn: { value: new THREE.Vector3(1, 1, 1) }, uSimN: { value: 256 }, uSimOn: { value: 0 },
    uWindDir: { value: wind }, uCapVar: { value: new THREE.Vector2(0.008, 0.006) },
    uHs: { value: 1 }, uGroupSpeed: { value: 0.5 * Math.sqrt(OCEAN_G / oceanSpec(false).kp) },
    uGridCell: { value: 1 }, uFoamTex: { value: foamTexture() },
    ...atmos,
  } as Record<string, THREE.IUniform>;

  const vertexShader = /* glsl */`
    #include <fog_pars_vertex>
    ${ATMOS_GLSL}
    ${SEA_GLSL}
    uniform float uGridCell;
    varying vec3 vWp;
    varying vec2 vBase;
    // One cascade's displacement, filtered to the grid's spacing so finer waves don't alias.
    vec3 cascDisp(sampler2D t, vec2 p, vec4 c, float a) {
      vec4 d = textureLod(t, cuv(p, c), max(0.0, log2(uGridCell * uSimN * c.z) + 0.5));
      vec2 h = vec2(c.x * d.x - c.y * d.z, c.y * d.x + c.x * d.z) * chopK(uChop);
      return vec3(h.x, d.y, h.y) * a * c.w;
    }
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vBase = wp.xz;
      #ifdef NEAR
        // Swell dies in the shallows and toward the edge of the grid, where it meets the flat far sea.
        float k = uSimOn * smoothstep(1.5, 22.0, seaDepth(wp.xz)) * smoothstep(0.48, 0.4, max(abs(position.x), abs(position.z)));
        if (k > 0.0) {
          wp.xyz += cascDisp(uDisp0, wp.xz, uCasc[0], seaGroups(wp.xz) * k);
          wp.xyz += cascDisp(uDisp1, wp.xz, uCasc[1], seaShort(wp.xz) * k * uCascOn.y);
        }
      #endif
      vWp = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;

  const fragmentShader = /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    ${ATMOS_GLSL}
    ${SEA_GLSL}
    uniform sampler2D uMom0, uMom1, uMom2, uOverlay, uFoamTex;
    uniform float uOverlayGlow, uNight, uPixAngle, uFoamAmt, uRain, uHs;
    uniform vec3 uKeyDir, uKeyColor, uSunDir, uHemiSky, uHemiGround, uZenith, uHorizon;
    uniform vec4 uOverlayRect, uHole;
    uniform vec2 uCapVar;
    varying vec3 vWp;
    varying vec2 vBase;
    bool outside(vec2 uv) { return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }

    // Ocean BRDF after Bruneton, Neyret & Holzschuch (2010): a Gaussian distribution of slopes
    // whose variance is what the textures couldn't resolve, with Smith shadowing.
    float erfcA(float x) { return 2.0 * exp(-x * x) / (2.319 * x + sqrt(4.0 + 1.52 * x * x)); }
    float smithL(float c, float s2) {
      float v = c / sqrt(max((1.0 - c * c) * 2.0 * s2, 1e-7));
      return max(0.0, (exp(-v * v) - v * 1.7724539 * erfcA(v)) / (2.0 * v * 1.7724539));
    }
    float glitter(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 s2) {
      vec3 H = normalize(L + V);
      float zH = max(dot(H, N), 1e-3);
      float zx = dot(H, Tx) / zH, zy = dot(H, Ty) / zH;
      float p = exp(-0.5 * (zx * zx / s2.x + zy * zy / s2.y)) / (6.2831853 * sqrt(s2.x * s2.y));
      vec2 lt = vec2(dot(L, Tx), dot(L, Ty)), vt = vec2(dot(V, Tx), dot(V, Ty));
      float sL = dot(lt * lt, s2) / max(dot(lt, lt), 1e-6), sV = dot(vt * vt, s2) / max(dot(vt, vt), 1e-6);
      float zL = max(dot(L, N), 0.01), zV = max(dot(V, N), 0.01);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
      return F * p / ((1.0 + smithL(zL, sL) + smithL(zV, sV)) * zV * zH * zH * zH * zH * 4.0);
    }
    // Fresnel averaged over the slopes in the view direction: a rough sea reflects less at grazing angles.
    float meanFresnel(float cosV, float sigV) {
      return 0.02 + 0.98 * pow(1.0 - cosV, 5.0 * exp(-2.69 * sigV)) / (1.0 + 22.7 * pow(sigV, 1.5));
    }
    // Rings from raindrops: one drop per cell at a time, a bright splash, then its ring spreading
    // and fading. Returns the ring's slope and how much it catches the light.
    vec3 ripple(vec2 p, float cell, float rate, float seed) {
      vec2 q = p / cell, id = floor(q), f = q - id;
      if (atmHash(id + seed + 3.1) > 0.15 + 0.85 * uRain) return vec3(0.0);
      vec2 c = 0.27 + 0.46 * vec2(atmHash(id + seed), atmHash(id + seed + 19.7));
      float ph = fract(uTime * rate + atmHash(id + seed + 7.3));
      vec2 d = f - c;
      float r = length(d), x = (r - ph * 0.25) * 34.0;
      float env = (1.0 - ph) * (1.0 - ph) * exp(-x * x * 0.2), w = sin(x * 1.7) * env;
      float splash = smoothstep(0.035, 0.0, r) * smoothstep(0.07, 0.0, ph);
      return vec3(d / max(r, 1e-4) * w, max(w, 0.0) * 0.5 + splash);
    }

    void main() {
      #ifdef NEAR
        if (uHole.z > 0.0 && (abs(vBase.x - uHole.x) > uHole.z || abs(vBase.y - uHole.y) > uHole.w)) discard;
      #else
        if (uHole.z > 0.0 && abs(vBase.x - uHole.x) < uHole.z && abs(vBase.y - uHole.y) < uHole.w) discard;
      #endif
      vec2 p = vBase;
      float depth = seaDepth(p);
      vec3 toEye = cameraPosition - vWp;
      float dist = length(toEye);
      vec3 V = toEye / dist;
      // World units per pixel here (smooth across the wave grid, unlike derivatives of a displaced mesh).
      float pix = max(dist * uPixAngle / sqrt(max(V.y, 0.12)), 1e-3);
      float calm = smoothstep(1.0, 20.0, depth); // the swell dies in the shallows; ripples less so
      float calmS = mix(0.35, 1.0, calm);
      float grp = seaGroups(p), sh = seaShort(p);
      float a0 = uCasc[0].w * grp * calm * uSimOn;
      float a1 = uCasc[1].w * sh * calmS * uCascOn.y * uSimOn;
      float a2 = uCasc[2].w * sh * calmS * uCascOn.z * uSimOn;
      vec2 uv0 = cuv(p, uCasc[0]), uv1 = cuv(p, uCasc[1]), uv2 = cuv(p, uCasc[2]);
      // The long tile's texels are several units wide: read it a little off true, by a noise, so
      // its whitecaps have ragged edges instead of bilinear blobs (and crest heights don't care).
      #ifdef LOW
        vec2 jit = vec2(0.0);
      #else
        vec2 jit = (vec2(atmNoise(p * 0.23), atmNoise(p * 0.23 + 17.3)) - 0.5) * 7.0;
      #endif
      vec4 d0 = texture(uDisp0, cuv(p + jit, uCasc[0])), d1 = texture(uDisp1, uv1);
      vec4 m0 = texture(uMom0, uv0), m1 = texture(uMom1, uv1), m2 = texture(uMom2, uv2);
      // LEAN: mean slope, and the variance the filtered texels hold, per cascade, in the wind's frame.
      vec2 mu = a0 * m0.xy + a1 * m1.xy + a2 * m2.xy;
      vec2 s2 = a0 * a0 * max(m0.zw - m0.xy * m0.xy, 0.0) + a1 * a1 * max(m1.zw - m1.xy * m1.xy, 0.0) + a2 * a2 * max(m2.zw - m2.xy * m2.xy, 0.0);
      float ac = sh * calmS;
      s2 += uCapVar * ac * ac + 2e-5;

      // Rain: rings close up; from afar, a rougher, matte, paler surface.
      vec3 rain = vec3(0.0);
      if (uRain > 0.002) {
        // Each layer fades out before its rings shrink below a couple of pixels.
        float v1 = 1.0 - smoothstep(0.03, 0.09, pix / 3.2), v2 = 1.0 - smoothstep(0.03, 0.09, pix / 5.0), v3 = 1.0 - smoothstep(0.03, 0.09, pix / 7.5);
        #ifndef LOW
        if (v3 > 0.0) rain = ripple(p, 3.2, 0.83, 0.0) * v1 + ripple(p + 0.37, 5.0, 0.61, 41.0) * v2 + ripple(p - 0.71, 7.5, 0.47, 83.0) * v3;
        #endif
        rain *= uRain;
        s2 += uRain * 0.035 * (1.0 - v2 * 0.6);
      }

      vec2 muW = vec2(uWindDir.x * mu.x - uWindDir.y * mu.y, uWindDir.y * mu.x + uWindDir.x * mu.y) + rain.xy * 0.3;
      vec3 n = normalize(vec3(-muW.x, 1.0, -muW.y));
      vec3 Tx = normalize(vec3(uWindDir.x, 0.0, uWindDir.y) - n * dot(n, vec3(uWindDir.x, 0.0, uWindDir.y)));
      vec3 Ty = cross(Tx, n);
      vec3 L = normalize(uKeyDir);
      float cs = cloudShadowAt(vWp);

      // Body color by depth: sand-pale turquoise, reef teal, open-sea blue, then ink navy far out.
      vec3 sand = vec3(0.09, 0.30, 0.26), reef = vec3(0.012, 0.13, 0.15), blue = vec3(0.004, 0.035, 0.085), navy = vec3(0.0016, 0.0075, 0.03);
      vec3 body = mix(sand, reef, smoothstep(0.5, 9.0, depth));
      body = mix(body, blue, smoothstep(8.0, 45.0, depth));
      body = mix(body, navy, smoothstep(45.0, 170.0, depth));
      body = mix(body, vec3(0.03, 0.045, 0.055), uRain * 0.3);
      vec3 amb = mix(uHemiGround, uHemiSky, 0.5 + 0.5 * n.y);
      float NL = max(dot(n, L), 0.0);
      vec3 col = body * (amb * 1.1 + uKeyColor * (0.12 + 0.55 * NL) * cs);

      // Light through the crests when looking low across the water toward the sun or moon.
      float back = pow(max(dot(-V.xz / max(length(V.xz), 1e-3), L.xz / max(length(L.xz), 1e-3)), 0.0), 3.0) * pow(1.0 - V.y, 3.0);
      float hgt = (a0 * d0.y + a1 * d1.y) / (uHs * max(uWaves, 0.3));
      float crest = smoothstep(-0.1, 0.8, hgt);
      col += vec3(0.01, 0.1, 0.08) * uKeyColor * (back * 0.7 + 0.03) * crest * crest * smoothstep(4.0, 30.0, depth) * cs;

      // The rings' crests and the splashes catch the sky's light.
      col += (amb * 0.5 + uKeyColor * 0.1 * cs) * min(rain.z, 1.0) * 0.35;

      // Draped overlays (territory, grid, borders) on the water as on the land.
      vec2 ouv = (p - uOverlayRect.xy) / uOverlayRect.zw;
      vec4 ov = outside(ouv) ? vec4(0.0) : texture2D(uOverlay, ouv);
      col = col * (1.0 - ov.a) + ov.rgb * (amb * 0.8 + uKeyColor * 0.25 * cs + uOverlayGlow);

      // Sky and clouds in the surface, by a Fresnel term that knows how rough the sea is.
      vec2 vt = vec2(dot(V, Tx), dot(V, Ty));
      float sigV = sqrt(dot(vt * vt, s2) / max(dot(vt, vt), 1e-6));
      vec3 R = reflect(-V, n);
      R.y = abs(R.y);
      vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.5 + sigV, R.y));
      if (R.y > 0.02) {
        vec2 cp = vWp.xz + R.xz * ((uCloudTile.w - vWp.y) / R.y);
        vec3 cloud = uHemiSky * 0.85 + uKeyColor * 0.16 * max(L.y, 0.0);
        sky = mix(sky, cloud, cloudCoverAt(cp) * 0.55 * smoothstep(0.03, 0.25, R.y));
      }
      sky *= mix(0.75, 1.0, cs);
      float F = meanFresnel(max(dot(V, n), 0.0), sigV) * (1.0 - 0.25 * uRain);
      col = mix(col, sky, F * (1.0 - ov.a * 0.7));

      // Sun or moon glitter from the slope distribution, along the true direction of the disc.
      vec3 Ls = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.01), uSunDir.z));
      float gli = glitter(Ls, V, n, Tx, Ty, s2) * smoothstep(0.0, 0.06, uSunDir.y);
      col += uKeyColor * min(gli, 40.0) * cs * (1.0 - ov.a * 0.6);

      // Foam: whitecaps where the surface folded (the dominant waves break in their groups), and
      // lines rolling in to the beach, each shaped by a lace of foam; in a gale, blown streaks.
      vec2 wq = toWind(p);
      float lace = texture(uFoamTex, wq * vec2(0.055, 0.085) + vec2(uTime * 0.02, 0.0)).r;
      #ifdef LOW
        float laceF = lace, laceM = lace; // one lace for everything
      #else
        float laceF = texture(uFoamTex, wq * vec2(0.14, 0.2) + vec2(0.37 + uTime * 0.03, 0.61)).r;
        float laceM = texture(uFoamTex, wq * vec2(0.028, 0.045) + vec2(0.71 + uTime * 0.01, 0.13)).r;
      #endif
      float farK = smoothstep(1.2, 5.0, pix);
      // Short waves break mostly on the crests of the long ones.
      float onCrest = 0.35 + 0.65 * smoothstep(-0.3, 0.7, a0 * d0.y / (uHs * max(uWaves, 0.3)));
      // The long waves' foam thins soon after it breaks (the power), so its patches stay a few units
      // across; thin old foam is clear enough to see through (the toe); and the short waves'
      // whitecaps, a unit or two across, fade as the view draws back instead of turning to specks.
      float caps = smoothstep(0.12, 1.0, pow(d0.w, 2.2) * smoothstep(0.5, 1.3, grp) * calm
        + d1.w * onCrest * calmS * uCascOn.y * (1.0 - smoothstep(0.35, 1.2, pix))) * uSimOn;
      float fn = depth < 14.0 ? atmFbm(p * 0.09 + vec2(uTime * 0.05, -uTime * 0.03)) : 0.5; // only the shore needs it
      float toShore = fract(depth * 0.085 - uTime * 0.11 + (fn - 0.5) * 0.35);
      float lines = smoothstep(0.8, 0.97, toShore) * (1.0 - smoothstep(2.0, 13.0, depth)) * smoothstep(0.25, 0.6, fn + 0.15);
      float swash = (1.0 - smoothstep(0.0, 1.6, depth)) * (0.55 + 0.45 * sin(uTime * 0.9 + fn * 6.0));
      float shore = clamp(lines * 0.9 + swash * 0.8, 0.0, 1.0);
      // Thin foam is a translucent lace, thick foam an opaque sheet; from afar, its average. The
      // whitecaps' lace has three scales: fine close up, a coarser one drawn out along the wind at
      // middle range (where the fine one is below a pixel and its threshold would give hard solid
      // blobs, so a whitecap still breaks into a ragged patch and trail), then the fraction covered.
      float capF = mix(smoothstep(1.0 - caps, 1.3 - caps, laceF), smoothstep(1.0 - caps, 1.3 - caps, laceM), smoothstep(0.15, 0.6, pix));
      capF = mix(capF, caps, smoothstep(0.9, 2.8, pix));
      float shoreF = mix(smoothstep(1.0 - shore, 1.3 - shore, lace), shore, smoothstep(0.4, 1.5, pix));
      float foam = max(capF * smoothstep(0.0, 0.06, caps) * (0.45 + 0.55 * caps), shoreF * smoothstep(0.0, 0.06, shore) * (0.45 + 0.55 * shore));
      // From afar a whitecap fills only part of the texels that carry it: an average, not a speck.
      float foamFar = max(caps * mix(0.6, 0.3, smoothstep(2.0, 8.0, pix)), shore * 0.7);
      float gale = smoothstep(1.35, 2.1, uWaves) * uFoamAmt * calm;
      if (gale > 0.0) {
        // Streaks: in lanes along the wind (bent gently, so they waver), each lane holding one line
        // at its own offset that comes and goes along its length, so streaks run long and thin,
        // start and end, and never loop. A line has a width in world units and is antialiased:
        // thinner than a pixel it fades by its coverage instead of breaking into dots, and once the
        // lanes near a pixel apart it gives way to its average.
        vec2 sq = wq + vec2(0.0, (atmNoise(wq * vec2(0.003, 0.012) + 3.0) - 0.5) * 36.0);
        float streak = 0.0;
        for (int i = 0; i < 2; i++) {
          float sp = i == 0 ? 9.0 : 4.3, lw = i == 0 ? 1.1 : 0.6;
          float y = sq.y / sp + (i == 0 ? 0.0 : 0.43), id = floor(y);
          float h = atmHash(vec2(id, 5.0 + float(i))), on = step(i == 0 ? 0.45 : 0.62, atmHash(vec2(id, 11.0 + float(i))));
          float seg = on * smoothstep(0.55, 0.8, atmNoise(vec2(sq.x * (i == 0 ? 0.005 : 0.011) + h * 37.0 - uTime * 0.012, id * 1.7)));
          float off = 0.25 + 0.5 * h + (atmNoise(vec2(sq.x * 0.02, id * 2.3 + 0.5)) - 0.5) * 0.3; // each line wanders in its lane
          float w = lw * (0.3 + 0.7 * seg) * 0.5 / pix; // half width in pixels, tapering at the ends
          float dpx = abs(fract(y) - off) / max(fwidth(y), 1e-5);
          float line = clamp(1.0 - dpx / max(w, 0.7), 0.0, 1.0) * min(1.0, w * 1.4) * seg;
          line *= (0.55 + 0.45 * atmNoise(vec2(sq.x * 0.12, id * 3.1))) * (0.35 + 0.65 * atmNoise(vec2(sq.x * 0.03, id * 1.3 + 7.0))); // filaments, and fading along
          line = mix(line, 0.12 * lw / sp, smoothstep(0.15, 0.4, pix / sp));
          streak += line * (i == 0 ? 0.6 : 0.4);
        }
        float dens = smoothstep(0.35, 0.75, atmNoise(wq * vec2(0.002, 0.006) + 9.0));
        foam = max(foam, min(streak, 1.0) * dens * gale * 0.8);
        foamFar = max(foamFar, 0.012 * dens * gale);
      }
      foam = mix(foam, foamFar, farK) * (1.0 - ov.a * 0.5);
      vec3 foamCol = (amb * 1.15 + uKeyColor * 0.55 * max(L.y, 0.2) * cs + uOverlayGlow * 0.15) * (0.8 + 0.2 * foam);
      col = mix(col, foamCol, foam);

      float alpha = mix(0.4, 1.0, smoothstep(0.0, 18.0, depth));
      alpha = max(alpha, max(foam, ov.a));
      float mist = mistAt(vWp, cameraPosition);
      col = mix(col, uMistColor, mist);
      alpha = max(alpha, mist);
      gl_FragColor = vec4(col, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  const make = (near: boolean) => new THREE.ShaderMaterial({ uniforms, fog: true, transparent: true, vertexShader, fragmentShader, defines: near ? { NEAR: 1 } : {} });
  const mats = () => [near.material, far.material] as THREE.ShaderMaterial[];
  const grid = (n: number) => new THREE.PlaneGeometry(1, 1, n, n).rotateX(-Math.PI / 2);
  let low = false;
  const near = new THREE.Mesh(grid(GRID), make(true));
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), make(false));
  near.renderOrder = 2; far.renderOrder = 1;
  near.frustumCulled = false; far.frustumCulled = false;
  const mesh = new THREE.Group();
  mesh.add(far, near);

  let sim: OceanSim | null = null;
  let seaY = 0;
  let holeEnabled = true;

  /** Center the far sea on the map and size it; the wave grid follows the camera (update). */
  const place = (cx: number, cz: number, sea: number, span: number) => {
    seaY = sea;
    far.position.set(cx, sea, cz); far.scale.set(span * 16, 1, span * 16);
    near.position.y = sea;
  };
  /** With the wave grid off, the flat sea covers everything. */
  const holeOn = (on: boolean) => {
    holeEnabled = on;
    if (!on) { near.visible = false; (uniforms.uHole.value as THREE.Vector4).z = 0; }
  };
  /**
   * Sea state from the weather, eased by the caller: `waves` scales wave height (0.5 glassy, 1 an
   * ordinary fair day, about 2.2 in a gale); `chop` (0..1) sharpens crests; `foam` (0..1) is how
   * readily whitecaps break; `rain` (0..1) is rain falling on the surface.
   */
  const setSea = (s: { waves: number; chop: number; foam: number; rain: number }) => {
    uniforms.uWaves.value = s.waves; uniforms.uChop.value = s.chop; uniforms.uFoamAmt.value = s.foam; uniforms.uRain.value = s.rain;
  };

  /**
   * Low quality: a coarser grid and simulation, with the finest ripples carried as a constant, and
   * a lighter shader (fewer noise octaves and foam lookups, no rain rings).
   */
  const setQuality = (lowQ: boolean) => {
    if (lowQ === low) return;
    low = lowQ;
    near.geometry.dispose();
    near.geometry = grid(low ? GRID_LOW : GRID);
    for (const m of mats()) { if (low) m.defines.LOW = 1; else delete m.defines.LOW; m.needsUpdate = true; }
    sim?.setQuality(low);
  };

  const dir = new THREE.Vector3();
  /**
   * Once per rendered frame, before drawing: advance the waves to `time` (seconds), skipping the
   * cascades whose waves are all below a pixel from this camera, and move the wave grid under the
   * view. `light` gives the true sun and moon for the glitter.
   */
  const update = (gl: THREE.WebGLRenderer, time: number, camera: THREE.Camera, light?: Lighting) => {
    if (!sim) sim = new OceanSim(gl, uniforms as unknown as SeaState, low);
    const spec = sim.spec, nc = spec.cascades.length;
    uniforms.uTime.value = time;
    // The nearest sea is at least the camera's height away; a cascade whose longest waves are
    // smaller than a pixel there shows only as averaged slopes, which its last state still gives.
    const pixMin = Math.max(camera.position.y - seaY, 1) * uniforms.uPixAngle.value;
    let active = 1;
    while (active < nc && (2 * Math.PI) / spec.cascades[active].kLo > pixMin * 1.5) active++;
    sim.step(time, active);

    const W = Math.max(uniforms.uWaves.value, 0);
    uniforms.uSimOn.value = sim.ok ? 1 : 0;
    uniforms.uSimN.value = spec.N;
    for (let c = 0; c < 3; c++) {
      const cs = spec.cascades[c], v = (uniforms.uCasc.value as THREE.Vector4[])[c];
      (uniforms.uCascOn.value as THREE.Vector3).setComponent(c, cs ? 1 : 0);
      const tex = (k: string, t: THREE.Texture | null) => { uniforms[k].value = t; };
      tex(`uDisp${c}`, cs ? sim.disp(c) : null); tex(`uMom${c}`, cs ? sim.moments(c) : null);
      if (!cs) continue;
      const a = WIND_ANGLE + cs.rot;
      v.set(Math.cos(a), Math.sin(a), 1 / cs.L, sim.baked[c] > 1e-3 ? W / sim.baked[c] : 1);
    }
    const { cap } = sim.stats(W, !sim.ok);
    (uniforms.uCapVar.value as THREE.Vector2).set(cap[0], cap[1]);
    uniforms.uHs.value = spec.hs;
    if (light) (uniforms.uSunDir.value as THREE.Vector3).copy(light.sunUp ? light.sunDir : light.moonDir);

    // The wave grid: about 2.6 view distances across, stepped in quarter octaves so small zooms
    // leave it be, and snapped to its own cells so panning never makes it swim.
    camera.getWorldDirection(dir);
    const o = camera.position;
    const t = dir.y < -1e-3 ? (seaY - o.y) / dir.y : Math.max(o.y - seaY, 1);
    const fx = o.x + dir.x * t, fz = o.z + dir.z * t;
    const d = Math.hypot(fx - o.x, seaY - o.y, fz - o.z);
    const S = 2 ** (Math.round(Math.log2(d * 2.6) * 4) / 4);
    const cell = S / (low ? GRID_LOW : GRID);
    // Past a few units a cell the long waves are below a pixel or two: the flat sea shades the same.
    near.visible = holeEnabled && sim.ok && cell < 14;
    near.position.set(Math.round(fx / cell) * cell, seaY, Math.round(fz / cell) * cell);
    near.scale.set(S, 1, S);
    uniforms.uGridCell.value = cell;
    const h = S * 0.48;
    (uniforms.uHole.value as THREE.Vector4).set(near.position.x, near.position.z, near.visible ? h : 0, h);
  };

  /** Check the GPU's transform against a direct CPU sum of the same spectrum (tests). */
  const verify = () => sim?.verify() ?? { ok: false };

  const dispose = () => {
    sim?.dispose(); sim = null;
    (uniforms.uFoamTex.value as THREE.Texture).dispose();
    near.geometry.dispose(); far.geometry.dispose();
    (near.material as THREE.Material).dispose(); (far.material as THREE.Material).dispose();
  };

  return { mesh, near, far, uniforms, place, holeOn, setSea, setQuality, update, verify, dispose, get sim() { return sim; } };
}

/**
 * Water depth for shading over a square reaching well past the ground: the true depth below sea
 * level, deepened with distance from land so the sea shelves off to open ocean in every direction.
 * Returns a half-float texture and the world rectangle it covers.
 */
export function depthTexture(hf: HeightField, sea: number) {
  const N = 1024;
  const side = Math.max(hf.w, hf.h) * 2.4;
  const rx = hf.minX + hf.w / 2 - side / 2, rz = hf.minY + hf.h / 2 - side / 2;
  const cell = side / (N - 1);
  const ground = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ground[j * N + i] = hf.at(rx + i * cell, rz + j * cell);
  const INF = 1e9;
  const dist = new Float32Array(N * N);
  for (let k = 0; k < dist.length; k++) dist[k] = ground[k] > sea ? 0 : INF;
  // Two-pass chamfer distance transform (in cells).
  const D1 = 1, D2 = Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    let v = dist[k];
    if (i > 0) v = Math.min(v, dist[k - 1] + D1);
    if (j > 0) { v = Math.min(v, dist[k - N] + D1); if (i > 0) v = Math.min(v, dist[k - N - 1] + D2); if (i < N - 1) v = Math.min(v, dist[k - N + 1] + D2); }
    dist[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i;
    let v = dist[k];
    if (i < N - 1) v = Math.min(v, dist[k + 1] + D1);
    if (j < N - 1) { v = Math.min(v, dist[k + N] + D1); if (i < N - 1) v = Math.min(v, dist[k + N + 1] + D2); if (i > 0) v = Math.min(v, dist[k + N - 1] + D2); }
    dist[k] = v;
  }
  const half = new Uint16Array(N * N);
  for (let k = 0; k < half.length; k++) {
    // The shelf: shallow near the beach, then falling away to open ocean a few hundred units out.
    const d = dist[k] >= INF ? 1e4 : dist[k] * cell;
    const shelf = Math.min(220, d * 0.45 + Math.max(0, d - 50) * 0.8);
    half[k] = THREE.DataUtils.toHalfFloat(Math.min(220, Math.max(sea - ground[k], shelf)));
  }
  const t = new THREE.DataTexture(half, N, N, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return { tex: t, rect: { x: rx, y: rz, w: side, h: side } };
}
