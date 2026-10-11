/**
 * API integration tests against a real Postgres (TEST_DATABASE_URL).
 * Each run starts from an empty schema so results don't depend on prior runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/index';
import { ensureOwner } from '../server/auth';
import { deflateSync } from 'node:zlib';
import { seedDemoWorld, upgradeDemo, DEMO_VERSION } from '../server/worlds';
import { recoverRemovedIsland, seedNewWorldOnce, upgradeNewWorldIsland, FIXES, LORE_FILE } from '../server/lore/newworld';
import { logEvent } from '../server/history';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { wikiPages, wikiLinks, mapModel, maps, appMeta, worlds } from '../server/db/schema';
import { WEATHER_KINDS, rollWeather, type WeatherKind } from '../shared/weather';
import { TOKEN_KINDS, isNotableKind } from '../shared/markers';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/atlas_test';
let app: FastifyInstance;
let cookie = '';
let db: Awaited<ReturnType<typeof buildApp>>['db'];

async function boot() {
  const built = await buildApp({ databaseUrl: URL });
  return built;
}

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as 'GET', url, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

beforeAll(async () => {
  const c = new pg.Client({ connectionString: URL });
  await c.connect();
  await c.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade;');
  await c.end();
  const built = await boot();
  app = built.app;
  db = built.db;
  await ensureOwner(built.db, 'gm', 'test-password-123');
  await seedDemoWorld(built.db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});
afterAll(async () => { await app?.close(); });

/** Run a world's clock (fast: 1 day a minute) to just past midnight, as if a screen had watched it get there. */
const pastMidnight = (id: string) =>
  db.update(worlds).set({ daylight: { hour: 23.9, speed: 'fast', at: new Date(Date.now() - 1000).toISOString() } }).where(eq(worlds.id, id));

describe('world rules and token stat sheets', () => {
  it('assigns independent sheets, switches systems without data loss, copies stats and preserves lore/hexes', async () => {
    const w=(await call('POST','/api/worlds',{name:'Sheets test',cols:4,rows:4})).body,path=`/api/worlds/${w.id}`;
    const before=(await call('GET',`${path}/map`)).body;
    const faction=(await call('POST',`${path}/factions`,{name:'Test company'})).body;
    const page=(await call('POST',`${path}/pages`,{title:'Lore remains lore'})).body;
    const t=(await call('POST',`${path}/tokens`,{name:'Test scout',kind:'character',hexId:before.hexes[0].id,factionId:faction.id,data:{sheetPageId:page.id}})).body;
    const endpoint=`${path}/tokens/${t.id}/sheet`;
    let bundle=(await call('GET',endpoint)).body;
    const pack=bundle.ruleset;
    expect(bundle.sheet.kind).toBe('character');expect(bundle.sheet.id).not.toBe(page.id);
    let result=await call('PATCH',endpoint,{rulesetId:pack.id,revision:bundle.sheet.revision,values:{hp:17,hpMax:30,dex:4,level:5,reflexRank:'2'}});
    expect(result.status).toBe(200);
    expect((await call('PATCH',endpoint,{rulesetId:pack.id,revision:bundle.sheet.revision,values:{hp:18}})).status).toBe(409);
    expect((await call('PATCH',endpoint,{rulesetId:pack.id,revision:result.body.revision,values:{ac:50}})).status).toBe(400);
    expect((await call('PATCH',endpoint,{rulesetId:pack.id,revision:result.body.revision,values:{hp:-1}})).status).toBe(400);
    const custom=(await call('POST',`${path}/rules`,{preset:'generic',name:'Another system'})).body;
    expect((await call('PUT',`${path}/rules/active`,{id:custom.id})).status).toBe(200);
    bundle=(await call('GET',endpoint)).body;expect(bundle.sheet.values.hp).toBe(0);expect(bundle.ruleset.id).toBe(custom.id);
    expect((await call('PATCH',endpoint,{rulesetId:pack.id,revision:result.body.revision,values:{hp:9}})).status).toBe(409);
    await call('PATCH',endpoint,{rulesetId:custom.id,revision:bundle.sheet.revision,values:{hp:8}});
    await call('PUT',`${path}/rules/active`,{id:pack.id});
    bundle=(await call('GET',endpoint)).body;expect(bundle.sheet.values.hp).toBe(17);
    const copy=(await call('POST',`${path}/tokens/${t.id}/deploy`,{hexId:before.hexes[1].id})).body;
    const copied=(await call('GET',`${path}/tokens/${copy.id}/sheet`)).body;
    expect(copied.sheet.values.hp).toBe(17);expect(copied.sheet.id).not.toBe(bundle.sheet.id);
    await call('PATCH',`${path}/tokens/${copy.id}/sheet`,{rulesetId:pack.id,revision:copied.sheet.revision,values:{hp:3}});
    expect((await call('GET',endpoint)).body.sheet.values.hp).toBe(17);
    await call('PUT',`${path}/rules/active`,{id:custom.id});
    expect((await call('GET',`${path}/tokens/${copy.id}/sheet`)).body.sheet.values.hp).toBe(8);
    await call('PUT',`${path}/rules/active`,{id:pack.id});
    const definition=structuredClone(pack.definition);definition.proficiency.addLevel=false;
    expect((await call('PATCH',`${path}/rules/${pack.id}`,{name:pack.name,definition,revision:pack.revision})).status).toBe(200);
    expect((await call('PATCH',`${path}/rules/${pack.id}`,{name:pack.name,definition,revision:pack.revision})).status).toBe(409);
    expect((await call('GET',`${path}/pages/${page.id}`)).body.title).toBe('Lore remains lore');
    expect((await call('GET',`${path}/map`)).body.hexes).toEqual(before.hexes);
    await app.close();const restarted=await boot();app=restarted.app;db=restarted.db;
    expect((await call('GET',endpoint)).body.sheet.values.hp).toBe(17);
  });
  it('keeps sheets, rulesets and roster references isolated between worlds', async()=>{
    const w=(await call('POST','/api/worlds',{name:'Rules isolation',cols:4,rows:4})).body,path=`/api/worlds/${w.id}`;
    const other=(await call('POST','/api/worlds',{name:'Other rules',cols:4,rows:4})).body,otherPath=`/api/worlds/${other.id}`;
    const faction=(await call('POST',`${path}/factions`,{name:'Party'})).body;
    const t=(await call('POST',`${path}/tokens`,{name:'Party',kind:'party',factionId:faction.id})).body;
    const foreign=(await call('POST',`${otherPath}/tokens`,{name:'Foreign character',kind:'character'})).body;
    const bundle=(await call('GET',`${path}/tokens/${t.id}/sheet`)).body;
    const rules=(await call('GET',`${otherPath}/rules`)).body;
    expect((await call('PUT',`${path}/rules/active`,{id:rules.activeId})).status).toBe(400);
    expect((await call('GET',`${otherPath}/tokens/${t.id}/sheet`)).status).toBe(404);
    expect((await call('PATCH',`${path}/tokens/${t.id}/sheet`,{rulesetId:bundle.ruleset.id,revision:bundle.sheet.revision,values:{members:[foreign.id]}})).status).toBe(400);
    const malformed=structuredClone(bundle.ruleset.definition);malformed.templates[0].sections[0].fields[0].formula='level';
    expect((await call('POST',`${path}/rules`,{definition:malformed})).status).toBe(400);
  });
  it('allows players to edit their visible faction sheets while protecting enemy/hidden sheets and art',async()=>{
    const w=(await call('POST','/api/worlds',{name:'Sheet access',cols:4,rows:4})).body,path=`/api/worlds/${w.id}`;
    const map=(await call('GET',`${path}/map`)).body;
    const own=(await call('POST',`${path}/factions`,{name:'Own'})).body,enemy=(await call('POST',`${path}/factions`,{name:'Enemy'})).body;
    const t=(await call('POST',`${path}/tokens`,{name:'Own character',kind:'character',hexId:map.hexes[0].id,factionId:own.id})).body;
    const hidden=(await call('POST',`${path}/tokens`,{name:'Hidden',kind:'unit',hexId:map.hexes[1].id,factionId:own.id,visibleToPlayers:false})).body;
    const foe=(await call('POST',`${path}/tokens`,{name:'Enemy',kind:'unit',hexId:map.hexes[1].id,factionId:enemy.id})).body;
    const artUpload=await app.inject({method:'POST',url:`${path}/token-portraits?name=Portrait.png`,headers:{cookie,'content-type':'image/png'},payload:png(48,48)});
    expect(artUpload.statusCode).toBe(200);const art=artUpload.json();
    await call('PATCH',`${path}/tokens/${hidden.id}`,{data:{portraitId:art.id}});
    await call('POST',`${path}/players`,{username:'sheet-player',password:'test-player-password',factionId:own.id});
    const gmCookie=cookie,login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'sheet-player',password:'test-player-password'}});cookie=String(login.headers['set-cookie']).split(';')[0];
    const endpoint=`${path}/tokens/${t.id}/sheet`,bundle=(await call('GET',endpoint)).body;
    expect((await call('PATCH',endpoint,{rulesetId:bundle.ruleset.id,revision:bundle.sheet.revision,values:{hp:10}})).status).toBe(200);
    expect((await call('GET',`${path}/tokens/${hidden.id}/sheet`)).status).toBe(404);
    expect((await call('GET',`${path}/tokens/${foe.id}/sheet`)).status).toBe(403);
    expect((await call('POST',`${path}/rules`,{preset:'generic'})).status).toBe(403);
    expect((await app.inject({method:'GET',url:`${path}/token-portraits/${art.id}`,headers:{cookie}})).statusCode).toBe(404);
    expect((await call('POST',`${endpoint}/roll`,{rulesetId:bundle.ruleset.id,field:'reflex',dc:15})).status).toBe(200);
    cookie=gmCookie;
    expect((await call('GET',endpoint)).body.sheet.values.hp).toBe(10);
    expect((await call('GET',`${path}/events`)).body.some(e=>e.kind==='sheet.roll')).toBe(true);
    expect((await call('PATCH',`${path}/files/token-art/${art.id}`,{name:'Renamed.png'})).status).toBe(200);
    expect((await call('DELETE',`${path}/files/token-art/${art.id}?confirm=delete`)).status).toBe(200);
    expect((await call('GET',`${path}/map`)).body.tokens.find(t=>t.id===hidden.id).data.portraitId).toBeUndefined();
  });
});

describe('hex interiors', () => {
  it('persists maps and tactical positions, guards concurrent movement, and leaves hex data and world trails unchanged', async () => {
    const w=(await call('POST','/api/worlds',{name:'Interior test',cols:4,rows:4})).body;
    const other=(await call('POST','/api/worlds',{name:'Interior isolation',cols:4,rows:4})).body;
    const path=`/api/worlds/${w.id}`,before=(await call('GET',`${path}/map`)).body,hexId=before.hexes[0].id;
    const faction=(await call('POST',`${path}/factions`,{name:'Test party',isParty:true})).body;
    const token=(await call('POST',`${path}/tokens`,{name:'Test party',kind:'party',mainParty:true,factionId:faction.id,hexId})).body;
    const settings={hexId,name:'Test room',mode:'2d',cols:12,rows:10,entryX:3,entryY:4,visibleToPlayers:true};
    expect((await call('POST',`/api/worlds/${other.id}/interiors`,settings)).status).toBe(400);
    expect((await call('POST',`${path}/interiors`,{...settings,entryX:12})).status).toBe(400);
    const i=(await call('POST',`${path}/interiors`,settings)).body,endpoint=`${path}/interiors/${i.id}`,bytes=png(240,200);
    const upload=await app.inject({method:'PUT',url:`${endpoint}/asset`,headers:{cookie,'content-type':'image/png','x-file-name':'Room.png'},payload:bytes});
    expect(upload.statusCode).toBe(200);expect(upload.json().version).toBe(1);
    expect((await call('PATCH',endpoint,{mode:'3d'})).status).toBe(400);
    expect((await app.inject({method:'GET',url:`/api/worlds/${other.id}/interiors/${i.id}/asset`,headers:{cookie}})).statusCode).toBe(404);
    expect((await call('PATCH',`${path}/files/interior/${i.id}`,{name:'Renamed room.png'})).status).toBe(200);
    expect((await call('GET',`${path}/interiors`)).body.interiors[0].asset.name).toBe('Renamed room.png');
    const entered=await call('POST',`${endpoint}/enter`,{tokenId:token.id});
    expect(entered.status).toBe(200);expect(entered.body).toMatchObject({x:3,y:4,revision:1});
    expect((await call('POST',`${endpoint}/enter`,{tokenId:token.id})).status).toBe(409);
    expect((await call('DELETE',`${endpoint}?confirm=delete`)).status).toBe(409);
    expect((await call('PATCH',endpoint,{cols:3,entryX:1})).status).toBe(409);
    expect((await call('PATCH',`${path}/tokens/${token.id}`,{hexId:before.hexes[1].id})).status).toBe(400);
    expect((await call('POST',`${path}/tokens/${token.id}/move`,{path:[before.hexes[1].id],from:hexId})).body.error).toBe('Leave the interior before moving on the world map.');
    expect((await call('POST',`${endpoint}/move`,{tokenId:token.id,x:12,y:0,revision:1})).status).toBe(400);
    const movements=await Promise.all([call('POST',`${endpoint}/move`,{tokenId:token.id,x:5,y:6,revision:1}),call('POST',`${endpoint}/move`,{tokenId:token.id,x:7,y:8,revision:1})]);
    expect(movements.map(r=>r.status).sort()).toEqual([200,409]);
    const moved=movements.find(r=>r.status===200)!.body;
    await app.close();const restarted=await boot();app=restarted.app;db=restarted.db;
    const persisted=(await call('GET',`${path}/interiors`)).body;
    expect(persisted.positions).toEqual([moved]);expect(persisted.interiors[0].asset.name).toBe('Renamed room.png');
    expect((await app.inject({method:'GET',url:`${endpoint}/asset`,headers:{cookie}})).rawPayload).toEqual(bytes);
    expect((await call('POST',`${endpoint}/leave`,{tokenId:token.id,revision:1})).status).toBe(409);
    expect((await call('POST',`${endpoint}/leave`,{tokenId:token.id,revision:2})).status).toBe(200);
    expect((await call('GET',`${path}/interiors`)).body.positions).toEqual([]);
    const after=(await call('GET',`${path}/map`)).body;
    expect(after.hexes).toEqual(before.hexes);expect(after.tokens.find((t:{id:string})=>t.id===token.id)).toMatchObject({hexId,trail:token.trail});
    expect((await call('GET',`${path}/events`)).body.filter((e:{kind:string})=>e.kind.startsWith('interior.')).map((e:{kind:string})=>e.kind).sort()).toEqual(['interior.entered','interior.left','interior.moved']);
    expect((await call('DELETE',endpoint)).status).toBe(400);
    expect((await call('DELETE',`${endpoint}?confirm=delete`)).status).toBe(200);
    expect((await call('GET',`${path}/files`)).body).toEqual([]);
    await call('DELETE',path);await call('DELETE',`/api/worlds/${other.id}`);
  });
  it('restricts hidden interiors, assets and other parties while allowing a player to move and leave their own party',async()=>{
    const w=(await call('POST','/api/worlds',{name:'Interior permission test',cols:4,rows:4})).body,path=`/api/worlds/${w.id}`;
    const map=(await call('GET',`${path}/map`)).body,hexId=map.hexes[0].id;
    const faction=(await call('POST',`${path}/factions`,{name:'Test players',isParty:true})).body,enemy=(await call('POST',`${path}/factions`,{name:'Test other party',isParty:true})).body;
    const campaign=(await call('POST',`${path}/campaigns`,{name:'Interior test campaign'})).body;
    const token=(await call('POST',`${path}/tokens`,{name:'Own party',kind:'party',mainParty:true,factionId:faction.id,hexId,campaignId:campaign.id})).body;
    const other=(await call('POST',`${path}/tokens`,{name:'Other party',kind:'party',mainParty:true,factionId:enemy.id,hexId})).body;
    await call('POST',`${path}/players`,{username:'test-interior-player',password:'test-player-123',factionId:faction.id,campaignId:campaign.id});
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'test-interior-player',password:'test-player-123'}}),pc=String(login.headers['set-cookie']).split(';')[0];
    const asPlayer=(method:string,url:string,payload?:unknown)=>app.inject({method:method as 'GET',url,headers:{cookie:pc},...(payload===undefined?{}:{payload:payload as object})});
    const i=(await call('POST',`${path}/interiors`,{hexId,name:'Hidden room',mode:'2d',cols:8,rows:8,entryX:1,entryY:2,visibleToPlayers:false})).body,ep=`${path}/interiors/${i.id}`;
    const unexplored=(await call('POST',`${path}/interiors`,{hexId:map.hexes[15].id,name:'Unexplored room',mode:'2d',cols:8,rows:8,entryX:0,entryY:0,visibleToPlayers:true})).body;
    await app.inject({method:'PUT',url:`${ep}/asset`,headers:{cookie,'content-type':'image/png'},payload:png(64,64)});
    expect((await asPlayer('GET',`${path}/interiors`)).json().interiors).toEqual([]);
    expect((await asPlayer('POST',`${path}/interiors/${unexplored.id}/enter`,{tokenId:token.id})).statusCode).toBe(403);
    expect((await asPlayer('GET',`${ep}/asset`)).statusCode).toBe(403);
    expect((await asPlayer('POST',`${ep}/enter`,{tokenId:token.id})).statusCode).toBe(403);
    expect((await asPlayer('PATCH',ep,{visibleToPlayers:true})).statusCode).toBe(403);
    await call('PATCH',ep,{visibleToPlayers:true});
    expect((await asPlayer('POST',`${ep}/enter`,{tokenId:other.id})).statusCode).toBe(403);
    expect((await asPlayer('POST',`${ep}/enter`,{tokenId:token.id})).json()).toMatchObject({x:1,y:2});
    await call('POST',`${ep}/enter`,{tokenId:other.id});
    expect((await asPlayer('GET',`${path}/interiors`)).json().positions.map((p:{tokenId:string})=>p.tokenId)).toEqual([token.id]);
    expect((await asPlayer('POST',`${ep}/move`,{tokenId:other.id,x:2,y:3,revision:1})).statusCode).toBe(403);
    await call('PATCH',ep,{visibleToPlayers:false}); // A party already inside must still be able to see the map and leave.
    expect((await asPlayer('GET',`${ep}/asset`)).statusCode).toBe(200);
    expect((await asPlayer('POST',`${ep}/move`,{tokenId:token.id,x:4,y:5,revision:1})).statusCode).toBe(200);
    expect((await asPlayer('POST',`${ep}/leave`,{tokenId:token.id,revision:2})).statusCode).toBe(200);
    expect((await asPlayer('GET',`${ep}/asset`)).statusCode).toBe(403);
    await call('DELETE',path); // World deletion cascades even with another party still inside.
  });
  it('validates 3D assets and versions replacements monotonically even after removal',async()=>{
    const w=(await call('POST','/api/worlds',{name:'Interior asset test',cols:4,rows:4})).body,path=`/api/worlds/${w.id}`,map=(await call('GET',`${path}/map`)).body;
    const i=(await call('POST',`${path}/interiors`,{hexId:map.hexes[0].id,name:'Test model room',mode:'3d',cols:10,rows:10,entryX:0,entryY:0,visibleToPlayers:false})).body,ep=`${path}/interiors/${i.id}/asset`;
    const glb=(doc:object)=>{let json=JSON.stringify(doc);json=json.padEnd(Math.ceil(json.length/4)*4,' ');const text=Buffer.from(json),out=Buffer.alloc(20+text.length);out.write('glTF');out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(text.length,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);return out;};
    const put=(payload:Buffer)=>app.inject({method:'PUT',url:ep,headers:{cookie,'content-type':'model/gltf-binary'},payload});
    const doc={asset:{version:'2.0'},buffers:[],meshes:[{primitives:[]}]};
    expect((await put(Buffer.from('bad model'))).statusCode).toBe(400);
    expect((await put(glb({...doc,buffers:{}}))).statusCode).toBe(400);
    expect((await put(glb({...doc,buffers:[{uri:'https://example.com/external.bin'}]}))).statusCode).toBe(400);
    const bytes=glb(doc);expect((await put(bytes)).json().version).toBe(1);
    expect((await call('DELETE',ep)).status).toBe(400);
    expect((await call('DELETE',`${path}/files/interior/${i.id}?confirm=delete`)).status).toBe(200);
    expect((await call('GET',`${path}/interiors`)).body.interiors[0].asset).toBeNull();
    expect((await put(bytes)).json().version).toBe(2);
    expect((await app.inject({method:'GET',url:ep,headers:{cookie}})).rawPayload).toEqual(bytes);
    await call('DELETE',path);
  });
});

describe('auth', () => {
  it('rejects anonymous API calls and bad passwords', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/worlds' });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'gm', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
  });
  it('keeps a session', async () => {
    expect((await call('GET', '/api/auth/me')).body.username).toBe('gm');
  });
});

describe('worlds', () => {
  it('keeps two worlds fully separate', async () => {
    const a = (await call('POST', '/api/worlds', { name: 'Alpha', cols: 6, rows: 5 })).body;
    const b = (await call('POST', '/api/worlds', { name: 'Beta', cols: 6, rows: 5 })).body;
    await call('POST', `/api/worlds/${a.id}/pages`, { title: 'Only in Alpha' });
    expect((await call('GET', `/api/worlds/${b.id}/pages`)).body).toHaveLength(0);
    expect((await call('GET', `/api/worlds/${b.id}/search?q=alpha`)).body).toHaveLength(0);
    // A hex from Alpha can't be edited through Beta.
    const alphaMap = (await call('GET', `/api/worlds/${a.id}/map`)).body;
    const res = await call('PATCH', `/api/worlds/${b.id}/hexes/${alphaMap.hexes[0].id}`, { terrain: 'forest' });
    expect(res.status).toBe(400);
    // Rename and delete
    expect((await call('PATCH', `/api/worlds/${a.id}`, { name: 'Alpha Prime' })).body.name).toBe('Alpha Prime');
    expect((await call('DELETE', `/api/worlds/${a.id}`)).status).toBe(200);
    expect((await call('GET', `/api/worlds/${a.id}`)).status).toBe(404);
    expect((await call('GET', `/api/worlds/${b.id}/map`)).body.hexes).toHaveLength(30);
  });
});

describe('notable places', () => {
  it('persists every place type and major-city designation without changing hexes', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Places test', cols: 4, rows: 4 })).body;
    const before = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    for (const type of TOKEN_KINDS.filter(t => isNotableKind(t.kind))) {
      const res = await call('POST', `/api/worlds/${w.id}/tokens`, {
        kind: type.kind, name: `Test ${type.label}`, hexId: before.hexes[0].id,
        data: { majorCity: type.kind === 'city', unresolved: true },
      });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe(type.kind);
      expect(res.body.data.unresolved).toBe(true);
      if (type.kind === 'city') {
        expect(res.body.data.majorCity).toBe(true);
        const edited = await call('PATCH', `/api/worlds/${w.id}/tokens/${res.body.id}`, { data: { majorCity: false, unresolved: true } });
        expect(edited.body.data).toEqual({ majorCity: false, unresolved: true });
      }
    }
    const after = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(after.hexes).toEqual(before.hexes);
    expect(after.tokens).toHaveLength(14);
    expect(after.settlements.map((s: { size: string }) => s.size).sort()).toEqual(['city', 'outpost', 'town', 'village']);
    expect((await call('POST', `/api/worlds/${w.id}/tokens`, { kind: 'unknown', name: 'No' })).status).toBe(400);
    expect((await call('POST', `/api/worlds/${w.id}/tokens`, { kind: 'city', name: 'No', data: { majorCity: 'yes' } })).status).toBe(400);
    await call('DELETE', `/api/worlds/${w.id}`);
  });
});

describe('faction pieces and player movement', () => {
  it('keeps drawers, exact ordered trails and permissions across a restart without changing hex data', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Living map test', cols: 6, rows: 4 })).body;
    const path = `/api/worlds/${w.id}`;
    const party = (await call('POST', `${path}/factions`, { name: 'Test players', isParty: true })).body;
    const enemy = (await call('POST', `${path}/factions`, { name: 'Test rival' })).body;
    const campaign = (await call('POST', `${path}/campaigns`, { name: 'Test campaign' })).body;
    const before = (await call('GET', `${path}/map`)).body;
    const route = [0, 1, 2, 3].map(q => before.hexes.find((h: { q: number; r: number }) => h.q === q && h.r === 0).id);
    const main = (await call('POST', `${path}/tokens`, { kind: 'party', name: 'Test main party', factionId: party.id, mainParty: true, hexId: route[0], campaignId: campaign.id })).body;
    const reserve = (await call('POST', `${path}/tokens`, { kind: 'unit', name: 'Test scout', factionId: party.id })).body;
    const secret = (await call('POST', `${path}/tokens`, { kind: 'unit', name: 'Secret scout', factionId: enemy.id, visibleToPlayers: false, hexId: route[0] })).body;
    const fogged = (await call('POST', `${path}/tokens`, { kind: 'unit', name: 'Unexplored rival', factionId: enemy.id, hexId: route[3] })).body;
    expect((await call('POST', `${path}/tokens`, { kind: 'party', name: 'Duplicate main', factionId: party.id, mainParty: true })).status).toBe(400);
    for (const body of [{ hexId: null }, { visibleToPlayers: false }, { mainParty: false }, { factionId: enemy.id }]) expect((await call('PATCH', `${path}/tokens/${main.id}`, body)).status).toBe(400);
    expect((await call('DELETE', `${path}/tokens/${main.id}`)).status).toBe(400);
    await call('POST', `${path}/players`, { username: 'test-piece-player', password: 'test-player-123', factionId: party.id, campaignId: campaign.id });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'test-piece-player', password: 'test-player-123' } });
    const playerCookie = String(login.headers['set-cookie']).split(';')[0];
    const asPlayer = async (method: string, url: string, body?: unknown) => {
      const response = await app.inject({ method: method as 'GET', url, headers: { cookie: playerCookie }, ...(body !== undefined ? { payload: body } : {}) });
      return { status: response.statusCode, body: response.json() };
    };
    expect((await asPlayer('GET', '/api/auth/me')).body.role).toBe('player');
    expect((await asPlayer('GET', '/api/worlds')).body.map((x: { id: string }) => x.id)).toEqual([w.id]);
    let view = (await asPlayer('GET', `${path}/map`)).body;
    expect(view.tokens.map((t: { id: string }) => t.id).sort()).toEqual([main.id, reserve.id].sort());
    expect((await asPlayer('POST', '/api/worlds', { name: 'Unauthorized' })).status).toBe(403);
    expect((await asPlayer('PATCH', `${path}/tokens/${main.id}`, { visibleToPlayers: false })).status).toBe(403);
    expect((await asPlayer('GET', `${path}/events`)).status).toBe(403);
    expect((await asPlayer('POST', `${path}/tokens/${secret.id}/deploy`, { hexId: route[0] })).status).toBe(403);
    expect((await asPlayer('POST', `${path}/tokens/${fogged.id}/deploy`, { hexId: route[0] })).status).toBe(403);
    const playerCopy = await asPlayer('POST', `${path}/tokens/${reserve.id}/deploy`, { hexId: route[0] });
    expect(playerCopy.status).toBe(200);
    expect(playerCopy.body).toMatchObject({ factionId: party.id, hexId: route[0], mainParty: false });
    expect((await asPlayer('POST', `${path}/tokens/${secret.id}/move`, { from: route[0], path: [route[1]] })).status).toBe(403);
    expect((await asPlayer('POST', `${path}/tokens/${main.id}/move`, { from: route[0], path: [route[3]] })).status).toBe(400);
    expect((await asPlayer('POST', `${path}/tokens/${main.id}/move`, { from: route[0], path: route.slice(1) })).status).toBe(200);
    expect((await asPlayer('POST', `${path}/tokens/${main.id}/move`, { from: route[0], path: [route[1]] })).status).toBe(409);
    view = (await asPlayer('GET', `${path}/map`)).body;
    expect(view.tokens.find((t: { id: string }) => t.id === main.id).trail.map((v: { hexId: string }) => v.hexId)).toEqual(route);
    expect(view.tokens.some((t: { id: string }) => t.id === fogged.id)).toBe(true);
    expect(view.tokens.some((t: { id: string }) => t.id === secret.id)).toBe(false);
    expect((await call('GET', `${path}/events?kind=token.moved`)).body.filter((e: { actor: string }) => e.actor === 'player')).toHaveLength(3);
    await app.close(); const rebooted = await boot(); app = rebooted.app; db = rebooted.db;
    const after = (await call('GET', `${path}/map`)).body;
    expect(after.hexes).toEqual(before.hexes);
    expect(after.tokens.find((t: { id: string }) => t.id === reserve.id)).toMatchObject({ factionId: party.id, hexId: null });
    expect(after.tokens.find((t: { id: string }) => t.id === main.id).trail.map((v: { hexId: string }) => v.hexId)).toEqual(route);
    await call('PATCH', `${path}/tokens/${reserve.id}`, { visibleToPlayers: false });
    expect((await asPlayer('GET', `${path}/map`)).body.tokens.some((t: { id: string }) => t.id === reserve.id)).toBe(false);
    expect((await asPlayer('GET', `${path}/map`)).body.tokens.some((t: { id: string }) => t.id === main.id)).toBe(true);
    await call('DELETE', `${path}`);
  });

  it('deploys independent copies of faction pieces and keeps the main party unique', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Repeated pieces', cols: 4, rows: 4 })).body;
    const path = `/api/worlds/${w.id}`;
    const faction = (await call('POST', `${path}/factions`, { name: 'Test faction' })).body;
    const before = (await call('GET', `${path}/map`)).body;
    const [h0, h1] = [0, 1].map(q => before.hexes.find((h: { q: number; r: number }) => h.q === q && h.r === 0).id);
    const original = (await call('POST', `${path}/tokens`, { name: 'Scouts', kind: 'unit', factionId: faction.id, color: '#123456', data: { role: 'Scouting party' }, hexId: h0 })).body;
    const sheet = (await call('POST', `${path}/pages`, { title: 'Scout sheet' })).body;
    expect((await call('PATCH', `${path}/tokens/${original.id}`, { data: { role: 'Scouting party', sheetPageId: sheet.id } })).status).toBe(200);
    const foreign = (await call('POST', '/api/worlds', { name: 'Other sheets', cols: 4, rows: 4 })).body;
    const foreignSheet = (await call('POST', `/api/worlds/${foreign.id}/pages`, { title: 'Private sheet' })).body;
    expect((await call('PATCH', `${path}/tokens/${original.id}`, { data: { sheetPageId: foreignSheet.id } })).status).toBe(400);
    await call('DELETE', `/api/worlds/${foreign.id}`);
    const copies = await Promise.all([call('POST', `${path}/tokens/${original.id}/deploy`, { hexId: h0 }), call('POST', `${path}/tokens/${original.id}/deploy`, { hexId: h0 })]);
    expect(copies.map(c => c.status)).toEqual([200, 200]);
    expect(new Set(copies.map(c => c.body.id)).size).toBe(2);
    expect(new Set(copies.map(c => c.body.name))).toEqual(new Set(['Scouts #2', 'Scouts #3']));
    for (const c of copies) expect(c.body).toMatchObject({ hexId: h0, factionId: faction.id, color: '#123456', mainParty: false, data: { role: 'Scouting party', sheetPageId: sheet.id, drawerSourceId: original.id } });
    await call('POST', `${path}/tokens/${copies[0].body.id}/move`, { from: h0, path: [h1] });
    const after = (await call('GET', `${path}/map`)).body;
    expect(after.tokens.find((t: { id: string }) => t.id === original.id).hexId).toBe(h0);
    expect(after.tokens.find((t: { id: string }) => t.id === copies[0].body.id).trail.map((v: { hexId: string }) => v.hexId)).toEqual([h0, h1]);
    expect(after.tokens.find((t: { id: string }) => t.id === copies[1].body.id).trail.map((v: { hexId: string }) => v.hexId)).toEqual([h0]);
    expect(after.hexes).toEqual(before.hexes);
    const main = (await call('POST', `${path}/tokens`, { name: 'Main', kind: 'party', factionId: faction.id, mainParty: true, hexId: h0 })).body;
    expect((await call('POST', `${path}/tokens/${main.id}/deploy`, { hexId: h1 })).status).toBe(400);
    expect((await call('POST', `${path}/tokens/${original.id}/deploy`, { hexId: faction.id })).status).toBe(400);
    await call('DELETE', path);
  });

  it('isolates miniature assets and faction/campaign assignments between worlds', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Miniature test', cols: 4, rows: 4 })).body;
    const other = (await call('POST', '/api/worlds', { name: 'Other miniature test', cols: 4, rows: 4 })).body;
    const path = `/api/worlds/${w.id}`;
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }).padEnd(96, ' '));
    const bytes = Buffer.alloc(20 + json.length); bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
    const upload = await app.inject({ method: 'POST', url: `${path}/token-models?name=test.glb`, headers: { cookie, 'content-type': 'model/gltf-binary' }, payload: bytes });
    expect(upload.statusCode).toBe(200); const model = upload.json();
    const t = (await call('POST', `${path}/tokens`, { kind: 'unit', name: 'Miniature piece', modelId: model.id })).body;
    expect(t.modelId).toBe(model.id);
    const downloaded = await app.inject({ method: 'GET', url: `${path}/token-models/${model.id}`, headers: { cookie } }); expect(downloaded.rawPayload).toEqual(bytes);
    expect((await call('POST', `/api/worlds/${other.id}/tokens`, { kind: 'unit', name: 'Foreign model', modelId: model.id })).status).toBe(400);
    const foreignFaction = (await call('POST', `/api/worlds/${other.id}/factions`, { name: 'Other faction' })).body;
    expect((await call('PATCH', `${path}/tokens/${t.id}`, { factionId: foreignFaction.id })).status).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${path}/token-models`, headers: { cookie, 'content-type': 'model/gltf-binary' }, payload: Buffer.from('Invalid') })).statusCode).toBe(400);
    await call('DELETE', path); await call('DELETE', `/api/worlds/${other.id}`);
  });
});

describe('wiki', () => {
  it('orders and moves children, rejects cycles and keeps children when a parent is deleted', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Wiki tree', cols: 4, rows: 4 })).body;
    const path = `/api/worlds/${w.id}/pages`;
    const parent = (await call('POST', path, { title: 'Faction', category: 'Factions' })).body;
    const a = (await call('POST', path, { title: 'History', parentId: parent.id })).body;
    const b = (await call('POST', path, { title: 'People', parentId: parent.id })).body;
    expect(a).toMatchObject({ parentId: parent.id, sortOrder: 0 });
    expect(b.sortOrder).toBe(1);
    expect((await call('POST', `${path}/reorder`, { parentId: parent.id, ids: [b.id, a.id] })).status).toBe(200);
    expect((await call('GET', `${path}/${b.id}`)).body.sortOrder).toBe(0);
    expect((await call('POST', `${path}/reorder`, { parentId: parent.id, ids: [a.id, a.id] })).status).toBe(400);
    expect((await call('POST', `${path}/reorder`, { parentId: parent.id, ids: [a.id] })).status).toBe(400);
    expect((await call('PATCH', `${path}/${parent.id}`, { parentId: a.id })).status).toBe(400);
    expect((await call('PATCH', `${path}/${a.id}`, { parentId: a.id })).status).toBe(400);
    const foreign = (await call('POST', '/api/worlds', { name: 'Other wiki', cols: 4, rows: 4 })).body;
    expect((await call('POST', `/api/worlds/${foreign.id}/pages`, { title: 'Foreign', parentId: parent.id })).status).toBe(404);
    expect((await call('PATCH', `${path}/${a.id}`, { parentId: null })).status).toBe(200);
    expect((await call('PATCH', `${path}/${a.id}`, { parentId: parent.id })).status).toBe(200);
    const competing = await Promise.all([
      call('PATCH', `${path}/${a.id}`, { parentId: b.id }),
      call('PATCH', `${path}/${b.id}`, { parentId: a.id }),
    ]);
    expect(competing.map(r => r.status).sort()).toEqual([200, 400]);
    // Restore siblings, then deleting their parent promotes both instead of deleting their content.
    await call('PATCH', `${path}/${a.id}`, { parentId: parent.id });
    await call('PATCH', `${path}/${b.id}`, { parentId: parent.id });
    await call('DELETE', `${path}/${parent.id}`);
    expect((await call('GET', path)).body.map((p: { parentId: string | null }) => p.parentId)).toEqual([null, null]);
    await call('DELETE', `/api/worlds/${w.id}`);
    await call('DELETE', `/api/worlds/${foreign.id}`);
  });

  it('stores inline image bytes across restarts and protects them within their world', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Wiki images', cols: 4, rows: 4 })).body;
    const path = `/api/worlds/${w.id}`, bytes = png(32, 16);
    const upload = await app.inject({ method: 'POST', url: `${path}/wiki-images`, headers: { cookie, 'content-type': 'image/png' }, payload: bytes });
    expect(upload.statusCode).toBe(200);
    const image = upload.json();
    expect(image).toMatchObject({ width: 32, height: 16 });
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Before ' }, { type: 'image', attrs: { src: image.src, alt: 'Map reference' } }, { type: 'text', text: ' after' },
    ] }] };
    const page = (await call('POST', `${path}/pages`, { title: 'Illustrated', content })).body;
    const copy = (await call('POST', `${path}/pages`, { title: 'Copy', content })).body;
    await call('DELETE', `${path}/pages/${page.id}`);
    await app.close(); const rebooted = await boot(); app = rebooted.app; db = rebooted.db;
    expect((await call('GET', `${path}/pages/${copy.id}`)).body.content).toEqual(content);
    const got = await app.inject({ method: 'GET', url: image.src, headers: { cookie } });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload).toEqual(bytes);
    expect((await app.inject({ method: 'GET', url: image.src })).statusCode).toBe(401);
    const foreign = (await call('GET', '/api/worlds')).body.find((other: { id: string }) => other.id !== w.id);
    expect((await call('GET', `/api/worlds/${foreign.id}/wiki-images/${image.id}`)).status).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${path}/wiki-images`, headers: { cookie, 'content-type': 'image/svg+xml' }, payload: Buffer.from('<svg/>') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${path}/wiki-images`, headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(10 * 1024 * 1024 + 1) })).statusCode).toBe(413);
    await call('DELETE', `/api/worlds/${w.id}`);
    expect((await call('GET', image.src)).status).toBe(404);
  });

  it('creates, links, backlinks and finds pages', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Wiki World', cols: 4, rows: 4 })).body;
    const target = (await call('POST', `/api/worlds/${w.id}/pages`, { title: 'Duke Harrow' })).body;
    const src = (await call('POST', `/api/worlds/${w.id}/pages`, { title: 'Iron Coast' })).body;
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Ruled by ' }, { type: 'wikiLink', attrs: { pageId: target.id, label: 'Duke Harrow' } },
      { type: 'text', text: ', who loathes seafarers.' },
    ] }] };
    expect((await call('PATCH', `/api/worlds/${w.id}/pages/${src.id}`, { content })).status).toBe(200);
    const t = (await call('GET', `/api/worlds/${w.id}/pages/${target.id}`)).body;
    expect(t.backlinks.map((b: { id: string }) => b.id)).toEqual([src.id]);
    const hits = (await call('GET', `/api/worlds/${w.id}/search?q=loath`)).body;
    expect(hits[0].id).toBe(src.id);
    expect((await call('GET', `/api/worlds/${w.id}/search?q=duke`)).body[0].id).toBe(target.id);
    // Duplicate titles are refused with a pointer to the existing page.
    const dup = await call('POST', `/api/worlds/${w.id}/pages`, { title: 'duke harrow' });
    expect(dup.status).toBe(409);
    expect(dup.body.page.id).toBe(target.id);
  });
});

describe('hexes', () => {
  it('persists edits across a server restart', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Persist', cols: 4, rows: 4 })).body;
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    const hex = map.hexes[4];
    await call('PATCH', `/api/worlds/${w.id}/hexes/${hex.id}`, { terrain: 'mountains', state: 'ruined', notes: 'Old watchtower' });
    await app.close();
    const rebooted = await boot();
    app = rebooted.app; db = rebooted.db;
    const again = (await call('GET', `/api/worlds/${w.id}/map`)).body.hexes.find((h: { id: string }) => h.id === hex.id);
    expect(again).toMatchObject({ terrain: 'mountains', state: 'ruined', notes: 'Old watchtower' });
  });

  it('derives control from claims and logs the change', async () => {
    const worlds = (await call('GET', '/api/worlds')).body;
    const demo = worlds.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const map = (await call('GET', `/api/worlds/${demo.id}/map`)).body;
    const f = map.factions[0];
    const free = map.hexes.find((h: { id: string }) => !map.claims.some((c: { hexId: string }) => c.hexId === h.id));
    const claims = (await call('POST', `/api/worlds/${demo.id}/claims/control`, { hexIds: [free.id], factionId: f.id })).body;
    expect(claims).toHaveLength(1);
    const events = (await call('GET', `/api/worlds/${demo.id}/events?kind=claim&limit=1`)).body;
    expect(events[0].summary).toContain(f.name);
  });
});

describe('meters', () => {
  it('records every change with cause and day, and clamps to range', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const factions = (await call('GET', `/api/worlds/${demo.id}/factions`)).body;
    const meters = (await call('GET', `/api/worlds/${demo.id}/meters`)).body;
    const morale = meters.find((m: { key: string }) => m.key === 'morale');
    const f = factions[0];
    const res = (await call('POST', `/api/worlds/${demo.id}/factions/${f.id}/meters/${morale.id}`, { delta: 500, cause: 'Miracle at the shrine' })).body;
    expect(res.value).toBe(100);
    expect(res.band.label).toBe('Inspired');
    const hist = (await call('GET', `/api/worlds/${demo.id}/factions/${f.id}/meters/${morale.id}/history`)).body;
    expect(hist[0]).toMatchObject({ newValue: 100, cause: 'Miracle at the shrine', gameDay: 142 });
    // A faction can't set another faction's signature meter.
    const other = factions[1];
    const wrong = await call('POST', `/api/worlds/${demo.id}/factions/${f.id}/meters/${other.signatureMeterId}`, { value: 10 });
    expect(wrong.status).toBe(400);
  });

  it('rolls only approved entries', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const tables = (await call('GET', `/api/worlds/${demo.id}/roll-tables`)).body;
    const t = tables[0];
    const draft = t.entries.find((e: { approved: boolean }) => !e.approved);
    expect(draft.source).toBe('ai');
    for (let i = 0; i < 40; i++) {
      const r = (await call('POST', `/api/worlds/${demo.id}/roll-tables/${t.id}/roll`, {})).body;
      expect(r.entry.approved).toBe(true);
    }
  });
});

/** A real (tiny, solid color) PNG so the upload path sees genuine image bytes. */
function png(w: number, h: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x40);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('map art', () => {
  it('uploads, covers the grid, aligns, serves and removes', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Painted', cols: 6, rows: 4 })).body;
    const bad = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.from('not an image at all, honest, just text padding') });
    expect(bad.statusCode).toBe(400);
    const img = png(300, 200);
    const up = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: img });
    expect(up.statusCode).toBe(200);
    const art = JSON.parse(up.body);
    expect(art).toMatchObject({ version: 1, width: 300, height: 200, mime: 'image/png' });
    // Covers the grid: 6 flat hexes wide is 40 * (1.5 * 5 + 2) = 380 units; the art keeps its 3:2 aspect.
    expect(art.placement.w).toBeGreaterThanOrEqual(380);
    expect(art.placement.w / art.placement.h).toBeCloseTo(1.5, 5);
    const moved = (await call('PATCH', `/api/worlds/${w.id}/map/art`, { placement: { x: 12, y: -8, opacity: 0.6 } })).body;
    expect(moved.placement).toMatchObject({ x: 12, y: -8, opacity: 0.6, w: art.placement.w });
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(map.map.art).toMatchObject({ version: 1, placement: { x: 12 } });
    const got = await app.inject({ method: 'GET', url: `/api/worlds/${w.id}/map/art?v=1`, headers: { cookie } });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(got.rawPayload, img)).toBe(0);
    const again = await app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/art`, headers: { cookie, 'content-type': 'image/png' }, payload: png(100, 100) });
    expect(JSON.parse(again.body).version).toBe(2);
    expect((await call('DELETE', `/api/worlds/${w.id}/map/art`)).status).toBe(200);
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.art).toBeNull();
    // Another world can't see this world's art.
    const other = (await call('POST', '/api/worlds', { name: 'Bare', cols: 4, rows: 4 })).body;
    expect((await app.inject({ method: 'GET', url: `/api/worlds/${other.id}/map/art`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('seeds the demo with art whose terrain matches the painting', async () => {
    const demo = (await call('GET', '/api/worlds')).body.find((x: { name: string }) => x.name === 'The Sundered Reach');
    const map = (await call('GET', `/api/worlds/${demo.id}/map`)).body;
    expect(map.map.art.width).toBeGreaterThan(1000);
    const kinds = new Set(map.hexes.map((h: { terrain: string }) => h.terrain));
    for (const k of ['deep', 'water', 'plains', 'forest', 'hills', 'mountains', 'wasteland']) expect(kinds).toContain(k);
    const cities = map.tokens.filter((t: { kind: string }) => t.kind === 'city');
    expect(cities.map((t: { name: string }) => t.name).sort()).toEqual(['Cinderhold', 'Port Halvard']);
    for (const c of cities) expect(['water', 'deep']).not.toContain(map.hexes.find((h: { id: string }) => h.id === c.hexId).terrain);
    expect(map.claims.filter((c: { kind: string }) => c.kind === 'contested').length).toBeGreaterThanOrEqual(2);
  });

  it('upgrades an untouched older demo in place and keeps an edited one', async () => {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    const fresh = await seedDemoWorld(db, { name: 'Old Demo A' });
    const edited = await seedDemoWorld(db, { name: 'Old Demo B' });
    await c.query(`update worlds set demo = 'reach-v1' where id in ($1, $2)`, [fresh.id, edited.id]);
    // Pretend both were seeded long ago, and the GM later wrote a note in B.
    await c.query(`alter table events disable trigger user`);
    await c.query(`update events set created_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table events enable trigger user`);
    await c.query(`update hexes set updated_at = now() - interval '2 days' from maps where maps.id = hexes.map_id and maps.world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`update wiki_pages set updated_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table meter_changes disable trigger user`);
    await c.query(`update meter_changes set created_at = now() - interval '2 days' where world_id in ($1, $2)`, [fresh.id, edited.id]);
    await c.query(`alter table meter_changes enable trigger user`);
    await c.query(`update worlds set created_at = now() - interval '2 days', updated_at = now() - interval '2 days' where id in ($1, $2)`, [fresh.id, edited.id]);
    await call('POST', `/api/worlds/${edited.id}/events`, { summary: 'The GM was here' });
    const notes = await upgradeDemo(db);
    expect(notes).toHaveLength(2);
    const rows = (await c.query(`select name, demo from worlds where name like 'Old Demo%' order by name`)).rows;
    await c.end();
    expect(rows).toEqual([
      { name: 'Old Demo A', demo: DEMO_VERSION },
      { name: 'Old Demo B', demo: 'reach-v1-kept' },
      { name: 'Old Demo B (painted)', demo: DEMO_VERSION },
    ]);
    expect(await upgradeDemo(db)).toHaveLength(0);
  });
});

describe('lore import', () => {
  it('imports The New World as linked pages, seven factions and an unclaimed island, and can be re-imported', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'The New World', template: 'newworld' })).body;
    const pages = await db.select().from(wikiPages).where(eq(wikiPages.worldId, w.id));
    const byTitle = new Map(pages.map((p) => [p.title, p]));
    for (const title of ['The New World', 'Core Setting', 'Geography of the Island', 'Casa de Mendoza', 'Company DuPont', 'The Qadir Ascendancy',
      'The Nhal’Kesh', 'The Flesh-Shapers', 'The Aelari', 'The Canopy People', 'The Mage City Within the Mountain', 'The Precursor Mages',
      'Still Intentionally Unresolved', 'Open Questions / Co-DM Discussion']) expect(byTitle.has(title), title).toBe(true);

    // Every line of the source lands on a page, word for word (bar the listed repairs).
    const norm = (x: string) => x.replace(/[^\p{L}\p{N}]+/gu, '');
    const all = norm(pages.map((p) => p.contentText).join('\n'));
    const src = readFileSync(new globalThis.URL(`../server/assets/lore/${LORE_FILE}`, import.meta.url), 'utf8').split('\n');
    const missing = src.map((l, i) => ({ n: i + 1, text: (FIXES[i + 1] ? l.replace(FIXES[i + 1].from, FIXES[i + 1].to) : l).replace(/^#+\s*/, '').replace(/\*+$/, '').trim() }))
      .filter((l) => l.text && !all.includes(norm(l.text)));
    expect(missing).toEqual([]);

    // Open matters say so on the page rather than reading as canon.
    expect(byTitle.get('Still Intentionally Unresolved')!.contentText).toMatch(/Open by design/);
    expect(byTitle.get('The Canopy People')!.contentText).toMatch(/Unfinished in the source/);
    expect(byTitle.get('Open Questions / Co-DM Discussion')!.contentText).toMatch(/Discussion, not canon/);
    expect(byTitle.get('Core Setting')!.contentText).toMatch(/Unresolved in the source/);

    // Names link to their pages.
    const links = await db.select().from(wikiLinks).where(eq(wikiLinks.fromPageId, byTitle.get('The Flesh-Shapers')!.id));
    expect(links.map((l) => l.toPageId)).toContain(byTitle.get('The Nhal’Kesh')!.id);
    // A link keeps the source's wording ("College of Mages") rather than the target's title.
    expect(byTitle.get('Established Facts About the Precursor City')!.contentText).toContain('an apolitical College of Mages rather than');
    expect(JSON.stringify(byTitle.get('Established Facts About the Precursor City')!.content)).toContain('"text":"College of Mages"');

    const meters = (await call('GET', `/api/worlds/${w.id}/meters`)).body as { id: string; name: string; kind: string }[];
    const fs = (await call('GET', `/api/worlds/${w.id}/factions`)).body as { name: string; signatureMeterId: string; sigil: string; meters?: unknown }[];
    const sig = Object.fromEntries(fs.map((f) => [f.name, meters.find((m) => m.id === f.signatureMeterId)?.name]));
    expect(sig).toEqual({
      'Casa de Mendoza': 'Zeal', 'Company DuPont': 'Grandeur', 'The Qadir Ascendancy': 'Attunement', 'The Nhal’Kesh': 'Vigil',
      'The Flesh-Shapers': 'Transcendence', 'The Aelari': 'Communion', 'The Canopy People': 'Provisional',
    });
    expect(meters.filter((m) => m.kind !== 'signature').map((m) => m.name).sort()).toEqual(['Morale', 'Treasury']);

    // The island is painted terrain with nothing claimed or settled.
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(map.hexes.length).toBe(48 * 32);
    const terrains = new Set(map.hexes.map((h: { terrain: string }) => h.terrain));
    for (const k of ['deep', 'water', 'jungle', 'mountains']) expect(terrains.has(k)).toBe(true);
    expect(map.claims ?? []).toEqual([]);
    expect(map.tokens ?? []).toEqual([]);

    // Deletable, and importing again gives a fresh copy.
    expect((await call('DELETE', `/api/worlds/${w.id}`)).status).toBe(200);
    const again = (await call('POST', '/api/worlds', { name: 'The New World', template: 'newworld' })).body;
    expect((await call('GET', `/api/worlds/${again.id}/factions`)).body).toHaveLength(7);
  });

  it('seeds once on boot and stays deleted after the owner removes it', async () => {
    const note = await seedNewWorldOnce(db);
    expect(note).toMatch(/imported/);
    const list = (await call('GET', '/api/worlds')).body as { id: string; name: string }[];
    const seeded = list.find((x) => x.name === 'The New World')!;
    await call('DELETE', `/api/worlds/${seeded.id}`);
    expect(await seedNewWorldOnce(db)).toBeNull();
  });
});

describe('3D map', () => {
  it('stores a terrain model per map: validates, serves cached, places and removes', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Modelled', cols: 8, rows: 6 })).body;
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.model).toBeNull();
    const put = (payload: Buffer, name = 'isle.glb') => app.inject({ method: 'PUT', url: `/api/worlds/${w.id}/map/model`, headers: { cookie, 'content-type': 'model/gltf-binary', 'x-file-name': name }, payload });
    expect((await put(Buffer.from('definitely not a binary gltf file, just text'))).statusCode).toBe(400);
    const glb = Buffer.alloc(64);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(64, 8);
    const up = await put(glb);
    expect(up.statusCode).toBe(200);
    const meta = JSON.parse(up.body);
    expect(meta).toMatchObject({ version: 1, name: 'isle.glb', size: 64 });
    // Placed as the largest square centred on the grid, at natural height.
    expect(meta.placement.w).toBeCloseTo(meta.placement.h, 6);
    expect(meta.placement.heightScale).toBe(1);
    const got = await app.inject({ method: 'GET', url: `/api/worlds/${w.id}/map/model?v=1`, headers: { cookie } });
    expect(got.headers['content-type']).toBe('model/gltf-binary');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(got.rawPayload, glb)).toBe(0);
    const moved = (await call('PATCH', `/api/worlds/${w.id}/map/model`, { placement: { heightScale: 0.6 } })).body;
    expect(moved.placement).toMatchObject({ heightScale: 0.6, w: meta.placement.w });
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.model).toMatchObject({ version: 1, placement: { heightScale: 0.6 } });
    expect(JSON.parse((await put(glb, 'v2.glb')).body).version).toBe(2);
    expect((await call('DELETE', `/api/worlds/${w.id}/map/model`)).status).toBe(200);
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.model).toBeNull();
    // Removed and replaced models are archived, newest first, and can be put back.
    const arch = (await call('GET', `/api/worlds/${w.id}/map/model/archive`)).body as { id: string; name: string; reason: string; version: number }[];
    expect(arch.map((a) => [a.name, a.reason, a.version])).toEqual([['v2.glb', 'removed', 2], ['isle.glb', 'replaced', 1]]);
    const back = (await call('POST', `/api/worlds/${w.id}/map/model/archive/${arch[1].id}/restore`)).body;
    expect(back).toMatchObject({ name: 'isle.glb', version: 3, placement: { heightScale: 0.6 } });
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.model).toMatchObject({ name: 'isle.glb', version: 3 });
    expect((await call('GET', `/api/worlds/${w.id}/map/model/archive`)).body).toHaveLength(1);
    expect((await call('POST', `/api/worlds/${w.id}/map/model/archive/${arch[1].id}/restore`)).status).toBe(404);
    // Hexes are untouched by any of it.
    expect((await call('GET', `/api/worlds/${w.id}/map`)).body.hexes).toHaveLength(48);
  });

  it('gives The New World its island model, with hexes read from it', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Isle check', template: 'newworld' })).body;
    const map = (await call('GET', `/api/worlds/${w.id}/map`)).body;
    expect(map.map.model).toMatchObject({ version: 1 });
    expect(map.map.model.size).toBeLessThan(8e6);
    const terrain = JSON.parse(readFileSync(new globalThis.URL('../server/assets/lore/new-world-terrain.json', import.meta.url), 'utf8'));
    const counts = (xs: string[]) => xs.reduce((m: Record<string, number>, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
    expect(counts(map.hexes.map((h: { terrain: string }) => h.terrain))).toEqual(counts(terrain.terrain));
  });

  it('upgrades an already imported New World: adds the model, re-reads untouched hexes, keeps edited ones', async () => {
    const strip = async (worldId: string) => {
      const [m] = await db.select().from(maps).where(eq(maps.worldId, worldId));
      await db.delete(mapModel).where(eq(mapModel.mapId, m.id));
      await db.delete(appMeta).where(eq(appMeta.key, `upgrade:island-model:${worldId}`));
    };
    const a = (await call('POST', '/api/worlds', { name: 'Old import', template: 'newworld' })).body;
    const b = (await call('POST', '/api/worlds', { name: 'Old edited import', template: 'newworld' })).body;
    const hexB = (await call('GET', `/api/worlds/${b.id}/map`)).body.hexes[0];
    await call('POST', `/api/worlds/${b.id}/hexes/paint`, { hexIds: [hexB.id], terrain: 'desert' });
    await strip(a.id); await strip(b.id);
    const notes = await upgradeNewWorldIsland(db);
    expect(notes.some((n) => n.includes(a.id) && n.includes('re-read'))).toBe(true);
    expect(notes.some((n) => n.includes(b.id) && n.includes('kept'))).toBe(true);
    for (const w of [a, b]) expect((await call('GET', `/api/worlds/${w.id}/map`)).body.map.model).not.toBeNull();
    expect((await call('GET', `/api/worlds/${b.id}/map`)).body.hexes.find((h: { id: string }) => h.id === hexB.id).terrain).toBe('desert');
    expect(await upgradeNewWorldIsland(db)).toEqual([]);
  });

  it('recovers an island removed before models were archived, once', async () => {
    const oldRemove = async (worldId: string) => {
      const [m] = await db.select().from(maps).where(eq(maps.worldId, worldId));
      await db.delete(mapModel).where(eq(mapModel.mapId, m.id));
      await logEvent(db, { worldId, kind: 'map.model', summary: 'Removed the 3D terrain model' });
    };
    const a = (await call('POST', '/api/worlds', { name: 'Lost island', template: 'newworld' })).body;
    const b = (await call('POST', '/api/worlds', { name: 'Lost then replaced', template: 'newworld' })).body;
    const c = (await call('POST', '/api/worlds', { name: 'Never lost', template: 'newworld' })).body;
    await oldRemove(a.id); await oldRemove(b.id);
    const glb = Buffer.alloc(64); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(64, 8);
    await app.inject({ method: 'PUT', url: `/api/worlds/${b.id}/map/model`, headers: { cookie, 'content-type': 'model/gltf-binary', 'x-file-name': 'mine.glb' }, payload: glb });
    const notes = await recoverRemovedIsland(db);
    expect(notes.some((n) => n.includes(a.id) && n.includes('back'))).toBe(true);
    expect(notes.some((n) => n.includes(b.id) && n.includes('archive'))).toBe(true);
    expect(notes.some((n) => n.includes(c.id))).toBe(false);
    expect((await call('GET', `/api/worlds/${a.id}/map`)).body.map.model).toMatchObject({ name: 'island.glb' });
    expect((await call('GET', `/api/worlds/${b.id}/map`)).body.map.model).toMatchObject({ name: 'mine.glb' });
    expect((await call('GET', `/api/worlds/${b.id}/map/model/archive`)).body.map((x: { name: string }) => x.name)).toContain('island.glb');
    expect(await recoverRemovedIsland(db)).toEqual([]);
  });

  it('keeps the time of day per world, and a running clock rolls the day over once', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Clockwork', cols: 4, rows: 4 })).body;
    const fresh = (await call('GET', `/api/worlds/${w.id}`)).body;
    expect(fresh.daylight).toMatchObject({ speed: 'paused' });
    const set = (await call('PATCH', `/api/worlds/${w.id}/daylight`, { hour: 20, speed: 'fast' })).body.daylight;
    expect(set).toMatchObject({ hour: 20, speed: 'fast' });
    const other = (await call('POST', '/api/worlds', { name: 'Other clock', cols: 4, rows: 4 })).body;
    expect((await call('GET', `/api/worlds/${other.id}`)).body.daylight.speed).toBe('paused');
    const day = fresh.currentDay;
    // A stale tab asking to roll over from a day that's already gone changes nothing, and neither does one asking before midnight.
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day - 1 } })).body.currentDay).toBe(day);
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body).toMatchObject({ currentDay: day, daylight: { hour: 20 } });
    await pastMidnight(w.id);
    const rolled = (await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body;
    expect(rolled.currentDay).toBe(day + 1);
    expect(rolled.daylight.hour).toBeGreaterThan(0.3);
    expect(rolled.daylight.hour).toBeLessThan(1);
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body.currentDay).toBe(day + 1);
    const evs = (await call('GET', `/api/worlds/${w.id}/events`)).body as { kind: string; actor: string }[];
    expect(evs.filter((e) => e.kind === 'day.changed' && e.actor === 'system')).toHaveLength(1);
  });

  it('ignores a midnight asked for by a screen that missed the clock being paused', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Paused clock', cols: 4, rows: 4 })).body;
    const day = (await call('GET', `/api/worlds/${w.id}`)).body.currentDay as number;
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'rain', auto: true });
    // Paused at 08:00 (the stale screen still thinks it is running toward midnight).
    await call('PATCH', `/api/worlds/${w.id}/daylight`, { hour: 8, speed: 'paused' });
    const r = (await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body;
    expect(r).toMatchObject({ currentDay: day, daylight: { hour: 8, speed: 'paused' }, weather: { kind: 'rain', day } });
    // Paused a moment before midnight is the same.
    await call('PATCH', `/api/worlds/${w.id}/daylight`, { hour: 23.99 });
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body).toMatchObject({ currentDay: day, daylight: { hour: 23.99, speed: 'paused' } });
    const after = (await call('GET', `/api/worlds/${w.id}`)).body;
    expect(after).toMatchObject({ currentDay: day, daylight: { hour: 23.99, speed: 'paused' }, weather: { kind: 'rain', day } });
    const evs = (await call('GET', `/api/worlds/${w.id}/events`)).body as { kind: string }[];
    expect(evs.filter((e) => e.kind === 'day.changed')).toHaveLength(0);
    expect(evs.filter((e) => e.kind === 'weather.changed')).toHaveLength(1);
  });

  it('starts the next day when the clock is paused just after midnight, before any screen asked', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Late pause', cols: 4, rows: 4 })).body;
    const day = (await call('GET', `/api/worlds/${w.id}`)).body.currentDay as number;
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'fog', auto: true });
    await pastMidnight(w.id);
    const r = (await call('PATCH', `/api/worlds/${w.id}/daylight`, { speed: 'paused' })).body;
    expect(r).toMatchObject({ currentDay: day + 1, daylight: { speed: 'paused' }, weather: { auto: true, day: day + 1 } });
    expect(r.daylight.hour).toBeGreaterThan(0.3);
    expect(r.daylight.hour).toBeLessThan(1);
    expect((await call('GET', `/api/worlds/${w.id}`)).body).toMatchObject({ currentDay: day + 1, weather: r.weather });
    // The screen that saw midnight asks too late, and changes nothing.
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body.currentDay).toBe(day + 1);
    const evs = (await call('GET', `/api/worlds/${w.id}/events`)).body as { kind: string; actor: string; gameDay: number }[];
    expect(evs.filter((e) => e.kind === 'day.changed')).toMatchObject([{ actor: 'system', gameDay: day + 1 }]);
    expect(evs.filter((e) => e.kind === 'weather.changed')[0]).toMatchObject({ actor: 'system', gameDay: day + 1 });

    // A speed change does the same; setting the hour by hand places the clock without starting a day.
    await pastMidnight(w.id);
    expect((await call('PATCH', `/api/worlds/${w.id}/daylight`, { speed: 'slow' })).body).toMatchObject({ currentDay: day + 2, daylight: { speed: 'slow' } });
    await pastMidnight(w.id);
    expect((await call('PATCH', `/api/worlds/${w.id}/daylight`, { hour: 6 })).body).toMatchObject({ currentDay: day + 2, daylight: { hour: 6, speed: 'fast' } });
  });
});

describe('weather', () => {
  type Ev = { kind: string; summary: string; payload: Record<string, unknown>; actor: string; gameDay: number };
  const weatherEvents = async (id: string) => (await call('GET', `/api/worlds/${id}/events?kind=weather`)).body as Ev[];

  it('starts fair, is set by hand with a chronicle line, and toggles auto quietly', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Stormy', cols: 4, rows: 4 })).body;
    const fresh = (await call('GET', `/api/worlds/${w.id}`)).body;
    expect(fresh.weather).toMatchObject({ kind: 'fair', auto: false, day: fresh.currentDay });
    // Filled once and kept, not made up again on every read.
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather.at).toBe(fresh.weather.at);
    const other = (await call('POST', '/api/worlds', { name: 'Calm', cols: 4, rows: 4 })).body;

    const set = await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'thunderstorm' });
    expect(set.status).toBe(200);
    expect(set.body.weather).toMatchObject({ kind: 'thunderstorm', auto: false, day: fresh.currentDay });
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather.kind).toBe('thunderstorm');
    expect((await call('GET', `/api/worlds/${other.id}`)).body.weather.kind).toBe('fair');
    const evs = await weatherEvents(w.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'weather.changed', summary: 'A thunderstorm rolls in', actor: 'gm', gameDay: fresh.currentDay, payload: { from: 'fair', to: 'thunderstorm' } });
    // Clearing after rain reads as the rain passing.
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'clear' });
    expect((await weatherEvents(w.id))[0].summary).toBe('The rain passes and the skies clear');

    // Picking the same kind again, or switching auto, changes no weather and logs nothing.
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'clear' });
    const auto = (await call('PATCH', `/api/worlds/${w.id}/weather`, { auto: true })).body.weather;
    expect(auto).toMatchObject({ kind: 'clear', auto: true });
    expect((await call('PATCH', `/api/worlds/${w.id}/weather`, { auto: false })).body.weather.auto).toBe(false);
    expect(await weatherEvents(w.id)).toHaveLength(2);

    // Two changes sent together (a kind picked, auto switched on) both land.
    await Promise.all([call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'gale' }), call('PATCH', `/api/worlds/${w.id}/weather`, { auto: true })]);
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather).toMatchObject({ kind: 'gale', auto: true });
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'clear', auto: false });
    expect(await weatherEvents(w.id)).toHaveLength(4);

    expect((await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'blizzard' })).status).toBe(400);
    expect((await call('PATCH', `/api/worlds/${w.id}/weather`, { auto: 'yes' })).status).toBe(400);
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather.kind).toBe('clear');
  });

  it('rolls today\'s weather on request', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Dice weather', cols: 4, rows: 4 })).body;
    const { currentDay } = (await call('GET', `/api/worlds/${w.id}`)).body;
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'fog' });
    const rolled = await call('POST', `/api/worlds/${w.id}/weather/roll`);
    expect(rolled.status).toBe(200);
    expect(WEATHER_KINDS).toContain(rolled.body.weather.kind);
    expect(rolled.body.weather).toMatchObject({ auto: false, day: currentDay });
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather.kind).toBe(rolled.body.weather.kind);
    const [ev] = await weatherEvents(w.id);
    expect(ev).toMatchObject({ actor: 'gm', gameDay: currentDay, payload: { from: 'fog', to: rolled.body.weather.kind, rolled: true } });
    expect(ev.summary.length).toBeGreaterThan(5);

    // A roll that comes up the same keeps the sky as it is, and says it holds (not 'another day' of it).
    const same = rolled.body.weather as { kind: WeatherKind; at: string };
    const hit = Array.from({ length: 1000 }, (_, i) => i / 1000).find((v) => rollWeather(same.kind, () => v) === same.kind)!;
    vi.spyOn(Math, 'random').mockReturnValueOnce(hit);
    const again = (await call('POST', `/api/worlds/${w.id}/weather/roll`)).body.weather;
    expect(again).toEqual(same);
    const [held] = await weatherEvents(w.id);
    expect(held).toMatchObject({ payload: { from: same.kind, to: same.kind, rolled: true } });
    expect(held.summary).not.toMatch(/again|Another/);
    vi.restoreAllMocks();
  });

  it('rolls new weather when a new day begins under auto weather, once', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Seasons', cols: 4, rows: 4 })).body;
    const day = (await call('GET', `/api/worlds/${w.id}`)).body.currentDay as number;
    await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'rain', auto: true });
    const before = (await call('GET', `/api/worlds/${w.id}`)).body.weather;

    // Several days at once roll once, for the day the clock lands on.
    const adv = (await call('POST', `/api/worlds/${w.id}/day`, { advance: 3 })).body;
    expect(adv.currentDay).toBe(day + 3);
    expect(adv.weather).toMatchObject({ auto: true, day: day + 3 });
    expect(adv.weather.at).not.toBe(before.at);
    expect(WEATHER_KINDS).toContain(adv.weather.kind);
    expect((await call('GET', `/api/worlds/${w.id}`)).body.weather).toEqual(adv.weather);
    let evs = await weatherEvents(w.id);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ actor: 'gm', gameDay: day + 3, payload: { from: 'rain', to: adv.weather.kind, rolled: true } });

    // Midnight on a running clock rolls too, as the system; a second tab asking for the same midnight doesn't.
    await pastMidnight(w.id);
    const [a, b] = await Promise.all([
      call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day + 3 } }),
      call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day + 3 } }),
    ]);
    expect(a.body.currentDay).toBe(day + 4);
    expect(b.body.currentDay).toBe(day + 4);
    const rolled = (await call('GET', `/api/worlds/${w.id}`)).body.weather;
    expect(rolled.day).toBe(day + 4);
    expect(a.body.weather).toEqual(rolled);
    expect(b.body.weather).toEqual(rolled);
    evs = await weatherEvents(w.id);
    expect(evs).toHaveLength(3);
    expect(evs[0]).toMatchObject({ actor: 'system', gameDay: day + 4, payload: { from: adv.weather.kind, to: rolled.kind, rolled: true } });
    const days = ((await call('GET', `/api/worlds/${w.id}/events?kind=day`)).body as Ev[]).filter((e) => e.actor === 'system');
    expect(days).toHaveLength(1);
    // A stale rollover still answers with the weather.
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day } })).body.weather).toEqual(rolled);

    // Going back a day keeps today's weather, and so does coming forward again to the day it was rolled for.
    for (let i = 0; i < 3; i++) {
      const back = (await call('POST', `/api/worlds/${w.id}/day`, { advance: -1 })).body;
      expect(back.currentDay).toBe(day + 3);
      expect(back.weather).toEqual(rolled);
      const fwd = (await call('POST', `/api/worlds/${w.id}/day`, { advance: 1 })).body;
      expect(fwd.currentDay).toBe(day + 4);
      expect(fwd.weather).toEqual(rolled);
    }
    expect(await weatherEvents(w.id)).toHaveLength(3);
    // Back two days and forward three reaches a day with no weather yet: that one rolls.
    await call('POST', `/api/worlds/${w.id}/day`, { day: day + 2 });
    expect((await call('POST', `/api/worlds/${w.id}/day`, { advance: 3 })).body.weather).toMatchObject({ day: day + 5 });
    expect(await weatherEvents(w.id)).toHaveLength(4);
  });

  it('keeps the weather across days when auto is off', async () => {
    const w = (await call('POST', '/api/worlds', { name: 'Doldrums', cols: 4, rows: 4 })).body;
    const day = (await call('GET', `/api/worlds/${w.id}`)).body.currentDay as number;
    const set = (await call('PATCH', `/api/worlds/${w.id}/weather`, { kind: 'overcast' })).body.weather;
    const next = (await call('POST', `/api/worlds/${w.id}/day`, { advance: 1 })).body;
    expect(next.currentDay).toBe(day + 1);
    expect(next.weather).toEqual(set);
    const later = (await call('POST', `/api/worlds/${w.id}/day`, { day: day + 10 })).body;
    expect(later.weather).toEqual(set);
    await pastMidnight(w.id);
    expect((await call('POST', `/api/worlds/${w.id}/day`, { rollover: { from: day + 10 } })).body).toMatchObject({ currentDay: day + 11, weather: set });
    expect(await weatherEvents(w.id)).toHaveLength(1);

    // Switched on later, the sky as it stands is today's: a day back and forward again keeps it, the next new day rolls.
    expect((await call('PATCH', `/api/worlds/${w.id}/weather`, { auto: true })).body.weather).toMatchObject({ kind: 'overcast', auto: true, day: day + 11 });
    expect((await call('POST', `/api/worlds/${w.id}/day`, { advance: -1 })).body.weather).toMatchObject({ kind: 'overcast', day: day + 11 });
    expect((await call('POST', `/api/worlds/${w.id}/day`, { advance: 1 })).body.weather).toMatchObject({ kind: 'overcast', day: day + 11 });
    expect(await weatherEvents(w.id)).toHaveLength(1);
    expect((await call('POST', `/api/worlds/${w.id}/day`, { advance: 1 })).body.weather).toMatchObject({ auto: true, day: day + 12 });
    expect(await weatherEvents(w.id)).toHaveLength(2);
  });
});

describe('history', () => {
  it('is append-only', async () => {
    const c = new pg.Client({ connectionString: URL });
    await c.connect();
    await expect(c.query("update events set summary = 'rewritten'")).rejects.toThrow(/append-only/);
    await expect(c.query('delete from meter_changes')).rejects.toThrow(/append-only/);
    await c.end();
  });
});


describe('uploaded file manager', () => {
  const glb = () => {
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] }).padEnd(96, ' '));
    const bytes = Buffer.alloc(20+json.length); bytes.write('glTF'); bytes.writeUInt32LE(2,4); bytes.writeUInt32LE(bytes.length,8); bytes.writeUInt32LE(json.length,12); bytes.writeUInt32LE(0x4e4f534a,16); json.copy(bytes,20); return bytes;
  };
  it('keeps renamed bytes across restarts, isolates worlds, and removes miniature assignments without moving pieces', async () => {
    const w = (await call('POST','/api/worlds',{name:'File manager QA',cols:4,rows:4})).body;
    const other = (await call('POST','/api/worlds',{name:'Other files QA',cols:4,rows:4})).body;
    const path = `/api/worlds/${w.id}`, bytes = glb();
    const model = (await app.inject({method:'POST',url:`${path}/token-models?name=accidental.glb`,headers:{cookie,'content-type':'model/gltf-binary'},payload:bytes})).json();
    const before = (await call('GET',`${path}/map`)).body;
    const piece = (await call('POST',`${path}/tokens`,{name:'Test piece',kind:'unit',hexId:before.hexes[0].id,modelId:model.id})).body;
    const endpoint = `${path}/files/miniature/${model.id}`;
    expect((await call('GET',`${path}/files`)).body).toContainEqual(expect.objectContaining({id:model.id,name:'accidental.glb',uses:['Test piece']}));
    expect((await call('PATCH',`/api/worlds/${other.id}/files/miniature/${model.id}`,{name:'foreign.glb'})).status).toBe(404);
    expect((await call('DELETE',`/api/worlds/${other.id}/files/miniature/${model.id}?confirm=delete`)).status).toBe(404);
    expect((await call('PATCH',endpoint,{name:'../invalid'})).status).toBe(400);
    expect((await call('PATCH',endpoint,{name:'Renamed scout.glb'})).status).toBe(200);
    await app.close(); const restarted = await boot(); app = restarted.app; db = restarted.db;
    const download = await app.inject({method:'GET',url:`${endpoint}/content`,headers:{cookie}});
    expect(download.rawPayload).toEqual(bytes); expect(download.headers['content-disposition']).toContain('Renamed%20scout.glb');
    expect((await call('GET',`${path}/files`)).body[0].name).toBe('Renamed scout.glb');
    expect((await call('DELETE',endpoint)).status).toBe(400);
    expect((await call('DELETE',`${endpoint}?confirm=delete`)).status).toBe(200);
    const after = (await call('GET',`${path}/map`)).body;
    expect(after.tokens.find((t:{id:string}) => t.id===piece.id)).toMatchObject({modelId:null,hexId:piece.hexId,trail:piece.trail,data:piece.data});
    expect(after.hexes.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id))).toEqual(before.hexes.sort((a:{id:string},b:{id:string})=>a.id.localeCompare(b.id)));
    expect((await app.inject({method:'GET',url:`${path}/token-models/${model.id}`,headers:{cookie}})).statusCode).toBe(404);
    await call('DELETE',path); await call('DELETE',`/api/worlds/${other.id}`);
  });
  it('protects referenced wiki images and active terrain while allowing unused files and archives to be deleted', async () => {
    const w = (await call('POST','/api/worlds',{name:'File usage QA',cols:4,rows:4})).body, path = `/api/worlds/${w.id}`;
    const image = (await app.inject({method:'POST',url:`${path}/wiki-images?name=reference.png`,headers:{cookie,'content-type':'image/png'},payload:png(64,64)})).json();
    const page = (await call('POST',`${path}/pages`,{title:'Image reference',content:{type:'doc',content:[{type:'paragraph',content:[{type:'image',attrs:{src:image.src}}]}]}})).body;
    let files = (await call('GET',`${path}/files`)).body;
    expect(files.find((f:{id:string})=>f.id===image.id)).toMatchObject({name:'reference.png',uses:['Image reference'],blocked:expect.any(String)});
    const imgPath = `${path}/files/wiki-image/${image.id}`;
    expect((await call('PATCH',imgPath,{name:'New image.png'})).status).toBe(200);
    expect((await call('DELETE',`${imgPath}?confirm=delete`)).status).toBe(409);
    expect((await app.inject({method:'GET',url:image.src,headers:{cookie}})).statusCode).toBe(200);
    await call('PATCH',`${path}/pages/${page.id}`,{content:{type:'doc',content:[{type:'paragraph'}]}});
    expect((await call('DELETE',`${imgPath}?confirm=delete`)).status).toBe(200);
    await app.inject({method:'PUT',url:`${path}/map/model`,headers:{cookie,'content-type':'model/gltf-binary','x-file-name':'terrain.glb'},payload:glb()});
    files=(await call('GET',`${path}/files`)).body;
    const terrain=files.find((f:{kind:string})=>f.kind==='terrain');
    expect((await call('DELETE',`${path}/files/terrain/${terrain.id}?confirm=delete`)).status).toBe(409);
    await call('DELETE',`${path}/map/model`);
    const archive=(await call('GET',`${path}/files`)).body.find((f:{kind:string})=>f.kind==='terrain-archive');
    expect((await call('PATCH',`${path}/files/terrain-archive/${archive.id}`,{name:'Old terrain.glb'})).status).toBe(200);
    expect((await app.inject({method:'GET',url:`${path}/files/terrain-archive/${archive.id}/content`,headers:{cookie}})).rawPayload).toEqual(glb());
    expect((await call('DELETE',`${path}/files/terrain-archive/${archive.id}?confirm=delete`)).status).toBe(200);
    await app.inject({method:'PUT',url:`${path}/map/model`,headers:{cookie,'content-type':'model/gltf-binary'},payload:glb()});
    expect((await call('GET',`${path}/map`)).body.map.model.version).toBeGreaterThan(1);
    await call('DELETE',`${path}/map/model`);
    const newerArchive=(await call('GET',`${path}/files`)).body.find((f:{kind:string})=>f.kind==='terrain-archive');
    await call('DELETE',`${path}/files/terrain-archive/${newerArchive.id}?confirm=delete`);
    await app.inject({method:'PUT',url:`${path}/map/art`,headers:{cookie,'content-type':'image/png','x-file-name':'Background.png'},payload:png(64,64)});
    const art=(await call('GET',`${path}/files`)).body.find((f:{kind:string})=>f.kind==='map-art');
    expect(art.name).toBe('Background.png');
    expect((await call('PATCH',`${path}/files/map-art/${art.id}`,{name:'Island art.png'})).status).toBe(200);
    expect((await call('DELETE',`${path}/files/map-art/${art.id}?confirm=delete`)).status).toBe(200);
    expect((await call('GET',`${path}/files`)).body).toEqual([]);
    await app.inject({method:'PUT',url:`${path}/map/art`,headers:{cookie,'content-type':'image/png'},payload:png(64,64)});
    expect((await call('GET',`${path}/map`)).body.map.art.version).toBeGreaterThan(1);
    await call('DELETE',path);
  });
  it('rejects player and anonymous browsing, downloads, renames, and deletion', async () => {
    const w = (await call('POST','/api/worlds',{name:'Private files QA',cols:4,rows:4})).body, path=`/api/worlds/${w.id}`;
    const faction=(await call('POST',`${path}/factions`,{name:'Test party'})).body;
    await call('POST',`${path}/players`,{username:'file-test-player',password:'test-player-123',factionId:faction.id});
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'file-test-player',password:'test-player-123'}});
    const playerCookie=String(login.headers['set-cookie']).split(';')[0];
    for (const [method,url] of [['GET',`${path}/files`],['GET',`${path}/files/miniature/${w.id}/content`],['PATCH',`${path}/files/miniature/${w.id}`],['DELETE',`${path}/files/miniature/${w.id}?confirm=delete`]]) {
      expect((await app.inject({method:method as 'GET',url,headers:{cookie:playerCookie},...(method==='PATCH'?{payload:{name:'No'}}:{})})).statusCode).toBe(403);
      expect((await app.inject({method:method as 'GET',url,...(method==='PATCH'?{payload:{name:'No'}}:{})})).statusCode).toBe(401);
    }
    await call('DELETE',path);
  });
});
