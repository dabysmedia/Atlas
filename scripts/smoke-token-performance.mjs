import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base=process.env.BASE_URL ?? 'http://localhost:3001',shots='./shots/token-performance';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(30000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;},{url,method,body});
function miniature() {
  const source = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const vertices=new Float32Array(source.length*40000);for(let i=0;i<40000;i++)vertices.set(source,i*source.length);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}
let world;
try {
  await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForSelector('canvas.map');
  world=await api('/api/worlds','POST',{name:`Token performance QA ${Date.now()}`,cols:36,rows:26});const path=`/api/worlds/${world.id}`;
  const before=await api(`${path}/map`),hex=before.hexes.find(h=>h.q===16&&h.r===4),neighbor=before.hexes.find(h=>h.q===17&&h.r===4);
  const faction=await api(`${path}/factions`,'POST',{name:'Test faction',color:'#da9f48'});
  const model=await page.evaluate(async({url,bytes})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'model/gltf-binary'},body:Uint8Array.from(bytes)});return r.json();},{url:`${path}/token-models?name=Dense-miniature.glb`,bytes:[...miniature()]});
  const tokens=[];for(const [i,h] of [hex,hex,neighbor].entries())tokens.push(await api(`${path}/tokens`,'POST',{kind:'unit',name:`Test scout ${i+1}`,hexId:h.id,factionId:faction.id,modelId:model.id}));
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.waitForFunction(ids=>ids.every(id=>window.__atlasMap.miniatures.has(id)),tokens.map(t=>t.id));
  const profile=await page.evaluate(id=>{
    const r=window.__atlasMap,h=r.hexById(id);r.setCamera({x:h.cx,y:h.cy,zoom:3});r.frame(performance.now(),false);
    const tile=r.pieceTiles[0],e=r.miniatures.extent(tile.token.id),p=r.projectPoint(e.x,e.y,e.foot+e.height*.4);
    let triangleCalls=0;const original=r.miniatures.ray.intersectObjects.bind(r.miniatures.ray);r.miniatures.ray.intersectObjects=(...args)=>{triangleCalls++;return original(...args);};
    const timings=[];for(let i=0;i<100;i++){const start=performance.now();r.tokenAt(p.x,p.y);timings.push(performance.now()-start);}
    timings.sort((a,b)=>a-b);return {triangles:480000,triangleCalls,mean:timings.reduce((a,b)=>a+b,0)/timings.length,p95:timings[95],max:timings.at(-1)};
  },hex.id);
  assert.equal(profile.triangleCalls,0,'hover never raycasts uploaded triangles');assert(profile.p95<8,`picking exceeds frame budget: ${JSON.stringify(profile)}`);
  const after=await api(`${path}/map`);assert.deepEqual(after.hexes.sort((a,b)=>a.id.localeCompare(b.id)),before.hexes.sort((a,b)=>a.id.localeCompare(b.id)));assert.deepEqual(errors,[]);
  console.log(JSON.stringify(profile));
} finally {if(world)await api(`/api/worlds/${world.id}`,'DELETE');await browser.close();}

