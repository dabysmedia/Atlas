import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.BASE_URL??'http://localhost:3016',shots='shots/settlements';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;},{url,method,body});
function miniature() {
  const vertices = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}
let world;
const at=async hexId=>{const p=await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);return r.worldToScreen(h.cx,h.cy);},hexId);const box=await page.locator('canvas.map:not(.map-gl)').boundingBox();return{x:box.x+p.x,y:box.y+p.y};};
const camera=async hexId=>{await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);r.saved=null;r.setCamera({x:h.cx,y:h.cy,zoom:1.4});},hexId);await page.waitForTimeout(300);};
try{
 await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS??'atlas-local-playtest');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForSelector('canvas.map');
 world=await api('/api/worlds','POST',{name:`Settlement smoke ${Date.now()}`,cols:36,rows:26});const path=`/api/worlds/${world.id}`;
 const before=await api(`${path}/map`),a=before.hexes.find(h=>h.q===16&&h.r===4),b=before.hexes.find(h=>h.q===17&&h.r===4),c=before.hexes.find(h=>h.q===18&&h.r===4);
 const faction=await api(`${path}/factions`,'POST',{name:'River alliance',color:'#58bda1'});
 await api(`${path}/claims/control`,'POST',{hexIds:[a.id,b.id,c.id],factionId:faction.id});
 const poi=await api(`${path}/tokens`,'POST',{name:'Shrine in the city',kind:'temple',hexId:a.id});
 await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);await camera(a.id);await page.keyboard.press('6');
 for(const id of [a.id,b.id]){const p=await at(id);await page.mouse.click(p.x,p.y);await page.waitForTimeout(120);}
 await page.getByRole('button',{name:'Create settlement',exact:true}).click();
 await page.getByRole('dialog',{name:'Found a settlement'}).waitFor();
 await page.getByLabel('Settlement type', {exact:true}).selectOption('city');await page.getByLabel('Settlement name',{exact:true}).fill('Rivergate');await page.getByRole('button',{name:'Found settlement',exact:true}).click();
 await page.getByRole('button',{name:'Edit settlement',exact:true}).waitFor();let map=await api(`${path}/map`),s=map.settlements.find(s=>s.name==='Rivergate'),token=map.tokens.find(t=>t.settlementId===s.id);assert.equal(s.hexIds.length,2);assert.equal(token.modelId,null);
 await page.screenshot({path:`${shots}/settlement-overview.png`});
 await page.getByRole('button',{name:'Edit settlement',exact:true}).click();await page.getByLabel('Population',{exact:true}).fill('8200');await page.getByLabel('Government',{exact:true}).fill('An elected river council');await page.getByLabel('Faction capital',{exact:true}).check();
 await api(`${path}/settlements/${s.id}`,'PATCH',{revision:s.revision,population:900});await page.waitForFunction(id=>window.__atlasMap.settlements.find(s=>s.id===id).population===900,s.id);
 await page.getByRole('button',{name:'Save settlement',exact:true}).click();await page.getByText('This settlement changed on another screen. Reload before saving.',{exact:true}).waitFor();assert.equal((await api(`${path}/map`)).settlements.find(place=>place.id===s.id).population,900);await page.getByRole('button',{name:'Cancel edits',exact:true}).click();await page.getByRole('button',{name:'Edit settlement',exact:true}).click();await page.getByLabel('Population',{exact:true}).fill('8200');await page.getByLabel('Government',{exact:true}).fill('An elected river council');await page.getByLabel('Faction capital',{exact:true}).check();
 await page.getByRole('tab',{name:'Development',exact:true}).click();await page.getByRole('button',{name:'Add structure',exact:true}).click();await page.getByLabel('Structure name',{exact:true}).fill('Riverside homes');await page.getByLabel('Residential',{exact:true}).check();await page.getByLabel('Lots (0 = infrastructure)',{exact:true}).fill('2');
 await page.getByRole('button',{name:'Save settlement',exact:true}).click();await page.getByRole('button',{name:'Edit settlement',exact:true}).waitFor();await page.screenshot({path:`${shots}/urban-development.png`});
 map=await api(`${path}/map`);s=map.settlements.find(place=>place.id===token.settlementId);assert.equal(s.population,8200);assert.equal(s.data.profile.structures[0].lots,2);
 await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.getByRole('button',{name:'Show influence',exact:false}).click();await page.waitForFunction(()=>window.__atlasMap.settlementInfluence.size===3);
 await page.getByRole('button',{name:'Edit hex footprint',exact:true}).click();await camera(b.id);const point=await at(c.id);await page.mouse.click(point.x,point.y);await page.waitForTimeout(150);await page.getByRole('button',{name:'Save footprint',exact:true}).click();await page.waitForFunction(()=>window.__atlasMap.settlements.some(s=>s.hexIds.length===3));
 await page.keyboard.press('6');await page.getByLabel('Settlement directory').selectOption(token.id);await page.getByRole('button',{name:'Edit settlement',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Appearance',exact:true}).click();
 const glbPath='.scratch/settlement-smoke.glb';writeFileSync(glbPath,miniature());await page.locator('label').filter({hasText:'Upload GLB miniature'}).locator('input[type=file]').setInputFiles(glbPath);
 await page.waitForFunction(id=>window.__atlasMap.miniatures.has(id),token.id);await camera(a.id);
 const modelState=await page.evaluate(id=>{const r=window.__atlasMap,t=r.tokens.find(t=>t.id===id),object=r.miniatures.group.children.find(o=>o.userData.tokenId===id),p=r.tokenPos(t);r.frame(performance.now(),false);return {visible:r.miniatures.group.visible,lift:object.position.y-r.groundAt(p.x,p.y),rotation:object.rotation.toArray().slice(0,3)};},token.id);assert.equal(modelState.visible,true);assert(Math.abs(modelState.lift)<.001);assert.deepEqual(modelState.rotation,[0,0,0]);
 await page.screenshot({path:`${shots}/settlement-model.png`});
 await page.getByRole('button',{name:'Use 2D indicator',exact:true}).click();await page.waitForFunction(id=>!window.__atlasMap.tokens.find(t=>t.id===id).modelId,token.id);
 await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Development',exact:true}).click();await page.screenshot({path:`${shots}/mobile-development.png`});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);assert.deepEqual(errors,[]);
 const after=await api(`${path}/map`);assert.deepEqual(after.hexes.sort((a,b)=>a.id.localeCompare(b.id)),before.hexes.sort((a,b)=>a.id.localeCompare(b.id)));assert(after.tokens.some(t=>t.id===poi.id));
 console.log(JSON.stringify({multihexFounding:true,statsSaved:true,urbanGrid:true,footprintEditing:true,capitalInfluence:true,modelUpload:true,staticModel:true,badgeFallback:true,mobile:true,concurrentEditProtected:true,hexesUnchanged:true,errors}));
}catch(e){await page.screenshot({path:`${shots}/failure.png`});console.log((await page.locator('body').innerText()).slice(-5000));console.log(errors);throw e;}finally{if(world)await api(`/api/worlds/${world.id}`,'DELETE');await browser.close();}
