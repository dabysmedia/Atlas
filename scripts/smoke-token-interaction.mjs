import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.env.BASE_URL ?? 'http://localhost:3001';
mkdirSync('shots/token-interaction', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
  const r = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await r.json(); if (!r.ok) throw Error(JSON.stringify(data)); return data;
}, { url, method, body });
function miniature() {
  const vertices = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}

const hexPoint = id => page.evaluate(id => { const r = window.__atlasMap, p = r.hexScreen(id), b = r.hud.getBoundingClientRect(); return { x: p.x + b.x, y: p.y + b.y }; }, id);
const modelPoint = id => page.evaluate(id => {
  const r = window.__atlasMap; r.layoutPieces(); const t = r.pieceTiles.find(t => t.token.id === id), b = r.hud.getBoundingClientRect(), bounds = t.modelBounds;
  for (let y = bounds.y + 2; y < bounds.y + bounds.height; y += 3) for (let x = bounds.x + 2; x < bounds.x + bounds.width; x += 3) if (r.miniatures.hit(x,y,r.viewport.w,r.viewport.h,r.camera) === id) return { x:x+b.x, y:y+b.y };
  throw Error('No model intersection');
}, id);
const inspect = id => page.evaluate(id => { const r = window.__atlasMap, o = r.miniatures.group.children.find(o => o.userData.tokenId === id); let emissive; o.traverse(mesh => { if (mesh.isMesh) emissive = mesh.material.emissive?.getHex(); }); return { y:o.position.y, rotation:o.rotation.toArray().slice(0,3), grow:o.userData.grow, emissive, neighbors:[...r.moveHexIds], hex:r.tokens.find(t => t.id === id).hexId }; }, id);
let world;
try {
  await page.goto(base); await page.locator('#u').fill('gm'); await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest'); await page.getByRole('button', { name:'Sign in' }).click(); await page.waitForSelector('canvas.map');
  world = await api('/api/worlds','POST',{name:`Interaction QA ${Date.now()}`,cols:16,rows:12}); const path=`/api/worlds/${world.id}`, before=await api(`${path}/map`);
  const origin=before.hexes.find(h=>h.q===7&&h.r===2), next=before.hexes.find(h=>h.q===8&&h.r===2), third=before.hexes.find(h=>h.q===8&&h.r===3), distant=before.hexes.find(h=>h.q===11&&h.r===2);
  const faction=await api(`${path}/factions`,'POST',{name:'Test scouts',color:'#d6b06a'});
  const token=await api(`${path}/tokens`,'POST',{name:'Swaying scout',kind:'unit',hexId:origin.id,factionId:faction.id});
  await page.goto(`${base}/w/${world.id}/map`); await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);r.saved=null;r.setCamera({x:h.cx,y:h.cy,zoom:1.5});},origin.id);
  await page.getByRole('button',{name:'Token drawer',exact:true}).click(); await page.getByRole('button',{name:'Select Swaying scout',exact:true}).click();
  await page.locator('.token-panel input[type=file]').setInputFiles({name:'scout.glb',mimeType:'model/gltf-binary',buffer:miniature()});
  await page.waitForFunction(id=>window.__atlasMap.miniatures.has(id),token.id);
  await page.getByRole('button',{name:'Close token drawer',exact:true}).click();
  await page.mouse.move(80,50); await page.waitForTimeout(800);
  const idle=await inspect(token.id); await page.waitForTimeout(700); const idle2=await inspect(token.id);
  assert(Math.abs(idle.y-idle2.y)>.01); assert.notDeepEqual(idle.rotation,idle2.rotation);
  const p=await modelPoint(token.id); await page.mouse.move(p.x,p.y); await page.waitForTimeout(450);
  const hover=await inspect(token.id); assert(hover.grow>1.1); assert.notEqual(hover.emissive,idle.emissive);
  await page.mouse.click(p.x,p.y); await page.waitForTimeout(600);
  assert.equal((await inspect(token.id)).neighbors.length,6);
  await page.screenshot({path:'shots/token-interaction/selected.png'});
  const destination=await hexPoint(next.id); await page.mouse.click(destination.x,destination.y);
  await page.waitForFunction(({id,hex})=>window.__atlasMap.tokens.find(t=>t.id===id)?.hexId===hex,{id:token.id,hex:next.id});
  await page.waitForTimeout(500);
  let state=await api(`${path}/map`); assert.equal(state.tokens.find(t=>t.id===token.id).hexId,next.id);
  let start=await modelPoint(token.id), end=await hexPoint(third.id);
  await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.mouse.move(end.x,end.y,{steps:15}); await page.mouse.up(); await page.waitForTimeout(700);
  state=await api(`${path}/map`); assert.equal(state.tokens.find(t=>t.id===token.id).hexId,third.id);
  start=await modelPoint(token.id); end=await hexPoint(distant.id);
  await page.mouse.move(start.x,start.y); await page.mouse.down(); await page.mouse.move(end.x,end.y,{steps:15}); await page.mouse.up(); await page.waitForTimeout(700);
  state=await api(`${path}/map`); assert.equal(state.tokens.find(t=>t.id===token.id).hexId,third.id,'invalid drag stays home');
  assert.deepEqual(state.tokens.find(t=>t.id===token.id).trail.map(v=>v.hexId),[origin.id,next.id,third.id]);
  assert.deepEqual(state.hexes,before.hexes); assert.deepEqual(errors,[]);
  console.log('PASS: idle bob/sway, actual model hover growth/highlight, six destinations, click move, drag move, invalid drop, saved trail, unchanged hex data');
} finally { if(world) await api(`/api/worlds/${world.id}`,'DELETE').catch(()=>{}); await browser.close(); }
