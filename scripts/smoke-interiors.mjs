import { chromium } from 'playwright';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base=process.env.BASE_URL??'http://localhost:3001',shots='shots/interiors';mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(30000);
const request=async(p,url,method='GET',body)=>p.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error);return value;},{url,method,body});
const api=(url,method,body)=>request(page,url,method,body);
const login=async(p,user='gm',pass=process.env.ATLAS_PASS??'atlas-local-playtest')=>{await p.goto(base);await p.locator('#u').fill(user);await p.locator('#p').fill(pass);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.waitForSelector('canvas.map');};
function glb(mini=false){
  const vertices=new Float32Array(mini?[0,1,0,-1,0,1,1,0,1,0,1,0,1,0,1,0,0,-1,0,1,0,0,0,-1,-1,0,1,-1,0,1,0,0,-1,1,0,1]:[0,0,0,0,0,10,10,0,0,10,0,0,0,0,10,10,0,10]),bin=Buffer.from(vertices.buffer);
  const doc={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0,translation:[9,4,7]}],meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[.3,.5,.4,1],metallicFactor:0,roughnessFactor:1}}],buffers:[{byteLength:bin.length}],bufferViews:[{buffer:0,byteLength:bin.length}],accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3',min:[0,0,0],max:[10,0,10]}]};
  if(mini){doc.nodes[0].translation=[0,0,0];doc.accessors[0]={...doc.accessors[0],count:vertices.length/3,min:[-1,0,-1],max:[1,1,1]};}
  let json=JSON.stringify(doc);json=json.padEnd(Math.ceil(json.length/4)*4,' ');const text=Buffer.from(json),out=Buffer.alloc(28+text.length+bin.length);out.write('glTF');out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(text.length,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);out.writeUInt32LE(bin.length,20+text.length);out.writeUInt32LE(0x004e4942,24+text.length);bin.copy(out,28+text.length);return out;
}
const settled=p=>p.waitForFunction(()=>{const stage=document.querySelector('.interior-stage');return stage&&getComputedStyle(stage).opacity==='1'&&getComputedStyle(document.querySelector('canvas.map')).opacity==='0';});
let world,playerContext;
try{
  await login(page);world=await api('/api/worlds','POST',{name:`Interior QA ${Date.now()}`,cols:24,rows:18});const path=`/api/worlds/${world.id}`,before=await api(`${path}/map`),hex=before.hexes.find(h=>h.q===10&&h.r===6);
  const faction=await api(`${path}/factions`,'POST',{name:'QA players',isParty:true,color:'#d6a558'}),campaign=await api(`${path}/campaigns`,'POST',{name:'QA campaign'});
  const token=await api(`${path}/tokens`,'POST',{name:'QA party',kind:'party',mainParty:true,factionId:faction.id,hexId:hex.id,campaignId:campaign.id});
  const username=`interior-qa-${Date.now()}`;await api(`${path}/players`,'POST',{username,password:'interior-qa-password',factionId:faction.id,campaignId:campaign.id});
  await page.goto(`${base}/w/${world.id}/map?focus=hex:${hex.id}`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);await page.getByRole('button',{name:'Link interior',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByLabel('Interior name').fill('QA image room');await dialog.getByLabel('Interior columns').fill('12');await dialog.getByLabel('Interior rows').fill('10');
  const image=await sharp({create:{width:600,height:500,channels:4,background:'#59654c'}}).composite([{input:Buffer.from('<svg width="600" height="500"><rect x="65" y="65" width="470" height="370" fill="#806e53" stroke="#c5ac78" stroke-width="25"/><path d="M100 150H500M250 70V420" stroke="#453f36" stroke-width="14"/></svg>')}]).png().toBuffer();
  await dialog.getByLabel('Interior map file').setInputFiles({name:'QA room.png',mimeType:'image/png',buffer:image});await dialog.getByText('QA room.png',{exact:true}).waitFor();
  const preview=dialog.getByLabel('Interior tactical map'),b=await preview.boundingBox(),scale=Math.min((b.width-40)/60,(b.height-40)/50);
  await preview.click({position:{x:b.width/2+(3.5*5-30)*scale,y:b.height/2+(4.5*5-25)*scale}});await dialog.getByText('Entry: column 4, row 5',{exact:true}).waitFor();
  await dialog.getByLabel('Visible to players').check();await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await page.waitForFunction(async path=>(await(await fetch(`${path}/interiors`)).json()).interiors.some(i=>i.entryX===3&&i.entryY===4&&i.visibleToPlayers),path);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  let state=await api(`${path}/interiors`),imageRoom=state.interiors[0];
  // A second linked map proves the sidebar supports several interiors without another inspector.
  const modelRoom=await api(`${path}/interiors`,'POST',{hexId:hex.id,name:'QA model room',mode:'3d',cols:10,rows:10,entryX:2,entryY:3,visibleToPlayers:true});
  const upload=await page.evaluate(async({url,bytes})=>{const r=await fetch(url,{method:'PUT',headers:{'content-type':'model/gltf-binary','x-file-name':'QA room.glb'},body:Uint8Array.from(bytes)});if(!r.ok)throw Error(await r.text());return r.json();},{url:`${path}/interiors/${modelRoom.id}/asset`,bytes:[...glb()]});assert.equal(upload.version,1);
  await page.getByRole('button',{name:/QA model room Enter/}).waitFor();
  playerContext=await browser.newContext({viewport:{width:1280,height:800}});const player=await playerContext.newPage();player.on('pageerror',e=>errors.push(e.message));await login(player,username,'interior-qa-password');await player.goto(`${base}/w/${world.id}/map?focus=hex:${hex.id}`);await player.waitForFunction(()=>window.__atlasMap?.hasGround);
  await page.waitForTimeout(800);
  const worldState=await page.evaluate(()=>{const r=window.__atlasMap;window.qaWorld=r;window.qaWorldCanvas=document.querySelector('canvas.map');return {cam:{...r.cam},target:{...r.target},selected:r.selectedId};});
  await page.getByRole('button',{name:/QA image room Enter/}).click();await page.locator('.interior-shell.ready').waitFor();await player.locator('.interior-shell.ready').waitFor();
  assert.equal((await api(`${path}/interiors`)).positions[0].x,3);assert.equal((await api(`${path}/interiors`)).positions[0].y,4);
  assert(await page.evaluate(()=>window.__atlasMap===window.qaWorld&&document.querySelector('canvas.map')===window.qaWorldCanvas&&window.__atlasMap.suspended));
  assert.equal(await page.locator('.map-tools').isVisible(),false);
  const moveCell=async(p,x,y)=>{const point=await p.evaluate(({x,y})=>window.__atlasInterior.projectCell(x,y),{x,y}),bounds=await p.getByLabel('Interior tactical map',{exact:true}).boundingBox();await p.mouse.click(bounds.x+point.x,bounds.y+point.y);};
  await moveCell(player,6,5);await page.waitForFunction(async({path,tokenId})=>(await(await fetch(`${path}/interiors`)).json()).positions.some(p=>p.tokenId===tokenId&&p.x===6&&p.y===5),{path,tokenId:token.id});await page.getByRole('status').filter({hasText:'column 7, row 6'}).waitFor();
  await settled(page);await settled(player);
  await page.screenshot({path:`${shots}/image-room.png`});
  const dragPoints=await player.evaluate(()=>[window.__atlasInterior.projectCell(6,5),window.__atlasInterior.projectCell(7,6)]),dragBounds=await player.getByLabel('Interior tactical map',{exact:true}).boundingBox();await player.mouse.move(dragBounds.x+dragPoints[0].x,dragBounds.y+dragPoints[0].y);await player.mouse.down();await player.mouse.move(dragBounds.x+dragPoints[1].x,dragBounds.y+dragPoints[1].y,{steps:10});await player.mouse.up();await page.getByRole('status').filter({hasText:'column 8, row 7'}).waitFor();
  await player.reload();await player.locator('.interior-shell.ready').waitFor();await player.getByRole('status').filter({hasText:'column 8, row 7'}).waitFor();
  await player.getByRole('button',{name:'Back to world',exact:true}).click();await player.locator('.interior-shell').waitFor({state:'detached'});await page.locator('.interior-shell').waitFor({state:'detached'});
  const returned=await page.evaluate(()=>{const r=window.__atlasMap;return {same:r===window.qaWorld&&document.querySelector('canvas.map')===window.qaWorldCanvas,suspended:r.suspended,cam:{...r.cam},target:{...r.target},selected:r.selectedId};});assert(returned.same);assert.equal(returned.suspended,false);assert.deepEqual(returned.target,worldState.target);assert.equal(returned.selected,hex.id);
  const miniature=await page.evaluate(async({url,bytes})=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'model/gltf-binary'},body:Uint8Array.from(bytes)});if(!r.ok)throw Error(await r.text());return r.json();},{url:`${path}/token-models?name=QA-party.glb`,bytes:[...glb(true)]});await api(`${path}/tokens/${token.id}`,'PATCH',{modelId:miniature.id});
  await page.getByRole('button',{name:/QA model room Enter/}).click();await page.locator('.interior-shell.ready').waitFor();await player.locator('.interior-shell.ready').waitFor();
  assert(await page.evaluate(()=>!!window.__atlasInterior.scene()));
  // Translated GLB roots normalize to the same tactical coordinates used by picking.
  const projection=await page.evaluate(()=>{const s=window.__atlasInterior.scene(),p=window.__atlasInterior.projectCell(2,3);return {cell:s.cell(p.x,p.y),ground:s.ground(12.5,17.5),models:s.scene.children.filter(o=>o.type==='Group').length};});assert.deepEqual(projection.cell,{x:2,y:3});assert(Math.abs(projection.ground)<.001);
  await moveCell(page,4,4);await page.getByRole('status').filter({hasText:'column 5, row 5'}).waitFor();await player.getByRole('status').filter({hasText:'column 5, row 5'}).waitFor();
  await page.waitForFunction(id=>window.__atlasInterior.scene().miniatures.has(id),token.id);await settled(page);await settled(player);
  await page.screenshot({path:`${shots}/model-room.png`});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${shots}/mobile-model-room.png`});assert(await page.getByRole('button',{name:'Back to world',exact:true}).isVisible());
  await page.getByRole('button',{name:'Back to world',exact:true}).click();await page.locator('.interior-shell').waitFor({state:'detached'});await player.locator('.interior-shell').waitFor({state:'detached'});
  await page.route(`**/interiors/${modelRoom.id}/asset*`,route=>route.abort());
  await page.getByRole('button',{name:/QA model room Enter/}).click();await page.locator('.interior-shell.ready .interior-error').waitFor();await settled(page);
  assert(await page.getByRole('button',{name:'Back to world',exact:true}).isVisible());await page.getByRole('button',{name:'Back to world',exact:true}).click();await page.locator('.interior-shell').waitFor({state:'detached'});await player.locator('.interior-shell').waitFor({state:'detached'});await page.unroute(`**/interiors/${modelRoom.id}/asset*`);
  const previewHex=before.hexes.find(h=>h.q===12&&h.r===6),previewRoom=await api(`${path}/interiors`,'POST',{hexId:previewHex.id,name:'QA preview room',mode:'2d',cols:8,rows:8,entryX:0,entryY:0,visibleToPlayers:false});
  await page.goto(`${base}/w/${world.id}/map?focus=hex:${previewHex.id}`);await page.getByRole('button',{name:/QA preview room Preview/}).click();await page.locator('.interior-shell.ready').waitFor();await page.getByRole('button',{name:'Interior settings',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete interior',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm deletion',exact:true}).click();await page.locator('.interior-shell').waitFor({state:'detached'});await page.waitForFunction(()=>!document.querySelector('.mapview').classList.contains('interior-active')&&!window.__atlasMap.suspended);
  assert(!(await api(`${path}/interiors`)).interiors.some(i=>i.id===previewRoom.id));
  const after=await api(`${path}/map`);assert.deepEqual(after.hexes.sort((a,b)=>a.id.localeCompare(b.id)),before.hexes.sort((a,b)=>a.id.localeCompare(b.id)));assert.deepEqual(after.tokens.find(t=>t.id===token.id).trail,token.trail);assert.equal(after.tokens.find(t=>t.id===token.id).hexId,hex.id);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({editorUpload:true,clickEntry:true,multipleInteriors:true,image2D:true,model3D:true,partyMiniature:true,livePartyMovement:true,dragMovement:true,reloadRecovery:true,worldRendererRetained:true,cameraRetained:true,mobileExit:true,failedMapExit:true,previewDeletionRecovery:true,hexDataUnchanged:true,errors}));
}finally{if(world)await api(`/api/worlds/${world.id}`,'DELETE');await playerContext?.close();await browser.close();}
