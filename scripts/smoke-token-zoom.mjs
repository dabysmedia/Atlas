import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base=process.env.BASE_URL ?? 'http://localhost:3001',shots='./shots/token-zoom';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;},{url,method,body});
function miniature() {
  const vertices = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}
let world;
try {
  await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForSelector('canvas.map');
  world=await api('/api/worlds','POST',{name:`Token zoom QA ${Date.now()}`,cols:36,rows:26});const path=`/api/worlds/${world.id}`;
  const before=await api(`${path}/map`),hex=before.hexes.find(h=>h.q===16&&h.r===4),neighbor=before.hexes.find(h=>h.q===17&&h.r===4);
  const faction=await api(`${path}/factions`,'POST',{name:'Test faction',color:'#da9f48'});
  const model=await page.evaluate(async({url,bytes})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'model/gltf-binary'},body:Uint8Array.from(bytes)});return r.json();},{url:`${path}/token-models?name=Zoom-miniature.glb`,bytes:[...miniature()]});
  const tokens=[];for(const [i,h] of [hex,hex,neighbor].entries())tokens.push(await api(`${path}/tokens`,'POST',{kind:'unit',name:`Test scout ${i+1}`,hexId:h.id,factionId:faction.id,modelId:model.id}));
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.waitForFunction(ids=>ids.every(id=>window.__atlasMap.miniatures.has(id)),tokens.map(t=>t.id));
  const inspect=ratio=>page.evaluate(({ratio,hexId})=>{
    const r=window.__atlasMap,h=r.hexById(hexId);r.saved=null;r.setCamera(ratio===1?r.fitCamera():{x:h.cx,y:h.cy,zoom:r.minZoom()*ratio});r.frame(performance.now(),false);r.layoutPieces();
    return {visible:r.miniatures.group.visible,tiles:r.pieceTiles.map(t=>({id:t.token.id,modeled:t.modeled,x:t.x,y:t.y,radius:t.radius,plate:t.plate,modelBottom:t.modelBottom,foot:r.worldToScreen(r.tokenPos(t.token).x,r.tokenPos(t.token).y)})),positions:r.tokens.filter(t=>t.modelId).map(t=>{const p=r.tokenPos(t),e=r.miniatures.extent(t.id),h=r.hexById(t.hexId);return {id:t.id,drift:Math.hypot(e.x-p.x,e.y-p.y),fit:Math.hypot(e.x-h.cx,e.y-h.cy)+Math.hypot(e.width,e.depth)/2,lift:e.foot-r.groundAt(e.x,e.y)};})};
  },{ratio,hexId:hex.id});
  for(const ratio of [1,1.2,1.44,1.46,1.8,3,1.2,1,3]) {
    const state=await inspect(ratio), modeled=ratio>=1.45;assert.equal(state.visible,modeled);assert(state.tiles.every(t=>t.modeled===modeled));
    for(const p of state.positions){assert(p.drift<.001,'one shared world position');assert(p.fit<=40*Math.sqrt(3)/2,'footprint stays in its hex');assert(Math.abs(p.lift-5)<.001);}
    if(!modeled) for(const tile of state.tiles) for(const other of state.tiles) if(tile.id!==other.id) assert(Math.hypot(tile.x-other.x,tile.y-other.y)>=tile.radius+other.radius,'overview glyphs do not overlap');
    for(const tile of state.tiles){assert(Math.hypot(tile.x-tile.foot.x,tile.y-tile.foot.y)<.001,'2D marker anchor matches terrain');if(modeled)assert(tile.plate.y>=tile.modelBottom+8);}
    const picks=await page.evaluate(()=>{const r=window.__atlasMap;return r.pieceTiles.map(t=>{const p=t.plate,x=p?p.x+p.width/2:t.x,y=p?p.y+p.height/2:t.y;return {id:t.token.id,picked:r.tokenAt(x,y)?.id};});});assert(picks.every(t=>t.id===t.picked),`each shared-hex piece is selectable at ratio ${ratio}: ${JSON.stringify(picks)}`);
  }
  await inspect(1);await page.mouse.move(720,450);
  for(let i=0;i<8;i++)await page.mouse.wheel(0,-200);
  await page.waitForFunction(()=>window.__atlasMap.miniatures.group.visible);
  for(let i=0;i<12;i++)await page.mouse.wheel(0,200);
  await page.waitForFunction(()=>!window.__atlasMap.miniatures.group.visible);
  await inspect(1);await page.screenshot({path:`${shots}/overview-2d.png`});
  await inspect(5);await page.screenshot({path:`${shots}/exploration-models.png`});
  // Check model nameplates remain clear of silhouettes when orbiting the selected hex.
  for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]) {
    const clear=await page.evaluate(angle=>{const r=window.__atlasMap;r.yaw=r.yawT=angle;r.tiltBias=r.tiltBiasT=.4;r.frame(performance.now(),false);r.layoutPieces();return r.pieceTiles.filter(t=>t.modeled).every(t=>t.plate.y>=t.modelBottom+8);},angle);assert(clear);
  }
  await page.setViewportSize({width:390,height:844});await inspect(4);await page.screenshot({path:`${shots}/mobile-models.png`});
  const after=await api(`${path}/map`);assert.deepEqual(after.hexes.sort((a,b)=>a.id.localeCompare(b.id)),before.hexes.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({overview2D:true,exploration3D:true,repeatZoom:true,positionsMatch:true,footprintsFit:true,platesClear:true,sharedHexPicking:true,hexesUnchanged:true,errors}));
} finally {if(world)await api(`/api/worlds/${world.id}`,'DELETE');await browser.close();}
