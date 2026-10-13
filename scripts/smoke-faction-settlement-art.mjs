import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const base=process.env.BASE_URL??'http://localhost:3016', shots='shots/faction-art';
mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const styles=['mendoza','dupont','qadir','nhalkesh','aelari','flesh'], types=['hamlet','village','town','city','metropolis','outpost','military_base'];
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{const r=await fetch(url,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;},{url,method,body});
let world;
try {
 await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS??'atlas-local-playtest');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForSelector('canvas.map');
 const assets=await page.evaluate(async({styles,types})=>Promise.all(styles.flatMap(style=>types.map(async type=>{const image=new Image();image.src=`/settlements/${style}/${type}.webp`;await image.decode();return {url:image.src,width:image.naturalWidth,height:image.naturalHeight};}))),{styles,types});
 assert.equal(assets.length,42);assert(assets.every(a=>a.width===512&&a.height===512));
 world=await api('/api/worlds','POST',{name:`Faction art smoke ${Date.now()}`,cols:36,rows:26});const path=`/api/worlds/${world.id}`;
 const before=await api(`${path}/map`),a=before.hexes.find(h=>h.q===16&&h.r===4),b=before.hexes.find(h=>h.q===17&&h.r===4),c=before.hexes.find(h=>h.q===18&&h.r===4);
 await api(`${path}/hexes/paint`,'POST',{hexIds:before.hexes.filter(h=>h.q>=14&&h.q<=20&&h.r>=2&&h.r<=6).map(h=>h.id),terrain:'forest'});
 const factions=[];for(const style of styles)factions.push(await api(`${path}/factions`,'POST',{name:`Art QA ${style}`,settlementArtStyle:style,color:'#b39a63'}));
 const canopy=await api(`${path}/factions`,'POST',{name:'The Canopy People',color:'#589b58'});
 let {settlement:s,token}=await api(`${path}/settlements`,'POST',{name:'Architecture test',type:'city',factionId:factions[0].id,hexIds:[a.id,b.id]});
 await api(`${path}/settlements`,'POST',{name:'Canopy homes',type:'village',factionId:canopy.id,hexIds:[c.id]});
 await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
 await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);r.saved=null;r.setCamera({x:h.cx,y:h.cy,zoom:1.4});},a.id);
 const coverage=()=>page.evaluate(()=>{const r=window.__atlasMap,ctx=r.ctx,draw=ctx.drawImage;let count=0;ctx.drawImage=function(img,...args){if(img instanceof HTMLCanvasElement&&img.width===512&&args.length===4&&args[2]===80)count++;return draw.call(this,img,...args);};try{r.updateOverlay(performance.now(),true);}finally{ctx.drawImage=draw;}return count;});
 for(let i=0;i<styles.length;i++)for(const type of types){
   s=await api(`${path}/settlements/${s.id}`,'PATCH',{revision:s.revision,factionId:factions[i].id,profile:{...s.data.profile,type}});
   const url=`/settlements/${styles[i]}/${type}.webp`;
   await page.waitForFunction(({id,url})=>{const r=window.__atlasMap;return r?.settlementArtwork.entries.get(url)?.ready&&r.tokens.find(t=>t.settlementId===id)?.kind===url.split('/').at(-1).replace('.webp','');},{id:s.id,url});
   assert.equal(await coverage(),2,`${url}: both districts draw art, Canopy draws no art`);
 }
 await api(`${path}/factions/${factions[5].id}`,'PATCH',{name:'Renamed organic faction'});
 await page.waitForFunction(id=>window.__atlasMap.factions.find(f=>f.id===id)?.name==='Renamed organic faction',factions[5].id);
 assert.equal((await api(`${path}/map`)).factions.find(f=>f.id===factions[5].id).settlementArtStyle,'flesh');
 const position=await page.evaluate(id=>{const r=window.__atlasMap,h=r.hexById(id);return r.worldToScreen(h.cx,h.cy);},b.id),box=await page.locator('canvas.map:not(.map-gl)').boundingBox();
 await page.mouse.click(box.x+position.x,box.y+position.y);await page.getByRole('button',{name:'Edit settlement',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Appearance',exact:true}).click();await page.getByText('The Flesh-Shapers architecture · Military base',{exact:true}).waitFor();
 await page.locator('button[aria-label="Use 2D ground art"] img').waitFor();
 await page.screenshot({path:`${shots}/faction-ground-art.png`});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${shots}/mobile-appearance.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({assets:42,decoded:true,automaticFactionAndType:true,multipleDistricts:true,renamePreservesStyle:true,canopyUsesTrees:true,appearancePreview:true,mobile:true,errors}));
} catch(e){await page.screenshot({path:`${shots}/failure.png`});throw e;} finally {if(world)await api(`/api/worlds/${world.id}`,'DELETE');await browser.close();}
