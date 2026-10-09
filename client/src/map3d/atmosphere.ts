/**
 * Weather over the island: a drifting deck of clouds, the shadows they throw, and low mist that
 * rolls through the valleys, thickest over swamp and jungle and at dawn.
 *
 * Clouds live on a square tile that repeats around the map and slides with the wind. Each cloud is
 * a cluster of soft billboard puffs (one instanced draw); the same clusters are painted into a
 * coverage texture that the ground and sea sample, offset along the light, for cloud shadows, so a
 * shadow always sits under its cloud. Mist is exponential height fog with its density taken from
 * a biome map and two layers of noise moving with the wind, integrated along the view ray.
 */
import * as THREE from 'three';
import type { HeightField } from './heightfield';
import type { Lighting } from './sky';

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

/** GLSL shared by the ground and the sea: noise, cloud shadow and mist. */
export const ATMOS_GLSL = /* glsl */`
uniform float uAtmTime, uAtmOn, uCloudShadow, uMistDensity, uMistHeight, uSeaY;
uniform vec2 uWind;
uniform vec4 uCloudTile; // origin x, origin z, size, cloud base altitude
uniform sampler2D uCloudMap, uMistMap;
uniform vec4 uMistRect;
uniform vec3 uAtmKeyDir, uMistColor;
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
/** 1 in sunlight, lower under a cloud. */
float cloudShadowAt(vec3 wp) {
  vec3 L = uAtmKeyDir;
  vec2 p = wp.xz + L.xz / max(L.y, 0.25) * (uCloudTile.w - wp.y);
  float c = texture2D(uCloudMap, (p - uWind * uAtmTime - uCloudTile.xy) / uCloudTile.z).r;
  return 1.0 - uCloudShadow * uAtmOn * smoothstep(0.08, 0.7, c);
}
/** How much rolling mist lies between the eye and this point (0..1). */
float mistAt(vec3 wp, vec3 eye) {
  if (uAtmOn < 0.5 || uMistDensity <= 0.0) return 0.0;
  vec2 muv = (wp.xz - uMistRect.xy) / uMistRect.zw;
  float biome = (muv.x < 0.0 || muv.y < 0.0 || muv.x > 1.0 || muv.y > 1.0) ? 0.1 : texture2D(uMistMap, muv).r;
  if (uMistDensity * biome < 0.004) return 0.0;
  vec2 q = (wp.xz - uWind * uAtmTime * 1.6) * 0.0021;
  float roll = atmFbm(q) * 0.62 + atmFbm(q * 2.7 + vec2(5.2, 1.3) + uAtmTime * 0.012) * 0.38;
  roll = smoothstep(0.3, 0.78, roll);
  float rho = uMistDensity * biome * (0.04 + 1.7 * roll);
  float H = uMistHeight;
  float h0 = max(wp.y - uSeaY, 0.0), h1 = max(eye.y - uSeaY, 0.0);
  float len = length(eye - wp), dh = h1 - h0;
  // Optical depth through an exponential layer: density rho/H at sea level, falling off with height H.
  float od = abs(dh) > 0.5 ? rho * len / dh * (exp(-h0 / H) - exp(-h1 / H)) : rho / H * len * exp(-h0 / H);
  return clamp(1.0 - exp(-od), 0.0, 0.72);
}
`;

type Puff = { x: number; y: number; z: number; size: number; seed: number; shade: number };

export class Atmosphere {
  readonly uniforms = {
    uAtmTime: { value: 0 }, uAtmOn: { value: 1 }, uCloudShadow: { value: 0.4 }, uMistDensity: { value: 0.5 }, uMistHeight: { value: 20 },
    uSeaY: { value: 0 }, uWind: { value: new THREE.Vector2(9, 4) },
    uCloudTile: { value: new THREE.Vector4(0, 0, 1, 100) }, uCloudMap: { value: null as THREE.Texture | null },
    uMistMap: { value: null as THREE.Texture | null }, uMistRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uAtmKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uMistColor: { value: new THREE.Color() },
  };
  readonly clouds: THREE.Mesh;
  protected cloudMat: THREE.ShaderMaterial;
  protected cloudMapTex: THREE.CanvasTexture | null = null;
  protected mistTex: THREE.CanvasTexture | null = null;
  protected puffTex = puffAtlas();
  protected cover = 0.5;
  on = true;

  constructor() {
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uPuffs: { value: this.puffTex }, uOpacity: { value: 1 }, uNear: { value: new THREE.Vector2(0, 1) },
        uLit: { value: new THREE.Color() }, uShade: { value: new THREE.Color() }, uRim: { value: new THREE.Color() },
        uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
      }]),
      transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute vec3 aPos; attribute vec3 aMeta; // size, seed, shade
        uniform float uAtmTime; uniform vec2 uWind; uniform vec4 uCloudTile; uniform vec2 uNear;
        varying vec2 vUv; varying float vAlpha, vShade, vSeed; varying vec3 vWp;
        void main() {
          vec3 c = aPos;
          c.xz = uCloudTile.xy + mod(c.xz + uWind * uAtmTime - uCloudTile.xy, uCloudTile.z);
          vec2 e = (c.xz - uCloudTile.xy) / uCloudTile.z;
          float edge = smoothstep(0.0, 0.1, e.x) * smoothstep(1.0, 0.9, e.x) * smoothstep(0.0, 0.1, e.y) * smoothstep(1.0, 0.9, e.y);
          vec4 mvPosition = modelViewMatrix * vec4(c, 1.0);
          float a = aMeta.y * 6.2831853 + uAtmTime * 0.004 * (aMeta.y - 0.5);
          vec2 r = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
          mvPosition.xy += r * aMeta.x;
          // Clouds part as the camera comes down through them.
          vAlpha = edge * smoothstep(uNear.x, uNear.y, -mvPosition.z);
          vUv = position.xy + 0.5; vShade = aMeta.z; vSeed = aMeta.y; vWp = c;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        uniform sampler2D uPuffs; uniform float uOpacity; uniform vec3 uLit, uShade, uRim, uKeyDir;
        varying vec2 vUv; varying float vAlpha, vShade, vSeed; varying vec3 vWp;
        void main() {
          vec2 cell = vec2(floor(vSeed * 3.99), 0.0);
          cell.y = floor(cell.x / 2.0); cell.x = mod(cell.x, 2.0);
          vec4 t = texture2D(uPuffs, (vUv + cell) * 0.5);
          float a = t.a * vAlpha * uOpacity;
          if (a < 0.004) discard;
          // t.r: how much of the puff faces up into the light; vShade: how high in its cloud it sits.
          float lit = clamp(t.r * 0.75 + vShade * 0.45, 0.0, 1.0);
          vec3 V = normalize(cameraPosition - vWp);
          float rim = pow(max(dot(-V, uKeyDir), 0.0), 6.0) * (1.0 - t.a) * 2.0;
          vec3 col = mix(uShade, uLit, lit) + uRim * rim;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(this.cloudMat.uniforms, { uAtmTime: this.uniforms.uAtmTime, uWind: this.uniforms.uWind, uCloudTile: this.uniforms.uCloudTile });
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 5;
  }

  /** Lay out clouds and the mist map for a ground. */
  build(hf: HeightField, sea: number, bounds: { minX: number; minY: number; maxX: number; maxY: number },
    hexes: { cx: number; cy: number; terrain: string }[], hexSize: number) {
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minY + bounds.maxY) / 2;
    const relief = Math.max(hf.maxH - sea, hexSize);
    const T = span * 2.6;
    const alt = sea + Math.max(relief * 1.25, span * 0.055);
    this.uniforms.uSeaY.value = sea;
    this.uniforms.uMistHeight.value = Math.max(6, relief * 0.13);
    this.uniforms.uCloudTile.value.set(cx - T / 2, cz - T / 2, T, alt);
    this.uniforms.uWind.value.set(span * 0.0032, span * 0.0014);

    // Clouds: clusters of puffs, seeded so a world always gets the same sky.
    let seed = Math.round(span) * 7919 + hexes.length;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed & 0xffffff) / 0x1000000; };
    const puffs: Puff[] = [];
    const clusters = Math.round(34 * (T / (span * 2.6)) ** 2);
    for (let c = 0; c < clusters; c++) {
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
        puffs.push({ x: cx - T / 2 + ox + sx, y: alt + y, z: cz - T / 2 + oz + sz, size: R * (0.55 + rnd() * 0.6) * (1 - d * 0.35), seed: rnd(), shade: h * 0.7 + (1 - d) * 0.3 });
      }
    }
    const pos = new Float32Array(puffs.length * 3), meta = new Float32Array(puffs.length * 3);
    puffs.forEach((p, i) => { pos.set([p.x, p.y, p.z], i * 3); meta.set([p.size, p.seed, p.shade], i * 3); });
    const geo = this.clouds.geometry as THREE.InstancedBufferGeometry;
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('aMeta', new THREE.InstancedBufferAttribute(meta, 3));
    geo.instanceCount = puffs.length;

    // Coverage for shadows: the same puffs, painted onto the repeating tile.
    const N = 512, cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'lighter';
    for (const p of puffs) {
      const u = ((p.x - (cx - T / 2)) / T) * N, v = ((p.z - (cz - T / 2)) / T) * N, r = (p.size / T) * N * 0.6;
      for (const du of [-N, 0, N]) for (const dv of [-N, 0, N]) {
        const gr = g.createRadialGradient(u + du, v + dv, 0, u + du, v + dv, r);
        gr.addColorStop(0, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(u + du, v + dv, r, 0, Math.PI * 2); g.fill();
      }
    }
    this.cloudMapTex?.dispose();
    const ct = new THREE.CanvasTexture(cv);
    ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
    ct.colorSpace = THREE.NoColorSpace;
    this.cloudMapTex = ct;
    this.uniforms.uCloudMap.value = ct;

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
    this.mistTex?.dispose();
    const mt = new THREE.CanvasTexture(mc);
    mt.colorSpace = THREE.NoColorSpace;
    this.mistTex = mt;
    this.uniforms.uMistMap.value = mt;
    this.uniforms.uMistRect.value.set(rx, rz, rw, rh);
  }

  /** Follow the time of day and the camera. */
  update(now: number, L: Lighting, camDist: number, zoom: number) {
    const u = this.uniforms;
    u.uAtmTime.value = now / 1000;
    u.uAtmOn.value = this.on ? 1 : 0;
    u.uAtmKeyDir.value.copy(L.keyDir);
    const h = L.hour;
    // Mist pools before dawn and lifts by late morning; a little returns in the evening.
    const dd = Math.min(Math.abs(h - 6.2), 24 - Math.abs(h - 6.2));
    const dawn = Math.exp(-(dd ** 2) / 4.5);
    const evening = Math.exp(-((h - 20.5) ** 2) / 6);
    u.uMistDensity.value = this.on ? 0.12 + 0.65 * dawn + 0.3 * evening + 0.22 * L.night : 0;
    u.uCloudShadow.value = (L.sunUp ? 0.5 : 0.25) * smooth(0, 0.25, L.keyDir.y);
    const amb = L.hemiSky.clone().multiplyScalar(L.hemiIntensity);
    u.uMistColor.value.copy(amb).multiplyScalar(0.75).add(L.keyColor.clone().multiplyScalar(0.16 * Math.max(L.keyDir.y, 0.2)));
    u.uMistColor.value.lerp(L.horizon, 0.35);

    const cu = this.cloudMat.uniforms;
    cu.uKeyDir.value.copy(L.keyDir);
    cu.uLit.value.copy(L.keyColor).multiplyScalar(0.42).add(amb.clone().multiplyScalar(0.8));
    cu.uShade.value.copy(amb).multiplyScalar(0.62).lerp(L.horizon, 0.25);
    cu.uRim.value.copy(L.keyColor).multiplyScalar(0.35);
    // The deck shows from far out and parts as the camera comes down; it never sits on the hexcrawl.
    cu.uNear.value.set(camDist * 0.5, camDist * 0.85);
    cu.uOpacity.value = this.on ? 0.9 * (1 - smooth(2.4, 4.2, zoom) * 0.6) : 0;
    this.clouds.visible = this.on;
    u.uCloudShadow.value *= this.on ? 1 : 0;
  }

  dispose() {
    this.cloudMapTex?.dispose(); this.mistTex?.dispose(); this.puffTex.dispose();
    this.clouds.geometry.dispose(); this.cloudMat.dispose();
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
