// Turns a raw island export (e.g. a 90 MB Meshy .glb) into a web-weight model for the 3D map.
// Usage: node scripts/bake-model.mjs <in.glb> <out.glb> [targetTriangles=220000] [colorSize=4096] [normalSize=2048]
//
// - welds and simplifies the mesh with meshoptimizer, keeping the silhouette and borders
// - centres it, and scales it so its footprint spans 2 units (x, z in -1..1), with y up
// - re-encodes the colour map (full size: it carries the close-up detail) and a smaller normal map
//   as WebP, and drops the metal/roughness map
//   (terrain reads as fully rough and non-metallic; the material sets that as constants)
// - compresses geometry with EXT_meshopt_compression (three.js decodes it with MeshoptDecoder)
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplify, prune, dedup, textureCompress, meshopt, getBounds, transformMesh } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mat4 } from 'gl-matrix';

const [, , input, output, tri = '220000', tex = '4096', ntex = '2048'] = process.argv;
if (!input || !output) { console.error('usage: bake-model.mjs <in.glb> <out.glb> [triangles] [textureSize]'); process.exit(1); }
await MeshoptSimplifier.ready; await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(input);
const root = doc.getRoot();
const triangles = () => root.listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
console.log('in: triangles', triangles());

// Normalise placement: centre on the footprint, footprint = 2 units, ground at the lowest point.
const scene = root.listScenes()[0];
const b = getBounds(scene);
const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
const s = 2 / span;
const m = mat4.create();
mat4.scale(m, m, [s, s, s]);
mat4.translate(m, m, [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2]);
for (const mesh of root.listMeshes()) transformMesh(mesh, m);
for (const node of root.listNodes()) node.setMatrix(mat4.create());

const ratio = Math.min(1, Number(tri) / triangles());
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.0005, lockBorder: true }), dedup(), prune());
console.log('out: triangles', triangles());

for (const mat of root.listMaterials()) {
  const mr = mat.getMetallicRoughnessTexture();
  mat.setMetallicRoughnessTexture(null).setMetallicFactor(0).setRoughnessFactor(0.92).setDoubleSided(false);
  if (mr) mr.dispose();
}
await doc.transform(
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^(?!normalTexture).*$/, resize: [Number(tex), Number(tex)], quality: 80 }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^normalTexture$/, resize: [Number(ntex), Number(ntex)], quality: 82 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
await io.write(output, doc);
const fs = await import('node:fs');
console.log('wrote', output, (fs.statSync(output).size / 1e6).toFixed(2), 'MB');
