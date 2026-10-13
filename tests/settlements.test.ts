import { describe, expect, it } from 'vitest';
import { connectedFootprint, defaultProfile, ProfileSchema, settlementStats, type SettlementStructure } from '../shared/settlements';
const structure=(id:string,fields:Partial<SettlementStructure>={}):SettlementStructure=>({id,type:'',name:'Market',block:1,lot:1,lots:1,residential:false,ruined:false,consumption:0,activity:'Trade',itemBonus:1,notes:'',...fields});
describe('settlement development',()=>{
  it('uses urban blocks rather than geographic hex count, checks housing and excludes rubble effects',()=>{
    const p=defaultProfile('city');p.structures=[structure('a',{residential:true,consumption:-1}),structure('b',{block:2}),structure('c',{block:3,ruined:true,residential:true,itemBonus:9,consumption:10})];
    expect(settlementStats('city',p)).toMatchObject({blocks:2,residential:1,occupiedLots:3,level:2,consumption:3,overcrowded:true,unrest:1,influence:2,bonuses:{Trade:2}});
    p.level=8;p.island=true;expect(settlementStats('city',p)).toMatchObject({level:8,influence:0});p.bridge=true;expect(settlementStats('city',p).influence).toBe(2);
  });
  it('caps identical structures and takes the higher bonus between different structures',()=>{
    const p=defaultProfile();p.structures=[structure('a'),structure('b',{block:2}),structure('c',{name:'Guild',block:3,itemBonus:3})];
    expect(settlementStats('city',p).bonuses).toEqual({Trade:2});
    p.structures=[structure('a',{name:'River market',type:'Marketplace'}),structure('b',{name:'Grand bazaar',type:'Marketplace',block:2})];expect(settlementStats('city',p).bonuses).toEqual({Trade:2});
    p.structures=[structure('a'),structure('b',{block:2}),structure('c',{name:'Guild',block:3,itemBonus:3})];
    expect(settlementStats('metropolis',p).bonuses).toEqual({Trade:3});
  });
  it('rejects overlapping lots and out-of-block structures, but permits infrastructure',()=>{
    const p=defaultProfile();p.structures=[structure('a'),structure('b')];expect(ProfileSchema.safeParse(p).success).toBe(false);
    p.structures=[structure('a',{lot:2,lots:2})];expect(ProfileSchema.safeParse(p).success).toBe(false);
    p.structures=[structure('a',{lot:4,lots:2})];expect(ProfileSchema.safeParse(p).success).toBe(false);
    p.structures=[structure('a'),structure('b',{lots:0})];expect(ProfileSchema.safeParse(p).success).toBe(true);
  });
  it('accepts connected axial footprints in either orientation and rejects detached hexes',()=>{
    expect(connectedFootprint([{q:0,r:0},{q:1,r:0},{q:1,r:-1}])).toBe(true);
    expect(connectedFootprint([{q:0,r:0},{q:3,r:0}])).toBe(false);
    expect(connectedFootprint([])).toBe(false);
  });
});
