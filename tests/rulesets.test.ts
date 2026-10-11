import { expect, it } from 'vitest';
import { PF2E_RULES, GENERIC_RULES, defaultsFor, sheetNumbers, checkDegree, travelBudget, kingdomStats } from '../shared/rulesets';
import { parseRules } from '../server/routes/rules';

it('validates both bundled packs and calculates Remastered proficiency, defenses and spell DCs',()=>{
  expect(parseRules(PF2E_RULES)).toEqual(PF2E_RULES);expect(parseRules(GENERIC_RULES)).toEqual(GENERIC_RULES);
  const values={...defaultsFor(PF2E_RULES,'character'),level:5,dex:4,wis:2,con:3,armor:2,dexCap:2,acRank:'1',reflexRank:'2',reflexBonus:1,spellAttribute:4,spellRank:'1'};
  const result=sheetNumbers(PF2E_RULES,'character',values);
  expect(result.ac).toBe(21);expect(result.reflex).toBe(14);expect(result.will).toBe(2);expect(result.spellAttack).toBe(11);expect(result.spellDC).toBe(21);
  expect(values.dex).toBe(4);
});
it('uses PF2e degree shifts rather than automatic success on a natural 20',()=>{
  expect(checkDegree(20,0,40,PF2E_RULES.check)).toBe('Failure');
  expect(checkDegree(1,20,10,PF2E_RULES.check)).toBe('Success');
  expect(checkDegree(10,10,20,PF2E_RULES.check)).toBe('Success');
  expect(checkDegree(10,0,20,PF2E_RULES.check)).toBe('Critical failure');
  expect(checkDegree(20,0,40,GENERIC_RULES.check)).toBe('Failure');
  expect(checkDegree(25,0,40,{...GENERIC_RULES.check,die:100,direction:'under'})).toBe('Success');
  expect(checkDegree(75,0,40,{...GENERIC_RULES.check,die:100,direction:'under'})).toBe('Failure');
});
it('derives Kingmaker travel pacing and kingdom size tiers from editable data',()=>{
  expect(travelBudget(PF2E_RULES,10,'forest',0)).toMatchObject({activities:.5,cost:2,remaining:.5});
  expect(travelBudget(PF2E_RULES,30,'mountains',1)).toMatchObject({activities:2,cost:3,remaining:1});
  expect(travelBudget(GENERIC_RULES,30,'forest')).toBeNull();
  expect(kingdomStats(PF2E_RULES,1,9)).toEqual({tier:'Territory',die:4,storage:4,dc:14});
  expect(kingdomStats(PF2E_RULES,20,100)).toEqual({tier:'Dominion',die:12,storage:20,dc:44});
});
it('rejects unsafe or invalid rules imports and circular calculations',()=>{
  const cyclic=structuredClone(PF2E_RULES);cyclic.templates[0].sections[0].fields[0].formula='level';
  expect(()=>parseRules(cyclic)).toThrow('cycle');
  const unknown=structuredClone(PF2E_RULES);unknown.templates[0].sections[0].fields[0].formula='absent';expect(()=>parseRules(unknown)).toThrow('Unknown');
  const duplicate=structuredClone(PF2E_RULES);duplicate.templates[0].sections[0].fields.push(duplicate.templates[0].sections[0].fields[0]);expect(()=>parseRules(duplicate)).toThrow('unique');
  const malicious=structuredClone(GENERIC_RULES);malicious.templates[0].sections[0].fields[0].key='constructor';expect(()=>parseRules(malicious)).toThrow();
  const constant=structuredClone(GENERIC_RULES);constant.templates[0].sections[0].fields[0].formula=0;
  expect(sheetNumbers(parseRules(constant),'character',{hp:100}).hp).toBe(0);
});
