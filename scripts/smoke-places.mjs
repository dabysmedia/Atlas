// Uses local demo markers, cleans them up, and checks that hex data stays unchanged.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.BASE_URL ?? 'http://localhost:3001', shots=process.env.SHOTS ?? './shots/places';
const dungeonName=`POI smoke dungeon ${Date.now()}`, cityName=`POI smoke major city ${Date.now()}`;
mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const page=await browser.newPage({viewport:{width:1440,height:900}}),ids=[],errors=[];
page.setDefaultTimeout(60000);
page.on('pageerror',e=>errors.push(e.message));
let world;
const api=(url,method='GET',body)=>page.evaluate(async({url,method,body})=>{
  const res=await fetch(url,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!res.ok)throw new Error(`${method} ${url}: ${res.status}`);return res.json();
},{url,method,body});
try {
  await page.goto(base);await page.locator('#u').fill('gm');await page.locator('#p').fill(process.env.ATLAS_PASS ?? 'atlas-local-playtest');
  await page.getByRole('button',{name:'Sign in'}).click();await page.waitForSelector('canvas.map');
  world=(await api('/api/worlds')).find(w=>w.name==='The Sundered Reach');assert(world);
  await page.goto(`${base}/w/${world.id}/map`);await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  const before=await api(`/api/worlds/${world.id}/map`);
  const hex=await page.evaluate(()=>{
    const r=window.__atlasMap,h=r.hexIds().find(h=>h.ground>r.seaLevel+10&&!r.tokens.some(t=>t.hexId===h.id));
    r.saved=null;r.setCamera({x:h.x,y:h.y,zoom:1.7});return h;
  });
  await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  const clickHex=async()=>{
    const p=await page.evaluate(id=>{const r=window.__atlasMap,p=r.hexScreen(id),b=r.hud.getBoundingClientRect();return {x:p.x+b.x,y:p.y+b.y}},hex.id);
    await page.mouse.click(p.x,p.y);await page.waitForFunction(id=>window.__atlasMap.selectedId===id,hex.id);
    await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  };
  await clickHex();await page.getByRole('button',{name:'Place a marker',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Place a marker'});
  const icons=await dialog.locator('canvas.marker-icon').evaluateAll(cs=>cs.map(c=>c.toDataURL()));
  assert.equal(icons.length,18);assert.equal(new Set(icons).size,18,'every type needs a distinct rendered icon');
  await page.screenshot({path:`${shots}/type-choices.png`});
  await dialog.getByRole('button',{name:'Dungeon',exact:true}).click();await dialog.getByPlaceholder('Name',{exact:true}).fill(dungeonName);
  await dialog.getByRole('button',{name:'Place',exact:true}).click();
  await page.waitForFunction(name=>window.__atlasMap.tokens.some(t=>t.name===name),dungeonName);
  const dungeon=(await api(`/api/worlds/${world.id}/map`)).tokens.find(t=>t.name===dungeonName);ids.push(dungeon.id);
  await page.getByRole('button',{name:'Close panel',exact:true}).last().click();await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  await clickHex();await page.getByRole('button',{name:'Place a marker',exact:true}).click();
  await dialog.getByRole('button',{name:'City',exact:true}).click();await dialog.getByPlaceholder('Name',{exact:true}).fill(cityName);
  await dialog.getByRole('checkbox',{name:'Major city'}).check();await dialog.getByRole('button',{name:'Place',exact:true}).click();
  await page.waitForFunction(name=>window.__atlasMap.tokens.some(t=>t.name===name),cityName);
  const city=(await api(`/api/worlds/${world.id}/map`)).tokens.find(t=>t.name===cityName);ids.push(city.id);assert.equal(city.data.majorCity,true);
  await page.getByRole('button',{name:'Close panel',exact:true}).last().click();await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  const variants=[];
  for (const [kind,name] of [['village','Smoke village'],['temple','Smoke shrine'],['outpost','Smoke outpost']]) {
    const token=await api(`/api/worlds/${world.id}/tokens`,'POST',{hexId:hex.id,kind,name});ids.push(token.id);
  }
  await page.waitForFunction(ids=>ids.every(id=>window.__atlasMap.tokens.some(t=>t.id===id)),ids);
  const tiling=[];
  for (const yaw of [0,1.6,3.2,4.8]) {
    const tiles=await page.evaluate(({hex,yaw,ids})=>{
      const r=window.__atlasMap;r.yaw=r.yawT=yaw;r.setCamera({x:hex.x,y:hex.y,zoom:1.7});r.frame(performance.now(),false);r.layoutPlaces();
      return r.placeTiles.filter(t=>ids.includes(t.token.id)).map(t=>({id:t.token.id,x:t.x,y:t.y,width:t.width,height:58+t.lines.length*14,
        top:t.y-24,bottom:t.y+34+(t.lines.length-1)*14,foot:t.gy,hit:r.tokenAt(t.x,t.y)?.id,nameHit:r.tokenAt(t.x,t.y+34)?.id}));
    },{hex,yaw,ids});
    assert.equal(tiles.length,5);assert(tiles.every(t=>t.hit===t.id&&t.nameHit===t.id&&t.bottom<t.foot));
    for (let i=0;i<tiles.length;i++) for (let j=i+1;j<tiles.length;j++) {
      const a=tiles[i],b=tiles[j];
      assert(Math.abs(a.x-b.x)>=(a.width+b.width)/2-0.01 || a.bottom<b.top || b.bottom<a.top,'same-hex labels must not overlap');
    }
    tiling.push({yaw,tiles});await page.screenshot({path:`${shots}/diamonds-orbit-${yaw}.png`});
  }
  for (const [id,nameClick] of [[dungeon.id,false],[city.id,true]]) {
    const point=await page.evaluate(({id,nameClick})=>{
      const r=window.__atlasMap;r.layoutPlaces();const tile=r.placeTiles.find(t=>t.token.id===id),b=r.hud.getBoundingClientRect();
      return {x:tile.x+b.x,y:tile.y+b.y+(nameClick?34:0)};
    },{id,nameClick});
    await page.mouse.click(point.x,point.y);await page.waitForFunction(id=>window.__atlasMap.selectedTokenId===id,id);
    await page.getByRole('button',{name:'Close panel',exact:true}).last().click();await page.waitForFunction(()=>!window.__atlasMap.cameraMoving);
  }
  for(const ratio of [3,1]) {
    variants.push(await page.evaluate(({ratio,city,dungeon})=>{
      const r=window.__atlasMap;r.setCamera({...r.fitCamera(),zoom:r.minZoom()*ratio});r.frame(performance.now(),false);
      const c=r.tokens.find(t=>t.id===city),d=r.tokens.find(t=>t.id===dungeon);r.layoutPlaces();
      const tile=r.placeTiles.find(t=>t.token.id===d.id);
      return {ratio,city:r.tokenVisibility(c),dungeon:r.tokenVisibility(d),lift:tile?tile.gy-tile.y:0,hiddenHit:tile?r.tokenAt(tile.x,tile.y)?.id===d.id:false};
    },{ratio,city:city.id,dungeon:dungeon.id}));
    await page.screenshot({path:`${shots}/${ratio===1?'overview':'exploration'}.png`});
  }
  assert.equal(variants[0].dungeon,1);assert(variants[0].lift>0);assert.equal(variants[1].dungeon,0);assert(!variants[1].hiddenHit);assert(variants.every(v=>v.city===1));
  await page.goto(`${base}/w/${world.id}/map?focus=token:${city.id}`);await page.waitForSelector('.token-panel');
  await page.getByRole('checkbox',{name:'Major city'}).uncheck();
  await page.waitForFunction(id=>window.__atlasMap.tokens.find(t=>t.id===id)?.data.majorCity===false,city.id);
  await page.reload();await page.waitForFunction(()=>window.__atlasMap?.hasGround);
  assert.equal((await api(`/api/worlds/${world.id}/map`)).tokens.find(t=>t.id===city.id).data.majorCity,false);
  await page.locator('.mode-toggle').click();await page.waitForFunction(()=>document.querySelector('.mapview').dataset.mapMode==='2d');
  const fallback=await page.evaluate(ids=>ids.every(id=>window.__atlasMap.tokenVisibility(window.__atlasMap.tokens.find(t=>t.id===id))===1),ids);assert(fallback);
  const after=await api(`/api/worlds/${world.id}/map`);assert.deepEqual(after.hexes,before.hexes);
  assert.equal(errors.length,0,errors.join('\n'));
  writeFileSync(`${shots}/results.json`,JSON.stringify({types:icons.length,uniqueIcons:new Set(icons).size,tiling,variants,persisted:true,fallback,hexesUnchanged:true},null,2));
  console.log('Place creation, icons, mode visibility, major-city persistence and 2D fallback passed');
} finally {
  for(const id of ids)await api(`/api/worlds/${world.id}/tokens/${id}`,'DELETE').catch(()=>{});
  await browser.close();
}
