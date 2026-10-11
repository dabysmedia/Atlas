import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
let renderer: THREE.WebGLRenderer | undefined, ktx: KTX2Loader | undefined;
const draco = new DRACOLoader().setDecoderPath('/codecs/draco/');
const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
/** One offscreen renderer, one thumbnail per model, rather than a WebGL context per card. */
export function miniaturePreview(world: string, model: string): Promise<string> {
  const key = `${world}/${model}`;
  const cached = cache.get(key); if (cached) return cached;
  const result = queue.catch(() => {}).then(async () => {
    renderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(240, 160, false); renderer.setClearColor(0, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    ktx ??= new KTX2Loader().setTranscoderPath('/codecs/basis/').detectSupport(renderer);
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx).setMeshoptDecoder(MeshoptDecoder);
    const { scene: modelScene } = await loader.loadAsync(`/api/worlds/${world}/token-models/${model}`);
    try {
      const bounds = new THREE.Box3().setFromObject(modelScene), sphere = bounds.getBoundingSphere(new THREE.Sphere());
      if (bounds.isEmpty() || !Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('No visible geometry');
      const scene = new THREE.Scene(), centered = new THREE.Group(); centered.add(modelScene); centered.position.copy(sphere.center).multiplyScalar(-1); scene.add(centered);
      scene.add(new THREE.HemisphereLight(0xe9f4ff, 0x6d5b47, 2.4));
      const keyLight = new THREE.DirectionalLight(0xffecd2, 3); keyLight.position.set(3, 5, 4); scene.add(keyLight);
      const camera = new THREE.PerspectiveCamera(35, 1.5, sphere.radius / 100, sphere.radius * 30);
      const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(17.5)) * 1.12;
      camera.position.set(1.8, 1.2, 2.2).normalize().multiplyScalar(distance); camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    } finally {
      const resources = new Set<{ dispose(): void }>();
      modelScene.traverse(o => { const mesh = o as THREE.Mesh; if (!mesh.isMesh) return; resources.add(mesh.geometry); for (const material of [mesh.material].flat()) { resources.add(material); for (const v of Object.values(material)) if (v instanceof THREE.Texture) resources.add(v); } });
      resources.forEach(r => r.dispose());
    }
  });
  cache.set(key, result); if (cache.size > 128) cache.delete(cache.keys().next().value!);
  queue = result;
  result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
  return result;
}
