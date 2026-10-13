import { z } from 'zod';
import { DIRS, key, type Axial } from './hex.js';

export const SETTLEMENT_TYPES = [
  { key: 'hamlet', label: 'Hamlet' }, { key: 'village', label: 'Village' },
  { key: 'town', label: 'Town' }, { key: 'city', label: 'City' },
  { key: 'metropolis', label: 'Metropolis' }, { key: 'outpost', label: 'Outpost' },
  { key: 'military_base', label: 'Military base' },
] as const;
export type SettlementType = typeof SETTLEMENT_TYPES[number]['key'];
export const SETTLEMENT_KEYS = SETTLEMENT_TYPES.map(t => t.key);
export const isSettlementKind = (kind: string): kind is SettlementType => SETTLEMENT_KEYS.includes(kind as SettlementType);
export const TIERS = ['village', 'town', 'city', 'metropolis'] as const;
export type SettlementTier = typeof TIERS[number];
export const KINGMAKER = {
  village: { consumption: 1, itemBonus: 1, influence: 0, kingdomLevel: 1, maxBlocks: 1, population: 'Up to 400' },
  town: { consumption: 2, itemBonus: 1, influence: 1, kingdomLevel: 3, maxBlocks: 4, population: '401–2,000' },
  city: { consumption: 4, itemBonus: 2, influence: 2, kingdomLevel: 9, maxBlocks: 9, population: '2,001–25,000' },
  metropolis: { consumption: 6, itemBonus: 3, influence: 3, kingdomLevel: 15, maxBlocks: 100, population: '25,001+' },
} as const;

const text = z.string().max(8000);
export const StructureSchema = z.object({
  id: z.string().min(1).max(80), type: z.string().max(120).default(''), name: z.string().trim().min(1).max(120),
  block: z.number().int().min(1).max(100), lot: z.number().int().min(1).max(4), lots: z.number().int().min(0).max(4),
  residential: z.boolean(), ruined: z.boolean(), consumption: z.number().int().min(-100).max(100),
  activity: z.string().max(100), itemBonus: z.number().int().min(0).max(10), notes: text,
});
export const ProfileSchema = z.object({
  type: z.enum(SETTLEMENT_KEYS), capital: z.boolean(), description: text, government: text, leader: text,
  languages: text, religions: text, demographics: text, services: text, trade: text, threats: text, defenses: text,
  foundedDay: z.number().int().min(0).nullable(), kingdomLevel: z.number().int().min(1).max(20).nullable(),
  level: z.number().int().min(0).max(20).nullable(), consumptionAdjustment: z.number().int().min(-1000).max(1000),
  island: z.boolean(), bridge: z.boolean(), waterBorders: z.number().int().min(0).max(4), walledBorders: z.number().int().min(0).max(4),
  structures: z.array(StructureSchema).max(400),
}).superRefine((p, ctx) => {
  const ids = new Set<string>(), occupied = new Set<string>();
  for (const s of p.structures) {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate structure id' });
    ids.add(s.id);
    if (s.lots===2 && s.lot===2) ctx.addIssue({code:'custom',message:'A two-lot structure must occupy adjoining lots in one row (start at lot 1 or 3).'});
    if (s.lot + s.lots - 1 > 4) ctx.addIssue({ code: 'custom', message: 'A structure must fit in one four-lot block.' });
    for (let n = 0; n < s.lots; n++) {
      const k = `${s.block}/${s.lot+n}`;
      if (occupied.has(k)) ctx.addIssue({ code: 'custom', message: 'Structures cannot occupy the same lot.' });
      occupied.add(k);
    }
  }
});
export type SettlementProfile = z.infer<typeof ProfileSchema>;
export type SettlementStructure = z.infer<typeof StructureSchema>;
export function defaultProfile(type: string = 'village'): SettlementProfile {
  return { type: isSettlementKind(type) ? type : 'village', capital: false, description: '', government: '', leader: '', languages: '', religions: '', demographics: '', services: '', trade: '', threats: '', defenses: '', foundedDay: null, kingdomLevel: null, level: null, consumptionAdjustment: 0, island: false, bridge: false, waterBorders: 0, walledBorders: 0, structures: [] };
}
export function profileFor(s: { size: string; data?: unknown }): SettlementProfile {
  const parsed = ProfileSchema.safeParse({ ...defaultProfile(s.size), ...((s.data as Record<string, unknown> | undefined)?.profile as object ?? {}) });
  return parsed.success ? parsed.data : defaultProfile(s.size);
}
export function tierFor(size: string): SettlementTier { return TIERS.includes(size as SettlementTier) ? size as SettlementTier : 'village'; }
/** World hexes describe geography; blocks and lots describe development inside a settlement. */
export function settlementStats(size: string, p: SettlementProfile) {
  const tier = KINGMAKER[tierFor(size)], active = p.structures.filter(s => !s.ruined);
  const blocks = new Set(active.filter(s => s.lots > 0).map(s => s.block)).size;
  const residential = active.filter(s => s.residential).reduce((n,s) => n+s.lots, 0);
  const occupiedLots = p.structures.reduce((n,s) => n+s.lots, 0);
  const overcrowded = residential < blocks;
  const bonuses: Record<string, number> = {};
  // Identical structures stack; different structure types use the best bonus for an activity.
  const groups = new Map<string, { activity: string; total: number }>();
  for (const s of active.filter(s => s.activity.trim() && s.itemBonus)) {
    const activity = s.activity.trim(), k = `${(s.type.trim()||s.name.trim()).toLowerCase()}/${activity.toLowerCase()}`;
    const prior = groups.get(k); groups.set(k,{activity,total:(prior?.total ?? 0)+s.itemBonus});
  }
  for (const g of groups.values()) bonuses[g.activity] = Math.max(bonuses[g.activity] ?? 0, Math.min(tier.itemBonus,g.total));
  return { blocks, residential, occupiedLots, overcrowded, unrest: overcrowded ? 1 : 0,
    level: p.level ?? Math.min(20, blocks || 1), consumption: Math.max(0,tier.consumption+p.consumptionAdjustment+active.reduce((n,s)=>n+s.consumption,0)),
    influence: p.island && !p.bridge ? 0 : tier.influence, itemBonus: tier.itemBonus, kingdomLevel: tier.kingdomLevel, maxBlocks: tier.maxBlocks, bonuses };
}
export function connectedFootprint(hexes: Axial[]) {
  if (!hexes.length) return false;
  const remaining = new Set(hexes.map(h => key(h.q,h.r))), queue = [hexes[0]];
  remaining.delete(key(hexes[0].q,hexes[0].r));
  for (let i=0;i<queue.length;i++) for (const d of DIRS.flat) {
    const h = {q:queue[i].q+d.q,r:queue[i].r+d.r};
    if (remaining.delete(key(h.q,h.r))) queue.push(h);
  }
  return remaining.size === 0;
}

