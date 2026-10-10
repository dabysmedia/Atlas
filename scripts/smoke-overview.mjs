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
  // Exercise the wheel handler itself, including device units and large wheel events.
  results.wheel=await page.evaluate(()=>{
    const r=window.__atlasMap,canvas=r.hud,fit=r.fitCamera();
    const box=canvas.getBoundingClientRect();
    const wheel=(deltaY,deltaMode=0,ctrlKey=false)=>canvas.dispatchEvent(new WheelEvent('wheel',{
      deltaY,deltaMode,ctrlKey,clientX:box.left+r.viewport.w/2,clientY:box.top+r.viewport.h/2,bubbles:true,cancelable:true
    }));
    r.saved=null;r.setCamera(fit);
    const levels=[r.target.zoom];
    for(let i=0;i<100;i++){
      wheel(-120);const z=r.target.zoom;
      if(z===levels.at(-1))break;
      levels.push(z);r.advance(2);
    }
    const upper=r.target.zoom;
    const down=[];
    for(let i=0;i<100;i++){
      wheel(120);const z=r.target.zoom;
      if(z===down.at(-1))break;
      down.push(z);r.advance(2);
    }
    const variants=[];
    for(const [name,dy,mode,ctrl] of [['pixels',-120,0,false],['lines',-3,1,false],['pages',-1,2,false],['large',-1200,0,false],['trackpad',-2,0,false],['pinch',-2,0,true]]){
      r.setCamera({...fit,zoom:1.5});wheel(dy,mode,ctrl);
      variants.push({name,ratio:r.target.zoom/1.5});
    }
    r.setCamera(fit);
    return {levels,down,upper,lower:down.at(-1),min:fit.zoom,variants};
  });
  assert(results.wheel.levels.length>=30,'full zoom range must offer many fine wheel increments');
  assert.equal(results.wheel.upper,4,'wheel must still reach the original maximum zoom');
  assert.equal(results.wheel.lower,results.wheel.min,'wheel must still reach the overview limit');
  assert(results.wheel.levels.every((z,i,a)=>!i||(z>a[i-1]&&z/a[i-1]<1.06)),'normal wheel notch must change zoom by less than 6%');
  assert(results.wheel.variants.filter(v=>v.name!=='pinch').every(v=>v.ratio>1&&v.ratio<1.08),'wheel devices must use small continuous increments');
  assert(Math.abs(results.wheel.variants.find(v=>v.name==='pinch').ratio-Math.exp(.024))<1e-6,'trackpad pinch sensitivity must be preserved');
  // A real browser wheel event must animate through intermediate magnifications.
  const bounds=await page.evaluate(()=>{const b=window.__atlasMap.hud.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}});
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.wheel(0,-120);
  const animation=await page.evaluate(async()=>{
    const samples=[];
    for(let i=0;i<24;i++){
      await new Promise(requestAnimationFrame);
      samples.push(window.__atlasMap.cam.zoom);
    }
    return {samples,target:window.__atlasMap.target.zoom};
  });
  assert(new Set(animation.samples.map(z=>z.toFixed(6))).size>3,'wheel animation must have intermediate zoom values');
  assert(animation.samples.every((z,i,a)=>!i||z>=a[i-1]),'wheel zoom must animate monotonically');
  results.wheel.animation=animation;
  // Real hex clicks must retain magnification, and leave the country overview fixed.
  results.selection=[];
  for(const ratio of [3,1]) {
    await page.keyboard.press('Escape');
    await page.evaluate(ratio=>{
      const r=window.__atlasMap;
      r.saved=null;r.yaw=r.yawT=.2;r.tiltBias=r.tiltBiasT=.3;
      r.setCamera({...r.fitCamera(),zoom:r.minZoom()*ratio});
    },ratio);
    await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
    const before=await page.evaluate(()=>{
      const r=window.__atlasMap;return {...r.cam,yaw:r.yaw,tilt:r.tiltNow};
    });
    for(let i=0;i<4;i++) {
      const at=await page.evaluate(i=>{
        const r=window.__atlasMap,b=r.hud.getBoundingClientRect();
        const hs=r.hexIds().filter(h=>h.ground>r.seaLevel+10).map(h=>({...h,...r.hexScreen(h.id)}))
          .filter(h=>h.id!==r.selectedId&&h.x>220&&h.x<r.viewport.w-420&&h.y>230&&h.y<r.viewport.h-180&&r.hexAt(h.x,h.y)?.id===h.id);
        const h=hs[(i*7)%hs.length];
        if(!h)throw new Error('No visible selectable hex');
        return {id:h.id,x:h.x+b.left,y:h.y+b.top};
      },i);
      await page.mouse.click(at.x,at.y);
      await page.waitForFunction(id=>window.__atlasMap.selectedId===id,at.id);
      await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
      const after=await page.evaluate(()=>{
        const r=window.__atlasMap;return {...r.cam,yaw:r.yaw,tilt:r.tiltNow};
      });
      assert.equal(after.zoom,before.zoom,'hex click changed magnification');
      assert.equal(after.yaw,before.yaw,'hex click changed orbit');
      assert.equal(after.tilt,before.tilt,'hex click changed tilt');
      if(ratio===1)assert.deepEqual(after,before,'overview click moved the camera');
    }
    await page.getByRole('button',{name:'Close panel',exact:true}).last().click();
    await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
    const closed=await page.evaluate(()=>({...window.__atlasMap.cam}));
    assert.equal(closed.zoom,before.zoom,'closing selection changed magnification');
    if(ratio===1)assert.deepEqual(closed,{x:before.x,y:before.y,zoom:before.zoom},'closing overview selection moved the camera');
    results.selection.push({ratio,clicks:4,zoom:closed.zoom,overviewFixed:ratio===1});
  }
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
