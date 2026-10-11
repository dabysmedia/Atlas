// Read-only browser checks: world modules must share the same live map and camera.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.env.BASE_URL ?? 'http://localhost:3001';
const shots = process.env.SHOTS ?? './shots/modules';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(60000);
const errors = [], modelRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (/model.*\.(glb|gltf)|\/map\/model(?:\?|$)|\/model\/file/.test(r.url())) modelRequests.push(r.url()); });
const api = url => page.evaluate(async url => { const r = await fetch(url); assertOk(r); return r.json(); function assertOk(r) { if (!r.ok) throw new Error(`${url}: ${r.status}`); } }, url);
const snapshot = () => page.evaluate(() => {
  const r = window.__atlasMap;
  return { same: r === window.__heldMap, canvas: r.hud === window.__heldCanvas, camera: { ...r.cam }, target: { ...r.target }, selected: r.selectedId, destroyed: window.__destroyedMap };
});
const hold = () => page.evaluate(() => {
  const r = window.__atlasMap;
  window.__heldMap = r; window.__heldCanvas = r.hud; window.__destroyedMap = 0;
  const destroy = r.destroy.bind(r); r.destroy = () => { window.__destroyedMap++; destroy(); };
});
try {
  await page.goto(base); await page.locator('#u').fill('gm'); await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button', { name: 'Sign in' }).click(); await page.waitForSelector('canvas.map');
  const world = (await api('/api/worlds')).find(w => w.name === 'The Sundered Reach'); assert(world);
  await page.goto(`${base}/w/${world.id}/map`); await page.waitForFunction(() => window.__atlasMap?.hasGround);
  const before = await api(`/api/worlds/${world.id}/map`);
  const hex = await page.evaluate(() => {
    const r = window.__atlasMap, h = r.hexIds().find(h => h.ground > r.seaLevel + 10);
    r.saved = null; r.setCamera({ x: h.x, y: h.y, zoom: 1.7 }); return h;
  });
  await page.waitForFunction(() => !window.__atlasMap.cameraMoving);
  const p = await page.evaluate(id => { const r = window.__atlasMap, s = r.hexScreen(id), b = r.hud.getBoundingClientRect(); return { x: s.x + b.x, y: s.y + b.y }; }, hex.id);
  await page.mouse.click(p.x, p.y); await page.waitForFunction(id => window.__atlasMap.selectedId === id, hex.id);
  await page.waitForFunction(() => !window.__atlasMap.cameraMoving); await hold();
  const initial = await snapshot(), requestCount = modelRequests.length;
  const sections = ['Wiki', 'Factions', 'Chronicle', 'Campaigns', 'World settings'];
  for (const label of sections) {
    await page.getByRole('link', { name: label, exact: true }).click();
    const panel = page.getByRole('region', { name: `${label} panel` }); await panel.waitFor();
    await panel.locator('.wiki, .pagebody').waitFor();
    const moduleBounds = await panel.boundingBox(), detailsBounds = await page.locator('.inspector').boundingBox();
    assert(moduleBounds.x < 20 && moduleBounds.x + moduleBounds.width < detailsBounds.x, 'left module must leave the right hex details exposed');
    await panel.focus();
    for (const key of ['q', 'e', 't', 'n', '-', 'f', '1', 'Space']) await page.keyboard.press(key);
    assert.deepEqual(await snapshot(), initial, `${label} preserves map and ignores panel keyboard shortcuts`);
    await page.screenshot({ path: `${shots}/${label.replaceAll(' ', '-')}.png` });
    await page.getByRole('button', { name: `Close ${label}`, exact: true }).click();
    assert.deepEqual(await snapshot(), initial, `${label} close preserves map`);
  }
  await page.getByRole('link', { name: 'Wiki', exact: true }).click();
  const item = page.locator('.world-module .wiki-item').first(); await item.waitFor(); await item.click();
  await page.waitForURL(/\/wiki\/.+/); const wikiUrl = page.url();
  const normalWidth = (await page.locator('.world-module').boundingBox()).width;
  await page.getByRole('button', { name: 'Expand panel', exact: true }).click();
  const expandedBounds=await page.locator('.world-module').boundingBox(), detailsBounds=await page.locator('.inspector').boundingBox();
  assert(expandedBounds.width > normalWidth && expandedBounds.x + expandedBounds.width < detailsBounds.x);
  assert.deepEqual(await snapshot(), initial, 'expansion does not resize or reposition map');
  await page.getByRole('button', { name: 'Restore panel size', exact: true }).click();
  await page.getByRole('link', { name: 'Factions', exact: true }).click(); await page.goBack();
  await page.getByRole('region', { name: 'Wiki panel' }).waitFor(); assert.equal(page.url(), wikiUrl);
  await page.getByRole('button', { name: 'Close Wiki', exact: true }).focus(); await page.keyboard.press('Escape');
  await page.locator('.world-module').waitFor({ state: 'detached' }); assert.deepEqual(await snapshot(), initial);
  await page.getByRole('link', { name: 'Chronicle', exact: true }).click();
  await page.getByRole('link', { name: 'Chronicle', exact: true }).click(); await page.locator('.world-module').waitFor({ state: 'detached' });
  assert.equal(modelRequests.length, requestCount, 'modules never request the model again');
  await page.getByRole('link', { name: 'Factions', exact: true }).click();
  const zoom = await page.evaluate(() => window.__atlasMap.cam.zoom);
  await page.mouse.move(980, 600); await page.mouse.wheel(0, -100);
  await page.waitForFunction(zoom => window.__atlasMap.cam.zoom !== zoom, zoom);
  assert((await snapshot()).same, 'exposed map stays interactive while a module is open');
  await page.goto(wikiUrl); await page.waitForFunction(() => window.__atlasMap?.hasGround); await hold();
  const direct = await snapshot(); await page.getByRole('button', { name: 'Close Wiki', exact: true }).click(); assert.deepEqual(await snapshot(), direct);
  assert.equal(await page.locator('.mode-toggle').count(), 0); await hold();
  const kept = await snapshot(); await page.getByRole('link', { name: 'Factions', exact: true }).click();
  await page.getByRole('region', { name: 'Factions panel' }).waitFor(); assert.deepEqual(await snapshot(), kept, '3D map stays mounted');
  await page.getByRole('button', { name: 'Close Factions', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.__atlasMap?.w === 390 && document.querySelector('canvas.map')?.getBoundingClientRect().width === 390);
  const mobilePoint=await page.evaluate(id=>{
    const r=window.__atlasMap,h=r.hexIds().find(h=>h.id===id);r.saved=null;r.setCamera({x:h.x,y:h.y,zoom:1.7});r.frame(performance.now(),false);
    const s=r.hexScreen(id),b=r.hud.getBoundingClientRect();return{x:s.x+b.x,y:s.y+b.y};
  },hex.id);
  await page.mouse.click(mobilePoint.x,mobilePoint.y);await page.waitForSelector('.inspector');await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  for (const label of ['Wiki', 'World settings']) {
    await page.getByRole('link', { name: label, exact: true }).click();
    const panel = page.getByRole('region', { name: `${label} panel` }); await panel.waitFor();
    const bounds = await panel.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 790);
    const details=await page.locator('.inspector').boundingBox();assert(bounds.y+bounds.height<details.y,'mobile module and hex details must not overlap');
    await page.screenshot({ path: `${shots}/mobile-${label.replaceAll(' ', '-')}.png` });
    await page.getByRole('button', { name: `Close ${label}`, exact: true }).click();
  }
  const after = await api(`/api/worlds/${world.id}/map`); assert.deepEqual(after, before);
  const unsupportedContext = await browser.newContext({storageState:await page.context().storageState()});
  const unsupported = await unsupportedContext.newPage();
  await unsupported.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return kind === 'webgl2' ? null : getContext.call(this, kind, ...args); };
  });
  await unsupported.goto(`${base}/w/${world.id}/map`);
  await unsupported.getByRole('alert').filter({hasText:'This browser cannot display the 3D map'}).waitFor();
  assert.equal(await unsupported.locator('.mode-toggle').count(),0);
  assert.equal(await unsupported.evaluate(()=>!!window.__atlasMap),false,'unsupported browser never starts a flat fallback');
  await unsupported.getByRole('link',{name:'Wiki',exact:true}).click();
  await unsupported.getByRole('region',{name:'Wiki panel'}).waitFor();await unsupportedContext.close();
  assert.deepEqual(errors, []);
  writeFileSync(`${shots}/results.json`, JSON.stringify({ persistent3D: true, cameraAndSelectionPreserved: true, navigation: true, keyboardIsolation: true, deepLinks: true, unsupportedBrowser: true, mobile: true, dataUnchanged: true }, null, 2));
  console.log('Persistent modules, camera/selection, history, mobile and unsupported-browser handling passed');
} finally { await browser.close(); }
