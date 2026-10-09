/**
 * The sea: one large plane at sea level with a shader that does the work. Waves are summed sines
 * (normals only, the surface stays flat so picking and markers agree with it); color comes from
 * depth (read from a depth texture built from the height field), the key light, a fresnel
 * reflection of the sky and a sun or moon glint; a foam band breathes along the shore. Overlays
 * (territory, grid, borders) are draped on the water the same way as on land.
 */
import * as THREE from 'three';
import type { HeightField } from './heightfield';

export function makeWater() {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uDetail: { value: 1 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyColor: { value: new THREE.Color() },
    uHemiSky: { value: new THREE.Color() }, uHemiGround: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
    uDepth: { value: null }, uDepthRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOverlay: { value: null }, uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uOverlayGlow: { value: 0.1 },
    uNight: { value: 0 },
  }]) as Record<string, THREE.IUniform>;
  const mat = new THREE.ShaderMaterial({
    uniforms, fog: true, transparent: true,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      varying vec3 vWp;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWp = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime, uDetail, uOverlayGlow, uNight;
      uniform vec3 uKeyDir, uKeyColor, uHemiSky, uHemiGround, uZenith, uHorizon;
      uniform sampler2D uDepth, uOverlay;
      uniform vec4 uDepthRect, uOverlayRect;
      varying vec3 vWp;
      vec2 wave(vec2 p, vec2 dir, float freq, float amp, float speed) {
        return dir * (cos(dot(p, dir) * freq + uTime * speed) * freq * amp);
      }
      float hash2(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 q) {
        vec2 i = floor(q), f = fract(q), u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
      }
      bool outside(vec2 uv) { return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0; }
      void main() {
        vec2 p = vWp.xz;
        // Swell modulated by slow noise so crests never line up into stripes.
        float sw = 0.35 + 0.65 * vnoise(p * 0.005 + uTime * 0.02);
        vec2 g = wave(p, normalize(vec2(1.0, 0.3)), 0.031, 0.55 * sw, 0.8);
        g += wave(p, normalize(vec2(-0.45, 1.0)), 0.043, 0.35 * (1.2 - sw), 1.0);
        g += wave(p, normalize(vec2(0.83, 0.56)), 0.067, 0.22, 1.25);
        g += wave(p, normalize(vec2(0.7, -0.7)), 0.105, 0.2 * uDetail, 1.6);
        g += wave(p, normalize(vec2(-1.0, -0.25)), 0.19, 0.12 * uDetail, 2.2);
        g += wave(p, normalize(vec2(0.25, 0.95)), 0.34, 0.06 * uDetail, 3.0);
        g += wave(p, normalize(vec2(-0.6, 0.8)), 0.53, 0.035 * uDetail, 3.7);
        // Chop: noise slopes at two scales, so glitter scatters instead of lining up along crests.
        vec2 q = p * 0.06 + vec2(uTime * 0.05, -uTime * 0.04);
        float e = 0.35;
        vec2 ch = vec2(vnoise(q + vec2(e, 0.0)) - vnoise(q - vec2(e, 0.0)), vnoise(q + vec2(0.0, e)) - vnoise(q - vec2(0.0, e)));
        vec2 q2 = p * 0.17 - vec2(uTime * 0.09, uTime * 0.07);
        ch += 0.6 * vec2(vnoise(q2 + vec2(e, 0.0)) - vnoise(q2 - vec2(e, 0.0)), vnoise(q2 + vec2(0.0, e)) - vnoise(q2 - vec2(0.0, e)));
        g += ch * mix(0.05, 0.13, uDetail);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - vWp);

        vec2 duv = (p - uDepthRect.xy) / uDepthRect.zw;
        float depth = outside(duv) ? 200.0 : texture2D(uDepth, duv).r;
        float d = clamp(depth / 90.0, 0.0, 1.0);
        vec3 shallow = vec3(0.05, 0.27, 0.26), mid = vec3(0.014, 0.1, 0.14), deep = vec3(0.005, 0.028, 0.055);
        vec3 water = mix(mix(shallow, mid, smoothstep(0.0, 0.3, d)), deep, smoothstep(0.25, 1.0, d));
        float NL = max(dot(n, uKeyDir), 0.0);
        vec3 amb = mix(uHemiGround, uHemiSky, 0.5 + 0.5 * n.y);
        vec3 light = amb + uKeyColor * NL * 0.4;
        vec3 col = water * (light + uHemiSky * 0.35);

        vec2 ouv = (p - uOverlayRect.xy) / uOverlayRect.zw;
        vec4 ov = outside(ouv) ? vec4(0.0) : texture2D(uOverlay, ouv);
        col = col * (1.0 - ov.a) + ov.rgb * (light * 0.75 + uOverlayGlow);

        vec3 R = reflect(-V, n);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, R.y));
        float F = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        col = mix(col, sky, clamp(F * 0.9 + 0.13, 0.0, 1.0) * (1.0 - ov.a * 0.7));
        float rs = max(dot(R, uKeyDir), 0.0);
        col += uKeyColor * (pow(rs, mix(90.0, 300.0, uDetail)) * mix(0.25, 1.6, uDetail) + pow(rs, 24.0) * 0.05);

        float band = 1.0 - smoothstep(0.0, 6.0, depth);
        float foam = band * smoothstep(0.35, 0.9, 0.5 + 0.5 * sin(depth * 1.3 - uTime * 1.5 + sin(p.x * 0.045 + p.y * 0.037) * 2.5));
        foam = max(foam, (1.0 - smoothstep(0.0, 1.4, depth)) * 0.8);
        col = mix(col, light * 0.9 + uOverlayGlow * 0.2, foam * 0.55);

        float alpha = mix(0.42, 1.0, smoothstep(0.0, 24.0, depth));
        alpha = max(alpha, max(foam * 0.7, ov.a));
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  mesh.renderOrder = 2;
  return { mesh, uniforms };
}

/**
 * Water depth for shading: the true depth below sea level, deepened with distance from land so a
 * model's flat base reads as a shelf falling away to open ocean. Returned as a half-float texture.
 */
export function depthTexture(hf: HeightField, sea: number) {
  const { nx, ny, data } = hf;
  const cell = Math.min(hf.w / (nx - 1), hf.h / (ny - 1));
  const INF = 1e9;
  const dist = new Float32Array(nx * ny);
  for (let k = 0; k < dist.length; k++) dist[k] = data[k] > sea ? 0 : INF;
  // Two-pass chamfer distance transform (in cells).
  const D1 = 1, D2 = Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    let v = dist[k];
    if (i > 0) v = Math.min(v, dist[k - 1] + D1);
    if (j > 0) { v = Math.min(v, dist[k - nx] + D1); if (i > 0) v = Math.min(v, dist[k - nx - 1] + D2); if (i < nx - 1) v = Math.min(v, dist[k - nx + 1] + D2); }
    dist[k] = v;
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    let v = dist[k];
    if (i < nx - 1) v = Math.min(v, dist[k + 1] + D1);
    if (j < ny - 1) { v = Math.min(v, dist[k + nx] + D1); if (i < nx - 1) v = Math.min(v, dist[k + nx + 1] + D2); if (i > 0) v = Math.min(v, dist[k + nx - 1] + D2); }
    dist[k] = v;
  }
  const half = new Uint16Array(nx * ny);
  for (let k = 0; k < half.length; k++) {
    const shelf = Math.min(160, dist[k] >= INF ? 160 : dist[k] * cell * 0.55);
    half[k] = THREE.DataUtils.toHalfFloat(Math.max(sea - data[k], shelf));
  }
  const t = new THREE.DataTexture(half, nx, ny, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
