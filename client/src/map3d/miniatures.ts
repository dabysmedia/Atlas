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
  private pieces = new Map<string, { modelId: string; object: THREE.Object3D; outline: THREE.Object3D; localBounds: THREE.Box3; bounds: THREE.Box3; phase: number }>();
  private disposed = false;
  private lastTime = 0;
  private borderMaterial = new THREE.MeshBasicMaterial({ color: '#8fe8e2', side: THREE.BackSide, depthWrite: false, toneMapped: false });
  private pickBounds = new THREE.Box3();
  private pickPoint = new THREE.Vector3();
  private draco = new DRACOLoader().setDecoderPath('/codecs/draco/');
  private ktx: KTX2Loader | null = null;
  configure(renderer: THREE.WebGLRenderer) { this.ktx = new KTX2Loader().setTranscoderPath('/codecs/basis/').detectSupport(renderer); }

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private release(object: THREE.Object3D) { object.traverse(o => { const mesh = o as THREE.Mesh; if (!mesh.isMesh) return; mesh.geometry.dispose(); for (const material of [mesh.material].flat()) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose(); material.dispose(); } }); }
  update(tokens: Token[], pos: (t: Token) => { x: number; y: number } | null, ground: (x: number, y: number) => number, invalidate: () => void, interaction: { now: number; hovered: string | null; selected: string | null; dragging: string | null; still: boolean } = { now: 0, hovered: null, selected: null, dragging: null, still: true }) {
    const dt = Math.min(0.1, Math.max(0, (interaction.now - this.lastTime) / 1000)); this.lastTime = interaction.now;
    const ease = 1 - Math.exp(-dt * 14);
    const byId = new Map(tokens.map(t => [t.id,t]));
    const peers = new Map<string,number>();
    for (const token of tokens) if (token.hexId) { const key = `${token.hexId}/${isNotableKind(token.kind)}`; peers.set(key,(peers.get(key) ?? 0)+1); }
    const wanted = new Set(tokens.filter(t => t.hexId && t.modelId).map(t => t.id));
    for (const [id, piece] of this.pieces) if (!wanted.has(id) || byId.get(id)?.modelId !== piece.modelId) { this.group.remove(piece.object); this.pieces.delete(id); }
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
        object.add(model); object.userData.footprint = Math.hypot(size.x, size.z) * scale; object.userData.extent = { width: size.x * scale, depth: size.z * scale, height: size.y * scale }; object.userData.tokenId = token.id;
        model.traverse(o => { o.userData.tokenId = token.id; if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        // Inverted hull: only the silhouette border draws beyond the original model. Its materials stay untouched.
        const outline = clone(model); outline.scale.multiplyScalar(1.04); outline.visible = false;
        outline.traverse(o => { const mesh=o as THREE.Mesh; if(mesh.isMesh) { mesh.material=this.borderMaterial; mesh.castShadow=false; mesh.receiveShadow=false; mesh.renderOrder=1; } });
        object.add(outline);
        const localBounds = new THREE.Box3(new THREE.Vector3(-size.x*scale/2,0,-size.z*scale/2),new THREE.Vector3(size.x*scale/2,size.y*scale,size.z*scale/2));
        piece = { modelId: token.modelId, object, outline, localBounds, bounds: localBounds.clone(), phase: [...token.id].reduce((n,c)=>n+c.charCodeAt(0),0)*.37 }; this.pieces.set(token.id,piece); this.group.add(object);
      }
      const p = pos(token);
      if (p) {
        const count = peers.get(`${token.hexId}/${isNotableKind(token.kind)}`) ?? 1;
        const radius = count > 1 ? HEX_SIZE * 0.38 : 0;
        const maxFootprint = count > 1 ? Math.min(HEX_SIZE * 1.64 - radius * 2, radius * 3.6 * Math.sin(Math.PI / count)) : HEX_SIZE * 1.64;
        const hover = token.id === interaction.hovered;
        const target = hover ? 1.12 : 1;
        const grow = interaction.still ? 1 : (piece.object.userData.grow ?? 1) + (target - (piece.object.userData.grow ?? 1)) * ease;
        piece.object.userData.grow = grow;
        // Reserve room for the hover growth so a miniature stays inside its shared-hex slot.
        piece.object.scale.setScalar(Math.min(1, maxFootprint / Math.max(piece.object.userData.footprint * 1.12, 0.001)) * grow);
        const time = interaction.now / 1000 + piece.phase;
        const atRest = !token.settlementId && !interaction.still && interaction.dragging !== token.id;
        piece.object.rotation.set(atRest ? Math.sin(time * 0.8) * 0.012 : 0, atRest ? Math.sin(time * 0.65) * 0.025 : 0, atRest ? Math.cos(time * 0.7) * 0.012 : 0);
        piece.outline.visible = !interaction.still && (hover || token.id === interaction.selected);
        // tokenPos already includes the shared-hex slot and any movement interpolation.
        piece.object.position.set(p.x, ground(p.x, p.y) + (token.settlementId ? 0 : 5) + (atRest ? Math.sin(time * 1.1) * 0.6 : 0), p.y);
        piece.object.updateMatrix(); piece.bounds.copy(piece.localBounds).applyMatrix4(piece.object.matrix);
      }
    }
  }
  has(id: string) { return this.pieces.has(id); }
  extent(id: string) {
    const piece = this.pieces.get(id); if (!piece) return null;
    const bounds=piece.bounds;
    return { x:(bounds.min.x+bounds.max.x)/2,y:(bounds.min.z+bounds.max.z)/2,foot:bounds.min.y,width:bounds.max.x-bounds.min.x,depth:bounds.max.z-bounds.min.z,height:bounds.max.y-bounds.min.y };
  }
  /** Pick cached model volumes, never uploaded triangles: cost scales with tokens, not mesh complexity. */
  hit(x: number, y: number, w: number, h: number, camera: THREE.Camera) {
    if (!this.group.visible) return undefined;
    this.ndc.set(x/w*2-1,1-y/h*2); this.ray.setFromCamera(this.ndc,camera); this.group.updateWorldMatrix(true,false);
    let id:string|undefined,nearest=Infinity;
    for(const [tokenId,piece] of this.pieces) {
      this.pickBounds.copy(piece.bounds).applyMatrix4(this.group.matrixWorld);
      if(!this.ray.ray.intersectBox(this.pickBounds,this.pickPoint))continue;
      const distance=this.ray.ray.origin.distanceToSquared(this.pickPoint);
      if(distance<nearest){nearest=distance;id=tokenId;}
    }
    return id;
  }
  dispose() { this.disposed = true; this.draco.dispose(); this.ktx?.dispose(); this.borderMaterial.dispose(); for (const asset of this.assets.values()) this.release(asset); this.assets.clear(); this.pieces.clear(); this.group.clear(); }
}
