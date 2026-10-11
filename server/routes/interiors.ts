import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/index.js';
import { interiors, interiorAssets, interiorPositions, hexes, maps, tokens, campaignFog } from '../db/schema.js';
import { getWorld, Uuid } from './worlds.js';
import { accessFor, forbidden } from '../tokenAccess.js';
import { badRequest, notFound, logEvent } from '../history.js';
import { changed } from '../live.js';
import { imageSize } from '../imagesize.js';
import { interiorCell } from '../../shared/interiors.js';
const Settings = z.object({ name:z.string().trim().min(1).max(120),mode:z.enum(['2d','3d']),cols:z.number().int().min(1).max(200),rows:z.number().int().min(1).max(200),entryX:z.number().int().min(0),entryY:z.number().int().min(0),visibleToPlayers:z.boolean() });
const conflict = (message: string) => Object.assign(new Error(message),{statusCode:409});
async function row(db: DbOrTx,w: string,id: string,lock=false) {
  const query=db.select().from(interiors).where(and(eq(interiors.worldId,Uuid.parse(w)),eq(interiors.id,Uuid.parse(id))));
  const [value]=await (lock?query.for('update'):query);
  if(!value) throw notFound('Interior'); return value;
}
async function readable(db: Db,req: FastifyRequest,value: typeof interiors.$inferSelect) {
  if(req.userRole !== 'player') return;
  const access=await accessFor(db,req.userId!,value.worldId); if(!access)throw forbidden();
  const party=await db.select().from(tokens).where(and(eq(tokens.worldId,value.worldId),eq(tokens.factionId,access.factionId),eq(tokens.mainParty,true)));
  const inside=await db.select().from(interiorPositions).where(eq(interiorPositions.interiorId,value.id));
  if(inside.some(p=>party.some(t=>t.id===p.tokenId)))return;
  if(!value.visibleToPlayers)throw forbidden();
  if(access.campaignId && !party.some(t=>t.hexId===value.hexId) && !await db.query.campaignFog.findFirst({where:and(eq(campaignFog.campaignId,access.campaignId),eq(campaignFog.hexId,value.hexId))}))throw forbidden();
}
async function party(db: DbOrTx,req: FastifyRequest,w: string,id: string) {
  const [token]=await db.select().from(tokens).where(and(eq(tokens.worldId,w),eq(tokens.id,Uuid.parse(id)))).for('update');
  if(!token?.mainParty)throw badRequest('Choose the faction’s main party token.');
  if(req.userRole==='player') {
    const access=await accessFor(db as Db,req.userId!,w);
    if(!access || access.factionId!==token.factionId || !token.visibleToPlayers)throw forbidden();
  }
  return token;
}
const metadata = { name:interiorAssets.name,mime:interiorAssets.mime,version:interiorAssets.version };
export function interiorRoutes(app: FastifyInstance,db: Db) {
  app.get('/api/worlds/:w/interiors',async req=>{
    const w=(await getWorld(db,(req.params as {w:string}).w)).id;
    const all=await db.select().from(interiors).where(eq(interiors.worldId,w));
    const allowed=[]; for(const value of all) { try { await readable(db,req,value); allowed.push(value); } catch(e) { if((e as {statusCode?:number}).statusCode!==403)throw e; } }
    const assets=await db.select({id:interiorAssets.id,...metadata}).from(interiorAssets).where(eq(interiorAssets.worldId,w));
    let positions=await db.select().from(interiorPositions).where(eq(interiorPositions.worldId,w));
    if(req.userRole==='player') { const access=await accessFor(db,req.userId!,w); const own=await db.select().from(tokens).where(and(eq(tokens.worldId,w),eq(tokens.factionId,access!.factionId))); positions=positions.filter(p=>own.some(t=>t.id===p.tokenId)); }
    return { interiors:allowed.map(({assetVersion,createdAt,updatedAt,...value})=>({...value,asset:assets.find(a=>a.id===value.id)??null})),positions };
  });
  app.post('/api/worlds/:w/interiors',async req=>{
    const w=(await getWorld(db,(req.params as {w:string}).w)).id, body=Settings.extend({hexId:Uuid}).parse(req.body);
    const hex=await db.select({id:hexes.id}).from(hexes).innerJoin(maps,eq(maps.id,hexes.mapId)).where(and(eq(hexes.id,body.hexId),eq(maps.worldId,w)));
    if(!hex.length)throw badRequest('Hex must belong to this world.');
    if(!interiorCell(body.entryX,body.entryY,body.cols,body.rows))throw badRequest('Entry point must be on the grid.');
    const [value]=await db.insert(interiors).values({...body,worldId:w}).returning();changed(req,{scopes:['interiors']});return {...value,asset:null};
  });
  app.patch('/api/worlds/:w/interiors/:id',async req=>{
    const {w,id}=req.params as {w:string;id:string}, body=Settings.partial().parse(req.body);
    const value=await db.transaction(async tx=>{
      const current=await row(tx,w,id,true); const next={...current,...body};
      if(!interiorCell(next.entryX,next.entryY,next.cols,next.rows))throw badRequest('Entry point must be on the grid.');
      const active=await tx.select().from(interiorPositions).where(eq(interiorPositions.interiorId,id));if(active.some(p=>!interiorCell(p.x,p.y,next.cols,next.rows)))throw conflict('The smaller grid would put a party outside the map. Move it first.');
      const asset=await tx.query.interiorAssets.findFirst({where:eq(interiorAssets.id,id)});if(asset&&next.mode!==current.mode)throw badRequest('Remove the current map before changing between 2D and 3D.');
      const [updated]=await tx.update(interiors).set({...body,updatedAt:new Date()}).where(eq(interiors.id,id)).returning();return updated;
    });changed(req,{scopes:['interiors']});return value;
  });
  app.delete('/api/worlds/:w/interiors/:id',async req=>{
    const {w,id}=req.params as {w:string;id:string};await row(db,w,id);if((req.query as {confirm?:string}).confirm!=='delete')throw badRequest('Confirm interior deletion.');
    await db.transaction(async tx=>{await tx.select().from(interiors).where(eq(interiors.id,id)).for('update');if(await tx.query.interiorPositions.findFirst({where:eq(interiorPositions.interiorId,id)}))throw conflict('Return every party to the world map before deleting this interior.');await tx.delete(interiors).where(eq(interiors.id,id));});changed(req,{scopes:['interiors','files']});return {ok:true};
  });
  app.put('/api/worlds/:w/interiors/:id/asset',{bodyLimit:40*1024*1024},async req=>{
    const {w,id}=req.params as {w:string;id:string}, value=await row(db,w,id), bytes=req.body;
    if(!Buffer.isBuffer(bytes)||!bytes.length)throw badRequest('Upload a map image or a self-contained GLB.');
    let mime:string;
    if(value.mode==='2d') {const info=imageSize(bytes);if(!info||info.width*info.height>40_000_000)throw badRequest('Use a PNG, JPEG, WebP or GIF up to 40 megapixels.');mime=info.mime;}
    else {
      if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a||20+bytes.readUInt32LE(12)>bytes.length)throw badRequest('Use a valid self-contained GLB 2.0 model.');
      let doc;try{doc=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));}catch{throw badRequest('Invalid GLB JSON.');}
      if(!doc||doc.asset?.version!=='2.0'||!Array.isArray(doc.buffers)||!Array.isArray(doc.meshes)||!doc.meshes.length||(doc.images!==undefined&&!Array.isArray(doc.images)))throw badRequest('Use a GLB 2.0 with map geometry.');
      if([...doc.buffers,...(doc.images??[])].some((x:{uri?:string}|null)=>!x||x.uri!==undefined&&(typeof x.uri!=='string'||!x.uri.startsWith('data:'))))throw badRequest('Embed the model’s buffers and textures.');mime='model/gltf-binary';
    }
    const name=z.string().trim().min(1).max(120).parse(req.headers['x-file-name']??'interior-map');
    const asset=await db.transaction(async tx=>{
      const [updated]=await tx.update(interiors).set({assetVersion:sql`${interiors.assetVersion}+1`,updatedAt:new Date()}).where(eq(interiors.id,id)).returning();
      if(updated.mode!==value.mode)throw conflict('The interior mode changed. Upload again.');
      const values={worldId:w,name,mime,bytes,version:updated.assetVersion,updatedAt:new Date()}; const [asset]=await tx.insert(interiorAssets).values({id,...values}).onConflictDoUpdate({target:interiorAssets.id,set:values}).returning(metadata);return asset;
    });changed(req,{scopes:['interiors','files']});return asset;
  });
  app.get('/api/worlds/:w/interiors/:id/asset',async(req,reply)=>{
    const {w,id}=req.params as {w:string;id:string}, value=await row(db,w,id);await readable(db,req,value);
    const asset=await db.query.interiorAssets.findFirst({where:eq(interiorAssets.id,id)});if(!asset)throw notFound('Interior map');return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').type(asset.mime).send(asset.bytes);
  });
  app.delete('/api/worlds/:w/interiors/:id/asset',async req=>{const {w,id}=req.params as {w:string;id:string};await row(db,w,id);if((req.query as {confirm?:string}).confirm!=='delete')throw badRequest('Confirm map removal.');await db.delete(interiorAssets).where(eq(interiorAssets.id,id));changed(req,{scopes:['interiors','files']});return {ok:true};});
  app.post('/api/worlds/:w/interiors/:id/enter',async req=>{
    const {w,id}=req.params as {w:string;id:string}, body=z.object({tokenId:Uuid}).parse(req.body), value=await row(db,w,id);await readable(db,req,value);
    const position=await db.transaction(async tx=>{
      const token=await party(tx,req,w,body.tokenId); const [current]=await tx.select().from(interiors).where(eq(interiors.id,id)).for('update');if(!current)throw notFound('Interior');
      if(req.userRole==='player'&&!current.visibleToPlayers)throw forbidden();
      if(token.hexId!==current.hexId)throw badRequest('The party must be on the linked hex before entering.');
      if(await tx.query.interiorPositions.findFirst({where:eq(interiorPositions.tokenId,token.id)}))throw conflict('The party is already inside an interior. Leave it first.');
      const [p]=await tx.insert(interiorPositions).values({tokenId:token.id,worldId:w,interiorId:id,x:current.entryX,y:current.entryY}).returning();
      await logEvent(tx,{worldId:w,campaignId:token.campaignId,kind:'interior.entered',actor:req.userRole??'gm',summary:`${token.name} entered ${current.name}`,payload:{tokenId:token.id,interiorId:id,x:p.x,y:p.y}});return p;
    });changed(req,{scopes:['interiors','events']});return position;
  });
  app.post('/api/worlds/:w/interiors/:id/move',async req=>{
    const {w,id}=req.params as {w:string;id:string},body=z.object({tokenId:Uuid,x:z.number().int(),y:z.number().int(),revision:z.number().int().positive()}).parse(req.body);
    const position=await db.transaction(async tx=>{
      const token=await party(tx,req,w,body.tokenId),value=await row(tx,w,id,true);
      if(!interiorCell(body.x,body.y,value.cols,value.rows))throw badRequest('Choose a square on this interior’s grid.');
      const old=await tx.query.interiorPositions.findFirst({where:and(eq(interiorPositions.tokenId,token.id),eq(interiorPositions.interiorId,id))});if(!old)throw badRequest('The party is not in this interior.');if(old.revision!==body.revision)throw conflict('The party moved on another screen. Refresh and try again.');
      const [p]=await tx.update(interiorPositions).set({x:body.x,y:body.y,revision:old.revision+1,updatedAt:new Date()}).where(eq(interiorPositions.tokenId,token.id)).returning();
      await logEvent(tx,{worldId:w,campaignId:token.campaignId,kind:'interior.moved',actor:req.userRole??'gm',summary:`${token.name} moved inside ${value.name}`,payload:{tokenId:token.id,interiorId:id,from:{x:old.x,y:old.y},to:{x:p.x,y:p.y}}});return p;
    });changed(req,{scopes:['interiors','events']});return position;
  });
  app.post('/api/worlds/:w/interiors/:id/leave',async req=>{
    const {w,id}=req.params as {w:string;id:string},body=z.object({tokenId:Uuid,revision:z.number().int().positive()}).parse(req.body);
    await db.transaction(async tx=>{
      const token=await party(tx,req,w,body.tokenId),value=await row(tx,w,id),position=await tx.query.interiorPositions.findFirst({where:and(eq(interiorPositions.tokenId,token.id),eq(interiorPositions.interiorId,id))});
      if(!position)throw badRequest('The party is not in this interior.');if(position.revision!==body.revision)throw conflict('The party moved on another screen. Refresh and try again.');await tx.delete(interiorPositions).where(eq(interiorPositions.tokenId,token.id));
      await logEvent(tx,{worldId:w,campaignId:token.campaignId,kind:'interior.left',actor:req.userRole??'gm',summary:`${token.name} left ${value.name}`,payload:{tokenId:token.id,interiorId:id,hexId:value.hexId}});
    });changed(req,{scopes:['interiors','events']});return {ok:true};
  });
}
