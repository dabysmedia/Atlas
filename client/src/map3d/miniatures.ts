import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { miniatureStatus, reportMiniature } from './modelStatus';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HEX_SIZE } from '../../../shared/hex';
import { isNotableKind } from '../../../shared/markers';
import type { Token } from '../types';
export class Miniatures {
  readonly group = new THREE.Group();
  private assets = new Map<string, THREE.Object3D>();
  private pending = new Set<string>();
  private pieces = new Map<string, { modelId: string; object: THREE.Object3D }>();
  private disposed = false;
  private lastTime = 0;
  private highlightColor = new THREE.Color('#8fe8e2');
  private releasePiece(object: THREE.Object3D) {
    object.traverse(o => { const mesh = o as THREE.Mesh; if (mesh.isMesh) for (const material of [mesh.material].flat()) material.dispose(); });
  }
  private draco = new DRACOLoader().setDecoderPath('/codecs/draco/');
  private ktx: KTX2Loader | null = null;
  configure(renderer: THREE.WebGLRenderer) { this.ktx = new KTX2Loader().setTranscoderPath('/codecs/basis/').detectSupport(renderer); }

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private release(object: THREE.Object3D) { object.traverse(o => { const mesh = o as THREE.Mesh; if (!mesh.isMesh) return; mesh.geometry.dispose(); for (const material of [mesh.material].flat()) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose(); material.dispose(); } }); }
  update(tokens: Token[], pos: (t: Token) => { x: number; y: number } | null, ground: (x: number, y: number) => number, invalidate: () => void, interaction: { now: number; hovered: string | null; selected: string | null; dragging: string | null; still: boolean } = { now: 0, hovered: null, selected: null, dragging: null, still: true }) {
    const dt = Math.min(0.1, Math.max(0, (interaction.now - this.lastTime) / 1000)); this.lastTime = interaction.now;
    const ease = 1 - Math.exp(-dt * 14);
    const wanted = new Set(tokens.filter(t => t.hexId && t.modelId).map(t => t.id));
    for (const [id, piece] of this.pieces) if (!wanted.has(id) || tokens.find(t => t.id === id)?.modelId !== piece.modelId) { this.group.remove(piece.object); this.releasePiece(piece.object); this.pieces.delete(id); }
    for (const token of tokens) {
      if (!token.modelId || !token.hexId) continue;
      const key = `${token.worldId}/${token.modelId}`, asset = this.assets.get(key);
      if (!asset && !this.pending.has(key) && miniatureStatus(key)?.state !== 'error') {
        this.pending.add(key); reportMiniature(key, { state: 'loading' }); const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); loader.setDRACOLoader(this.draco); if (this.ktx) loader.setKTX2Loader(this.ktx);
        loader.load(`/api/worlds/${token.worldId}/token-models/${token.modelId}`, gltf => {
          this.pending.delete(key);
          if (this.disposed) { this.release(gltf.scene); return; }
          const bounds = new THREE.Box3().setFromObject(gltf.scene);
          if (bounds.isEmpty() || !Number.isFinite(bounds.getSize(new THREE.Vector3()).length())) { this.release(gltf.scene); reportMiniature(key, { state: 'error', message: 'This GLB has no visible geometry.' }); return; }
          this.assets.set(key, gltf.scene); reportMiniature(key, { state: 'ready' }); invalidate();
        }, undefined, error => { this.pending.delete(key); if (!this.disposed) reportMiniature(key, { state: 'error', message: `Miniature failed to load: ${error instanceof Error ? error.message : 'check the GLB file'}` }); invalidate(); });
      }
      if (!asset) continue;
      let piece = this.pieces.get(token.id);
      if (!piece) {
        const object = new THREE.Group(), model = clone(asset), box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
        const scale = Math.min(46 / Math.max(size.y, 0.001), HEX_SIZE * 1.64 / Math.max(Math.hypot(size.x, size.z), 0.001));
        model.scale.setScalar(scale); model.position.set(-(box.min.x + box.max.x) * scale / 2, -box.min.y * scale, -(box.min.z + box.max.z) * scale / 2);
        object.add(model); object.userData.footprint = Math.hypot(size.x, size.z) * scale; object.userData.extent = { width: size.x * scale, depth: size.z * scale, height: size.y * scale }; object.userData.tokenId = token.id; object.traverse(o => { o.userData.tokenId = token.id; if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          const mesh = o as THREE.Mesh;
          const copy = (source: THREE.Material) => {
            const material = source.clone() as THREE.MeshStandardMaterial;
            material.userData.baseColor = material.color?.clone(); material.userData.baseEmissive = material.emissive?.clone();
            material.userData.baseIntensity = material.emissiveIntensity;
            return material;
          };
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
        } });
        piece = { modelId: token.modelId, object }; this.pieces.set(token.id, piece); this.group.add(object);
      }
      const p = pos(token);
      if (p) {
        const peers = tokens.filter(t => t.hexId === token.hexId && isNotableKind(t.kind) === isNotableKind(token.kind));
        const radius = peers.length > 1 ? HEX_SIZE * 0.38 : 0;
        const maxFootprint = peers.length > 1 ? Math.min(HEX_SIZE * 1.64 - radius * 2, radius * 3.6 * Math.sin(Math.PI / peers.length)) : HEX_SIZE * 1.64;
        const hover = token.id === interaction.hovered;
        const target = hover ? 1.12 : 1;
        const grow = interaction.still ? 1 : (piece.object.userData.grow ?? 1) + (target - (piece.object.userData.grow ?? 1)) * ease;
        piece.object.userData.grow = grow;
        // Reserve room for the hover growth so a miniature stays inside its shared-hex slot.
        piece.object.scale.setScalar(Math.min(1, maxFootprint / Math.max(piece.object.userData.footprint * 1.12, 0.001)) * grow);
        const phase = [...token.id].reduce((n, c) => n + c.charCodeAt(0), 0) * 0.37;
        const time = interaction.now / 1000 + phase;
        const atRest = !interaction.still && interaction.dragging !== token.id;
        piece.object.rotation.set(atRest ? Math.sin(time * 0.8) * 0.012 : 0, atRest ? Math.sin(time * 0.65) * 0.025 : 0, atRest ? Math.cos(time * 0.7) * 0.012 : 0);
        const highlight = interaction.still ? 0 : hover ? 0.45 : token.id === interaction.selected ? 0.25 : 0;
        piece.object.traverse(o => {
          const mesh = o as THREE.Mesh; if (!mesh.isMesh) return;
          for (const m of [mesh.material].flat()) {
            const material = m as THREE.MeshStandardMaterial;
            if (material.emissive && material.userData.baseEmissive) {
              material.emissive.copy(material.userData.baseEmissive).lerp(this.highlightColor, highlight);
              material.emissiveIntensity = Math.max(material.userData.baseIntensity ?? 1, highlight ? 0.8 : 0);
            } else if (material.color && material.userData.baseColor) material.color.copy(material.userData.baseColor).lerp(this.highlightColor, highlight * 0.6);
          }
        });
        // tokenPos already includes the shared-hex slot and any movement interpolation.
        piece.object.position.set(p.x, ground(p.x, p.y) + 5 + (atRest ? Math.sin(time * 1.1) * 0.6 : 0), p.y);
      }
    }
  }
  has(id: string) { return this.pieces.has(id); }
  extent(id: string) {
    const object = this.pieces.get(id)?.object; if (!object) return null;
    const e = object.userData.extent as { width: number; depth: number; height: number };
    // Transform the cached model bounds, including hover scale and sway, for clear nameplates.
    object.updateMatrix();
    const bounds = new THREE.Box3(new THREE.Vector3(-e.width / 2, 0, -e.depth / 2), new THREE.Vector3(e.width / 2, e.height, e.depth / 2)).applyMatrix4(object.matrix);
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    return { x: center.x, y: center.z, foot: bounds.min.y, width: size.x, depth: size.z, height: size.y };
  }
  hit(x: number, y: number, w: number, h: number, camera: THREE.Camera) { if (!this.group.visible) return undefined; this.ndc.set(x / w * 2 - 1, 1 - y / h * 2); this.ray.setFromCamera(this.ndc, camera); return this.ray.intersectObjects(this.group.children, true)[0]?.object.userData.tokenId as string | undefined; }
  dispose() { this.disposed = true; this.draco.dispose(); this.ktx?.dispose(); for (const piece of this.pieces.values()) this.releasePiece(piece.object); for (const asset of this.assets.values()) this.release(asset); this.assets.clear(); this.pieces.clear(); this.group.clear(); }
}
