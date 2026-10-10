// Presentation regression checks against a running app and the imported island.
// BASE_URL=http://localhost:3001 ATLAS_PASS=... CHROMIUM_PATH=... node scripts/smoke-map-batch1.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:3001';
const shots = process.env.SHOTS ?? './shots/batch1';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); });
const results = {};
let traceSession;
try {
  await page.goto(base);
  await page.locator('#u').fill(process.env.ATLAS_USER ?? 'gm');
  await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('canvas.map');
  const world = await page.evaluate(async () => (await (await fetch('/api/worlds')).json()).find(w => w.name === 'The New World'));
  assert(world, 'The New World must be imported in the local fixture');
  await page.goto(`${base}/w/${world.id}/map`);
  await page.waitForFunction(() => window.__atlasMap?.hasGround);
  await page.waitForFunction(() => !window.__atlasMap.cameraMoving);
  const originalData = await page.evaluate(async id => JSON.stringify((await (await fetch(`/api/worlds/${id}/map`)).json()).hexes), world.id);
  results.gpu = await page.evaluate(() => {
    const gl = window.__atlasMap.gl.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log('GPU', results.gpu);
  results.overview = await page.evaluate(() => {
    const r = window.__atlasMap, fit = r.fitCamera();
    r.setCamera({ ...fit, zoom: fit.zoom / 100 });
    const clamped = r.cam.zoom;
    r.zoomAt(r.viewport.w / 2, r.viewport.h / 2, 0.001); r.advance(3);
    const checks = [];
    for (let i = 0; i < 16; i++) {
      r.yaw = r.yawT = i * Math.PI / 8;
      r.tiltBias = r.tiltBiasT = i % 2 ? 1.32 : 0;
      r.setCamera({ ...fit, zoom: r.minZoom() });
      r.frame(performance.now(), false);
      const far = r.water.mesh.children[1], size = far.scale.x / 2;
      let covered = true;
      for (const [x,y] of [[0,0],[r.viewport.w,0],[0,r.viewport.h],[r.viewport.w,r.viewport.h]]) {
        const ray = r.rayAt(x,y), t = (r.seaLevel - ray.o.y) / ray.d.y;
        const p = ray.o.clone().addScaledVector(ray.d, t);
        covered &&= t > 0 && t < r.camera.far && Math.abs(p.x-far.position.x) < size && Math.abs(p.z-far.position.z) < size;
      }
      checks.push(covered);
    }
    r.faceNorth(); r.advance(3); r.setCamera(fit);
    return { clamped, min: r.minZoom(), fit: fit.zoom, oceanCovered: checks.every(Boolean) };
  });
  assert.equal(results.overview.clamped, results.overview.min);
  assert.equal(results.overview.min, results.overview.fit);
  assert(results.overview.oceanCovered, 'ocean must cover every corner ray at every tested angle');
  await page.screenshot({ path: `${shots}/overview.png` });
  console.log('overview', JSON.stringify(results.overview));

  if (!process.env.PAN_ONLY) {
  results.clouds = await page.evaluate(() => {
    const r = window.__atlasMap;
    const hs = r.hexIds().filter(h => h.ground > r.seaLevel + 10);
    const h = hs[Math.floor(hs.length / 2)];
    r.pointer = null; r.hoverId = h.id;
    r.setCamera({ x:h.x, y:h.y, zoom: 1.3 });
    const checks = [];
    for (const kind of ['clear','fair','overcast','fog','drizzle','rain','downpour','thunderstorm','gale']) {
      r.setWeather({ kind, auto:false, day:1, at:new Date().toISOString() });
      r.wx.set(kind, true, performance.now());
      for (let hour = 0; hour < 24; hour++) {
        r.setDaylight({hour,speed:'paused',at:new Date().toISOString()});
        r.yaw = r.yawT = hour * Math.PI / 12;
        r.setCamera({x:h.x,y:h.y,zoom:1.3});
        r.frame(performance.now(),false);
        checks.push(r.hoverMask.mesh.visible && !r.hoverMask.mesh.material.stencilWrite
          && !r.atmos.cloudMat.stencilWrite && !r.atmos.deckMat.stencilWrite
          && r.atmos.cloudMat.fragmentShader.includes('vec4(col, a)')
          && r.atmos.deckMat.fragmentShader.includes('vec4(col, a)')
          && r.atmos.cloudMat.uniforms.uOpacity.value <= .2
          && r.atmos.deckMat.uniforms.uOpacity.value <= .36
          && !r.atmos.cloudMat.fragmentShader.includes('mapShowAt')
          && !r.atmos.deckMat.fragmentShader.includes('groundUv'));
      }
    }
    return { combinations:checks.length, softIndependentClouds:checks.every(Boolean), hover:h.id };
  });
  assert(results.clouds.softIndependentClouds);
  console.log('cloud states', results.clouds.combinations);
  await page.screenshot({ path: `${shots}/clouds-hover.png` });

  for (const kind of ['clear','fair','overcast','fog','drizzle','rain','downpour','thunderstorm','gale']) {
    await page.evaluate(kind => {
      const r=window.__atlasMap;
      r.hoverId=null;r.pointer=null;r.faceNorth();r.advance(3);r.setCamera(r.fitCamera());
      r.setDaylight({hour:10,speed:'paused',at:new Date().toISOString()});
      r.wx.set(kind,true,performance.now());r.frame(performance.now(),false);
    },kind);
    await page.screenshot({path:`${shots}/overview-${kind}.png`});
  }

  // A translucent closed deck must retain underlying map detail. Hover may add an outline,
  // but must leave every pixel in the hex's interior unchanged (no fill or cloud cutout).
  results.transparency = await page.evaluate(() => {
    const r=window.__atlasMap, h=r.hexIds().filter(h=>h.ground>r.seaLevel+10)[100];
    r.pointer=null;r.hoverId=null;r.selectedId=null;r.setOverhead(true);
    r.setCamera({x:h.x,y:h.y,zoom:1.3});r.setDaylight({hour:10,speed:'paused',at:new Date().toISOString()});
    r.wx.set('overcast',true,performance.now());r.frame(performance.now(),false);
    const u=r.atmos.uniforms;
    u.uCloudNear.value.set(-100,-99);u.uCloudCov.value.set(-1,-.9,0,1);
    r.atmos.deckMat.uniforms.uOpacity.value=.55;r.atmos.deck.visible=true;
    const puffsVisible=r.atmos.puffs.visible;r.atmos.puffs.visible=false;
    const gl=r.gl.getContext(), width=r.glCanvas.width,height=r.glCanvas.height;
    const read=()=>{r.gl.render(r.scene,r.camera);const pixels=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels};
    const grid=r.layers.grid;
    r.layers.grid=true;r.updateOverlay(performance.now(),true);const on=read();
    r.layers.grid=false;r.updateOverlay(performance.now(),true);const off=read();
    let retainedMapDetailPixels=0;
    for(let i=0;i<on.length;i+=4)if(on[i]!==off[i]||on[i+1]!==off[i+1]||on[i+2]!==off[i+2])retainedMapDetailPixels++;
    r.layers.grid=true;r.updateOverlay(performance.now(),true);
    r.hoverMask.update(r.hexById(h.id),40,r.o,r.groundFn,r.ground.id);
    const hover=read();let outlinePixels=0,interiorChangedPixels=0;
    const center=r.hexScreen(h.id);
    const shot=document.createElement('canvas');shot.width=width;shot.height=height;
    shot.getContext('2d').drawImage(r.glCanvas,0,0);
    const screenshot=shot.toDataURL('image/png');
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const i=(y*width+x)*4;
      if(hover[i]===on[i]&&hover[i+1]===on[i+1]&&hover[i+2]===on[i+2])continue;
      outlinePixels++;
      const sx=(x+.5)/width*r.viewport.w, sy=(height-y-.5)/height*r.viewport.h;
      if(Math.hypot(sx-center.x,sy-center.y)<12)interiorChangedPixels++;
    }
    r.layers.grid=grid;r.hoverMask.update(undefined,40,r.o,r.groundFn,r.ground.id);
    r.atmos.puffs.visible=puffsVisible;
    r.setOverhead(false);r.frame(performance.now(),false);
    return {retainedMapDetailPixels,outlinePixels,interiorChangedPixels,screenshot};
  });
  writeFileSync(`${shots}/clouds-soft-outline.png`,Buffer.from(results.transparency.screenshot.split(',')[1],'base64'));
  delete results.transparency.screenshot;
  assert(results.transparency.retainedMapDetailPixels>100,'map detail must remain visible beneath translucent clouds');
  assert(results.transparency.outlinePixels>100,'hover outline must remain visible over clouds');
  assert.equal(results.transparency.interiorChangedPixels,0,'hover must not change the cloud-covered hex interior');
  console.log('pixel transparency',JSON.stringify(results.transparency));
  }

  results.beacon = await page.evaluate(() => {
    const r=window.__atlasMap, h=r.hexIds().find(h=>h.ground>r.seaLevel+10);
    r.pointer=null; r.hoverId=null; r.selectedId=h.id;
    const sizes=[];
    for(const zoom of [r.minZoom(),2.1,5]) {
      r.setCamera({x:h.x,y:h.y,zoom}); r.frame(performance.now(),false);
      sizes.push({height:r.beacon.cu.uHeight.value,radius:r.beacon.R,width:r.beacon.cu.uWidth.value});
    }
    return sizes;
  });
  assert(results.beacon.every(s=>s.height===60 && s.radius===34 && s.width===6));

  // Real UI clicks and actual rAF timing: do not fast-forward the camera for this check.
  await page.evaluate(() => {
    const r=window.__atlasMap, h=r.hexIds().find(h=>h.ground>r.seaLevel+10);
    r.selectedId=null; r.setWeather({kind:'fair',auto:false,day:1,at:new Date().toISOString()});
    r.setDaylight({hour:10,speed:'paused',at:new Date().toISOString()});
    r.faceNorth();r.advance(3);r.setCamera({x:h.x,y:h.y,zoom:2.1});
    window.__batch1 = { frames:[], snapshots:0, captures:0, previous:0, phase:0, stalls:[], overlay:[], masks:[] };
    const snapshot=r.snapshot.bind(r); r.snapshot=(...a)=>{window.__batch1.snapshots++;return snapshot(...a)};
    const copy=r.copyView.bind(r);r.copyView=(...a)=>{window.__batch1.captures++;return copy(...a)};
    const after=r.onAfterFrame;r.onAfterFrame=()=>{
      after?.();const b=window.__batch1,now=performance.now();
      if(r.cameraMoving) {if(b.previous){b.frames.push(now-b.previous);if(now-b.previous>33)b.stalls.push({phase:b.phase,ms:now-b.previous})}b.previous=now;}
      else b.previous=0;
    };
    window.__batch1.slowFunctions=[];
    for (const name of ['step','frame','applyLight','updateOverlay','layoutLabels','updateNeon','fitShadow']) {
      const fn=r[name].bind(r);r[name]=(...a)=>{const t=performance.now(),out=fn(...a);if(performance.now()-t>5)window.__batch1.slowFunctions.push({name,phase:window.__batch1.phase,ms:performance.now()-t});return out};
    }
    window.__batch1.longTasks=[];
    new PerformanceObserver(list=>{for(const e of list.getEntries())window.__batch1.longTasks.push({phase:window.__batch1.phase,ms:e.duration,start:e.startTime})}).observe({type:'longtask',buffered:false});
  });
  await page.waitForTimeout(3000);
  if(process.env.TRACE) {
    traceSession=await page.context().newCDPSession(page);
    await traceSession.send('Tracing.start',{categories:'devtools.timeline,v8,blink,disabled-by-default-devtools.timeline',transferMode:'ReturnAsStream'});
  }
  const clicks=[];
  for(let i=0;i<12;i++) {
    const p=await page.evaluate(i=>{
      const r=window.__atlasMap, candidates=r.hexIds().filter(h=>h.ground>r.seaLevel+10).map(h=>({...h,...r.hexScreen(h.id)}))
        .filter(h=>h.id!==r.selectedId&&h.x>220&&h.x<r.viewport.w-420&&h.y>230&&h.y<r.viewport.h-180&&r.hexAt(h.x,h.y)?.id===h.id);
      const h=candidates[(i*7)%candidates.length];
      if(!h)throw new Error('No visible land hex available');
      const b=r.hud.getBoundingClientRect();return {id:h.id,x:h.x+b.left,y:h.y+b.top};
    },i);
    const start=Date.now();
    await page.evaluate(i=>{window.__batch1.phase=i+1;window.__batch1.previous=0},i);
    await page.mouse.click(p.x,p.y);
    await page.waitForFunction(id=>window.__atlasMap.selectedId===id,p.id);
    await page.waitForFunction(()=>!window.__atlasMap.cameraMoving, null, {timeout:10000});
    clicks.push(Date.now()-start);
    console.log('hex click',i+1,clicks.at(-1));
  }
  results.pans=await page.evaluate(clicks=>{
    const b=window.__batch1, deltas=[...b.frames];
    deltas.sort((a,b)=>a-b);
    return {clicks:clicks.length,settleMs:clicks,p50:deltas[Math.floor(deltas.length*.5)],p95:deltas[Math.floor(deltas.length*.95)],max:Math.max(...deltas),stalls:b.stalls,slowFunctions:b.slowFunctions,longTasks:b.longTasks,fullSceneSnapshots:b.snapshots,captures:b.captures,stats:window.__atlasMap.stats()};
  },clicks);
  if(traceSession) {
    const done=new Promise(resolve=>traceSession.once('Tracing.tracingComplete',resolve));
    await traceSession.send('Tracing.end');const {stream}=await done;let data='';
    while(true){const chunk=await traceSession.send('IO.read',{handle:stream});data+=chunk.data;if(chunk.eof)break;}
    await traceSession.send('IO.close',{handle:stream});writeFileSync(`${shots}/trace.json`,data);
  }
  assert.equal(results.pans.fullSceneSnapshots,0,'panel art must not trigger additional scene renders');
  await page.waitForSelector('.panel-art img');
  results.pans.captures=await page.evaluate(()=>window.__batch1.captures);
  assert(results.pans.captures>0,'panel art must still appear once the glide settles');
  await page.screenshot({path:`${shots}/beacon-and-panel.png`});
  await page.locator('.mode-toggle').click();
  await page.waitForSelector('.mapview[data-map-mode="2d"]');
  results.fallback=await page.evaluate(()=>window.__atlasMap.minZoom()<window.__atlasMap.fitCamera().zoom);
  assert(results.fallback,'2D fallback must retain its independent overview range');
  await page.locator('.mode-toggle').click();
  await page.waitForSelector('.mapview[data-map-mode="3d"]');
  const afterData = await page.evaluate(async id=>JSON.stringify((await (await fetch(`/api/worlds/${id}/map`)).json()).hexes),world.id);
  assert.equal(afterData,originalData,'presentation checks must not alter hex data');
  assert.equal(errors.length,0,errors.join('\n'));
  results.hexDataUnchanged=true;
  writeFileSync(`${shots}/results.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally { await browser.close(); }
