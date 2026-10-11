import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base=process.env.BASE_URL??'http://localhost:3001';mkdirSync('shots/token-presets',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;},{url,method,body});
function miniature() {
  const vertices = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}

let world;
try {
  await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS??'atlas-local-playtest');await page.getByRole('button',{name:'Sign in'}).click();await page.waitForSelector('canvas.map');
  world=await api('/api/worlds','POST',{name:`Presets QA ${Date.now()}`,cols:16,rows:12});const path=`/api/worlds/${world.id}`;
  const faction=await api(`${path}/factions`,'POST',{name:'Test faction',color:'#da9f48'}),before=await api(`${path}/map`),hex=before.hexes.find(h=>h.q===7&&h.r===2);
  const model=await page.evaluate(async({url,bytes})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'model/gltf-binary'},body:Uint8Array.from(bytes)});return r.json();},{url:`${path}/token-models?name=Copper_Scout.glb`,bytes:[...miniature()]});
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);r.saved=null;r.setCamera({x:h.cx,y:h.cy,zoom:1.5});window.__presetMap=r;},hex.id);
  await page.getByRole('button',{name:'Token drawer',exact:true}).click();await page.getByRole('button',{name:'Add token',exact:true}).click();
  await page.getByRole('button',{name:'Preset Envoy',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Token name',exact:true}).inputValue(),'Envoy');
  await page.getByRole('textbox',{name:'Token name',exact:true}).fill('Custom envoy');await page.getByRole('button',{name:'Preset Fleet',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Token name',exact:true}).inputValue(),'Fleet');
  assert.equal(await page.getByRole('combobox',{name:'Piece type'}).count(),0);await page.screenshot({path:'shots/token-presets/desktop.png'});
  await page.getByRole('button',{name:'Save to drawer',exact:true}).click();let state=await api(`${path}/map`),fleet=state.tokens.find(t=>t.name==='Fleet');assert(fleet);assert.equal(fleet.hexId,null);assert.equal(fleet.data.role,'Fleet');assert.equal(fleet.kind,'unit');
  await page.getByRole('button',{name:'Add token',exact:true}).click();await page.getByRole('button',{name:'Preset Copper Scout',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Token name',exact:true}).inputValue(),'Copper Scout');
  await page.getByRole('button',{name:'Place token',exact:true}).click();await page.getByRole('dialog',{name:'Add token'}).waitFor({state:'detached'});
  let point=await page.evaluate(id=>{const r=window.__atlasMap,p=r.hexScreen(id),b=r.hud.getBoundingClientRect();return{x:p.x+b.x,y:p.y+b.y};},hex.id);await page.mouse.click(point.x,point.y);
  await page.waitForFunction(modelId=>window.__atlasMap.tokens.some(t=>t.modelId===modelId&&t.hexId),model.id);state=await api(`${path}/map`);const scout=state.tokens.find(t=>t.name==='Copper Scout');assert.equal(scout.modelId,model.id);assert.equal(scout.hexId,hex.id);
  const sheet=await api(`${path}/pages`,'POST',{title:'Test unit sheet'});await api(`${path}/tokens/${scout.id}`,'PATCH',{data:{...scout.data,sheetPageId:sheet.id}});await page.waitForFunction(({id,sheet})=>window.__atlasMap.tokens.find(t=>t.id===id)?.data.sheetPageId===sheet,{id:scout.id,sheet:sheet.id});
  await page.getByRole('button',{name:'Add token',exact:true}).click();await page.getByRole('button',{name:'Preset Copper Scout',exact:true}).first().click();await page.getByRole('button',{name:'Place token',exact:true}).click();
  point=await page.evaluate(id=>{const r=window.__atlasMap,p=r.hexScreen(id),b=r.hud.getBoundingClientRect();return{x:p.x+b.x,y:p.y+b.y};},hex.id);await page.mouse.click(point.x,point.y);
  await page.waitForFunction(()=>window.__atlasMap.tokens.some(t=>t.name==='Copper Scout #2'));state=await api(`${path}/map`);const copy=state.tokens.find(t=>t.name==='Copper Scout #2');assert.equal(copy.modelId,model.id);assert.equal(copy.data.sheetPageId,sheet.id);assert.equal(copy.data.drawerSourceId,scout.id);
  assert.equal(await page.getByRole('button',{name:'Deploy another',exact:false}).count(),0);assert.equal(await page.getByRole('button',{name:'Move',exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Add token',exact:true}).click();await page.waitForTimeout(400);await page.screenshot({path:'shots/token-presets/mobile.png'});
  assert(await page.getByRole('dialog',{name:'Add token'}).evaluate(el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight;}));
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.reload();await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  state=await api(`${path}/map`);assert.equal(state.tokens.length,3);assert.deepEqual(state.hexes,before.hexes);assert.deepEqual(errors,[]);
  console.log('PASS: dedicated Add token, role/model presets auto-name, saved reserve, 3D placement, repeated instances inherit model/sheet, mobile, reload, hex data unchanged');
}finally{if(world)await api(`/api/worlds/${world.id}`,'DELETE').catch(()=>{});await browser.close();}
