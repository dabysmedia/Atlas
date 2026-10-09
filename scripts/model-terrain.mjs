// Reads a baked terrain model and derives a terrain type per hex for a grid laid over it,
// so a world's hexes describe the land the model shows. Used to seed The New World.
// Usage: node scripts/model-terrain.mjs <model.glb> <cols> <rows> <out.json> [preview.png]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { dequantize } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import { offsetToAxial, hexToPixel, gridBounds, HEX_SIZE } from '../dist/shared/hex.js';

const [, , input, colsS, rowsS, out, preview] = process.argv;
const cols = Number(colsS), rows = Number(rowsS), o = 'flat';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(input);
await doc.transform(dequantize());
const node = doc.getRoot().listNodes()[0];
const [sx, sy, sz] = node.getScale(), [tx, ty, tz] = node.getTranslation();
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices();
const tex = prim.getMaterial().getBaseColorTexture();
const img = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });

// Top-down raster of the model over its footprint (x, z in -1..1): highest surface wins.
const N = 768;
const H = new Float32Array(N * N).fill(-1);
const C = new Uint8Array(N * N * 3);
const P = Float32Array.from(pos.getArray()), U = uv.getArray(), I = idx.getArray();
for (let i = 0; i < P.length; i += 3) { P[i] = P[i] * sx + tx; P[i + 1] = P[i + 1] * sy + ty; P[i + 2] = P[i + 2] * sz + tz; }
const gx = (x) => ((x + 1) / 2) * (N - 1);
for (let t = 0; t < I.length; t += 3) {
  const a = I[t], b = I[t + 1], c = I[t + 2];
  const ax = gx(P[a * 3]), az = gx(P[a * 3 + 2]), bx = gx(P[b * 3]), bz = gx(P[b * 3 + 2]), cx = gx(P[c * 3]), cz = gx(P[c * 3 + 2]);
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) continue;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
  const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), z1 = Math.min(N - 1, Math.ceil(Math.max(az, bz, cz)));
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -0.01 || l2 < -0.01 || l3 < -0.01) continue;
    const y = l1 * P[a * 3 + 1] + l2 * P[b * 3 + 1] + l3 * P[c * 3 + 1];
    const k = z * N + x;
    if (y <= H[k]) continue;
    H[k] = y;
    const u = l1 * U[a * 2] + l2 * U[b * 2] + l3 * U[c * 2], v = l1 * U[a * 2 + 1] + l2 * U[b * 2 + 1] + l3 * U[c * 2 + 1];
    const px = Math.min(img.info.width - 1, Math.max(0, Math.round(u * (img.info.width - 1))));
    const py = Math.min(img.info.height - 1, Math.max(0, Math.round(v * (img.info.height - 1))));
    const s = (py * img.info.width + px) * 3;
    C[k * 3] = img.data[s]; C[k * 3 + 1] = img.data[s + 1]; C[k * 3 + 2] = img.data[s + 2];
  }
}

// The grid sits over the model the way the server's fitModelPlacement places it.
const b = gridBounds(cols, rows, o);
const side = Math.min(b.maxX - b.minX, b.maxY - b.minY);
const place = { x: (b.minX + b.maxX - side) / 2, y: (b.minY + b.maxY - side) / 2, w: side, h: side };
const SEA = 0.006; // model units; the shoreline sits just above the base of the cliffs
const sample = (wx, wy) => {
  const mx = ((wx - place.x) / place.w) * 2 - 1, mz = ((wy - place.y) / place.h) * 2 - 1;
  if (mx < -1 || mx > 1 || mz < -1 || mz > 1) return null;
  const k = Math.round(gx(mz)) * N + Math.round(gx(mx));
  return H[k] < 0 ? null : { y: H[k], r: C[k * 3], g: C[k * 3 + 1], b: C[k * 3 + 2] };
};
const terrain = [];
const land = [];
for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
  const a = offsetToAxial(col, row, o), c = hexToPixel(a.q, a.r, HEX_SIZE, o);
  const pts = [];
  for (let ring = 0; ring <= 2; ring++) for (let i = 0; i < (ring ? 6 * ring : 1); i++) {
    const ang = (i / (ring ? 6 * ring : 1)) * Math.PI * 2, rad = ring * HEX_SIZE * 0.38;
    pts.push(sample(c.x + Math.cos(ang) * rad, c.y + Math.sin(ang) * rad));
  }
  const hits = pts.filter((p) => p && p.y > SEA);
  const share = hits.length / pts.length;
  if (share < 0.45) { terrain.push('water'); land.push(false); continue; }
  const ys = hits.map((p) => p.y).sort((x, y) => x - y);
  const med = ys[Math.floor(ys.length / 2)], spread = ys[ys.length - 1] - ys[0];
  const avg = (k) => hits.reduce((s, p) => s + p[k], 0) / hits.length;
  const r = avg('r'), g = avg('g'), bl = avg('b');
  const grey = Math.abs(r - g) < 18 && Math.abs(g - bl) < 22 && r > 95;
  let t;
  if (med > 0.135 || (med > 0.1 && (spread > 0.05 || grey))) t = 'mountains';
  else if (med > 0.062 || spread > 0.06) t = 'hills';
  else if (bl > g * 0.9 && bl > r) t = 'swamp'; // river flats and wetlands read blue-green
  else t = 'jungle'; // the lowlands are rainforest (the lore and the model agree)
  terrain.push(t); land.push(true);
}
// Open ocean is water more than two hexes from any land.
const at = (col, row) => (col < 0 || row < 0 || col >= cols || row >= rows ? false : land[row * cols + col]);
for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
  if (land[row * cols + col]) continue;
  let near = false;
  for (let dr = -2; dr <= 2 && !near; dr++) for (let dc = -2; dc <= 2 && !near; dc++) near = at(col + dc, row + dr);
  if (!near) terrain[row * cols + col] = 'deep';
}
const counts = terrain.reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
console.log(counts);
fs.writeFileSync(out, JSON.stringify({ cols, rows, orientation: o, placement: place, terrain }));

if (preview) {
  const COL = { deep: [36, 71, 95], water: [63, 111, 143], jungle: [47, 107, 61], forest: [79, 122, 70], hills: [156, 138, 90], mountains: [125, 116, 104], swamp: [93, 107, 74] };
  const S = 12, buf = Buffer.alloc(cols * S * rows * S * 3);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const c = COL[terrain[row * cols + col]] ?? [255, 0, 255];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const k = ((row * S + y + (col & 1 ? S / 2 : 0) >= rows * S ? rows * S - 1 : row * S + y + (col & 1 ? S / 2 : 0)) * cols * S + col * S + x) * 3; buf[k] = c[0]; buf[k + 1] = c[1]; buf[k + 2] = c[2]; }
  }
  await sharp(buf, { raw: { width: cols * S, height: rows * S, channels: 3 } }).png().toFile(preview);
}
