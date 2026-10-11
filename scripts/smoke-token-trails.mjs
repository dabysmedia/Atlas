import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.env.BASE_URL ?? 'http://localhost:3001';
mkdirSync('shots/token-trails', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
  const r = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await r.json(); if (!r.ok) throw Error(JSON.stringify(data)); return data;
}, { url, method, body });
let world;
try {
  await page.goto(base); await page.locator('#u').fill('gm'); await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForSelector('canvas.map');
  world = await api('/api/worlds', 'POST', { name: `Trail QA ${Date.now()}`, cols: 12, rows: 8 });
  const path = `/api/worlds/${world.id}`, before = await api(`${path}/map`);
  const ids = [];
  for (const [index, kind] of ['unit', 'character'].entries()) {
    const route = Array.from({ length: 8 }, (_, q) => before.hexes.find(h => h.q === q + 1 && h.r === index + 2).id);
    const t = await api(`${path}/tokens`, 'POST', { name: `Traveling ${kind}`, kind, hexId: route[0], color: index ? '#e0a440' : '#70ceec' });
    await api(`${path}/tokens/${t.id}/move`, 'POST', { from: route[0], path: route.slice(1) });
    ids.push(t.id);
    assert.deepEqual((await api(`${path}/map`)).tokens.find(token => token.id === t.id).trail.map(v => v.hexId), route);
  }
  await page.goto(`${base}/w/${world.id}/map`); await page.waitForFunction(() => window.__atlasMap?.hasGround);
  const check = async () => page.evaluate(ids => {
    const r = window.__atlasMap, ctx = r.ctx, original = ctx.createLinearGradient;
    const fades = [];
    ctx.createLinearGradient = function(...coords) {
      const gradient = original.apply(this, coords), add = gradient.addColorStop.bind(gradient), stops = [];
      gradient.addColorStop = (offset, color) => { stops.push({ offset, color }); add(offset, color); };
      fades.push({ coords, stops }); return gradient;
    };
    try { r.drawTokens(performance.now(), r.cam.zoom, true); } finally { ctx.createLinearGradient = original; }
    return { fades: fades.filter(f => f.stops.length === 2 && f.stops.every(s => s.color.startsWith('rgba('))), expected: ids.flatMap(id => {
      const t = r.tokens.find(t => t.id === id), h = t.trail.slice(-5).map(v => r.hexById(v.hexId));
      return h.slice(1).map((end, i) => { const a = r.worldToScreen(h[i].cx, h[i].cy), b = r.worldToScreen(end.cx, end.cy); return [a.x, a.y, b.x, b.y]; });
    }) };
  }, ids);
  for (const zoom of [1, 2.5]) {
    await page.evaluate(zoom => { const r = window.__atlasMap, c = r.fitCamera(); r.saved = null; r.setCamera({ ...c, zoom: c.zoom * zoom }); }, zoom);
    await page.waitForTimeout(500);
    const result = await check();
    assert.equal(result.fades.length, 8, 'both non-party tokens have four recent route segments');
    assert.deepEqual(result.fades.map(f => f.coords), result.expected);
    for (let i = 0; i < 8; i++) {
      const age = i % 4;
      assert(result.fades[i].stops[0].color.endsWith(`,${0.85 * age / 4})`));
      assert(result.fades[i].stops[1].color.endsWith(`,${0.85 * (age + 1) / 4})`));
    }
    await page.screenshot({ path: `shots/token-trails/${zoom === 1 ? 'overview' : 'exploration'}.png` });
  }
  await page.getByRole('button', { name: 'Token drawer', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Show token trails' }).uncheck();
  assert.equal((await check()).fades.length, 0);
  await page.reload(); await page.waitForFunction(() => window.__atlasMap?.hasGround && !window.__atlasMap.showTokenTrails);
  assert.equal((await check()).fades.length, 0);
  const after = await api(`${path}/map`);
  assert(after.tokens.every(t => t.trail.length === 8));
  assert.deepEqual(after.hexes, before.hexes);
  assert.deepEqual(errors, []);
  console.log('PASS: every token fades its last five visits, both zoom modes, toggle/reload, full history and hex data preserved');
} finally {
  if (world) await api(`/api/worlds/${world.id}`, 'DELETE').catch(() => {});
  await browser.close();
}
