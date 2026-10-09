/**
 * The sea. Near the island the surface is a dense grid moved by Gerstner waves (water parcels run in
 * circles, so crests sharpen and troughs flatten) whose speeds follow deep-water dispersion: long
 * swells travel faster than short chop. Out past the grid a flat plane carries the same shading.
 *
 * Shading is done per pixel from the same wave sum plus scrolling noise for capillary ripples.
 * Waves too small for a pixel fade out, and the slope they carried widens the sun's highlight
 * instead, so the sea reads right at every zoom: sharp glitter close in, a broad sheen from afar.
 * Color comes from depth (taken from a distance-to-land shelf): pale turquoise over sand, teal
 * over the reef, and deep ink navy in open ocean. Light scatters through backlit crests, whitecaps
 * break where the surface folds, foam lines roll in to the shore, clouds shade it, and mist lies on it.
 */
import * as THREE from 'three';
import type { HeightField } from './heightfield';
import { ATMOS_GLSL } from './atmosphere';

// Wavelength (world units), amplitude, direction (degrees), steepness. The first three move the grid.
const WAVES: [number, number, number, number][] = [
  [300, 2.3, 18, 0.55], [190, 1.5, -35, 0.6], [128, 0.95, 62, 0.6], [82, 0.55, -8, 0.55],
  [51, 0.3, 105, 0.5], [31, 0.16, 40, 0.5], [19, 0.08, -70, 0.45], [12, 0.045, 150, 0.4],
];
const MOVING = 3;
const GLSL_WAVES = `
const float G = 21.0; // gravity in world units: a 300-unit swell takes about 8 s to pass
const int NW = ${WAVES.length};
const int NMOVE = ${MOVING};
const vec4 WAVE[NW] = vec4[NW](${WAVES.map(([L, A, deg, Q]) => {
  const a = (deg * Math.PI) / 180;
  return `vec4(${Math.cos(a).toFixed(4)}, ${Math.sin(a).toFixed(4)}, ${L.toFixed(1)}, ${A.toFixed(3)})`;
}).join(', ')});
const float STEEP[NW] = float[NW](${WAVES.map((w) => w[3].toFixed(2)).join(', ')});
`;

export function makeWater(atmos: Record<string, THREE.IUniform>) {
  const uniforms = {
    ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    uTime: { value: 0 }, uSwell: { value: 1 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color() },
    uHemiSky: { value: new THREE.Color() }, uHemiGround: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uDepth: { value: null }, uDepthRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOverlay: { value: null }, uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uOverlayGlow: { value: 0.1 },
    uNight: { value: 0 }, uPixAngle: { value: 0.001 }, uHole: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWaves: { value: 1 }, uChop: { value: 0.5 }, uFoamAmt: { value: 0.5 }, uRain: { value: 0 },
    ...atmos,
  } as Record<string, THREE.IUniform>;

  const vertexShader = /* glsl */`
    #include <fog_pars_vertex>
    uniform float uTime, uSwell;
    uniform sampler2D uDepth;
    uniform vec4 uDepthRect;
    varying vec3 vWp;
    varying vec2 vBase;
    ${GLSL_WAVES}
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vBase = wp.xz;
      #ifdef NEAR
        vec2 duv = (wp.xz - uDepthRect.xy) / uDepthRect.zw;
        float depth = (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) ? 200.0 : texture2D(uDepth, duv).r;
        // Swell dies in the shallows and at the edge of the grid, where it meets the flat far sea.
        float k = uSwell * smoothstep(1.5, 26.0, depth) * smoothstep(0.5, 0.4, max(abs(position.x), abs(position.z)));
        vec3 off = vec3(0.0);
        for (int i = 0; i < NMOVE; i++) {
          vec2 d = WAVE[i].xy; float L = WAVE[i].z, A = WAVE[i].w * k;
          float kk = 6.2831853 / L, w = sqrt(G * kk);
          float f = kk * dot(d, wp.xz) - w * uTime;
          off.xz -= STEEP[i] * A * d * sin(f);
          off.y += A * cos(f);
        }
        wp.xyz += off;
      #endif
      vWp = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;

  const fragmentShader = /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    uniform float uTime, uSwell, uOverlayGlow, uNight, uPixAngle;
    uniform vec3 uKeyDir, uKeyColor, uHemiSky, uHemiGround, uZenith, uHorizon;
    uniform sampler2D uDepth, uOverlay;
    uniform vec4 uDepthRect, uOverlayRect, uHole;
    varying vec3 vWp;
    varying vec2 vBase;
    ${GLSL_WAVES}
    ${ATMOS_GLSL}
    bool outside(vec2 uv) { return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }
    // Gradient noise slope for capillary ripples.
    vec2 rippleSlope(vec2 p) {
      float e = 0.5;
      return vec2(atmNoise(p + vec2(e, 0.0)) - atmNoise(p - vec2(e, 0.0)), atmNoise(p + vec2(0.0, e)) - atmNoise(p - vec2(0.0, e))) / (2.0 * e);
    }
    void main() {
      #ifndef NEAR
        if (uHole.z > 0.0 && abs(vBase.x - uHole.x) < uHole.z && abs(vBase.y - uHole.y) < uHole.w) discard;
      #endif
      vec2 p = vBase;
      vec2 duv = (p - uDepthRect.xy) / uDepthRect.zw;
      float depth = outside(duv) ? 220.0 : texture2D(uDepth, duv).r;
      // Past the edge of the measured ground it is open ocean; blend there so no seam shows.
      vec2 ed = abs(duv - 0.5) * 2.0;
      depth = mix(depth, 220.0, smoothstep(0.85, 1.0, max(ed.x, ed.y)));
      // World units per pixel here, from distance and viewing angle (smooth across the wave grid,
      // unlike screen derivatives of a displaced mesh).
      vec3 toEye = cameraPosition - vWp;
      float pix = max(length(toEye) * uPixAngle / sqrt(max(normalize(toEye).y, 0.12)), 1e-3);
      float calm = smoothstep(1.0, 20.0, depth); // waves flatten in the shallows

      // Wave sum: slope, fold (for whitecaps) and height, with waves below a pixel faded out and
      // their slope variance kept for the highlight.
      vec2 slope = vec2(0.0);
      float fold = 0.0, height = 0.0, lost = 0.0;
      for (int i = 0; i < NW; i++) {
        vec2 d = WAVE[i].xy; float L = WAVE[i].z;
        float vis = 1.0 - smoothstep(L * 0.008, L * 0.035, pix);
        if (vis <= 0.0) { float s0 = 6.2831853 / L * WAVE[i].w * uSwell * calm; lost += s0 * s0 * 0.5; continue; }
        // Each train comes in groups: its height swells and fades across the sea, so no two
        // stretches of water repeat.
        float gn = atmNoise(p / (L * 3.7) + vec2(float(i) * 7.31, float(i) * 3.17) + uTime * 0.012);
        float grp = 0.2 + 1.7 * gn * gn;
        float A = WAVE[i].w * uSwell * calm * grp;
        float kk = 6.2831853 / L, w = sqrt(G * kk);
        float f = kk * dot(d, p) - w * uTime;
        float s = kk * A;
        slope += d * (-s * sin(f)) * vis;
        fold += STEEP[i] * s * cos(f) * vis;
        height += A * cos(f) * vis;
        lost += s * s * 0.5 * (1.0 - vis);
      }
      // Capillary ripples: two layers of noise drifting with the wind.
      // Each layer fades before its cells shrink below a few pixels, so they never alias.
      float r1 = 1.0 - smoothstep(0.4, 1.5, pix), r2 = 1.0 - smoothstep(0.15, 0.6, pix);
      if (r1 > 0.0) {
        vec2 rip = rippleSlope(p * 0.21 + uWind * uTime * 0.02) * 0.09 * r1;
        if (r2 > 0.0) rip += rippleSlope(p * 0.53 - uTime * vec2(0.31, 0.17)) * 0.05 * r2;
        slope += rip * mix(0.4, 1.0, calm);
      }
      lost += 0.004 * (1.0 - r1) + 0.0013 * (1.0 - r2);
      // Wind slicks: broad patches where the surface is rougher or glassier, seen best from afar.
      float slick = atmFbm(p * 0.0011 + uWind * uTime * 0.00025);
      lost *= mix(0.35, 1.7, slick);
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 V = normalize(cameraPosition - vWp);
      vec3 L = normalize(uKeyDir);
      float cs = cloudShadowAt(vWp);

      // Body color by depth: sand-pale turquoise, reef teal, open-sea blue, then ink navy far out.
      vec3 sand = vec3(0.09, 0.30, 0.26), reef = vec3(0.012, 0.13, 0.15), blue = vec3(0.004, 0.035, 0.085), navy = vec3(0.0016, 0.0075, 0.03);
      vec3 body = mix(sand, reef, smoothstep(0.5, 9.0, depth));
      body = mix(body, blue, smoothstep(8.0, 45.0, depth));
      body = mix(body, navy, smoothstep(45.0, 170.0, depth));
      vec3 amb = mix(uHemiGround, uHemiSky, 0.5 + 0.5 * n.y);
      float NL = max(dot(n, L), 0.0);
      vec3 col = body * (amb * 1.1 + uKeyColor * (0.25 + 0.35 * NL) * cs) * mix(0.82, 1.18, slick);

      // Light through the crests when looking toward the sun or moon.
      float back = pow(max(dot(-V, vec3(L.x, 0.0, L.z) / max(length(L.xz), 1e-3)), 0.0), 3.0);
      float crest = clamp(height / 6.0 + 0.5, 0.0, 1.0);
      col += vec3(0.01, 0.09, 0.075) * uKeyColor * (back * 0.6 + 0.025) * crest * crest * smoothstep(4.0, 30.0, depth) * cs;

      // Draped overlays (territory, grid, borders) on the water as on the land.
      vec2 ouv = (p - uOverlayRect.xy) / uOverlayRect.zw;
      vec4 ov = outside(ouv) ? vec4(0.0) : texture2D(uOverlay, ouv);
      col = col * (1.0 - ov.a) + ov.rgb * (amb * 0.8 + uKeyColor * 0.25 * cs + uOverlayGlow);

      // Sky in the surface, by Fresnel.
      vec3 R = reflect(-V, n);
      R.y = abs(R.y);
      vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.5, R.y)) * mix(0.75, 1.0, cs);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
      col = mix(col, sky, F * (1.0 - ov.a * 0.7));

      // Sun or moon glitter: a slope-distribution highlight, wider where small waves were averaged away.
      vec3 Hh = normalize(L + V);
      float NH = max(dot(n, Hh), 1e-3);
      float s2 = 0.0012 + lost + 0.004 * smoothstep(0.6, 4.0, pix);
      float t2 = (1.0 - NH * NH) / (NH * NH);
      float D = exp(-t2 / (2.0 * s2)) / (6.2831853 * s2 * NH * NH * NH * NH);
      float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(Hh, V), 0.0), 5.0);
      col += uKeyColor * min(D * Fs * 0.25, 60.0) * step(0.0, dot(n, L)) * cs * (1.0 - ov.a * 0.6);

      // Foam: whitecaps where the surface folds, and lines rolling in to the beach.
      float fn = atmFbm(p * 0.09 + vec2(uTime * 0.05, -uTime * 0.03));
      float caps = smoothstep(0.55, 0.95, fold + (fn - 0.5) * 0.6) * calm;
      float toShore = fract(depth * 0.085 - uTime * 0.11 + (fn - 0.5) * 0.35);
      float lines = smoothstep(0.82, 0.97, toShore) * (1.0 - smoothstep(2.0, 13.0, depth)) * smoothstep(0.3, 0.6, fn + 0.15);
      float swash = (1.0 - smoothstep(0.0, 1.6, depth)) * (0.55 + 0.45 * sin(uTime * 0.9 + fn * 6.0));
      float foam = clamp(caps * 0.7 + lines * 0.85 + swash * 0.75, 0.0, 1.0) * (1.0 - ov.a * 0.5);
      vec3 foamCol = amb * 1.15 + uKeyColor * 0.55 * max(L.y, 0.2) * cs + uOverlayGlow * 0.15;
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

  const make = (near: boolean) => {
    return new THREE.ShaderMaterial({ uniforms, fog: true, transparent: true, vertexShader, fragmentShader, defines: near ? { NEAR: 1 } : {} });
  };
  const near = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 288, 288).rotateX(-Math.PI / 2), make(true));
  const far = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), make(false));
  near.renderOrder = 2; far.renderOrder = 1;
  near.frustumCulled = false; far.frustumCulled = false;
  const mesh = new THREE.Group();
  mesh.add(far, near);

  /** Center the wave grid on the map and size both planes. */
  const place = (cx: number, cz: number, sea: number, span: number) => {
    const g = span * 2.2;
    near.position.set(cx, sea, cz); near.scale.set(g, 1, g);
    far.position.set(cx, sea, cz); far.scale.set(span * 16, 1, span * 16);
    // The far plane steps aside where the grid lies, minus the grid's flat rim.
    (uniforms.uHole.value as THREE.Vector4).set(cx, cz, near.visible ? g * 0.42 : 0, g * 0.42);
    hole.set(cx, cz, g * 0.42, g * 0.42);
  };
  /** With the wave grid off, the flat sea covers everything. */
  let hole = new THREE.Vector4();
  const holeOn = (on: boolean) => {
    const h = uniforms.uHole.value as THREE.Vector4;
    if (!on && h.z > 0) { hole = h.clone(); h.z = 0; } else if (on && h.z === 0 && hole.z > 0) h.copy(hole);
  };
  /**
   * Sea state from the weather, eased by the caller: `waves` scales wave height (0.5 glassy, 1 an
   * ordinary fair day, about 2.2 in a gale); `chop` (0..1) sharpens crests; `foam` (0..1) is how
   * readily whitecaps break; `rain` (0..1) is rain falling on the surface.
   */
  const setSea = (s: { waves: number; chop: number; foam: number; rain: number }) => {
    uniforms.uWaves.value = s.waves; uniforms.uChop.value = s.chop; uniforms.uFoamAmt.value = s.foam; uniforms.uRain.value = s.rain;
  };
  return { mesh, near, far, uniforms, place, holeOn, setSea };
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
