/** Atlas rules are data, independent of the map and wiki. No rule expressions execute code. */
export type SheetKind = 'character' | 'unit' | 'party' | 'kingdom' | 'site';
export type SheetValue = number | string | boolean | string[];
export type SheetValues = Record<string, SheetValue>;
export type Formula = number | string | { op: 'add' | 'multiply' | 'min' | 'max'; args: Formula[] } | { op: 'proficiency'; rank: string; level: string };
export type RuleField = { key: string; label: string; type: 'number' | 'text' | 'textarea' | 'choice' | 'roster'; default: SheetValue; min?: number; max?: number; integer?: boolean; options?: { value: string; label: string }[]; formula?: Formula; roll?: boolean; help?: string };
export type RuleSection = { key: string; label: string; fields: RuleField[] };
export type RulesDefinition = {
  version: 1; name: string; description: string;
  sources: { title: string; url: string }[];
  check: { die: number; criticalMargin: number | null; naturalDegrees: boolean; direction?: 'over' | 'under' };
  proficiency: { ranks: number[]; addLevel: boolean };
  templates: { kind: SheetKind; label: string; sections: RuleSection[] }[];
  exploration: { speedKey: string; bands: { maxSpeed: number; activities: number }[]; terrainCosts: Record<string, number>; fallbackCost: number; hexMiles: number } | null;
  kingdom: { levelDCs: number[]; sizes: { min: number; label: string; die: number; dc: number; storage: number }[] } | null;
};
export type Ruleset = { id: string; worldId: string; key: string; name: string; definition: RulesDefinition; revision: number };
export type RulesState = { activeId: string; rulesets: Ruleset[] };
export type StatSheet = { id: string; tokenId: string; rulesetId: string; kind: SheetKind; values: SheetValues; revision: number };
export type SheetBundle = { sheet: StatSheet; ruleset: Ruleset; canEdit: boolean; members: { id: string; name: string; speed: number | null }[] };

const n = (key: string, label: string, value = 0, min?: number, max?: number): RuleField => ({ key, label, type:'number', default:value, min, max, integer:['level','size','heroPoints','dying','wounded','actions','reactions','focus','xp','resourceDice','unrest'].includes(key) });
const text = (key: string, label: string, multiline = false): RuleField => ({ key,label,type:multiline?'textarea':'text',default:'' });
const rank = (key: string, label: string): RuleField => ({ key,label,type:'choice',default:'0',options:['Untrained','Trained','Expert','Master','Legendary'].map((label,i)=>({label,value:String(i)})) });
const sum = (...args: Formula[]): Formula => ({op:'add',args});
const prof = (key: string): Formula => ({op:'proficiency',rank:`${key}Rank`,level:'level'});
const derived = (key: string, label: string, formula: Formula, roll = false): RuleField => ({key,label,type:'number',default:0,formula,roll});
const attributes = [['str','Strength'],['dex','Dexterity'],['con','Constitution'],['int','Intelligence'],['wis','Wisdom'],['cha','Charisma']];
const skills = [['acrobatics','dex'],['arcana','int'],['athletics','str'],['crafting','int'],['deception','cha'],['diplomacy','cha'],['intimidation','cha'],['medicine','wis'],['nature','wis'],['occultism','int'],['performance','cha'],['religion','wis'],['society','int'],['stealth','dex'],['survival','wis'],['thievery','dex']];
const label = (s: string) => s[0].toUpperCase()+s.slice(1);
const checkFields = (key: string, name: string, attribute: string): RuleField[] => [rank(`${key}Rank`,`${name} training`),n(`${key}Bonus`,`${name} other bonus`),derived(key,name,sum(attribute,prof(key),`${key}Bonus`),true)];
const actorSections: RuleSection[] = [
  {key:'identity',label:'Identity',fields:[n('level','Level',1,1,20),text('ancestry','Ancestry'),text('background','Background'),text('class','Class'),text('traits','Traits')]},
  {key:'vitals',label:'Vitals & defenses',fields:[n('hp','Hit points',0,0),n('hpMax','Maximum HP',0,0),n('tempHp','Temporary HP',0,0),n('speed','Speed (feet)',25,0),n('heroPoints','Hero points',1,0,3),n('dying','Dying',0,0),n('wounded','Wounded',0,0),n('armor','Armor item bonus',0,0),n('dexCap','Armor Dex cap',10,0),rank('acRank','Armor training'),n('acBonus','AC other bonus'),derived('ac','Armor class',sum(10,{op:'min',args:['dex','dexCap']},'armor',prof('ac'),'acBonus'))]},
  {key:'attributes',label:'Attribute modifiers',fields:attributes.map(([key,name])=>n(key,name,0,-5,10))},
  {key:'saves',label:'Perception & saving throws',fields:[...checkFields('perception','Perception','wis'),...checkFields('fortitude','Fortitude','con'),...checkFields('reflex','Reflex','dex'),...checkFields('will','Will','wis')]},
  {key:'skills',label:'Skills',fields:[...skills.flatMap(([key,attribute])=>checkFields(key,label(key),attribute)),text('lore','Lore skills',true)]},
  {key:'combat',label:'Actions & attacks',fields:[{...n('attack','Strike modifier'),roll:true},n('damageBonus','Damage bonus'),text('damage','Damage dice'),n('actions','Actions per turn',3,0,6),n('reactions','Reactions',1,0,6),text('strikes','Strikes, traits & MAP',true),text('abilities','Feats & abilities',true),text('conditions','Conditions & values',true)]},
  {key:'magic',label:'Spellcasting',fields:[text('tradition','Tradition'),n('spellAttribute','Casting attribute modifier'),rank('spellRank','Spellcasting training'),n('spellBonus','Spellcasting other bonus'),derived('spellAttack','Spell attack',sum('spellAttribute',prof('spell'),'spellBonus'),true),derived('spellDC','Spell DC',sum(10,'spellAttack')),n('focus','Focus points',0,0,3),text('spells','Spells, ranks & slots',true)]},
  {key:'gear',label:'Equipment',fields:[n('currency','Gold pieces',0,0),n('bulk','Carried Bulk',0,0),text('inventory','Inventory',true),text('notes','Table notes',true)]},
];

/** Numeric mechanics and original UI labels; source books remain linked references, not copied rulebook prose. */
export const PF2E_RULES: RulesDefinition = {
  version:1,name:'PF2e Remastered + Kingmaker',description:'Remastered stat sheets and checks, with Kingmaker party travel and kingdom bookkeeping. Enter the actual creature statistics; character building and ability automation are manual.',
  sources:[
    {title:'Player Core: character creation',url:'https://2e.aonprd.com/Rules.aspx?ID=66'},
    {title:'Player Core: checks',url:'https://2e.aonprd.com/Rules.aspx?ID=2263'},
    {title:'GM Core: hexploration',url:'https://2e.aonprd.com/Rules.aspx?ID=3103'},
    {title:'Kingmaker: Player’s Guide',url:'https://downloads.paizo.com/KingmakerSecondEdition_PlayersGuide.pdf'},
  ],
  check:{die:20,criticalMargin:10,naturalDegrees:true},proficiency:{ranks:[0,2,4,6,8],addLevel:true},
  templates:[
    {kind:'character',label:'Character',sections:actorSections},
    {kind:'unit',label:'Creature / unit',sections:actorSections},
    {kind:'party',label:'Party',sections:[
      {key:'company',label:'The company',fields:[{key:'members',label:'Party members',type:'roster',default:[]},n('level','Party level',1,1,20),n('speed','Travel speed if no roster (feet)',25,0),text('formation','Marching order',true)]},
      {key:'journey',label:'The journey',fields:[n('activitiesSpent','Activities used today',0,0),n('supplies','Ration days',0,0),n('currency','Shared gold',0,0),text('explorationTasks','Exploration assignments',true),text('camp','Camp & watch',true)]},
      {key:'journal',label:'At the table',fields:[text('inventory','Shared inventory',true),text('notes','Party notes',true)]},
    ]},
    {kind:'kingdom',label:'Kingdom',sections:[
      {key:'realm',label:'Realm',fields:[n('level','Kingdom level',1,1,20),n('size','Claimed hex count',1,1),n('xp','Kingdom XP',0,0),n('unrest','Unrest',0,0),n('fame','Fame',0,0),n('infamy','Infamy',0,0),text('charter','Charter'),text('government','Government'),text('leaders','Leadership roles',true)]},
      {key:'abilities',label:'Kingdom ability modifiers',fields:['culture','economy','loyalty','stability'].map(k=>n(k,label(k),0,-5,10))},
      {key:'resources',label:'Resources & commodities',fields:[n('resourcePoints','Resource points',0,0),n('resourceDice','Resource dice',0,0),n('consumption','Consumption',0,0),...['food','lumber','luxuries','ore','stone'].map(k=>n(k,label(k),0,0))]},
      {key:'ruin',label:'Ruin',fields:['corruption','crime','decay','strife'].map(k=>n(k,label(k),0,0))},
      {key:'turn',label:'Kingdom turn',fields:[text('skills','Kingdom skill training & bonuses',true),text('activities','Turn activities & events',true),text('notes','Kingdom notes',true)]},
    ]},
    {kind:'site',label:'Site',sections:[{key:'site',label:'Site statistics',fields:[n('level','Level',1,0),n('dc','Difficulty class',15),n('hp','Hit points',0,0),text('hazards','Hazards & mechanics',true)]}]},
  ],
  exploration:{speedKey:'speed',bands:[{maxSpeed:10,activities:0.5},{maxSpeed:25,activities:1},{maxSpeed:40,activities:2},{maxSpeed:55,activities:3},{maxSpeed:100000,activities:4}],terrainCosts:{plains:1,grassland:1,forest:2,woods:2,desert:2,hills:2,mountain:3,mountains:3,swamp:3,marsh:3},fallbackCost:1,hexMiles:12},
  kingdom:{levelDCs:[0,14,15,16,18,20,22,23,24,26,27,28,30,31,32,34,35,36,38,39,40],sizes:[{min:1,label:'Territory',die:4,dc:0,storage:4},{min:10,label:'Province',die:6,dc:1,storage:8},{min:25,label:'State',die:8,dc:2,storage:12},{min:50,label:'Country',die:10,dc:3,storage:16},{min:100,label:'Dominion',die:12,dc:4,storage:20}]},
};
export const GENERIC_RULES: RulesDefinition = {
  version:1,name:'Custom tabletop',description:'A system-neutral sheet. Customize its fields and check rules for your world.',sources:[],check:{die:20,criticalMargin:null,naturalDegrees:false},proficiency:{ranks:[0],addLevel:false},
  templates:['character','unit','party','kingdom','site'].map(kind=>({kind:kind as SheetKind,label:label(kind),sections:[{key:'stats',label:'Statistics',fields:[n('hp','Hit points',0,0),n('hpMax','Maximum HP',0,0),n('defense','Defense'),n('speed','Speed',25,0),{...n('check','Check modifier'),roll:true},text('notes','Stats & abilities',true)]}]})),exploration:null,kingdom:null,
};

export const fieldsFor = (rules: RulesDefinition, kind: SheetKind) => rules.templates.find(t=>t.kind===kind)?.sections.flatMap(s=>s.fields) ?? [];
export const defaultsFor = (rules: RulesDefinition, kind: SheetKind): SheetValues => Object.fromEntries(fieldsFor(rules,kind).filter(f=>f.formula===undefined).map(f=>[f.key,structuredClone(f.default)]));
export function sheetNumbers(rules: RulesDefinition, kind: SheetKind, values: SheetValues): Record<string, number> {
  const fields = new Map(fieldsFor(rules,kind).map(f=>[f.key,f])), result: Record<string,number> = {}, visiting = new Set<string>();
  const field = (key: string): number => {
    if (Object.hasOwn(result,key)) return result[key];
    if (visiting.has(key)) return 0;
    visiting.add(key); const f=fields.get(key), raw=values[key]??f?.default;
    const value = f?.formula !== undefined ? calculate(f.formula) : Number(raw??0);
    visiting.delete(key); return result[key]=Number.isFinite(value)?value:0;
  };
  const calculate = (formula: Formula): number => {
    if (typeof formula==='number') return formula;
    if (typeof formula==='string') return field(formula);
    if (formula.op==='proficiency') { const rank=field(formula.rank); return rank>0 ? (rules.proficiency.ranks[rank]??0)+(rules.proficiency.addLevel?field(formula.level):0) : 0; }
    const args=formula.args.map(calculate);
    return formula.op==='add'?args.reduce((a,b)=>a+b,0):formula.op==='multiply'?args.reduce((a,b)=>a*b,1):formula.op==='min'?Math.min(...args):Math.max(...args);
  };
  for (const key of fields.keys()) field(key);
  return result;
}
export function checkDegree(die: number, modifier: number, dc: number, rule: RulesDefinition['check']) {
  const total=die+modifier, margin=rule.criticalMargin, under=rule.direction==='under',difference=under?dc-total:total-dc;
  let degree=margin===null?(difference>=0?2:1):difference>=margin?3:difference>=0?2:difference<=-margin?0:1;
  if(rule.naturalDegrees)degree=Math.max(0,Math.min(3,degree+(die===rule.die?(under?-1:1):die===1?(under?1:-1):0)));
  return ['Critical failure','Failure','Success','Critical success'][degree];
}
export function travelBudget(rules: RulesDefinition, speed: number, terrain: string, spent=0) {
  const e=rules.exploration;if(!e)return null;
  const activities=e.bands.find(b=>speed<=b.maxSpeed)?.activities??e.bands.at(-1)?.activities??0;
  return {activities,remaining:Math.max(0,activities-spent),cost:e.terrainCosts[terrain]??e.fallbackCost,hexMiles:e.hexMiles};
}
export function kingdomStats(rules: RulesDefinition, level: number, size: number) {
  const k=rules.kingdom;if(!k)return null;
  const tier=[...k.sizes].reverse().find(s=>size>=s.min)??k.sizes[0];
  return {tier:tier.label,die:tier.die,storage:tier.storage,dc:(k.levelDCs[level]??k.levelDCs.at(-1)??0)+tier.dc};
}
