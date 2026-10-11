import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './db/index.js';
import { rulesets, worldRules, tokenSheets, tokens } from './db/schema.js';
import { PF2E_RULES, defaultsFor, type SheetKind } from '../shared/rulesets.js';

export const kindForToken = (token: {kind: string}) : SheetKind => token.kind==='party'?'party':token.kind==='character'?'character':['unit','marker'].includes(token.kind)?'unit':'site';
export async function ensureRules(db: DbOrTx, worldId: string) {
  const [current]=await db.select({rule:rulesets}).from(worldRules).innerJoin(rulesets,eq(rulesets.id,worldRules.activeId)).where(eq(worldRules.worldId,worldId));
  if(current)return current.rule;
  await db.insert(rulesets).values({worldId,key:'pf2e-remaster-kingmaker',name:PF2E_RULES.name,definition:PF2E_RULES}).onConflictDoNothing();
  const preset=(await db.select().from(rulesets).where(and(eq(rulesets.worldId,worldId),eq(rulesets.key,'pf2e-remaster-kingmaker'))))[0];
  await db.insert(worldRules).values({worldId,activeId:preset.id}).onConflictDoNothing();
  const [active]=await db.select({rule:rulesets}).from(worldRules).innerJoin(rulesets,eq(rulesets.id,worldRules.activeId)).where(eq(worldRules.worldId,worldId));
  return active.rule;
}
export async function ensureSheets(db: DbOrTx, worldId: string, only?: string) {
  const rule=await ensureRules(db,worldId);
  const rows=await db.select().from(tokens).where(and(eq(tokens.worldId,worldId),only?eq(tokens.id,only):undefined));
  const existing=new Set((await db.select({tokenId:tokenSheets.tokenId}).from(tokenSheets).where(and(eq(tokenSheets.worldId,worldId),eq(tokenSheets.rulesetId,rule.id)))).map(s=>s.tokenId));
  const missing=rows.filter(t=>!existing.has(t.id));
  if(missing.length)await db.insert(tokenSheets).values(missing.map(t=>({worldId,tokenId:t.id,rulesetId:rule.id,kind:kindForToken(t),values:defaultsFor(rule.definition,kindForToken(t))}))).onConflictDoNothing();
  return rule;
}
export async function copySheets(db: DbOrTx, sourceId: string, targetId: string) {
  const rows=await db.select().from(tokenSheets).where(eq(tokenSheets.tokenId,sourceId));
  if(rows.length)await db.insert(tokenSheets).values(rows.map(s=>({worldId:s.worldId,tokenId:targetId,rulesetId:s.rulesetId,kind:s.kind,values:s.values}))).onConflictDoNothing();
}
export const lockRules = (db: DbOrTx, world: string) => db.execute(sql`select pg_advisory_xact_lock(hashtext(${`rules:${world}`}))`);
