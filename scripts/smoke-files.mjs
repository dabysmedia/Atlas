import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const base=process.env.BASE_URL ?? 'http://localhost:3001', shots='./shots/files'; mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}}); page.setDefaultTimeout(30000);
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const api=async (url,method='GET',body) => page.evaluate(async ({url,method,body}) => { const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})}); const v=await r.json(); if(!r.ok) throw new Error(v.error); return v; },{url,method,body});
const upload=async (url,bytes,mime) => page.evaluate(async ({url,bytes,mime}) => {const r=await fetch(url,{method:'POST',headers:{'content-type':mime},body:Uint8Array.from(bytes)}); if(!r.ok) throw new Error(await r.text()); return r.json();},{url,bytes:[...bytes],mime});
function png(width,height) {
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
  const chunk=(name,bytes)=>{const type=Buffer.from(name),out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,bytes])),out.length-4);return out;};
  const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=6;
  const pixels=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+1+x*4;pixels[i]=80;pixels[i+1]=145;pixels[i+2]=165;pixels[i+3]=255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function miniature() {
  const vertices = new Float32Array([0,1,0,-1,0,1,1,0,1, 0,1,0,1,0,1,0,0,-1, 0,1,0,0,0,-1,-1,0,1, -1,0,1,0,0,-1,1,0,1]);
  const bin = Buffer.from(vertices.buffer), doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.25, 1], metallicFactor: 0.2, roughnessFactor: 0.6 } }], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length }], accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-1,0,-1], max: [1,1,1] }] };
  let json = JSON.stringify(doc); json = json.padEnd(Math.ceil(json.length / 4) * 4, ' '); const text = Buffer.from(json), out = Buffer.alloc(28 + text.length + bin.length);
  out.write('glTF'); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(text.length,12); out.writeUInt32LE(0x4e4f534a,16); text.copy(out,20); out.writeUInt32LE(bin.length,20+text.length); out.writeUInt32LE(0x004e4942,24+text.length); bin.copy(out,28+text.length); return out;
}
let world;
try {
  await page.goto(base); await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForSelector('canvas.map');
  world=await api('/api/worlds','POST',{name:`Files QA ${Date.now()}`,cols:8,rows:6});const path=`/api/worlds/${world.id}`;
  const faction=await api(`${path}/factions`,'POST',{name:'Test party',color:'#da9f48'});
  const before=await api(`${path}/map`);
  const model=await upload(`${path}/token-models?name=Accidental.glb`,miniature(),'model/gltf-binary');
  const spare=await upload(`${path}/token-models?name=Spare.glb`,miniature(),'model/gltf-binary');
  const piece=await api(`${path}/tokens`,'POST',{name:'Scout',kind:'unit',factionId:faction.id,hexId:before.hexes[0].id,modelId:model.id});
  const image=await upload(`${path}/wiki-images?name=Reference.png`,png(64,64),'image/png');
  const unused=await upload(`${path}/wiki-images?name=Unused.png`,png(64,64),'image/png');
  await api(`${path}/pages`,'POST',{title:'Test reference',content:{type:'doc',content:[{type:'paragraph',content:[{type:'image',attrs:{src:image.src}}]}]}});
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.evaluate(()=>{window.__filesHeldMap=window.__atlasMap;});
  await page.getByRole('button',{name:'Token drawer',exact:true}).click();await page.getByRole('link',{name:'Manage files',exact:true}).click();
  await page.getByRole('region',{name:'Uploaded files',exact:true}).waitFor();
  const row=name=>page.getByRole('article',{name,exact:true});
  await row('Accidental.glb').getByRole('img',{name:'Accidental.glb miniature preview',exact:true}).waitFor();
  await page.getByRole('button',{name:'Rename Accidental.glb',exact:true}).click();await page.getByRole('textbox',{name:'File name',exact:true}).fill('Island scout.glb');await page.getByRole('button',{name:'Save name',exact:true}).click();await row('Island scout.glb').waitFor();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Download Island scout.glb',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'Island scout.glb');
  await page.getByRole('button',{name:'Delete Island scout.glb',exact:true}).click();await page.getByRole('button',{name:'Keep file',exact:true}).click();assert.equal((await api(`${path}/map`)).tokens.find(t=>t.id===piece.id).modelId,model.id);
  assert(await page.getByRole('button',{name:'Delete Reference.png',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Delete Unused.png',exact:true}).click();await page.getByRole('button',{name:'Delete file permanently',exact:true}).click();await row('Unused.png').waitFor({state:'detached'});
  await page.getByRole('combobox',{name:'File type',exact:true}).selectOption('miniature');assert.equal(await page.locator('.file-row').count(),2);await page.getByRole('combobox',{name:'File type',exact:true}).selectOption('all');
  await page.getByRole('textbox',{name:'Search uploaded files',exact:true}).fill('scout');assert.equal(await page.locator('.file-row').count(),1);await page.getByRole('textbox',{name:'Search uploaded files',exact:true}).fill('');
  await page.screenshot({path:`${shots}/desktop-files.png`});
  await page.getByRole('button',{name:'Delete Island scout.glb',exact:true}).click();await page.getByText('1 assigned pieces will use their 2D indicators.',{exact:false}).waitFor();await page.getByRole('button',{name:'Delete file permanently',exact:true}).click();await row('Island scout.glb').waitFor({state:'detached'});
  await page.waitForFunction(id=>window.__atlasMap.tokens.find(t=>t.id===id)?.modelId===null,piece.id);
  assert(await page.evaluate(()=>window.__atlasMap===window.__filesHeldMap));
  const after=await api(`${path}/map`);assert.equal(after.tokens.find(t=>t.id===piece.id).hexId,piece.hexId);assert.deepEqual(after.hexes.sort((a,b)=>a.id.localeCompare(b.id)),before.hexes.sort((a,b)=>a.id.localeCompare(b.id)));
  await page.reload();await row('Spare.glb').waitFor();assert.equal(await row('Island scout.glb').count(),0);
  assert((await api(`${path}/files`)).some(f=>f.id===spare.id));assert(!(await api(`${path}/files`)).some(f=>f.id===model.id||f.id===unused.id));
  await page.setViewportSize({width:390,height:844});await page.getByRole('region',{name:'Uploaded files',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`${shots}/mobile-files.png`});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({preview:true,rename:true,download:true,twoStepDelete:true,usedImageProtected:true,miniatureFallback:true,mapPreserved:true,reloadPersists:true,mobile:true,errors}));
} finally {if(world)await api(`/api/worlds/${world.id}`,'DELETE');await browser.close();}
