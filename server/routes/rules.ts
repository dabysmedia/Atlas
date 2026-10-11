import { randomInt, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { rulesets, worldRules, tokenSheets, tokenPortraits, tokens } from '../db/schema.js';
import { getWorld, Uuid } from './worlds.js';
import { badRequest, notFound, logEvent } from '../history.js';
import { changed } from '../live.js';
import { accessFor, forbidden, visibleTokens } from '../tokenAccess.js';
import { ensureRules, ensureSheets, lockRules } from '../rules.js';
import { imageSize } from '../imagesize.js';
import { PF2E_RULES, GENERIC_RULES, fieldsFor, defaultsFor, sheetNumbers, checkDegree, type Formula, type RulesDefinition, type SheetValue, type SheetKind } from '../../shared/rulesets.js';

const Kind=z.enum(['character','unit','party','kingdom','site']);
const Key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/).refine(s=>!['constructor','prototype','__proto__'].includes(s));
const Value=z.union([z.number().finite().min(-1000000).max(1000000),z.string().max(20000),z.boolean(),z.array(z.string().max(120)).max(100)]);
const Expression: z.ZodType<Formula> = z.lazy(()=>z.union([z.number().finite().min(-1000000).max(1000000),Key,z.object({op:z.enum(['add','multiply','min','max']),args:z.array(Expression).min(1).max(20)}),z.object({op:z.literal('proficiency'),rank:Key,level:Key})]));
const Field=z.object({key:Key,label:z.string().min(1).max(120),type:z.enum(['number','text','textarea','choice','roster']),default:Value,min:z.number().finite().optional(),max:z.number().finite().optional(),integer:z.boolean().optional(),options:z.array(z.object({value:z.string().max(120),label:z.string().max(120)})).min(1).max(100).optional(),formula:Expression.optional(),roll:z.boolean().optional(),help:z.string().max(1000).optional()});
const Definition=z.object({
  version:z.literal(1),name:z.string().trim().min(1).max(120),description:z.string().max(2000),sources:z.array(z.object({title:z.string().max(200),url:z.string().url().refine(s=>s.startsWith('https://'))})).max(50),
  check:z.object({die:z.number().int().min(2).max(1000),criticalMargin:z.number().positive().max(1000).nullable(),naturalDegrees:z.boolean(),direction:z.enum(['over','under']).optional()}),proficiency:z.object({ranks:z.array(z.number().finite().min(0).max(100)).min(1).max(10),addLevel:z.boolean()}),
  templates:z.array(z.object({kind:Kind,label:z.string().min(1).max(120),sections:z.array(z.object({key:Key,label:z.string().min(1).max(120),fields:z.array(Field).max(150)})).min(1).max(20)})).length(5),
  exploration:z.object({speedKey:Key,bands:z.array(z.object({maxSpeed:z.number().min(0).max(1000000),activities:z.number().min(0).max(1000)})).min(1).max(30),terrainCosts:z.record(Key,z.number().positive().max(1000)),fallbackCost:z.number().positive().max(1000),hexMiles:z.number().positive().max(10000)}).nullable(),
  kingdom:z.object({levelDCs:z.array(z.number().finite().min(0).max(1000)).min(2).max(101),sizes:z.array(z.object({min:z.number().int().min(0),label:z.string().max(120),die:z.number().int().min(2).max(1000),dc:z.number().min(0).max(100),storage:z.number().min(0).max(100000)})).min(1).max(30)}).nullable(),
});
function validateValue(field: z.infer<typeof Field>, value: SheetValue) {
  if(field.formula!==undefined)throw badRequest(`${field.label} is calculated.`);
  if(field.type==='number'&&(typeof value!=='number'||!Number.isFinite(value)||(field.min!==undefined&&value<field.min)||(field.max!==undefined&&value>field.max)))throw badRequest(`Invalid ${field.label}.`);
  if(field.integer&&typeof value==='number'&&!Number.isInteger(value))throw badRequest(`${field.label} must be a whole number.`);
  if(['text','textarea','choice'].includes(field.type)&&typeof value!=='string')throw badRequest(`Invalid ${field.label}.`);
  if(field.type==='choice'&&!field.options?.some(o=>o.value===value))throw badRequest(`Choose a valid ${field.label}.`);
  if(field.type==='roster'&&(!Array.isArray(value)||new Set(value).size!==value.length||value.some(id=>!Uuid.safeParse(id).success)))throw badRequest('Choose valid, distinct party members.');
}
export function parseRules(input: unknown): RulesDefinition {
  // Bound depth before recursive schema validation, including malicious imports.
  const depth=(value: unknown,n=0):void=>{if(n>16)throw badRequest('Rules expressions are too deeply nested.');if(value&&typeof value==='object')Object.values(value).forEach(v=>depth(v,n+1));};depth(input);
  const parsed=Definition.safeParse(input);
  if(!parsed.success){const issue=parsed.error.issues[0];throw badRequest(`Rules definition · ${issue.path.join('.')||'root'}: ${issue.message}`);}
  const definition=parsed.data;
  if(new Set(definition.templates.map(t=>t.kind)).size!==5)throw badRequest('Include each sheet type exactly once.');
  for(const t of definition.templates){
    const fields=t.sections.flatMap(s=>s.fields),byKey=new Map(fields.map(f=>[f.key,f]));
    if(byKey.size!==fields.length||new Set(t.sections.map(s=>s.key)).size!==t.sections.length)throw badRequest('Sheet field and section keys must be unique.');
    const refs=(e:Formula):string[]=>typeof e==='string'?[e]:typeof e==='number'?[]:e.op==='proficiency'?[e.rank,e.level]:e.args.flatMap(refs);
    const checked=new Set<string>();
    const walk=(key:string,path:string[]):void=>{if(path.includes(key))throw badRequest('Calculated fields cannot form a cycle.');if(checked.has(key))return;const f=byKey.get(key);if(!f)throw badRequest(`Unknown formula field ${key}.`);if(f.formula!==undefined)refs(f.formula).forEach(k=>walk(k,[...path,key]));checked.add(key);};
    for(const f of fields){if(f.min!==undefined&&f.max!==undefined&&f.min>f.max)throw badRequest('Field minimum exceeds maximum.');if(f.formula!==undefined)walk(f.key,[]);else validateValue(f,f.default);}
  }
  if(definition.exploration?.bands.some((b,i,a)=>i>0&&b.maxSpeed<=a[i-1].maxSpeed))throw badRequest('Travel speed bands must be increasing.');
  if(definition.kingdom?.sizes.some((b,i,a)=>i>0&&b.min<=a[i-1].min))throw badRequest('Kingdom size bands must be increasing.');
  return definition;
}
async function permittedToken(db: Db, req: FastifyRequest, world: string, id: string, edit=false) {
  const token=await db.query.tokens.findFirst({where:and(eq(tokens.worldId,world),eq(tokens.id,Uuid.parse(id)))});
  if(!token||!(await visibleTokens(db,req,world,[token])).length)throw notFound('Token');
  const own=req.userRole!=='player'||(await accessFor(db,req.userId!,world))?.factionId===token.factionId;
  if(req.userRole==='player'&&!own)throw forbidden(); // Visible opponents do not expose their stat sheets.
  return token;
}
export function rulesRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/worlds/:w/rules',async req=>{
    const world=(await getWorld(db,(req.params as {w:string}).w)).id;
    const active=await ensureSheets(db,world);
    return {activeId:active.id,rulesets:await db.select().from(rulesets).where(eq(rulesets.worldId,world))};
  });
  app.post('/api/worlds/:w/rules',async req=>{
    const world=(await getWorld(db,(req.params as {w:string}).w)).id;
    const body=z.object({preset:z.enum(['pf2e','generic']).optional(),definition:z.unknown().optional(),name:z.string().trim().min(1).max(120).optional()}).parse(req.body);
    const definition=parseRules(body.definition??(body.preset==='pf2e'?PF2E_RULES:GENERIC_RULES));
    const [row]=await db.insert(rulesets).values({worldId:world,key:`custom-${randomUUID()}`,name:body.name??definition.name,definition}).returning();changed(req,{scopes:['rules']});return row;
  });
  app.patch('/api/worlds/:w/rules/:id',async req=>{
    const {w,id}=req.params as {w:string;id:string},world=(await getWorld(db,w)).id;
    const body=z.object({name:z.string().trim().min(1).max(120),definition:z.unknown(),revision:z.number().int().positive()}).parse(req.body),definition=parseRules(body.definition);
    return db.transaction(async tx=>{
      await lockRules(tx,world);
      const [row]=await tx.update(rulesets).set({name:body.name,definition,revision:body.revision+1,updatedAt:new Date()}).where(and(eq(rulesets.worldId,world),eq(rulesets.id,Uuid.parse(id)),eq(rulesets.revision,body.revision))).returning();
      if(!row)throw Object.assign(new Error('Rules changed on another screen. Reload before saving.'),{statusCode:409});
      changed(req,{scopes:['rules','sheets']});return row;
    });
  });
  app.put('/api/worlds/:w/rules/active',async req=>{
    const world=(await getWorld(db,(req.params as {w:string}).w)).id,{id}=z.object({id:Uuid}).parse(req.body);
    await db.transaction(async tx=>{await lockRules(tx,world);await ensureRules(tx,world);if(!await tx.query.rulesets.findFirst({where:and(eq(rulesets.worldId,world),eq(rulesets.id,id))}))throw badRequest('Ruleset must belong to this world.');await tx.update(worldRules).set({activeId:id}).where(eq(worldRules.worldId,world));await ensureSheets(tx,world);await logEvent(tx,{worldId:world,kind:'rules.switched',summary:'World ruleset changed',payload:{rulesetId:id}});});
    changed(req,{scopes:['rules','sheets']});return {ok:true};
  });
  app.get('/api/worlds/:w/tokens/:id/sheet',async req=>{
    const {w,id}=req.params as {w:string;id:string},world=(await getWorld(db,w)).id,token=await permittedToken(db,req,world,id);
    const rule=await ensureSheets(db,world,id),sheet=(await db.select().from(tokenSheets).where(and(eq(tokenSheets.tokenId,id),eq(tokenSheets.rulesetId,rule.id))))[0];
    const rows=await db.select().from(tokens).where(eq(tokens.worldId,world)),shown=await visibleTokens(db,req,world,rows);
    const candidateIds=shown.filter(t=>t.id!==id&&t.factionId===token.factionId&&['character','unit'].includes(t.kind)).map(t=>t.id);
    const sheets=candidateIds.length?await db.select().from(tokenSheets).where(and(eq(tokenSheets.rulesetId,rule.id),inArray(tokenSheets.tokenId,candidateIds))):[];
    const members=shown.filter(t=>candidateIds.includes(t.id)).map(t=>{const s=sheets.find(s=>s.tokenId===t.id);return {id:t.id,name:t.name,speed:s?sheetNumbers(rule.definition,s.kind,s.values)[rule.definition.exploration?.speedKey??'speed']??null:null};});
    return {sheet,ruleset:rule,canEdit:true,members};
  });
  app.patch('/api/worlds/:w/tokens/:id/sheet',async req=>{
    const {w,id}=req.params as {w:string;id:string},world=(await getWorld(db,w)).id,token=await permittedToken(db,req,world,id,true);
    const body=z.object({rulesetId:Uuid,revision:z.number().int().positive(),rulesRevision:z.number().int().positive().optional(),kind:Kind.optional(),values:z.record(Key,Value)}).parse(req.body);
    return db.transaction(async tx=>{
      await lockRules(tx,world);const rule=await ensureSheets(tx,world,id);
      if(rule.id!==body.rulesetId)throw Object.assign(new Error('The world ruleset changed. Reopen the sheet.'),{statusCode:409});
      if(body.rulesRevision!==undefined&&body.rulesRevision!==rule.revision)throw Object.assign(new Error('The sheet rules changed. Reload before saving.'),{statusCode:409});
      const old=await tx.query.tokenSheets.findFirst({where:and(eq(tokenSheets.tokenId,id),eq(tokenSheets.rulesetId,rule.id))});
      const kind=body.kind??old!.kind;if(req.userRole==='player'&&kind!==old!.kind)throw forbidden();
      const fields=new Map(fieldsFor(rule.definition,kind).map(f=>[f.key,f]));
      for(const [key,value] of Object.entries(body.values)){const field=fields.get(key);if(!field)throw badRequest(`Unknown sheet field ${key}.`);validateValue(field,value);if(field.type==='roster')for(const memberId of value as string[]){const m=await tx.query.tokens.findFirst({where:and(eq(tokens.id,memberId),eq(tokens.worldId,world))});if(!m||m.id===id||m.factionId!==token.factionId||!['character','unit'].includes(m.kind)||(req.userRole==='player'&&!m.visibleToPlayers))throw badRequest('Party members must be characters or units of this faction.');}}
      const values={...defaultsFor(rule.definition,kind),...old!.values,...body.values};
      const [row]=await tx.update(tokenSheets).set({kind,values,revision:body.revision+1,updatedAt:new Date()}).where(and(eq(tokenSheets.id,old!.id),eq(tokenSheets.revision,body.revision))).returning();
      if(!row)throw Object.assign(new Error('The sheet changed on another screen. Reload before saving.'),{statusCode:409});
      changed(req,{scopes:['sheets']});return row;
    });
  });
  app.post('/api/worlds/:w/tokens/:id/sheet/roll',async req=>{
    const {w,id}=req.params as {w:string;id:string},world=(await getWorld(db,w)).id,token=await permittedToken(db,req,world,id,true);
    const body=z.object({rulesetId:Uuid,field:Key,dc:z.number().finite().min(-1000).max(1000).nullable()}).parse(req.body);
    const rule=await ensureSheets(db,world,id);if(rule.id!==body.rulesetId)throw Object.assign(new Error('The ruleset changed. Reopen the sheet.'),{statusCode:409});
    const sheet=await db.query.tokenSheets.findFirst({where:and(eq(tokenSheets.tokenId,id),eq(tokenSheets.rulesetId,rule.id))}),field=fieldsFor(rule.definition,sheet!.kind).find(f=>f.key===body.field);
    if(!field?.roll)throw badRequest('Choose a rollable statistic.');
    const die=randomInt(1,rule.definition.check.die+1),modifier=sheetNumbers(rule.definition,sheet!.kind,sheet!.values)[field.key],total=die+modifier;
    const result={die,modifier,total,dc:body.dc,degree:body.dc===null?null:checkDegree(die,modifier,body.dc,rule.definition.check)};
    await logEvent(db,{worldId:world,campaignId:token.campaignId,kind:'sheet.roll',actor:req.userRole??'gm',summary:`${token.name} · ${field.label}: ${total}${result.degree?` · ${result.degree}`:''}`,payload:{tokenId:id,rulesetId:rule.id,field:field.key,...result}});changed(req,{scopes:['events']});return result;
  });
  app.get('/api/worlds/:w/token-portraits',async req=>db.select({id:tokenPortraits.id,name:tokenPortraits.name}).from(tokenPortraits).where(eq(tokenPortraits.worldId,(await getWorld(db,(req.params as {w:string}).w)).id)));
  app.post('/api/worlds/:w/token-portraits',{bodyLimit:8*1024*1024},async req=>{
    const world=(await getWorld(db,(req.params as {w:string}).w)).id,bytes=req.body;
    if(!Buffer.isBuffer(bytes))throw badRequest('Upload PNG, JPEG, WebP or GIF art.');
    const size=imageSize(bytes);if(!size||size.width<1||size.height<1||size.width*size.height>24000000)throw badRequest('Upload raster art up to 8 MB and 24 megapixels.');
    const name=z.string().trim().min(1).max(120).parse((req.query as {name?:string}).name??'Portrait');
    const [row]=await db.insert(tokenPortraits).values({worldId:world,name,mime:size.mime,bytes}).returning({id:tokenPortraits.id,name:tokenPortraits.name});changed(req,{scopes:['portraits','files']});return row;
  });
  app.get('/api/worlds/:w/token-portraits/:id',async (req,reply)=>{
    const {w,id}=req.params as {w:string;id:string};await getWorld(db,w);
    const portrait=await db.query.tokenPortraits.findFirst({where:and(eq(tokenPortraits.worldId,w),eq(tokenPortraits.id,Uuid.parse(id)))});if(!portrait)throw notFound('Art');
    if(req.userRole==='player'){const rows=await db.select().from(tokens).where(eq(tokens.worldId,w));if(!(await visibleTokens(db,req,w,rows)).some(t=>(t.data as Record<string,unknown>)?.portraitId===id))throw notFound('Art');}
    return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').type(portrait.mime).send(portrait.bytes);
  });
}
