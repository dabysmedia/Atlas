import { describe, expect, it } from 'vitest';
import { SETTLEMENT_ART_STYLES, settlementArtStyleFor, settlementArtUrl, settlementUsesExistingTrees } from '../shared/settlementArt';
import { SETTLEMENT_KEYS } from '../shared/settlements';

describe('faction settlement architecture', () => {
  it('recognizes lore names and punctuation without assigning an ambiguous alliance', () => {
    for (const [name,key] of [['Casa de Mendoza','mendoza'],['Company DuPont','dupont'],['The Qadir Ascendancy','qadir'],['The Nhal’Kesh','nhalkesh'],['The Aelari','aelari'],['The Flesh-Shapers','flesh']]) {
      expect(settlementArtStyleFor({name})).toBe(key);
    }
    expect(settlementArtStyleFor({name:'Mendoza–DuPont alliance'})).toBeNull();
    expect(settlementArtStyleFor({name:'River alliance'})).toBeNull();
    expect(settlementArtStyleFor(null)).toBeNull();
  });
  it('keeps saved architecture after renaming and supports custom factions and generic art', () => {
    expect(settlementArtUrl({name:'Renamed faction',settlementArtStyle:'qadir'},'military_base')).toBe('/settlements/qadir/military_base.webp');
    expect(settlementArtUrl({name:'Mendoza',settlementArtStyle:'generic'},'city')).toBeNull();
    expect(settlementArtUrl({name:'Mendoza'},'temple')).toBeNull();
    expect(settlementArtUrl({name:'Mendoza',settlementArtStyle:null},'city')).toBe('/settlements/mendoza/city.webp');
  });
  it('provides 42 distinct faction/type paths while Canopy settlements use existing trees', () => {
    const paths=SETTLEMENT_ART_STYLES.flatMap(style=>SETTLEMENT_KEYS.map(kind=>settlementArtUrl({name:style.label,settlementArtStyle:style.key},kind))).filter(Boolean);
    expect(paths).toHaveLength(42);
    expect(new Set(paths).size).toBe(42);
    for(const kind of SETTLEMENT_KEYS) expect(settlementArtUrl({name:'The Canopy People'},kind)).toBeNull();
    expect(settlementUsesExistingTrees({name:'The Canopy People'})).toBe(true);
    expect(settlementUsesExistingTrees({name:'Renamed',settlementArtStyle:'canopy'})).toBe(true);
    expect(settlementUsesExistingTrees({name:'The Aelari'})).toBe(false);
  });
});
