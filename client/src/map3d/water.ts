/**
 * The sea. Its waves come from a spectral ocean simulated on the GPU (ocean.ts): a few tiles of
 * incommensurate sizes, each holding one band of a measured ocean spectrum. The finer tiles would
 * still repeat in a lattice plain to see from the air, so the sea reads them over a triangle grid,
 * each corner from its own random place in the tile, blended so the waves keep their variance:
 * the surface is a random sea with no repeating pattern and no regular interference anywhere.
 *
 * Around the point looked at, a dense grid follows the camera (sized to the view, snapped to its
 * own cells so it never swims) and is moved by the long waves, so close views have real 3D swell.
 * Past it a flat plane carries the same shading, each pixel finding its own point on the sea from
 * its view ray; the two overlap by a hair where the grid's waves have died away, so no seam shows.
 * Shading is per pixel from the same textures: slopes and their variance (mipmapped, so waves too
 * small for a pixel widen the sun's glitter instead of aliasing), foam, and crest height. Wave
 * groups, gusts and glassy slicks vary the sea over hundreds of units.
 *
 * Color comes from depth (a distance-to-land shelf): pale turquoise over sand, teal over the reef,
 * blue, then ink navy far out. The surface reflects the sky and the clouds by a Fresnel term that
 * accounts for roughness, the sun or moon glitters on it by the slope distribution, a low sun
 * shines through the crests in front of it, whitecaps break where the surface folds and a gale
 * draws their foam out into streaks, foam lines roll in to the shore, cloud shadows cross it, mist
 * lies on it, and rain rings it.
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
uniform sampler2D uDisp0, uDisp1, uDepth;
uniform vec4 uCasc[3]; // per cascade: tile heading (cos, sin), 1/size, height correction
uniform vec3 uCascOn;
uniform vec4 uDepthRect;
uniform vec2 uWindDir;
uniform float uTime, uWaves, uChop, uSimN, uGroupSpeed, uSimOn, uDrift;
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
// Each tile would repeat in a lattice that shows from the air (the finer ones plainly), every copy
// moving in step. So each is read at the corners of a triangle grid laid over the sea (sides 0.42
// of the tile), each corner from its own random place in the tile, and the reads are blended
// across the triangle and rescaled to keep their variance (Heitz & Neyret 2018). The fields are
// Gaussian, so the blend is the same kind of sea everywhere: nothing repeats and no triangle
// shows. Weights are sharpened so each corner rules the middle of its own patch, where one read
// does, and three are needed only near the triangles' centres.
struct Tri { vec3 w; float n; vec2 a, b, c; };
vec2 triOff(vec2 v, float seed) {
  v = mod(v, 289.0) + seed;
  // Without the simulation (uDrift > 0), each corner's copy also drifts its own way, so a still
  // frame of the sea keeps changing.
  return vec2(atmHash(v), atmHash(v + 31.7)) + uDrift * (vec2(atmHash(v + 5.1), atmHash(v + 9.4)) - 0.5);
}
Tri triGrid(vec2 p, float side, float seed) {
  vec2 q = p * (0.81649658 / side);
  vec2 s = q + (q.x + q.y) * 0.36602540; // skewed so the triangles are equilateral
  vec2 b = floor(s), f = s - b;
  Tri t;
  vec3 w = vec3(1.0 - max(f.x, f.y), abs(f.x - f.y), min(f.x, f.y));
  w *= w; w *= w;
  w /= w.x + w.y + w.z;
  w *= step(0.02, w);
  t.w = w / (w.x + w.y + w.z);
  t.n = inversesqrt(dot(t.w, t.w));
  t.a = triOff(b, seed); t.b = triOff(b + (f.x > f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)), seed); t.c = triOff(b + 1.0, seed);
  return t;
}
float triSide(vec4 c) { return 0.42 / c.z; }
// Displacement and height rescaled to keep their variance; foam just blended.
vec4 triLod(sampler2D t, vec2 uv, Tri r, float lod) {
  vec4 d = vec4(0.0);
  if (r.w.x > 0.0) d += textureLod(t, uv + r.a, lod) * r.w.x;
  if (r.w.y > 0.0) d += textureLod(t, uv + r.b, lod) * r.w.y;
  if (r.w.z > 0.0) d += textureLod(t, uv + r.c, lod) * r.w.z;
  return vec4(d.xyz * r.n, d.w);
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
    uNight: { value: 0 }, uPixAngle: { value: 0.001 },
    uHole: { value: new THREE.Vector4(0, 0, 0, 0) }, uHoleE: { value: 0.05 }, uSeaLevel: { value: 0 }, uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uWaves: { value: 1 }, uChop: { value: 0.5 }, uFoamAmt: { value: 0.5 }, uRain: { value: 0 },
    uDisp0: { value: null }, uDisp1: { value: null },
    uMom0: { value: null }, uMom1: { value: null }, uMom2: { value: null },
    uCasc: { value: [new THREE.Vector4(1, 0, 1, 1), new THREE.Vector4(1, 0, 1, 1), new THREE.Vector4(1, 0, 1, 1)] },
    uCascOn: { value: new THREE.Vector3(1, 1, 1) }, uSimN: { value: 256 }, uSimOn: { value: 0 },
    uDrift: { value: 0 },
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
    // A cascade's displacement (read at the grid's spacing so finer waves don't alias) in the world.
    float gridLod(vec4 c) { return max(0.0, log2(uGridCell * uSimN * c.z) + 0.5); }
    vec3 cascDisp(vec4 d, vec4 c, float a) {
      vec2 h = vec2(c.x * d.x - c.y * d.z, c.y * d.x + c.x * d.z) * chopK(uChop);
      return vec3(h.x, d.y, h.y) * a * c.w;
    }
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec2 p = wp.xz;
      vBase = p;
      #ifdef NEAR
        // Swell dies in the shallows and toward the edge of the grid, where it meets the flat far sea.
        float k = uSimOn * smoothstep(1.5, 22.0, seaDepth(p)) * smoothstep(0.48, 0.4, max(abs(position.x), abs(position.z)));
        if (k > 0.0) {
          vec4 c0 = uCasc[0], c1 = uCasc[1];
          wp.xyz += cascDisp(triLod(uDisp0, cuv(p, c0), triGrid(p, triSide(c0), 113.0), gridLod(c0)), c0, seaGroups(p) * k);
          wp.xyz += cascDisp(triLod(uDisp1, cuv(p, c1), triGrid(p, triSide(c1), 0.0), gridLod(c1)), c1, seaShort(p) * k * uCascOn.y);
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
    uniform float uOverlayGlow, uNight, uPixAngle, uFoamAmt, uRain, uHs, uSeaLevel, uHoleE;
    uniform vec3 uKeyDir, uKeyColor, uSunDir, uHemiSky, uHemiGround, uZenith, uHorizon;
    uniform vec4 uOverlayRect, uHole, uViewport;
    uniform vec2 uCapVar;
    #ifndef NEAR
      uniform mat4 projectionMatrix;
    #endif
    varying vec3 vWp;
    varying vec2 vBase;
    bool outside(vec2 uv) { return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }

    // Over the triangle grid: a cascade's displacement and foam, and its LEAN moments (mean slope,
    // rescaled like the fields, and the variance below the pixel, blended by the same weights squared).
    vec4 triGrad(sampler2D t, vec2 uv, vec2 gx, vec2 gy, Tri r) {
      vec4 d = vec4(0.0);
      if (r.w.x > 0.0) d += textureGrad(t, uv + r.a, gx, gy) * r.w.x;
      if (r.w.y > 0.0) d += textureGrad(t, uv + r.b, gx, gy) * r.w.y;
      if (r.w.z > 0.0) d += textureGrad(t, uv + r.c, gx, gy) * r.w.z;
      return vec4(d.xyz * r.n, d.w);
    }
    void momAdd(vec4 m, float w, float n, inout vec2 mu, inout vec2 v) { mu += m.xy * (w * n); v += max(m.zw - m.xy * m.xy, 0.0) * (w * w * n * n); }
    void triMom(sampler2D t, vec2 uv, vec2 gx, vec2 gy, Tri r, out vec2 mu, out vec2 v) {
      mu = vec2(0.0); v = vec2(0.0);
      if (r.w.x > 0.0) momAdd(textureGrad(t, uv + r.a, gx, gy), r.w.x, r.n, mu, v);
      if (r.w.y > 0.0) momAdd(textureGrad(t, uv + r.b, gx, gy), r.w.y, r.n, mu, v);
      if (r.w.z > 0.0) momAdd(textureGrad(t, uv + r.c, gx, gy), r.w.z, r.n, mu, v);
    }

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
        vec3 wp = vWp;
        vec2 p = vBase;
        if (uHole.z > 0.0 && (abs(p.x - uHole.x) > uHole.z + uHoleE || abs(p.y - uHole.y) > uHole.w + uHoleE)) discard;
      #else
        // The far sea is two vast triangles, across which interpolated positions drift by whole
        // units. So each pixel finds its own point on the sea from its view ray, and the far sea
        // meets the wave grid exactly: the two overlap by uHoleE, and the grid, drawn first, wins.
        vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
        vec3 rd = vec3((ndc.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (ndc.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0) * mat3(viewMatrix);
        vec3 wp = cameraPosition + rd * ((uSeaLevel - cameraPosition.y) / min(rd.y, -1e-6));
        vec2 p = wp.xz;
        if (uHole.z > 0.0 && abs(p.x - uHole.x) < uHole.z - uHoleE && abs(p.y - uHole.y) < uHole.w - uHoleE) discard;
      #endif
      float depth = seaDepth(p);
      vec3 toEye = cameraPosition - wp;
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
      vec2 uv0 = cuv(p, uCasc[0]), uv1 = cuv(p, uCasc[1]);
      vec2 g0x = dFdx(uv0), g0y = dFdy(uv0), g1x = dFdx(uv1), g1y = dFdy(uv1);
      Tri t0 = triGrid(p, triSide(uCasc[0]), 113.0), t1 = triGrid(p, triSide(uCasc[1]), 0.0);
      // The long tile's texels are several units wide: read it a little off true, by a noise, so
      // its whitecaps have ragged edges instead of bilinear blobs (and crest heights don't care).
      #ifdef LOW
        vec2 jit = vec2(0.0);
      #else
        vec2 jit = (vec2(atmNoise(p * 0.23), atmNoise(p * 0.23 + 17.3)) - 0.5) * 7.0;
      #endif
      vec4 d0 = triGrad(uDisp0, cuv(p + jit, uCasc[0]), g0x, g0y, t0);
      // The short waves' heights and foam only show while they span a pixel or so.
      vec4 d1 = pix < 1.3 ? triGrad(uDisp1, uv1, g1x, g1y, t1) * (1.0 - smoothstep(0.9, 1.3, pix)) : vec4(0.0);
      // LEAN: mean slope, and the variance the filtered texels hold, per cascade, in the wind's frame.
      vec2 mu0, v0, mu1, v1, mu2 = vec2(0.0), v2 = vec2(0.0);
      triMom(uMom0, uv0, g0x, g0y, t0, mu0, v0);
      triMom(uMom1, uv1, g1x, g1y, t1, mu1, v1);
      #ifndef LOW
        vec2 uv2 = cuv(p, uCasc[2]), g2x = dFdx(uv2), g2y = dFdy(uv2);
        // Once the ripples' whole tile is under a few pixels, only their variance is left.
        if (pix < 8.0) triMom(uMom2, uv2, g2x, g2y, triGrid(p, triSide(uCasc[2]), 57.0), mu2, v2);
        else { vec4 m2 = textureLod(uMom2, uv2, 8.0); v2 = max(m2.zw - m2.xy * m2.xy, 0.0); }
      #endif
      vec2 mu = a0 * mu0 + a1 * mu1 + a2 * mu2;
      vec2 s2 = a0 * a0 * v0 + a1 * a1 * v1 + a2 * a2 * v2;
      float ac = sh * calmS;
      s2 += uCapVar * ac * ac + 2e-5;

      // Rain: rings close up; from afar, a rougher, matte, paler surface.
      vec3 rain = vec3(0.0);
      if (uRain > 0.002) {
        // Each layer fades out before its rings shrink below a couple of pixels.
        float r1 = 1.0 - smoothstep(0.03, 0.09, pix / 3.2), r2 = 1.0 - smoothstep(0.03, 0.09, pix / 5.0), r3 = 1.0 - smoothstep(0.03, 0.09, pix / 7.5);
        #ifndef LOW
        if (r3 > 0.0) rain = ripple(p, 3.2, 0.83, 0.0) * r1 + ripple(p + 0.37, 5.0, 0.61, 41.0) * r2 + ripple(p - 0.71, 7.5, 0.47, 83.0) * r3;
        #endif
        rain *= uRain;
        s2 += uRain * 0.035 * (1.0 - r2 * 0.6);
      }

      vec2 muW = vec2(uWindDir.x * mu.x - uWindDir.y * mu.y, uWindDir.y * mu.x + uWindDir.x * mu.y) + rain.xy * 0.3;
      vec3 n = normalize(vec3(-muW.x, 1.0, -muW.y));
      vec3 Tx = normalize(vec3(uWindDir.x, 0.0, uWindDir.y) - n * dot(n, vec3(uWindDir.x, 0.0, uWindDir.y)));
      vec3 Ty = cross(Tx, n);
      vec3 L = normalize(uKeyDir);
      float cs = cloudShadowAt(wp);

      // Body color by depth: sand-pale turquoise, reef teal, open-sea blue, then ink navy far out.
      vec3 sand = vec3(0.09, 0.30, 0.26), reef = vec3(0.012, 0.13, 0.15), blue = vec3(0.004, 0.035, 0.085), navy = vec3(0.0016, 0.0075, 0.03);
      vec3 body = mix(sand, reef, smoothstep(0.5, 9.0, depth));
      body = mix(body, blue, smoothstep(8.0, 45.0, depth));
      body = mix(body, navy, smoothstep(45.0, 170.0, depth));
      body = mix(body, vec3(0.03, 0.045, 0.055), uRain * 0.3);
      vec3 amb = mix(uHemiGround, uHemiSky, 0.5 + 0.5 * n.y);
      float NL = max(dot(n, L), 0.0);
      vec3 col = body * (amb * 1.1 + uKeyColor * (0.12 + 0.55 * NL) * cs);

      // Light through the crests: a low sun or moon behind the waves, seen across the water, shines
      // through their thin tops. Forward scattering, so it is gone once the light stands high.
      float back = pow(max(dot(-V, L), 0.0), 4.0);
      float hgt = (a0 * d0.y + a1 * d1.y) / (uHs * max(uWaves, 0.3));
      float crest = smoothstep(0.0, 0.9, hgt);
      col += vec3(0.01, 0.1, 0.08) * uKeyColor * back * crest * crest * smoothstep(4.0, 30.0, depth) * cs;

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
        vec2 cp = wp.xz + R.xz * ((uCloudTile.w - wp.y) / R.y);
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
      // Short waves break mostly on the crests of the long ones.
      float onCrest = 0.35 + 0.65 * smoothstep(-0.3, 0.7, a0 * d0.y / (uHs * max(uWaves, 0.3)));
      // The long waves' foam thins soon after it breaks (the power), so its patches stay a few units
      // across; thin old foam is clear enough to see through (the toe); and the short waves'
      // whitecaps, a unit or two across, fade as the view draws back instead of turning to specks.
      float caps = smoothstep(0.12, 1.0, pow(d0.w, mix(2.2, 1.5, uFoamAmt)) * smoothstep(0.5, 1.3, grp) * calm
        + d1.w * onCrest * calmS * uCascOn.y * (1.0 - smoothstep(0.35, 1.2, pix))) * uSimOn;
      float fn = depth < 14.0 ? atmFbm(p * 0.09 + vec2(uTime * 0.05, -uTime * 0.03)) : 0.5; // only the shore needs it
      float toShore = fract(depth * 0.085 - uTime * 0.11 + (fn - 0.5) * 0.35);
      float lines = smoothstep(0.8, 0.97, toShore) * (1.0 - smoothstep(2.0, 13.0, depth)) * smoothstep(0.25, 0.6, fn + 0.15);
      float swash = (1.0 - smoothstep(0.0, 1.6, depth)) * (0.55 + 0.45 * sin(uTime * 0.9 + fn * 6.0));
      float shore = clamp(lines * 0.9 + swash * 0.8, 0.0, 1.0);
      // Whitecaps are a lace whose threshold falls as the foam thickens, but never to a solid sheet:
      // even a fresh cap keeps holes and a ragged rim and lets a little sea through. The lace has
      // three scales: fine close up, a coarser one drawn out along the wind at middle range (where
      // the fine one is below a pixel), and past a few units a pixel, the share of surface covered.
      float cov = 0.7 * caps;
      float capF = mix(smoothstep(1.0 - cov, 1.25 - cov, laceF), smoothstep(1.0 - cov, 1.25 - cov, laceM), smoothstep(0.15, 0.6, pix));
      capF = mix(capF, cov * 0.8, smoothstep(2.5, 5.0, pix));
      float shoreF = mix(smoothstep(1.0 - shore, 1.3 - shore, lace), shore, smoothstep(0.4, 1.5, pix));
      float foam = max(capF * smoothstep(0.0, 0.06, caps) * (0.45 + 0.4 * caps), shoreF * smoothstep(0.0, 0.06, shore) * (0.45 + 0.55 * shore));
      // From afar a whitecap fills only part of the texels that carry it: an average, not a speck.
      float foamFar = max(caps * mix(0.5, 0.3, smoothstep(2.0, 8.0, pix)), shore * 0.7);
      float gale = smoothstep(1.35, 2.1, uWaves) * uFoamAmt * calm;
      if (gale > 0.0) {
        // Streaks: foam torn from the breaking crests and drawn out downwind. From the air they are
        // long, thin lines along the wind a few units wide that waver, converge and part, stop and
        // start. So the sea across the wind is cut into lanes, a few holding one streak each, which
        // bends within its lane on its own; each streak's width changes along it, its edge is
        // fuzzy, the lace breaks it into bubbles and gaps, and it lies only downwind of crests that
        // are breaking. Thinner than a pixel it fades by its coverage; once a pixel is a few units,
        // only the average is left.
        vec2 sq = wq + vec2(0.0, (atmNoise(wq * vec2(0.004, 0.011) + 3.0) - 0.5) * 22.0);
        float lane = sq.y / 9.0, id = floor(lane);
        float mid = 0.25 + 0.5 * atmHash(vec2(id, 3.1)) + 0.25 * (atmNoise(vec2(sq.x * 0.007, id * 1.37)) - 0.5);
        float sd = abs(fract(lane) - mid) * 9.0; // world units to the streak's middle
        float hw = 0.35 + 1.6 * atmNoise(vec2(sq.x * 0.012, id * 2.11 + 0.5)); // its half width
        float vein = (1.0 - smoothstep(0.2 * hw, hw + 0.7 * pix, sd)) * hw / (hw + 0.35 * pix);
        float on = step(atmHash(vec2(id, 8.9)), 0.7) * smoothstep(0.4, 0.62, atmNoise(vec2(sq.x / (50.0 + 60.0 * atmHash(vec2(id, 1.3))), id * 3.7)));
        float bub = mix(smoothstep(0.15, 0.7, texture(uFoamTex, sq * vec2(0.012, 0.11) + vec2(0.31, 0.77)).r), 0.5, smoothstep(0.3, 1.2, pix));
        float brk = triLod(uDisp0, cuv(p - uWindDir * 40.0, uCasc[0]), t0, 4.5).w;
        // Streaks gather in broad bands and each fades in and out along its length.
        float dens = smoothstep(0.5, 1.2, sh) * (0.2 + 0.8 * smoothstep(0.005, 0.04, brk)) * (0.25 + 0.75 * smoothstep(0.25, 0.65, atmNoise(sq * vec2(0.0035, 0.014) + 9.1)));
        float tone = 0.3 + 0.7 * atmNoise(vec2(sq.x * 0.02, id * 5.1 + 2.0));
        float streak = mix(vein * on * tone * (0.25 + 0.75 * bub), 0.04, smoothstep(1.8, 4.0, pix));
        foam = max(foam, streak * dens * gale * 0.65);
        foamFar = max(foamFar, 0.04 * dens * gale * 0.65);
      }
      foam = mix(foam, foamFar, smoothstep(3.0, 8.0, pix)) * (1.0 - ov.a * 0.5);
      vec3 foamCol = (amb * 1.15 + uKeyColor * 0.55 * max(L.y, 0.2) * cs + uOverlayGlow * 0.15) * (0.8 + 0.2 * foam);
      col = mix(col, foamCol, foam);

      float alpha = mix(0.4, 1.0, smoothstep(0.0, 18.0, depth));
      alpha = max(alpha, max(foam, ov.a));
      float mist = mistAt(wp, cameraPosition);
      col = mix(col, uMistColor, mist);
      alpha = max(alpha, mist);
      gl_FragColor = vec4(col, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  const make = (near: boolean) => new THREE.ShaderMaterial({
    uniforms, fog: true, transparent: true, vertexShader, fragmentShader, defines: near ? { NEAR: 1 } : {},
    // The far sea sits a hair behind the grid where the two overlap, so the grid wins there.
    polygonOffset: !near, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const mats = () => [near.material, far.material] as THREE.ShaderMaterial[];
  const grid = (n: number) => new THREE.PlaneGeometry(1, 1, n, n).rotateX(-Math.PI / 2);
  let low = false, noFloat = false, precise = false;
  const near = new THREE.Mesh(grid(GRID), make(true));
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), make(false));
  near.renderOrder = 1; far.renderOrder = 2;
  near.frustumCulled = false; far.frustumCulled = false;
  // The far sea finds its points from the pixel's view ray, so it needs the viewport it is drawn into.
  far.onBeforeRender = (r) => { r.getCurrentViewport(uniforms.uViewport.value as THREE.Vector4); };
  const mesh = new THREE.Group();
  mesh.add(near, far);

  let sim: OceanSim | null = null;
  let seaY = 0;
  let holeEnabled = true;
  let lastStep = -1;

  /** Center the far sea on the map and size it; the wave grid follows the camera (update). */
  const place = (cx: number, cz: number, sea: number, span: number) => {
    seaY = sea;
    uniforms.uSeaLevel.value = sea;
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
  const dispU = [uniforms.uDisp0, uniforms.uDisp1], momU = [uniforms.uMom0, uniforms.uMom1, uniforms.uMom2];
  const cascU = uniforms.uCasc.value as THREE.Vector4[], cascOn = uniforms.uCascOn.value as THREE.Vector3;
  /**
   * Once per rendered frame, before drawing: advance the waves to `time` (seconds), skipping the
   * cascades whose waves are all below a pixel from this camera, and move the wave grid under the
   * view. `light` gives the true sun and moon for the glitter. With `step` false the waves stay as
   * they are and only the grid moves (a still drawn from another camera between frames).
   */
  const update = (gl: THREE.WebGLRenderer, time: number, camera: THREE.Camera, light?: Lighting, step = true) => {
    if (!sim) sim = new OceanSim(gl, uniforms as unknown as SeaState, low, noFloat, precise);
    const spec = sim.spec, nc = spec.cascades.length;
    uniforms.uTime.value = time;
    // The nearest sea is at least the camera's height away; a cascade whose longest waves are
    // smaller than a pixel there shows only as averaged slopes, which its last state still gives.
    const pixMin = Math.max(camera.position.y - seaY, 1) * uniforms.uPixAngle.value;
    let active = 1;
    while (active < nc && (2 * Math.PI) / spec.cascades[active].kLo > pixMin * 1.5) active++;
    // Where the long waves travel under half a pixel in a thirtieth of a second, thirty updates a
    // second look the same as sixty and cost half as much.
    if (step && (pixMin < 0.8 || !(time - lastStep < 0.03 && time >= lastStep))) { sim.step(time, active); lastStep = time; }

    const W = Math.max(uniforms.uWaves.value, 0);
    uniforms.uSimOn.value = sim.disp(0) ? 1 : 0;
    // Without the simulation, the still frame drifts.
    uniforms.uDrift.value = sim.ok ? 0 : time * 0.01;
    uniforms.uSimN.value = spec.N;
    for (let c = 0; c < 3; c++) {
      const cs = spec.cascades[c];
      cascOn.setComponent(c, cs ? 1 : 0);
      if (c < 2) dispU[c].value = cs ? sim.disp(c) : null;
      momU[c].value = cs ? sim.moments(c) : null;
      if (!cs) continue;
      const a = WIND_ANGLE + cs.rot;
      cascU[c].set(Math.cos(a), Math.sin(a), 1 / cs.L, sim.baked[c] > 1e-3 ? W / sim.baked[c] : 1);
    }
    const { cap } = sim.stats(W);
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
    uniforms.uHoleE.value = 0.02 + h * 2e-4;
  };

  /** Check the GPU's transform against a direct CPU sum of the same spectrum (tests), at wave height W. */
  const verify = (W = 1) => sim?.verify(3.7, W) ?? { ok: false };
  /** Tests: drop to the still sea a GPU without float render targets gets. */
  const debugNoFloat = () => { sim?.dispose(); sim = null; noFloat = true; };
  /** Tests: run the transform in float32 (where the GPU can), to measure what half floats cost. */
  const debugPrecise = (on = true) => { sim?.dispose(); sim = null; precise = on; };

  const dispose = () => {
    sim?.dispose(); sim = null;
    (uniforms.uFoamTex.value as THREE.Texture).dispose();
    near.geometry.dispose(); far.geometry.dispose();
    (near.material as THREE.Material).dispose(); (far.material as THREE.Material).dispose();
  };

  return { mesh, near, far, uniforms, place, holeOn, setSea, setQuality, update, verify, debugNoFloat, debugPrecise, dispose, get sim() { return sim; } };
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
