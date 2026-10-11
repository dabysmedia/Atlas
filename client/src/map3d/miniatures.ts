import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { miniatureStatus, reportMiniature } from './modelStatus';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Token } from '../types';
export class Miniatures {
  readonly group = new THREE.Group();
  private assets = new Map<string, THREE.Object3D>();
  private pending = new Set<string>();
  private pieces = new Map<string, { modelId: string; object: THREE.Object3D }>();
  private disposed = false;
  private draco = new DRACOLoader().setDecoderPath('/codecs/draco/');
  private ktx: KTX2Loader | null = null;
  configure(renderer: THREE.WebGLRenderer) { this.ktx = new KTX2Loader().setTranscoderPath('/codecs/basis/').detectSupport(renderer); }

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private release(object: THREE.Object3D) { object.traverse(o => { const mesh = o as THREE.Mesh; if (!mesh.isMesh) return; mesh.geometry.dispose(); for (const material of [mesh.material].flat()) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose(); material.dispose(); } }); }
  update(tokens: Token[], pos: (t: Token) => { x: number; y: number } | null, ground: (x: number, y: number) => number, invalidate: () => void) {
    const wanted = new Set(tokens.filter(t => t.hexId && t.modelId).map(t => t.id));
    for (const [id, piece] of this.pieces) if (!wanted.has(id) || tokens.find(t => t.id === id)?.modelId !== piece.modelId) { this.group.remove(piece.object); this.pieces.delete(id); }
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
        const scale = Math.min(26 / Math.max(size.y, 0.001), 32 / Math.max(size.x, size.z, 0.001));
        model.scale.setScalar(scale); model.position.set(-(box.min.x + box.max.x) * scale / 2, -box.min.y * scale, -(box.min.z + box.max.z) * scale / 2);
        object.add(model); object.userData.tokenId = token.id; object.traverse(o => { o.userData.tokenId = token.id; if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        piece = { modelId: token.modelId, object }; this.pieces.set(token.id, piece); this.group.add(object);
      }
      const p = pos(token);
      if (p) {
        const peers = tokens.filter(t => t.hexId === token.hexId).sort((a, b) => a.id.localeCompare(b.id));
        const index = peers.findIndex(t => t.id === token.id);
        const angle = index / peers.length * Math.PI * 2, radius = peers.length > 1 ? 20 : 0;
        const x = p.x + Math.cos(angle) * radius, y = p.y + Math.sin(angle) * radius;
        piece.object.position.set(x, ground(x, y) + 0.35, y);
      }
    }
  }
  has(id: string) { return this.pieces.has(id); }
  hit(x: number, y: number, w: number, h: number, camera: THREE.Camera) { this.ndc.set(x / w * 2 - 1, 1 - y / h * 2); this.ray.setFromCamera(this.ndc, camera); return this.ray.intersectObjects(this.group.children, true)[0]?.object.userData.tokenId as string | undefined; }
  dispose() { this.disposed = true; this.draco.dispose(); this.ktx?.dispose(); for (const asset of this.assets.values()) this.release(asset); this.assets.clear(); this.pieces.clear(); this.group.clear(); }
}
