/**
 * The 3D map: the island as a place, lit by a living sky.
 *
 * Hexes stay the source of truth. This renderer reuses the 2D renderer for everything derived from
 * them (territory washes, borders, grid, fog, labels, selection, brushes) by drawing that output
 * into an offscreen canvas over the part of the world in view, and draping it onto the terrain and
 * the sea as a texture looked up by world position, so it follows every slope. Markers stand on the
 * ground in a screen-space layer above the scene.
 *
 * Ground comes from a world's 3D model when it has one, or from relief raised out of its hex
 * terrain (with its map art or painted terrain laid on top) when it doesn't. Either way a height
 * field sampled from that ground answers picking, marker footing and the sea's depth.
 *
 * Camera: the same { x, y, zoom } as the 2D map (zoom = screen pixels per world unit at the point
 * looked at), plus tilt and heading. Zoomed out it looks straight down; zooming in tips it toward
 * the horizon. World x is three.js x, world y is three.js z, height is three.js y.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HexMapRenderer, HEX_SIZE, MAX_ZOOM, clamp, type Camera, type RenderInput } from '../map/renderer';
import type { ArtPlacement, ModelPlacement, TokenKind, Token } from '../types';
import { hoursNow, type Daylight } from '../../../shared/daylight';
import { HeightField, rasterizeMesh, reliefFromHexes } from './heightfield';
import { lightingAt, makeSkyDome, partOfDay, type Lighting } from './sky';
import { depthTexture, makeWater } from './water';

const FOV = 24; // degrees, vertical; narrow so the overhead view stays close to a flat map
const MAX_TILT = 1.32;
/** Sea level on a model, in its normalized height units (its base sits at 0). */
const MODEL_SEA = 0.008;
const OVERLAY_MAX = 2048;

export type ModelSource = { url: string; placement: ModelPlacement };

const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class HexMapRenderer3D extends HexMapRenderer {
  readonly gl: THREE.WebGLRenderer;
  readonly glCanvas: HTMLCanvasElement;
  readonly hud: HTMLCanvasElement;
  protected hudCtx: CanvasRenderingContext2D;
  protected scene = new THREE.Scene();
  protected camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1e5);
  protected key = new THREE.DirectionalLight(0xffffff, 2);
  protected hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  protected fog3 = new THREE.FogExp2(0x000000, 0.0002);
  protected sky = makeSkyDome();
  protected water = makeWater();
  protected ground: THREE.Object3D | null = null;
  protected glows = new THREE.Group();
  protected glowTex = glowTexture();
  protected hf = HeightField.empty(0, 0, 1, 1, 2, 2);
  protected depthTex: THREE.DataTexture | null = null;
  protected sea = 0;
  protected bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  protected model: ModelSource | null = null;
  protected modelWanted: string | null | undefined = undefined; // url, null = relief; undefined = not told yet
  protected modelLoad = 0;
  protected reliefSig = '';
  protected reliefTimer = 0;
  protected artImg: HTMLImageElement | null = null;

  // Overlay: the 2D renderer's output for the area in view, draped by world position.
  protected ovTex: THREE.CanvasTexture;
  protected ovRect = { x: 0, y: 0, w: 1, h: 1, zoom: 0 };
  protected ovUniforms = { uOverlay: { value: null as THREE.Texture | null }, uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uOverlayGlow: { value: 0.1 } };
  protected ovLast = 0;

  // Camera beyond { x, y, zoom }.
  yaw = 0;
  protected yawT = 0;
  protected tiltBias = 0;
  protected tiltBiasT = 0;
  protected tiltNow = 0;
  overhead = false;
  protected groundY = 0;
  protected ease = 14;
  protected anchorY = 0;
  protected saved: { cam: Camera; yaw: number; tiltBias: number; overhead: boolean } | null = null;
  protected camVersion = 0;
  protected occlusion = new Map<string, number>();

  // Time of day.
  protected daylight: Daylight | null = null;
  protected sweepStart = 0;
  protected light: Lighting = lightingAt(10);
  /** For tests and the frame readout: the hour the light currently shows. */
  shownHour = 10;

  protected idleTick = 0;
  protected frameMs: number[] = [];
  protected lastFrame = 0;
  onLoadState?: (s: 'loading' | 'ready' | 'error') => void;

  constructor(glCanvas: HTMLCanvasElement, hud: HTMLCanvasElement) {
    super(document.createElement('canvas'), { alpha: true });
    this.overlayMode = true;
    this.glCanvas = glCanvas;
    this.hud = hud;
    this.hudCtx = hud.getContext('2d')!;
    this.gl = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.shadowMap.autoUpdate = false; // re-rendered only when the light or the view moves

    this.ovTex = this.makeOverlayTexture();
    this.scene.fog = this.fog3;
    this.scene.add(this.sky.mesh, this.water.mesh, this.glows, this.hemi, this.key, this.key.target);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.water.uniforms.uOverlay.value = this.ovTex;
    this.water.uniforms.uOverlayRect = this.ovUniforms.uOverlayRect;
    this.water.uniforms.uOverlayGlow = this.ovUniforms.uOverlayGlow;
  }

  protected makeOverlayTexture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.flipY = false;
    t.premultiplyAlpha = true;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
    t.minFilter = THREE.LinearMipmapLinearFilter;
    this.ovUniforms.uOverlay.value = t;
    if (this.water) this.water.uniforms.uOverlay.value = t;
    return t;
  }

  destroy() {
    super.destroy();
    window.clearTimeout(this.reliefTimer);
    this.modelLoad++;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) { for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose(); mat.dispose(); }
    });
    this.ovTex.dispose(); this.depthTex?.dispose(); this.glowTex.dispose();
    this.gl.dispose();
    this.gl.forceContextLoss();
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.gl.setPixelRatio(this.dpr);
    this.gl.setSize(w, h, false);
    this.hud.width = Math.round(w * this.dpr); this.hud.height = Math.round(h * this.dpr);
    this.camera.aspect = w / Math.max(1, h);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- data
  setData(d: RenderInput) {
    super.setData(d);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.chunks.values()) { minX = Math.min(minX, c.minX); minY = Math.min(minY, c.minY); maxX = Math.max(maxX, c.maxX); maxY = Math.max(maxY, c.maxY); }
    if (Number.isFinite(minX)) this.bounds = { minX, minY, maxX, maxY };
    this.rebuildGlows();
    this.scheduleRelief();
  }

  setTokens(tokens: Token[]) { super.setTokens(tokens); this.rebuildGlows(); }

  setArt(img: HTMLImageElement | null, placement: ArtPlacement | null) {
    super.setArt(img, placement);
    this.artImg = img;
    this.reliefSig = '';
    this.scheduleRelief();
  }

  /** The world's 3D model, or null to raise relief from the hexes. */
  setModel(src: ModelSource | null) {
    const url = src?.url ?? null;
    if (url === this.modelWanted && JSON.stringify(src?.placement) === JSON.stringify(this.model?.placement)) return;
    this.modelWanted = url;
    this.model = src;
    if (!src) { this.reliefSig = ''; this.scheduleRelief(0); return; }
    const ticket = ++this.modelLoad;
    this.onLoadState?.('loading');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(src.url, (gltf) => {
      if (ticket !== this.modelLoad) return;
      this.useModel(gltf.scene, src.placement);
      this.onLoadState?.('ready');
    }, undefined, () => { if (ticket === this.modelLoad) this.onLoadState?.('error'); });
  }

  protected useModel(root: THREE.Object3D, p: ModelPlacement) {
    const group = new THREE.Group();
    group.add(root);
    const s = p.w / 2;
    group.position.set(p.x + p.w / 2, 0, p.y + p.h / 2);
    group.scale.set(s, s * p.heightScale, p.h / 2);
    group.updateMatrixWorld(true);
    const hf = HeightField.empty(p.x, p.y, p.w, p.h, 1024, 1024);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.metalness = 0; mat.roughness = 0.92;
      if (mat.map) mat.map.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
      this.drape(mat);
      rasterizeMesh(m.geometry, m.matrixWorld, hf);
    });
    this.setGround(group, hf, MODEL_SEA * s * p.heightScale);
  }

  protected setGround(obj: THREE.Object3D, hf: HeightField, sea: number) {
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); const mat = m.material as THREE.MeshStandardMaterial; mat.map?.dispose(); mat.normalMap?.dispose(); mat.dispose(); } });
    }
    this.ground = obj;
    this.scene.add(obj);
    this.hf = hf;
    this.sea = sea;
    this.depthTex?.dispose();
    this.depthTex = depthTexture(hf, sea);
    this.water.uniforms.uDepth.value = this.depthTex;
    const b = this.bounds, span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    this.water.mesh.position.set((b.minX + b.maxX) / 2, sea, (b.minY + b.maxY) / 2);
    this.water.mesh.scale.set(span * 16, 1, span * 16);
    (this.water.uniforms.uDepthRect.value as THREE.Vector4).set(hf.minX, hf.minY, hf.w, hf.h);
    this.occlusion.clear();
    this.rebuildGlows();
    this.groundY = this.groundAround(this.cam.x, this.cam.y);
    this.ovRect.zoom = 0; // redraw the overlay for the new ground
    this.dirty = true;
  }

  /** Mix the draped overlay into a terrain material: by world position, lit like the ground. */
  protected drape(mat: THREE.MeshStandardMaterial) {
    const U = this.ovUniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'varying vec3 vWp;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'varying vec3 vWp;\nuniform sampler2D uOverlay;\nuniform vec4 uOverlayRect;\nuniform float uOverlayGlow;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', `#include <map_fragment>
  vec2 ouv = (vWp.xz - uOverlayRect.xy) / uOverlayRect.zw;
  vec4 ov = (ouv.x < 0.0 || ouv.y < 0.0 || ouv.x > 1.0 || ouv.y > 1.0) ? vec4(0.0) : texture2D(uOverlay, ouv);
  diffuseColor.rgb = diffuseColor.rgb * (1.0 - ov.a) + ov.rgb;`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += ov.rgb * uOverlayGlow;');
    };
    mat.customProgramCacheKey = () => 'atlas-drape';
    mat.needsUpdate = true;
  }

  /** Worlds without a model: relief raised from hex terrain, with the art (or painted terrain) on it. */
  protected scheduleRelief(delay = 250) {
    if (this.modelWanted !== null || !this.hexes.length) return;
    const sig = this.hexes.map((h) => h.terrain).join(',') + `|${this.o}|${this.hexes.length}|${this.artImg?.src ?? ''}|${JSON.stringify(this.artPlacement)}`;
    if (sig === this.reliefSig) return;
    this.reliefSig = sig;
    window.clearTimeout(this.reliefTimer);
    this.reliefTimer = window.setTimeout(() => this.buildRelief(), this.ground ? delay : 0);
  }

  protected buildRelief() {
    if (this.modelWanted !== null) return;
    const hf = reliefFromHexes(this.hexes, this.o, this.bounds);
    const geo = new THREE.PlaneGeometry(hf.w, hf.h, hf.nx - 1, hf.ny - 1).rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) pos.setY(k, hf.data[k]);
    geo.translate(hf.minX + hf.w / 2, 0, hf.minY + hf.h / 2);
    geo.computeVertexNormals();
    const albedo = new THREE.CanvasTexture(this.albedo(hf));
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
    const mat = new THREE.MeshStandardMaterial({ map: albedo, roughness: 0.95, metalness: 0 });
    this.drape(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.setGround(mesh, hf, 0);
  }

  /** The ground's colors for relief: the map art if there is one, else the painted terrain. */
  protected albedo(hf: HeightField): HTMLCanvasElement {
    const W = 2048, H = Math.max(256, Math.round((W * hf.h) / hf.w));
    const scratch = document.createElement('canvas');
    const r = new HexMapRenderer(scratch);
    try {
      r.resize(W, H);
      Object.assign(r, { dpr: 1 });
      r.layers = { terrainOverlay: 0, grid: false, territory: false };
      r.setData({
        orientation: this.o, hexes: this.hexes.map((h) => ({ ...h, name: '', state: '' })), claims: [], tokens: [], factions: [],
        terrain: [...this.terrainColor].map(([key, color]) => ({ key, color, name: key, glyph: this.terrainGlyph.get(key) ?? 'none' })) as never,
        states: [], fog: null,
      });
      if (this.artImg && this.artPlacement) r.setArt(this.artImg, this.artPlacement);
      let snap = r.snapshot(hf.minX + hf.w / 2, hf.minY + hf.h / 2, W / hf.w, W, H);
      // Painted terrain fills in over a few passes; take the finished one.
      for (let i = 0; i < 40 && (r as unknown as { painting_pending: boolean }).painting_pending; i++) snap = r.snapshot(hf.minX + hf.w / 2, hf.minY + hf.h / 2, W / hf.w, W, H);
      return snap;
    } finally { r.destroy(); }
  }

  // ---------------------------------------------------------------- ground queries
  groundAt(x: number, y: number) { return Math.max(this.hf.at(x, y), this.sea); }
  protected groundAround(x: number, y: number) {
    const R = HEX_SIZE * 1.5;
    let s = this.groundAt(x, y) * 2, n = 2;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; s += this.groundAt(x + Math.cos(a) * R, y + Math.sin(a) * R); n++; }
    return s / n;
  }

  protected rayAt(sx: number, sy: number) {
    const v = new THREE.Vector3((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1, 0.5).unproject(this.camera);
    const o = this.camera.position.clone();
    return { o, d: v.sub(o).normalize() };
  }

  /** The ground point (land or sea) under a screen point. */
  pick(sx: number, sy: number): THREE.Vector3 {
    const { o, d } = this.rayAt(sx, sy);
    const hit = this.hf.raycast(o, d, this.sea);
    if (hit) return hit;
    const t = d.y < -1e-4 ? (this.sea - o.y) / d.y : this.camDist() * 3;
    return o.addScaledVector(d, t);
  }

  screenToWorld(sx: number, sy: number) {
    if (!this.w) return super.screenToWorld(sx, sy);
    const p = this.pick(sx, sy);
    return { x: p.x, y: p.z };
  }

  worldToScreen(x: number, y: number) {
    const v = new THREE.Vector3(x, this.groundAt(x, y), y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h };
  }

  /** Screen point of a world point at a given height (for tests and the HUD). */
  projectPoint(x: number, y: number, height: number) {
    const v = new THREE.Vector3(x, height, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.w, y: ((1 - v.y) / 2) * this.h };
  }

  protected tokenLift(kind: TokenKind, r: number) { return r * (kind === 'city' || kind === 'outpost' ? 1.15 : 1.35); }

  /** Markers behind a ridge from where the camera stands are shown faintly. */
  protected tokenAlpha(x: number, y: number) {
    const k = `${Math.round(x)},${Math.round(y)}`;
    const hit = this.occlusion.get(k);
    if (hit !== undefined) return hit;
    const p = new THREE.Vector3(x, this.groundAt(x, y) + 4, y);
    const o = this.camera.position;
    const d = p.clone().sub(o);
    const len = d.length();
    d.normalize();
    const h = this.hf.raycast(o, d, this.sea);
    const a = h && h.distanceTo(o) < len - HEX_SIZE * 0.4 ? 0.35 : 1;
    this.occlusion.set(k, a);
    return a;
  }

  // ---------------------------------------------------------------- camera
  protected camDist(z = this.cam.zoom) { return this.h / (2 * z * Math.tan(THREE.MathUtils.degToRad(FOV / 2))); }
  protected autoTilt(z: number) { return 0.62 * smooth(26, 84, HEX_SIZE * z); }
  protected wantedTilt() { return this.overhead ? 0 : clamp(this.autoTilt(this.cam.zoom) + this.tiltBias, 0, MAX_TILT); }

  protected updateCamera() {
    const dist = this.camDist();
    const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const T = new THREE.Vector3(this.cam.x, this.groundY, this.cam.y);
    const c = this.camera;
    c.position.copy(T).addScaledVector(back, Math.sin(this.tiltNow) * dist);
    c.position.y += Math.cos(this.tiltNow) * dist;
    c.up.set(-back.x, 0, -back.z);
    c.lookAt(T);
    const span = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    c.near = Math.max(1, dist * 0.04);
    c.far = dist * 10 + span * 6;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    const sig = `${c.position.x.toFixed(2)},${c.position.y.toFixed(2)},${c.position.z.toFixed(2)},${this.yaw.toFixed(4)},${this.w},${this.h}`;
    if (sig !== this.camSig) { this.camSig = sig; this.camVersion++; this.occlusion.clear(); }
  }
  protected camSig = '';

  /** Move the view by a screen-space drag, on the ground. */
  protected panRaw(dx: number, dy: number) {
    const z = this.cam.zoom;
    const cy = Math.max(0.25, Math.cos(this.tiltNow));
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const bx = Math.sin(this.yaw), bz = Math.cos(this.yaw);
    this.cam.x -= (rx * dx + (bx * dy) / cy) / z;
    this.cam.y -= (rz * dx + (bz * dy) / cy) / z;
  }

  panBy(dx: number, dy: number) {
    this.anchor = null;
    this.ease = 14;
    this.panRaw(dx, dy);
    this.target = { ...this.cam };
    this.dirty = true;
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z = clamp(this.target.zoom * factor, this.minZoom(), MAX_ZOOM);
    const p = this.pick(sx, sy);
    this.anchor = { sx, sy, wx: p.x, wy: p.z };
    this.anchorY = p.y;
    this.target.zoom = z;
    this.velocity = { x: 0, y: 0 };
    this.ease = 14;
    this.dirty = true;
  }

  flyTo(x: number, y: number, zoom?: number) {
    super.flyTo(x, y, zoom);
    this.ease = 4.5;
  }

  setCamera(c: Camera) {
    super.setCamera(c);
    this.groundY = this.groundAround(c.x, c.y);
    this.tiltNow = this.wantedTilt();
    this.updateCamera();
  }

  /** Turn the view about the point looked at (radians), or tip it toward the horizon. */
  rotate(dYaw: number) { this.yawT += dYaw; this.dirty = true; }
  tip(dTilt: number) { this.overhead = false; this.tiltBiasT = clamp(this.tiltBiasT + dTilt, -0.7, MAX_TILT); this.dirty = true; }
  setOverhead(on: boolean) { this.overhead = on; if (on) this.tiltBiasT = 0; this.dirty = true; }
  faceNorth() { this.yawT = Math.round(this.yawT / (Math.PI * 2)) * Math.PI * 2; this.tiltBiasT = 0; this.dirty = true; }

  /**
   * A slow, gentle move onto a place: zoom in, tip a little toward the horizon, and leave room for
   * the panel on the right. The view before the first focus is kept for restoreView().
   */
  focusOn(x: number, y: number, zoom: number, panelPx = 0) {
    if (!this.saved) this.saved = { cam: { ...this.target }, yaw: this.yawT, tiltBias: this.tiltBiasT, overhead: this.overhead };
    const z = clamp(zoom, this.minZoom(), MAX_ZOOM);
    const rx = Math.cos(this.yawT), rz = -Math.sin(this.yawT);
    this.anchor = null;
    this.velocity = { x: 0, y: 0 };
    this.target = { x: x + (rx * panelPx) / z, y: y + (rz * panelPx) / z, zoom: z };
    this.overhead = false;
    this.tiltBiasT = this.saved.tiltBias + 0.16;
    this.ease = 2.4;
    this.dirty = true;
  }

  /** Back out of a focus to exactly the view before it. */
  restoreView() {
    const s = this.saved;
    if (!s) return;
    this.saved = null;
    this.anchor = null;
    this.velocity = { x: 0, y: 0 };
    this.target = { ...s.cam };
    this.yawT = s.yaw; this.tiltBiasT = s.tiltBias; this.overhead = s.overhead;
    this.ease = 2.2;
    this.dirty = true;
  }
  get focused() { return !!this.saved; }

  protected step(dt: number): boolean {
    const k = 1 - Math.exp(-dt * this.ease);
    const kr = 1 - Math.exp(-dt * Math.min(this.ease, 7));
    const before = { ...this.cam };
    let moving = false;
    if (Math.abs(this.velocity.x) + Math.abs(this.velocity.y) > 2) {
      this.panRaw(this.velocity.x * dt, this.velocity.y * dt);
      this.target.x = this.cam.x; this.target.y = this.cam.y;
      const decay = Math.exp(-dt * 5);
      this.velocity.x *= decay; this.velocity.y *= decay;
      moving = true;
    }
    const zDiff = Math.log(this.target.zoom / this.cam.zoom);
    if (Math.abs(zDiff) > 0.0005) { this.cam.zoom *= Math.exp(zDiff * k); moving = true; } else this.cam.zoom = this.target.zoom;
    const settle = (v: number, t: number, eps: number) => (Math.abs(t - v) < eps ? t : v + (t - v) * kr);
    if (this.yaw !== this.yawT || this.tiltBias !== this.tiltBiasT) moving = true;
    this.yaw = settle(this.yaw, this.yawT, 1e-4);
    this.tiltBias = settle(this.tiltBias, this.tiltBiasT, 1e-4);
    const tilt = this.wantedTilt();
    if (Math.abs(tilt - this.tiltNow) > 1e-4) { this.tiltNow += (tilt - this.tiltNow) * kr; moving = true; } else this.tiltNow = tilt;
    const g = this.groundAround(this.cam.x, this.cam.y);
    if (Math.abs(g - this.groundY) > 0.05) { this.groundY += (g - this.groundY) * (1 - Math.exp(-dt * 5)); moving = true; }
    this.updateCamera();

    if (this.anchor) {
      // Keep the ground point under the cursor where it is while the zoom eases.
      const s = this.projectPoint(this.anchor.wx, this.anchor.wy, this.anchorY);
      const dx = this.anchor.sx - s.x, dy = this.anchor.sy - s.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) { this.panRaw(dx, dy); this.updateCamera(); }
      this.target.x = this.cam.x; this.target.y = this.cam.y;
      // Hold the anchor until the tilt that follows the zoom has settled too.
      if (this.cam.zoom === this.target.zoom && this.tiltNow === tilt) this.anchor = null;
    } else {
      const dx = this.target.x - this.cam.x, dy = this.target.y - this.cam.y;
      if (Math.abs(dx) * this.cam.zoom > 0.3 || Math.abs(dy) * this.cam.zoom > 0.3) {
        this.cam.x += dx * k; this.cam.y += dy * k; moving = true;
      } else { this.cam.x = this.target.x; this.cam.y = this.target.y; }
      this.updateCamera();
    }
    if (this.cam.x !== before.x || this.cam.y !== before.y || this.cam.zoom !== before.zoom) this.onCameraChange?.(this.cam);
    return moving;
  }

  // ---------------------------------------------------------------- time of day
  setDaylight(d: Daylight | null) { this.daylight = d; }
  /** A day passed on the world clock: the light runs once round the clock and lands where it was. */
  sweepDay() { this.sweepStart = performance.now(); }

  protected hourAt(now: number) {
    let hour = this.daylight ? hoursNow(this.daylight) % 24 : 10;
    const t = (now - this.sweepStart) / 3200;
    if (this.sweepStart && t < 1) { const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; hour = (hour - 24 * (1 - e) + 48) % 24; }
    return hour;
  }

  protected applyLight(now: number) {
    const L = (this.light = lightingAt(this.hourAt(now)));
    this.shownHour = L.hour;
    this.key.color.copy(L.keyColor); this.key.intensity = 1;
    this.hemi.color.copy(L.hemiSky); this.hemi.groundColor.copy(L.hemiGround); this.hemi.intensity = L.hemiIntensity;
    this.gl.toneMappingExposure = L.exposure;
    this.fog3.color.copy(L.horizon);
    this.fog3.density = L.fogK / this.camDist();
    this.scene.background = L.horizon;
    const su = this.sky.uniforms;
    su.uZenith.value.copy(L.zenith); su.uHorizon.value.copy(L.horizon);
    su.uSunDir.value.copy(L.sunDir); su.uMoonDir.value.copy(L.moonDir); su.uSunColor.value.copy(L.keyColor); su.uNight.value = L.night;
    const wu = this.water.uniforms;
    wu.uKeyDir.value.copy(L.keyDir); wu.uKeyColor.value.copy(L.keyColor);
    wu.uHemiSky.value.copy(L.hemiSky).multiplyScalar(L.hemiIntensity); wu.uHemiGround.value.copy(L.hemiGround).multiplyScalar(L.hemiIntensity);
    wu.uZenith.value.copy(L.zenith); wu.uHorizon.value.copy(L.horizon); wu.uNight.value = L.night;
    wu.uTime.value = now / 1000;
    wu.uDetail.value = smooth(0.35, 1.4, this.cam.zoom);
    this.ovUniforms.uOverlayGlow.value = L.overlayGlow;
    for (const s of this.glows.children as THREE.Sprite[]) (s.material as THREE.SpriteMaterial).opacity = L.night * (s.userData.strength as number);
    this.glows.visible = L.night > 0.01;
  }

  /** Warm light over settlements after dark. */
  protected rebuildGlows() {
    for (const s of [...this.glows.children]) { this.glows.remove(s); ((s as THREE.Sprite).material as THREE.Material).dispose(); }
    for (const t of this.tokens) {
      if (t.kind !== 'city' && t.kind !== 'outpost') continue;
      const p = this.tokenPos(t);
      if (!p) continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffb35c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true }));
      const size = HEX_SIZE * (t.kind === 'city' ? 2.6 : 1.5);
      sp.scale.set(size, size, 1);
      sp.position.set(p.x, this.groundAt(p.x, p.y) + size * 0.12, p.y);
      sp.userData.strength = t.kind === 'city' ? 0.95 : 0.7;
      this.glows.add(sp);
    }
  }

  // ---------------------------------------------------------------- frame
  protected loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.w || !this.h) return;
    const moving = this.step(dt);
    // Idle: the sea and sky still move, at half rate.
    if (!moving && !this.dirty && !this.dragToken && (this.idleTick++ & 1)) return;
    const t0 = performance.now();
    this.frame(now, moving);
    const ms = performance.now() - t0;
    this.frameMs.push(now - (this.lastFrame || now));
    this.lastFrame = now;
    if (this.frameMs.length > 120) this.frameMs.shift();
    this.cpuMs = this.cpuMs * 0.9 + ms * 0.1;
    this.onAfterFrame?.();
  }
  protected cpuMs = 0;

  /** Frames per second over the last couple of seconds, and the CPU cost of a frame. */
  stats() {
    const xs = this.frameMs.filter((x) => x > 0);
    const avg = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return { fps: avg ? 1000 / avg : 0, frameMs: avg, cpuMs: this.cpuMs, overlay: { w: this.canvas.width, h: this.canvas.height } };
  }

  protected frame(now: number, moving: boolean) {
    this.applyLight(now);
    this.updateOverlay(now, false);
    this.fitShadow();
    this.sky.mesh.position.copy(this.camera.position);
    this.sky.mesh.scale.setScalar(this.camera.far * 0.9);
    this.gl.render(this.scene, this.camera);
    this.drawHud(now);
    void moving;
  }

  protected drawHud(now: number) {
    const ctx = this.hudCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.hud.width, this.hud.height);
    const saved = this.ctx;
    this.ctx = ctx;
    try { this.drawTokens(now, this.cam.zoom, false); } finally { this.ctx = saved; }
  }

  /** The ground in view, as a world rectangle (conservative over the range of heights). */
  protected footprint() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const o = this.camera.position;
    const reach = this.camDist() * 3.2;
    const levels = [this.sea, Math.max(this.sea, this.hf.maxH)];
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const d = new THREE.Vector3(nx, ny, 0.5).unproject(this.camera).sub(o).normalize();
      for (const lv of levels) {
        let t = d.y < -1e-3 ? (lv - o.y) / d.y : reach;
        if (t < 0 || t > reach) t = reach;
        const x = o.x + d.x * t, z = o.z + d.z * t;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, z); maxY = Math.max(maxY, z);
      }
    }
    const pad = HEX_SIZE * 3, b = this.bounds;
    minX = Math.max(minX, b.minX - pad); minY = Math.max(minY, b.minY - pad);
    maxX = Math.min(maxX, b.maxX + pad); maxY = Math.min(maxY, b.maxY + pad);
    if (maxX <= minX || maxY <= minY) return null;
    return { minX, minY, maxX, maxY };
  }

  /** Redraw the draped overlay when the view leaves it, the zoom moves on, or the map changed. */
  protected updateOverlay(now: number, force: boolean) {
    const f = this.footprint();
    if (!f) return;
    const R = this.ovRect;
    const fw = f.maxX - f.minX, fh = f.maxY - f.minY;
    const covered = R.zoom > 0 && f.minX >= R.x && f.minY >= R.y && f.maxX <= R.x + R.w && f.maxY <= R.y + R.h && R.w * R.h < fw * fh * 4.5;
    const zr = R.zoom ? this.cam.zoom / R.zoom : 0;
    const zoomOk = zr > 0.84 && zr < 1.19;
    // Only edit flashes animate the overlay; selection and contested borders hold still in 3D, so a
    // quiet map costs no redraws or texture uploads.
    const anim = (this.flashes.size > 0 || this.painting_pending) && now - this.ovLast > 33;
    if (!force && covered && zoomOk && !this.dirty && !anim) return;
    this.dirty = false;
    this.ovLast = now;
    let rect = { x: R.x, y: R.y, w: R.w, h: R.h };
    if (force || !covered || !zoomOk) {
      const m = 0.12;
      rect = { x: f.minX - fw * m, y: f.minY - fh * m, w: fw * (1 + 2 * m), h: fh * (1 + 2 * m) };
    }
    const ppw = Math.min(this.cam.zoom * this.dpr, OVERLAY_MAX / rect.w, OVERLAY_MAX / rect.h);
    const W = Math.min(OVERLAY_MAX, Math.ceil((rect.w * ppw) / 128) * 128), H = Math.min(OVERLAY_MAX, Math.ceil((rect.h * ppw) / 128) * 128);
    // Grow the rectangle to the canvas's whole-tile size so pixels stay square.
    rect.w = W / ppw; rect.h = H / ppw;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W; this.canvas.height = H;
      this.ovTex.dispose();
      this.ovTex = this.makeOverlayTexture();
    }
    this.ovRect = { ...rect, zoom: this.cam.zoom };
    // Draw the 2D map's overlay for this rectangle: its pixels are this many per world unit, and
    // its "screen" units match the 3D screen at the point looked at, so line weights and labels
    // come out at their usual on-screen size there.
    const save = { cam: this.cam, w: this.w, h: this.h, dpr: this.dpr };
    const z = this.cam.zoom;
    const dprO = ppw / z;
    this.cam = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom: z };
    this.w = W / dprO; this.h = H / dprO; this.dpr = dprO;
    // Map modes: the hexcrawl detail (grid, coordinates, names) arrives a little later than in 2D,
    // so the zoomed-out island reads as regions, borders and faction names.
    this.lodZoom = z * 0.62;
    try { this.draw(now); } finally { this.cam = save.cam; this.w = save.w; this.h = save.h; this.dpr = save.dpr; this.lodZoom = null; }
    this.ovUniforms.uOverlayRect.value.set(rect.x, rect.y, rect.w, rect.h);
    this.ovTex.needsUpdate = true;
  }

  /** Shadows cover the ground in view; the key light stands off along its direction. */
  protected fitShadow() {
    const R = this.ovRect;
    const cx = R.x + R.w / 2, cz = R.y + R.h / 2;
    const rad = Math.hypot(R.w, R.h) / 2 + HEX_SIZE;
    const L = this.light.keyDir;
    const top = Math.max(this.hf.maxH, this.sea);
    const c = new THREE.Vector3(cx, top / 2, cz);
    this.key.target.position.copy(c);
    this.key.position.copy(c).addScaledVector(L, rad * 2.5);
    this.key.target.updateMatrixWorld();
    const sc = this.key.shadow.camera;
    sc.left = -rad; sc.right = rad; sc.top = rad; sc.bottom = -rad;
    sc.near = rad * 0.5; sc.far = rad * 4.5;
    sc.updateProjectionMatrix();
    this.key.shadow.normalBias = (rad * 2 / 2048) * 1.5;
    const sig = `${cx.toFixed(1)},${cz.toFixed(1)},${rad.toFixed(1)},${L.x.toFixed(4)},${L.y.toFixed(4)},${L.z.toFixed(4)},${this.ground?.id ?? 0}`;
    if (sig !== this.shadowSig) { this.shadowSig = sig; this.gl.shadowMap.needsUpdate = true; }
  }
  protected shadowSig = '';

  /**
   * A still for panel headers: the place seen at a gentle angle, rendered with the live scene and
   * copied out, then the live view is drawn again in the same task.
   */
  snapshot(x: number, y: number, zoom: number, w: number, h: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = Math.round(w * this.dpr); out.height = Math.round(h * this.dpr);
    if (!this.w || !this.h || w > this.w || h > this.h) return out;
    const saved = { cam: { ...this.cam }, tilt: this.tiltNow, g: this.groundY, hover: this.hoverId, sel: this.selectedId, brush: this.brushIds, selTok: this.selectedTokenId };
    try {
      this.cam = { x, y, zoom };
      this.tiltNow = clamp(this.autoTilt(zoom) + 0.32, 0.55, 1.05);
      this.groundY = this.groundAround(x, y);
      this.hoverId = null; this.selectedId = null; this.brushIds = new Set(); this.selectedTokenId = null;
      this.updateCamera();
      this.applyLight(performance.now());
      this.updateOverlay(performance.now(), true);
      this.fitShadow();
      this.gl.render(this.scene, this.camera);
      this.drawHud(performance.now());
      const ctx = out.getContext('2d')!;
      const sx = ((this.w - w) / 2) * this.dpr, sy = ((this.h - h) / 2) * this.dpr;
      ctx.drawImage(this.glCanvas, sx, sy, w * this.dpr, h * this.dpr, 0, 0, out.width, out.height);
      ctx.drawImage(this.hud, sx, sy, w * this.dpr, h * this.dpr, 0, 0, out.width, out.height);
    } finally {
      this.cam = saved.cam; this.tiltNow = saved.tilt; this.groundY = saved.g;
      this.hoverId = saved.hover; this.selectedId = saved.sel; this.brushIds = saved.brush; this.selectedTokenId = saved.selTok;
      this.updateCamera();
      this.updateOverlay(performance.now(), true);
      this.fitShadow();
      this.gl.render(this.scene, this.camera);
      this.drawHud(performance.now());
    }
    return out;
  }

  /** The surface point under a screen point, found against the drawn triangles (tests check picking with it). */
  meshPick(sx: number, sy: number): { x: number; y: number; h: number } | null {
    if (!this.ground) return null;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1), this.camera);
    const hit = rc.intersectObject(this.ground, true)[0];
    const seaT = rc.ray.direction.y < 0 ? (this.sea - rc.ray.origin.y) / rc.ray.direction.y : Infinity;
    if (!hit || seaT < hit.distance) { if (!Number.isFinite(seaT)) return null; const p = rc.ray.at(seaT, new THREE.Vector3()); return { x: p.x, y: p.z, h: p.y }; }
    return { x: hit.point.x, y: hit.point.z, h: hit.point.y };
  }
  /** Run the camera's easing forward without drawing (tests; the live view does this per frame). */
  advance(seconds: number) { for (let t = 0; t < seconds; t += 1 / 60) this.step(1 / 60); }

  /** The hex centre's screen point at its ground height (tests use this to check picking). */
  hexScreen(id: string) {
    const h = this.byId.get(id);
    if (!h) return null;
    return this.worldToScreen(h.cx, h.cy);
  }
  hexIds() { return this.hexes.map((h) => ({ id: h.id, terrain: h.terrain, x: h.cx, y: h.cy, ground: this.groundAt(h.cx, h.cy) })); }
  get seaLevel() { return this.sea; }
  partOfDay(h: number) { return partOfDay(h); }
  get hasGround() { return !!this.ground; }
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,220,170,0.75)');
  grd.addColorStop(0.5, 'rgba(255,170,90,0.22)');
  grd.addColorStop(1, 'rgba(255,140,60,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
