// Read-only: fake art responses exercise alignment on a model without changing stored data.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.BASE_URL ?? 'http://localhost:3001';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.setDefaultTimeout(60000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button',{name:'Sign in'}).click();await page.waitForSelector('canvas.map');
  const world=await page.evaluate(async()=> (await (await fetch('/api/worlds')).json()).find(w=>w.name==='The Sundered Reach'));
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  const hex=await page.evaluate(()=>{const r=window.__atlasMap;return r.hexIds().find(h=>h.ground>r.seaLevel+10)});
  const original=await page.evaluate(async id=>(await fetch(`/api/worlds/${id}/map`)).json(),world.id);
  const fixture=structuredClone(original);
  fixture.map.art={version:999,width:128,height:128,mime:'image/png',updatedAt:new Date().toISOString(),placement:{x:hex.x-40,y:hex.y-40,w:80,h:80,opacity:1}};
  await page.route(`**/api/worlds/${world.id}/map`,r=>r.fulfill({json:fixture}));
  await page.route(`**/api/worlds/${world.id}/map/art?*`,r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#ff00ff"/></svg>'}));
  await page.reload();await page.waitForFunction(()=>window.__atlasMap?.hasGround && window.__atlasMap.hasArt);
  await page.evaluate(hex=>{const r=window.__atlasMap;r.saved=null;r.setCamera({x:hex.x,y:hex.y,zoom:1.7});r.setOverhead(true);window.__alignMap=r;},hex);
  await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  await page.getByRole('button',{name:'Layers',exact:true}).click();await page.getByRole('button',{name:'Align',exact:true}).click();
  await page.waitForFunction(()=>window.__atlasMap.alignArt);
  await page.waitForFunction(()=>window.__atlasMap.gridProjection.uniforms.uGridOverview.value===1);
  const magenta=()=>page.evaluate(()=>{
    const r=window.__atlasMap;r.frame(performance.now(),false);const c=r.ovTex.image,px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let n=0;for(let i=0;i<px.length;i+=16)if(px[i]>230&&px[i+1]<20&&px[i+2]>230)n++;return n;
  });
  assert(await magenta()>100,'alignment art must be visible on the 3D terrain');
  const before=await page.evaluate(()=>({...window.__atlasMap.artPlacement}));
  await page.mouse.move(720,450);await page.mouse.down();await page.mouse.move(770,475,{steps:8});await page.mouse.up();
  await page.waitForFunction(p=>window.__atlasMap.artPlacement.x!==p.x||window.__atlasMap.artPlacement.y!==p.y,before);
  assert.equal(await page.evaluate(()=>window.__atlasMap===window.__alignMap),true,'alignment keeps the 3D renderer');
  assert.equal(await page.locator('.mapview').getAttribute('data-map-mode'),'3d');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>!window.__atlasMap.alignArt);
  assert.equal(await magenta(),0,'alignment overlay must disappear on cancel');
  await page.unrouteAll();
  const after=await page.evaluate(async id=>(await fetch(`/api/worlds/${id}/map`)).json(),world.id);assert.deepEqual(after,original);
  assert.deepEqual(errors,[]);
  console.log('Art preview, ground-based dragging, cancel and 3D-only alignment passed; stored map unchanged');
} finally {await browser.close();}
