// Acceptance checks for the 3D map, against the demo world. Drives the real app in Chromium.
// Usage: BASE_URL=http://localhost:3001 ATLAS_PASS=... SHOTS=./shots3d node scripts/smoke3d.mjs
// Headless Chromium renders WebGL in software (SwiftShader), so frame numbers here are a floor,
// not what a GPU does. Camera easing is advanced with the renderer's own step function where a
// check only needs the end state, so slow software frames don't stretch the run.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const DIR = process.env.SHOTS ?? './shots3d';
const WORLD = process.env.WORLD ?? 'The Sundered Reach';
mkdirSync(DIR, { recursive: true });
const S = (n) => `${DIR}/${n}.png`;
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Software GL can take several seconds a frame; a screenshot waits for one.
p.setDefaultTimeout(90000);
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
let failed = 0;
const results = {};
const step = async (name, fn) => {
  try { const r = await fn(); results[name] = r ?? 'ok'; console.log('ok  ', name, r ? JSON.stringify(r) : ''); } catch (e) {
    failed++; results[name] = 'FAIL ' + e.message.split('\n')[0]; console.log('FAIL', name, e.message.split('\n')[0]);
    await p.screenshot({ path: S('fail-' + name) }).catch(() => {});
  }
};
const expect = (c, msg) => { if (!c) throw new Error(msg); };
const R = (fn, arg) => p.evaluate(fn, arg);
// Renderer screen points are relative to the map canvas; the mouse works in page coordinates.
const page = async (s) => { const o = await R(() => { const b = window.__atlasMap.hud.getBoundingClientRect(); return { x: b.left, y: b.top }; }); return { x: s.x + o.x, y: s.y + o.y }; };
let worldId = '';
const openWorld = async () => {
  await p.goto(`${BASE}/w/${worldId}/map`);
  await p.waitForSelector('canvas.map');
  await p.waitForFunction(() => window.__atlasMap?.hasGround, null, { timeout: 90000 });
};

await step('login-opens-3d', async () => {
  await p.goto(BASE);
  await p.fill('#u', process.env.ATLAS_USER ?? 'gm');
  await p.fill('#p', process.env.ATLAS_PASS ?? 'correcthorse1');
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('canvas.map');
  const ws = await R(() => fetch('/api/worlds').then((r) => r.json()));
  worldId = ws.find((w) => w.name === WORLD).id;
  await openWorld();
  const mode = await p.getAttribute('.mapview', 'data-map-mode');
  expect(mode === '3d', `map opened in ${mode}`);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S('01-opens-3d') });
  return { mode };
});

await step('orbit-pan-zoom', async () => {
  const before = await R(() => ({ ...window.__atlasMap.target, yaw: window.__atlasMap.yawT }));
  await p.mouse.move(720, 480);
  for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -300); await p.waitForTimeout(80); }
  const zoomed = await R(() => window.__atlasMap.target.zoom);
  await p.mouse.move(720, 480); await p.mouse.down(); await p.mouse.move(620, 430, { steps: 6 }); await p.mouse.up();
  const panned = await R(() => ({ ...window.__atlasMap.target }));
  await p.mouse.move(720, 480); await p.mouse.down({ button: 'right' }); await p.mouse.move(820, 460, { steps: 6 }); await p.mouse.up({ button: 'right' });
  const turned = await R(() => window.__atlasMap.yawT);
  expect(zoomed > before.zoom * 1.5, 'wheel did not zoom');
  expect(Math.hypot(panned.x - before.x, panned.y - before.y) > 5, 'drag did not pan');
  expect(Math.abs(turned - before.yaw) > 0.2, 'right-drag did not turn');
  await R(() => { const r = window.__atlasMap; r.advance(3); });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S('02-orbited') });
  await R(() => { const r = window.__atlasMap; r.faceNorth(); r.advance(3); });
  return { zoom: [before.zoom, zoomed], yaw: turned };
});

// Wheel zoom keeps the ground point under the cursor in place, off-centre too, in and out.
await step('wheel-zoom-holds-cursor', async () => {
  await R(() => { const r = window.__atlasMap; const f = r.fitCamera(); r.setCamera(f); r.advance(2); });
  const out = [];
  for (const [fx, fy, dy] of [[0.3, 0.3, -100], [0.75, 0.7, -100], [0.25, 0.75, 100], [0.7, 0.3, 100]]) {
    const s = await R(([fx, fy]) => ({ x: window.__atlasMap.viewport.w * fx, y: window.__atlasMap.viewport.h * fy }), [fx, fy]);
    const pg = await page(s);
    await p.mouse.move(pg.x, pg.y);
    await p.mouse.wheel(0, dy);
    const a = await R(() => { const r = window.__atlasMap; return r.anchor && { ...r.anchor, y: r.anchorY }; });
    expect(a, 'wheel set no zoom anchor');
    await R(() => window.__atlasMap.advance(3));
    const e = await R((a) => { const q = window.__atlasMap.projectPoint(a.wx, a.wy, a.y); return Math.hypot(q.x - a.sx, q.y - a.sy); }, a);
    out.push(Math.round(e * 10) / 10);
    expect(e < 3, `ground under the cursor slid ${e.toFixed(0)} px`);
  }
  return { slidePx: out };
});

await step('overhead-reads-flat', async () => {
  await R(() => { const r = window.__atlasMap; r.setOverhead(true); const f = r.fitCamera(); r.setCamera({ ...f, zoom: f.zoom * 1.6 }); r.advance(2); });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S('03-overhead') });
  const tilt = await R(() => window.__atlasMap.tiltNow);
  expect(tilt < 0.001, `tilt ${tilt}`);
  await R(() => window.__atlasMap.setOverhead(false));
  return { tilt };
});

await step('pick-20-hexes', async () => {
  // Five each: flat, sloped, coastal, forested slope. Each pick aims at a point inside the hex
  // (not only its centre), from one of four views; the hex under the cursor must be that hex,
  // both by the height field the map uses and by the drawn triangles.
  const out = await R(() => {
    const r = window.__atlasMap;
    const sea = r.seaLevel;
    const all = r.hexIds();
    const g = (x, y) => r.groundAt(x, y);
    const slope = (h) => { let m = 0; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; m = Math.max(m, Math.abs(g(h.x + Math.cos(a) * 22, h.y + Math.sin(a) * 22) - h.ground)); } return m; };
    const nearSea = (h) => { for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; if (g(h.x + Math.cos(a) * 44, h.y + Math.sin(a) * 44) <= sea + 0.01) return true; } return false; };
    const land = all.filter((h) => h.ground > sea + 1).map((h) => ({ ...h, slope: slope(h) }));
    const spread = (xs, n) => { const s = [...xs].sort((a, b) => a.id < b.id ? -1 : 1); return Array.from({ length: n }, (_, i) => s[Math.floor((i + 0.5) * s.length / n)]).filter(Boolean); };
    const groups = {
      flat: spread(land.filter((h) => h.slope < 5 && !nearSea(h)), 5),
      sloped: spread(land.filter((h) => h.slope > 22), 5),
      coastal: spread(land.filter((h) => nearSea(h)), 5),
      'forested slope': spread(land.filter((h) => (h.terrain === 'forest' || h.terrain === 'jungle') && h.slope > 9), 5),
    };
    const views = [
      { name: 'overhead', overhead: true, zoom: 1.4, yaw: 0, tilt: 0 },
      { name: 'hexcrawl', overhead: false, zoom: 2.4, yaw: 0, tilt: 0 },
      { name: 'tilted+turned', overhead: false, zoom: 2.0, yaw: 0.7, tilt: 0.35 },
      { name: 'regional', overhead: false, zoom: 1.0, yaw: -0.4, tilt: 0.2 },
    ];
    const res = [];
    let k = 0;
    for (const [cat, hs] of Object.entries(groups)) for (const h of hs) {
      const v = views[k % views.length];
      const ang = k * 2.39996, rad = 40 * 0.45 * ((k % 3) / 2);
      const wx = h.x + Math.cos(ang) * rad, wy = h.y + Math.sin(ang) * rad;
      r.setOverhead(v.overhead); r.yaw = r.yawT = v.yaw; r.tiltBias = r.tiltBiasT = v.tilt;
      r.setCamera({ x: wx + 30, y: wy - 20, zoom: v.zoom });
      let s = r.projectPoint(wx, wy, g(wx, wy));
      let view = v.name;
      // A point hidden behind a ridge from this angle is checked from overhead instead.
      const m0 = r.meshPick(s.x, s.y);
      if (!m0 || Math.hypot(m0.x - wx, m0.y - wy) > 8) { r.setOverhead(true); r.setCamera({ x: wx, y: wy, zoom: v.zoom }); s = r.projectPoint(wx, wy, g(wx, wy)); view += '→overhead'; }
      const want = r.hexAtWorld(wx, wy)?.id;
      const got = r.hexAt(s.x, s.y)?.id;
      const m = r.meshPick(s.x, s.y);
      const meshHex = m ? r.hexAtWorld(m.x, m.y)?.id : null;
      res.push({ cat, view, hex: r.label(r.hexById(h.id)), terrain: h.terrain, slope: Math.round(h.slope), ok: want === h.id && got === want && meshHex === want, err: m ? Math.hypot(m.x - wx, m.y - wy).toFixed(2) : null });
      k++;
    }
    r.setOverhead(false); r.yaw = r.yawT = 0; r.tiltBias = r.tiltBiasT = 0;
    return res;
  });
  writeFileSync(`${DIR}/picks.json`, JSON.stringify(out, null, 2));
  const pass = out.filter((x) => x.ok).length;
  expect(out.length === 20, `only ${out.length} test hexes found`);
  expect(pass === 20, `${pass}/20 picks correct: ${JSON.stringify(out.filter((x) => !x.ok))}`);
  return { pass: `${pass}/20`, byCategory: Object.fromEntries(['flat', 'sloped', 'coastal', 'forested slope'].map((c) => [c, out.filter((x) => x.cat === c && x.ok).length])) };
});

await step('click-selects-and-focus-returns', async () => {
  // Real clicks on a tilted view: the panel opens for the hex under the cursor, the camera moves
  // onto it, and backing out restores exactly the view before.
  const target = await R(() => {
    const r = window.__atlasMap;
    const h = r.hexIds().filter((x) => x.ground > r.seaLevel + 20)[40];
    r.setCamera({ x: h.x - 60, y: h.y + 40, zoom: 1.8 });
    r.advance(1);
    const s = r.worldToScreen(h.x, h.y);
    return { id: h.id, s, before: { ...r.target, yaw: r.yawT, tb: r.tiltBiasT } };
  });
  await p.waitForTimeout(1500);
  const at = await page(target.s);
  await p.mouse.click(at.x, at.y);
  await p.waitForSelector('.inspector');
  const sel = await R(() => window.__atlasMap.selectedId);
  expect(sel === target.id, `clicked ${target.id}, selected ${sel}`);
  await R(() => window.__atlasMap.advance(4));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S('04-focus-move') });
  const focused = await R(() => ({ ...window.__atlasMap.cam, tilt: window.__atlasMap.tiltNow }));
  await p.keyboard.press('Escape');
  await R(() => window.__atlasMap.advance(8));
  const after = await R(() => ({ ...window.__atlasMap.cam, yaw: window.__atlasMap.yaw, tb: window.__atlasMap.tiltBias }));
  const d = Math.hypot(after.x - target.before.x, after.y - target.before.y) + Math.abs(after.zoom - target.before.zoom) * 100;
  expect(focused.zoom > target.before.zoom * 1.1, 'focus did not zoom in');
  expect(d < 0.01 && Math.abs(after.tb - target.before.tb) < 1e-3, `view not restored (off by ${d})`);
  return { selected: sel === target.id, restoredWithin: d };
});

await step('paint-claim-live', async () => {
  // Paint control with the claim brush on unclaimed land; the draped overlay repaints there.
  const t = await R(() => {
    const r = window.__atlasMap;
    const h = r.hexIds().find((x) => x.ground > r.seaLevel + 4 && !r.control.has(x.id) && !r.contested.has(x.id) && !r.influence.has(x.id) && x.x > 300 && x.y > 300);
    r.setCamera({ x: h.x, y: h.y, zoom: 1.6 }); r.advance(1);
    return { id: h.id, x: h.x, y: h.y, s: r.worldToScreen(h.x, h.y) };
  });
  const px = () => R(([x, y]) => {
    const r = window.__atlasMap, o = r.ovRect, c = r.canvas;
    const d = c.getContext('2d').getImageData(Math.round((x - o.x) / o.w * c.width), Math.round((y - o.y) / o.h * c.height), 1, 1).data;
    return [...d];
  }, [t.x, t.y + 14]);
  await p.waitForTimeout(1500);
  const before = await px();
  await p.keyboard.press('4');
  await p.click('.brushbar .brush >> nth=0');
  const at = await page(t.s);
  await p.mouse.click(at.x, at.y);
  await p.waitForFunction((id) => window.__atlasMap.control.has(id) || window.__atlasMap.contested.has(id), t.id, { timeout: 15000 });
  // The overlay repaints on the next frame that gets to it; on software GL that can be seconds.
  const differs = (a) => before.some((v, i) => Math.abs(v - a[i]) > 12);
  let after = await px();
  for (let i = 0; i < 30 && !differs(after); i++) { await p.waitForTimeout(500); after = await px(); }
  await p.screenshot({ path: S('05-claim-painted') });
  await p.keyboard.press('1');
  const changed = differs(after);
  expect(changed, `overlay pixel unchanged ${before} → ${after}`);
  return { hex: t.id, overlayBefore: before, overlayAfter: after };
});

await step('token-stands-on-slope', async () => {
  // Drag a party marker onto a steep hex; it lands there, at the ground's height.
  await p.keyboard.press('1');
  const info = await R(() => {
    const r = window.__atlasMap;
    const tok = r.tokens.find((t) => t.kind === 'party') ?? r.tokens.find((t) => t.kind !== 'city' && t.kind !== 'outpost');
    const p0 = r.tokenPos(tok);
    const g = (x, y) => r.groundAt(x, y);
    const steep = r.hexIds().filter((h) => h.ground > r.seaLevel + 30 && !r.tokens.some((t) => t.hexId === h.id))
      .map((h) => ({ ...h, d: Math.hypot(h.x - p0.x, h.y - p0.y), s: Math.abs(g(h.x + 15, h.y) - g(h.x - 15, h.y)) + Math.abs(g(h.x, h.y + 15) - g(h.x, h.y - 15)) }))
      .filter((h) => h.s > 12).sort((a, b) => a.d - b.d)[0];
    r.setOverhead(true);
    r.setCamera({ x: (p0.x + steep.x) / 2, y: (p0.y + steep.y) / 2, zoom: Math.min(1.6, 900 / (steep.d + 200)) });
    r.advance(1);
    const from = r.worldToScreen(p0.x, p0.y);
    from.y -= r.tokenLift(tok.kind, r.markerRadius(tok.kind));
    return { tok: tok.id, name: tok.name, from, to: r.worldToScreen(steep.x, steep.y), hex: steep.id, slope: steep.s };
  });
  await p.waitForTimeout(1500);
  const from = await page(info.from), to = await page(info.to);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move(to.x, to.y, { steps: 12 });
  await p.mouse.up();
  await p.waitForFunction(([id, hex]) => window.__atlasMap.tokens.find((t) => t.id === id)?.hexId === hex, [info.tok, info.hex], { timeout: 15000 });
  const stand = await R(([id]) => {
    const r = window.__atlasMap;
    const t = r.tokens.find((x) => x.id === id);
    const pos = r.tokenPos(t);
    r.setOverhead(false);
    r.tiltBias = r.tiltBiasT = 0.2;
    r.setCamera({ x: pos.x, y: pos.y + 30, zoom: 2.6 }); r.advance(1);
    return { onHex: r.hexAtWorld(pos.x, pos.y)?.id === t.hexId, footHeight: r.groundAt(pos.x, pos.y), terrainHeight: r.hf.at(pos.x, pos.y), sea: r.seaLevel };
  }, [info.tok]);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S('06-token-on-slope') });
  const server = await R(([w, id]) => fetch(`/api/worlds/${w}/map`).then((r) => r.json()).then((d) => d.tokens.find((t) => t.id === id).hexId), [worldId, info.tok]);
  expect(server === info.hex, 'move not saved');
  expect(stand.onHex && Math.abs(stand.footHeight - Math.max(stand.terrainHeight, stand.sea)) < 1e-6, `token not on its hex's ground ${JSON.stringify(stand)}`);
  await R(() => { const r = window.__atlasMap; r.tiltBias = r.tiltBiasT = 0; });
  return { token: info.name, slopeAcrossHex: Math.round(info.slope), ...stand };
});

await step('search-flies-camera', async () => {
  await R(() => { const r = window.__atlasMap; const f = r.fitCamera(); r.setCamera(f); });
  await p.keyboard.press('Control+k');
  await p.keyboard.type('Cinderhold');
  await p.waitForSelector('.palette li .cat:text-is("Settlement")');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.inspector.token-panel');
  const d = await R(() => {
    const r = window.__atlasMap;
    r.advance(6);
    const t = r.tokens.find((x) => x.name === 'Cinderhold');
    const pos = r.tokenPos(t);
    const s = r.worldToScreen(pos.x, pos.y);
    return { zoom: r.cam.zoom, screen: s, w: r.viewport.w, h: r.viewport.h };
  });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S('07-search-flew') });
  // The place sits in the map area left of the panel, near the middle.
  expect(d.zoom > 1.5, `zoom ${d.zoom}`);
  expect(Math.abs(d.screen.x - (d.w / 2 - 185)) < 40 && Math.abs(d.screen.y - d.h / 2) < 40, `place at ${JSON.stringify(d.screen)}`);
  await p.keyboard.press('Escape');
  return d;
});

await step('day-cycle', async () => {
  // The light runs dawn → noon → golden hour → dusk → night, and a running clock that passes
  // midnight starts the next day on the world clock. Software frames take seconds, longer than a
  // part of the day lasts at the fastest speed, so each part is shown by setting the hour, and the
  // running clock is checked across midnight on its own.
  await openWorld();
  await R(() => { const r = window.__atlasMap; const f = r.fitCamera(); r.setCamera({ ...f, zoom: f.zoom * 1.15 }); });
  const shots = [];
  for (const [name, hour] of [['dawn', 6.05], ['noon', 12], ['golden-hour', 17.8], ['dusk', 18.9], ['night', 21.8]]) {
    await R((h) => window.__atlasMap.setDaylight({ hour: h, speed: 'paused', at: new Date().toISOString() }), hour);
    await p.waitForFunction((h) => Math.abs(window.__atlasMap.shownHour - h) < 0.01, hour, { timeout: 30000, polling: 50 });
    shots.push(await R(() => {
      const r = window.__atlasMap, L = r.light;
      return { hour: +r.shownHour.toFixed(2), part: r.partOfDay(r.shownHour), sunHeight: +L.sunDir.y.toFixed(2), keyLight: L.keyColor.toArray().map((v) => +v.toFixed(2)), fog: '#' + L.horizon.getHexString(), fogDensityK: +L.fogK.toFixed(2) };
    }));
    await p.screenshot({ path: S(`08-day-${name}`) });
  }
  // The DM starts the clock just before midnight from the clock popover; the day turns over.
  await R(([w]) => fetch(`/api/worlds/${w}/daylight`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hour: 23.4, speed: 'paused' }) }), [worldId]);
  await openWorld();
  const day0 = await R(([w]) => fetch(`/api/worlds/${w}`).then((r) => r.json()).then((x) => x.currentDay), [worldId]);
  await p.click('.tod-btn');
  await p.click('.tod-speeds button:has-text("1 day per minute")');
  await p.waitForFunction(() => window.__atlasMap.daylight?.speed === 'fast', null, { timeout: 10000 });
  await p.click('.tod-btn');
  await p.waitForFunction(([w, d0]) => fetch(`/api/worlds/${w}`).then((r) => r.json()).then((x) => x.currentDay === d0 + 1), [worldId, day0], { timeout: 60000, polling: 1000 });
  await R(([w]) => fetch(`/api/worlds/${w}/daylight`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hour: 10, speed: 'paused' }) }), [worldId]);
  writeFileSync(`${DIR}/day-cycle.json`, JSON.stringify(shots, null, 2));
  const parts = shots.map((s) => s.part);
  expect(JSON.stringify(parts) === JSON.stringify(['Dawn', 'Noon', 'Golden hour', 'Dusk', 'Night']), `parts ${parts}`);
  return { shots: shots.length, midnightAdvancedDay: `${day0} → ${day0 + 1}` };
});

await step('frames-at-zoom-extremes', async () => {
  // Software rendering; numbers are a floor. Measured while the camera keeps turning.
  await openWorld();
  const measure = async (name, setup) => {
    await R(setup);
    await p.waitForTimeout(1500);
    await R(() => { window.__spin = setInterval(() => window.__atlasMap.rotate(0.02), 30); });
    await p.waitForTimeout(6000);
    const s = await R(() => { clearInterval(window.__spin); return window.__atlasMap.stats(); });
    await p.screenshot({ path: S(`09-frames-${name}`) });
    return { fps: +s.fps.toFixed(2), frameMs: Math.round(s.frameMs), cpuMs: Math.round(s.cpuMs) };
  };
  const out = {};
  out.continental = await measure('continental', () => { const r = window.__atlasMap; const f = r.fitCamera(); r.setCamera(f); });
  out.hexcrawl = await measure('hexcrawl', () => { const r = window.__atlasMap; const f = r.fitCamera(); r.setCamera({ x: f.x, y: f.y, zoom: 3.2 }); });
  return out;
});

await step('2d-still-reachable', async () => {
  await p.click('.mode-toggle');
  await p.waitForSelector('.mapview[data-map-mode="2d"]');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S('10-flat-2d') });
  await p.click('.mode-toggle');
  await p.waitForSelector('.mapview[data-map-mode="3d"]');
});

writeFileSync(`${DIR}/results.json`, JSON.stringify(results, null, 2));
console.log(errs.length ? 'console errors:\n' + errs.slice(0, 12).join('\n') : 'no console errors');
await b.close();
process.exit(failed || errs.length ? 1 : 0);
