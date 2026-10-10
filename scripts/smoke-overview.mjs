// Read-only presentation checks: overview tilt, restored orbit, and country-border fading.
// BASE_URL=... ATLAS_PASS=... CHROMIUM_PATH=... node scripts/smoke-overview.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base=process.env.BASE_URL ?? 'http://localhost:3001';
const shots=process.env.SHOTS ?? './shots/overview';
mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('401'))errors.push(m.text())});
page.setDefaultTimeout(60000);
try {
  await page.goto(base);
  await page.locator('#u').fill(process.env.ATLAS_USER ?? 'gm');
  await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.waitForSelector('canvas.map');
  const world=await page.evaluate(async()=> (await (await fetch('/api/worlds')).json()).find(w=>w.name==='The Sundered Reach'));
  assert(world,'demo world with faction territories must exist');
  await page.goto(`${base}/w/${world.id}/map`);
  await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  const original=await page.evaluate(async id=>JSON.stringify(await(await fetch(`/api/worlds/${id}/map`)).json()),world.id);
  const results=await page.evaluate(()=>{
    const r=window.__atlasMap,fit=r.fitCamera(),z=Math.max(1.7,fit.zoom*2.8);
    r.pointer=null;r.hoverId=null;r.selectedId=null;r.setOverhead(false);
    r.yaw=r.yawT=.63;r.tiltBias=r.tiltBiasT=.37;
    r.setCamera({...fit,zoom:z});r.frame(performance.now(),false);
    const prior={tilt:r.tiltNow,bias:r.tiltBiasT,yaw:r.yaw};
    r.zoomAt(r.viewport.w/2,r.viewport.h/2,fit.zoom/r.cam.zoom);
    const path=[];
    for(let i=0;i<300;i++){
      r.step(1/60);
      if(i%15===0)path.push({zoom:r.cam.zoom,tilt:r.tiltNow});
    }
    r.frame(performance.now(),false);
    const ray=r.rayAt(r.viewport.w/2,r.viewport.h/2);
    const overhead={tilt:r.tiltNow,bias:r.tiltBiasT,yaw:r.yaw,vertical:Math.hypot(ray.d.x,ray.d.z),alpha:r.neon.uniforms.uOverview.value};
    r.zoomAt(r.viewport.w/2,r.viewport.h/2,z/r.cam.zoom);r.advance(5);r.frame(performance.now(),false);
    const restored={tilt:r.tiltNow,bias:r.tiltBiasT,yaw:r.yaw};
    const fades=[];
    const faction=[...r.territories.values()].find(t=>t.label.n>=3&&t.name);
    for(const ratio of [1,1.1,1.25,1.45,2]){
      r.setCamera({...fit,zoom:fit.zoom*ratio});r.frame(performance.now(),false);
      const label=faction ? r.placeLabel({id:faction.id},0) : null;
      fades.push({ratio,border:r.neon.uniforms.uOverview.value,label:label?.alpha ?? 0});
    }
    return {prior,overhead,restored,path,fades,territories:r.territories.size,
      dotted:r.neon.mesh.material.fragmentShader.includes('along / uWorldPerPx'),
      throughCloudPass:r.neon.through.visible};
  });
  assert(results.territories>0);
  assert.equal(results.overhead.tilt,0,'zoom limit must settle exactly overhead');
  assert(results.overhead.vertical<1e-6,'center view ray must point straight down');
  assert.equal(results.overhead.bias,results.prior.bias,'zooming out must preserve the user tilt setting');
  assert(Math.abs(results.restored.tilt-results.prior.tilt)<1e-4,'zooming back must restore the previous angle');
  assert.equal(results.restored.yaw,results.prior.yaw,'zooming must preserve orbit direction');
  assert(results.path.every((p,i,a)=>!i||p.tilt<=a[i-1].tilt+1e-4),'zoom-out tilt must progress smoothly toward overhead');
  assert.equal(results.fades[0].border,1);
  assert(results.fades[2].border>0&&results.fades[2].border<1,'borders must fade progressively');
  assert.equal(results.fades[3].border,0);
  assert.equal(results.fades[3].label,0,'nation names must fade out with their borders');
  assert(results.dotted&&!results.throughCloudPass);
  for(const [name,ratio] of [['countries',1],['fading',1.25],['exploration',3]]){
    await page.evaluate(ratio=>{
      const r=window.__atlasMap,fit=r.fitCamera();
      r.yaw=r.yawT=0;r.setCamera({...fit,zoom:fit.zoom*ratio});
      r.setDaylight({hour:10,speed:'paused',at:new Date().toISOString()});
      r.wx.set('fair',true,performance.now());r.frame(performance.now(),false);
    },ratio);
    await page.waitForTimeout(800); // let existing DOM label fades finish
    await page.screenshot({path:`${shots}/${name}.png`});
  }
  const after=await page.evaluate(async id=>JSON.stringify(await(await fetch(`/api/worlds/${id}/map`)).json()),world.id);
  assert.equal(after,original,'presentation checks must not change map data');
  assert.equal(errors.length,0,errors.join('\n'));
  results.mapDataUnchanged=true;
  writeFileSync(`${shots}/results.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally {await browser.close()}
