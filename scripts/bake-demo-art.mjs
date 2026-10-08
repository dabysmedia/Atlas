// Bakes the demo world's map art and its matching hex terrain into server/assets.
// Usage: node scripts/bake-demo-art.mjs   (needs Playwright's Chromium; CHROMIUM_PATH to override)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const DEMO = { cols: 28, rows: 19, size: 40, margin: 110, ppu: Number(process.env.PPU ?? 2), seed: 1512 };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const p = await b.newPage();
await p.setContent('<html><body></body></html>');
await p.addScriptTag({ content: readFileSync(`${root}scripts/demo-art/generator.js`, 'utf8') });
const t0 = Date.now();
const out = await p.evaluate((o) => window.paintAtlas(o), DEMO);
await b.close();
mkdirSync(`${root}server/assets`, { recursive: true });
const bytes = Buffer.from(out.url.split(',')[1], 'base64');
writeFileSync(`${root}server/assets/demo-map.webp`, bytes);
const counts = {};
for (const t of out.terrain) counts[t.terrain] = (counts[t.terrain] ?? 0) + 1;
writeFileSync(`${root}server/assets/demo-map.json`, JSON.stringify({
  ...DEMO, width: out.width, height: out.height, rect: out.rect,
  // Row-major terrain keys, one per hex in offset (col, row) order.
  terrain: out.terrain.map((t) => t.terrain),
}));
console.log(`${out.width}x${out.height}, ${(bytes.length / 1e6).toFixed(2)} MB, ${out.rivers} rivers, ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
