import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from './db/index.js';
import {
  campaigns, campaignFog, claims, factions, hexes, maps, meterDefinitions, meterValues,
  rollTableEntries, rollTables, settlements, tokens, wikiLinks, wikiPages, worlds, events, meterChanges,
} from './db/schema.js';
import { DEFAULT_HEX_STATES, DEFAULT_TERRAIN, MORALE_BANDS, SIGNATURE_BANDS } from './defaults.js';
import { rectangle, key, distance, hexLabel, type Orientation } from '../shared/hex.js';
import { docText, docLinks } from './wikidoc.js';

export async function createWorld(tx: DbOrTx, p: {
  name: string; description?: string; cols?: number; rows?: number; orientation?: Orientation; accent?: string;
}) {
  const [world] = await tx.insert(worlds).values({
    name: p.name, description: p.description ?? '', terrainTypes: DEFAULT_TERRAIN, hexStates: DEFAULT_HEX_STATES,
    accent: p.accent ?? '#c8a24a',
  }).returning();
  const layout = { orientation: p.orientation ?? 'flat', cols: p.cols ?? 32, rows: p.rows ?? 24 } as const;
  const [map] = await tx.insert(maps).values({ worldId: world.id, name: 'World map', layout }).returning();
  const cells = rectangle(layout.cols, layout.rows, layout.orientation);
  for (let i = 0; i < cells.length; i += 2000) {
    await tx.insert(hexes).values(cells.slice(i, i + 2000).map((c) => ({ mapId: map.id, q: c.q, r: c.r })));
  }
  // The shared core every faction carries.
  await tx.insert(meterDefinitions).values([
    { worldId: world.id, key: 'morale', name: 'Morale', kind: 'core', min: 0, max: 100, defaultValue: 60, bands: MORALE_BANDS, sortOrder: 0,
      description: 'Shared core meter. Signature erosion cascades here.' },
    { worldId: world.id, key: 'treasury', name: 'Treasury', kind: 'resource', min: 0, max: null, defaultValue: 0, bands: [], sortOrder: 1,
      description: 'Liquid funds, tracked as a resource rather than a mood.' },
  ]);
  await tx.insert(events).values({ worldId: world.id, gameDay: 1, kind: 'world.created', summary: `World "${p.name}" founded`, actor: 'system' });
  return { world, map };
}

// ---------------------------------------------------------------- demo world
type Node = Record<string, unknown>;
const t = (text: string, marks?: Node[]): Node => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const link = (pageId: string, label: string): Node => ({ type: 'wikiLink', attrs: { pageId, label } });
const para = (...c: (string | Node)[]): Node => ({ type: 'paragraph', content: c.map((x) => (typeof x === 'string' ? t(x) : x)) });
const h = (level: number, text: string): Node => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const ul = (...items: (string | Node)[][]): Node => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [para(...i)] })) });
const doc = (...content: Node[]) => ({ type: 'doc', content });

/** Small deterministic value noise so the demo map looks like a place, not a checkerboard. */
function noise(seed: number) {
  const rand = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const smooth = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = rand(x0, y0), b = rand(x0 + 1, y0), c = rand(x0, y0 + 1), d = rand(x0 + 1, y0 + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x: number, y: number) => smooth(x / 4, y / 4) * 0.65 + smooth(x / 2, y / 2) * 0.35;
}

export async function seedDemoWorld(db: Db) {
  return db.transaction(async (tx) => {
    const { world, map } = await createWorld(tx, {
      name: 'The Sundered Reach', cols: 22, rows: 16, orientation: 'flat', accent: '#d4a64a',
      description: 'A storm-cut frontier where a chartered company carves out holdings between a zealot covenant and a proud old house.',
    });
    await tx.update(worlds).set({ currentDay: 142 }).where(eq(worlds.id, world.id));

    // Terrain from elevation + moisture noise; the west edge is coast.
    const elev = noise(7), wet = noise(19);
    const rows = await tx.select().from(hexes).where(eq(hexes.mapId, map.id));
    const byKey = new Map(rows.map((r) => [key(r.q, r.r), r]));
    const col = (q: number) => q;
    const terrainOf = (q: number, r: number) => {
      const row = r + (q - (q & 1)) / 2;
      const e = elev(col(q), row) - Math.max(0, (3 - col(q)) * 0.18);
      const m = wet(col(q) + 50, row);
      if (e < 0.22) return 'deep';
      if (e < 0.32) return 'water';
      if (e > 0.78) return 'mountains';
      if (e > 0.66) return 'hills';
      if (m > 0.62) return e < 0.45 ? 'swamp' : 'forest';
      if (m > 0.45) return 'forest';
      if (m < 0.25) return 'desert';
      return 'plains';
    };
    for (const r of rows) {
      const terrain = terrainOf(r.q, r.r);
      await tx.update(hexes).set({ terrain }).where(eq(hexes.id, r.id));
      r.terrain = terrain;
    }
    const land = (q: number, r: number) => {
      const x = byKey.get(key(q, r));
      return x && x.terrain !== 'water' && x.terrain !== 'deep' ? x : undefined;
    };
    // Pick capitals: nearest land hex to target offset positions.
    const nearestLand = (q0: number, r0: number) => rows
      .filter((x) => land(x.q, x.r))
      .sort((a, b) => distance(a, { q: q0, r: r0 }) - distance(b, { q: q0, r: r0 }))[0];
    const covenantSeat = nearestLand(15, -3);
    const valcourtSeat = nearestLand(7, 4);

    // ---- meters
    const defs = await tx.select().from(meterDefinitions).where(eq(meterDefinitions.worldId, world.id));
    const morale = defs.find((d) => d.key === 'morale')!;
    const treasury = defs.find((d) => d.key === 'treasury')!;
    const [zeal, grandeur] = await tx.insert(meterDefinitions).values([
      { worldId: world.id, key: 'zeal', name: 'Zeal', kind: 'signature', min: 0, max: 100, defaultValue: 70, bands: SIGNATURE_BANDS, sortOrder: 2,
        description: 'Fervor of the faithful. Erodes when the faction compromises its creed.' },
      { worldId: world.id, key: 'grandeur', name: 'Grandeur', kind: 'signature', min: 0, max: 100, defaultValue: 70, bands: SIGNATURE_BANDS, sortOrder: 3,
        description: 'Prestige and display. Erodes when the faction is seen to be small, poor, or humbled.' },
    ]).returning();

    // ---- wiki
    const pageRows = await tx.insert(wikiPages).values([
      { worldId: world.id, title: 'The Sundered Reach', category: 'Place' },
      { worldId: world.id, title: 'The Ashen Covenant', category: 'Faction' },
      { worldId: world.id, title: 'House Valcourt', category: 'Faction' },
      { worldId: world.id, title: 'Port Halvard', category: 'Place' },
      { worldId: world.id, title: 'The Long Charter', category: 'Lore' },
      { worldId: world.id, title: 'Prelate Siris Vane', category: 'Person' },
    ]).returning();
    const P = Object.fromEntries(pageRows.map((p) => [p.title, p.id]));
    const contents: Record<string, ReturnType<typeof doc>> = {
      'The Sundered Reach': doc(
        h(2, 'Overview'),
        para('A frontier of broken coast and highland moors, split between ', link(P['The Ashen Covenant'], 'The Ashen Covenant'),
          ' in the eastern hills and ', link(P['House Valcourt'], 'House Valcourt'), ' along the western shore.'),
        para('The party holds ', link(P['The Long Charter'], 'The Long Charter'), ', a royal grant to settle and trade, and operates out of ',
          link(P['Port Halvard'], 'Port Halvard'), '.'),
        h(2, 'Rumors'),
        ul(['Storms off the Reach have not let up in three seasons.'], ['Ash falls on the eastern moors when the Covenant burns its dead.']),
      ),
      'The Ashen Covenant': doc(
        para('A militant faith that believes the Reach was sundered as punishment. Led by ', link(P['Prelate Siris Vane'], 'Prelate Siris Vane'), '.'),
        h(2, 'Signature: Zeal'),
        para('Zeal is slipping since the Covenant began trading grain with ', link(P['House Valcourt'], 'House Valcourt'), '. Every compromise costs the faithful.'),
      ),
      'House Valcourt': doc(
        para('An old noble house whose fortunes rose with the harbor at ', link(P['Port Halvard'], 'Port Halvard'), '.'),
        h(2, 'Signature: Grandeur'),
        para('Valcourt spends lavishly to look larger than it is. Grandeur is high, Treasury feels it.'),
      ),
      'Port Halvard': doc(
        para('Walled harbor city and seat of ', link(P['House Valcourt'], 'House Valcourt'), '. The chartered company keeps a warehouse on the Saltgate wharf.'),
        ul(['Population: about 8,000'], ['Exports: salt fish, timber, wool']),
      ),
      'The Long Charter': doc(
        para('Royal grant held by the party’s company. It permits settlement of unclaimed hexes in ', link(P['The Sundered Reach'], 'The Sundered Reach'), ' and tax-free trade through ', link(P['Port Halvard'], 'Port Halvard'), ' for ten years.'),
      ),
      'Prelate Siris Vane': doc(
        para('Leader of ', link(P['The Ashen Covenant'], 'The Ashen Covenant'), '. Publicly uncompromising; privately signed the grain accord.'),
      ),
    };
    for (const [title, content] of Object.entries(contents)) {
      await tx.update(wikiPages).set({ content, contentText: docText(content) }).where(eq(wikiPages.id, P[title]));
      const targets = docLinks(content);
      if (targets.length) await tx.insert(wikiLinks).values(targets.map((to) => ({ fromPageId: P[title], toPageId: to }))).onConflictDoNothing();
    }

    // ---- factions
    const [covenant, valcourt] = await tx.insert(factions).values([
      { worldId: world.id, name: 'The Ashen Covenant', color: '#c0392b', signatureMeterId: zeal.id, wikiPageId: P['The Ashen Covenant'],
        description: 'Militant faith of the eastern moors.' },
      { worldId: world.id, name: 'House Valcourt', color: '#3b6fd4', signatureMeterId: grandeur.id, wikiPageId: P['House Valcourt'],
        description: 'Old coastal nobility with more pride than coin.' },
    ]).returning();
    const history: [typeof covenant, typeof morale, number, number, string][] = [
      [covenant, morale, 72, 120, 'Founding value'],
      [covenant, zeal, 74, 120, 'Founding value'],
      [covenant, treasury, 900, 120, 'Founding value'],
      [covenant, zeal, 55, 131, 'Signed the grain accord with House Valcourt'],
      [covenant, zeal, 38, 139, 'Prelate seen dining at the Valcourt table'],
      [covenant, morale, 64, 140, 'Zeal erosion cascades into Morale'],
      [covenant, treasury, 1200, 141, 'Grain accord payments'],
      [valcourt, morale, 78, 120, 'Founding value'],
      [valcourt, grandeur, 66, 120, 'Founding value'],
      [valcourt, treasury, 6200, 120, 'Founding value'],
      [valcourt, grandeur, 71, 133, 'Midsummer tourney at Port Halvard'],
      [valcourt, treasury, 5400, 133, 'Paid for the tourney'],
      [valcourt, morale, 82, 134, 'Tourney victory'],
    ];
    const prev = new Map<string, number>();
    for (const [f, m, value, day, cause] of history) {
      const k = f.id + m.id;
      await tx.insert(meterValues).values({ factionId: f.id, meterId: m.id, value })
        .onConflictDoUpdate({ target: [meterValues.factionId, meterValues.meterId], set: { value } });
      await tx.insert(meterChanges).values({ worldId: world.id, factionId: f.id, meterId: m.id, oldValue: prev.get(k) ?? null, newValue: value, cause, gameDay: day });
      if (prev.has(k)) {
        await tx.insert(events).values({ worldId: world.id, gameDay: day, kind: 'meter.changed',
          summary: `${f.name} ${m.name} ${prev.get(k)} → ${value}: ${cause}`,
          payload: { factionId: f.id, meterId: m.id, oldValue: prev.get(k), newValue: value } });
      }
      prev.set(k, value);
    }

    // ---- claims: blobs around each seat
    const claimAround = async (seat: typeof rows[number], factionId: string, radius: number, day: number) => {
      const owned = rows.filter((x) => land(x.q, x.r) && distance(x, seat) <= radius);
      for (const x of owned) {
        await tx.insert(claims).values({ hexId: x.id, factionId, kind: 'control', sinceDay: day }).onConflictDoNothing();
        await tx.update(hexes).set({ state: distance(x, seat) <= 1 ? 'settled' : 'wild' }).where(eq(hexes.id, x.id));
      }
      return owned.length;
    };
    const nCov = await claimAround(covenantSeat, covenant.id, 3, 100);
    const nVal = await claimAround(valcourtSeat, valcourt.id, 3, 90);
    // A contested border hex between them.
    const mid = nearestLand(Math.round((covenantSeat.q + valcourtSeat.q) / 2), Math.round((covenantSeat.r + valcourtSeat.r) / 2));
    await tx.update(hexes).set({ state: 'contested', notes: 'Both factions run patrols through here. Grain caravans pass on the old road.' }).where(eq(hexes.id, mid.id));
    await tx.insert(claims).values([
      { hexId: mid.id, factionId: covenant.id, kind: 'contested', sinceDay: 136 },
      { hexId: mid.id, factionId: valcourt.id, kind: 'contested', sinceDay: 136 },
    ]).onConflictDoNothing();
    await tx.insert(events).values([
      { worldId: world.id, gameDay: 90, kind: 'claim.changed', summary: `House Valcourt claims ${nVal} hexes around Port Halvard` },
      { worldId: world.id, gameDay: 100, kind: 'claim.changed', summary: `The Ashen Covenant claims ${nCov} hexes in the eastern moors` },
      { worldId: world.id, gameDay: 136, kind: 'claim.changed', summary: `Hex ${hexLabel(mid.q, mid.r, 'flat')} becomes contested between the Covenant and Valcourt` },
    ]);

    // ---- settlement token
    await tx.update(hexes).set({ name: 'Saltgate', wikiPageId: P['Port Halvard'], notes: 'Walled harbor. Company warehouse on the wharf.' }).where(eq(hexes.id, valcourtSeat.id));
    const [halvard] = await tx.insert(settlements).values({
      worldId: world.id, name: 'Port Halvard', size: 'city', population: 8000, factionId: valcourt.id, wikiPageId: P['Port Halvard'],
      notes: 'Seat of House Valcourt.',
    }).returning();
    await tx.insert(tokens).values({
      worldId: world.id, mapId: map.id, hexId: valcourtSeat.id, kind: 'city', name: 'Port Halvard',
      factionId: valcourt.id, settlementId: halvard.id,
    });

    // ---- campaign, party, fog
    const [camp] = await tx.insert(campaigns).values({ worldId: world.id, name: 'The Long Charter', system: 'Pathfinder 2e', notes: 'Main campaign.' }).returning();
    await tx.insert(tokens).values({
      worldId: world.id, mapId: map.id, hexId: valcourtSeat.id, kind: 'party', name: 'Charter Company', campaignId: camp.id, color: '#f2d27a',
    });
    const explored = rows.filter((x) => distance(x, valcourtSeat) <= 3 || distance(x, mid) <= 1);
    await tx.insert(campaignFog).values(explored.map((x) => ({ campaignId: camp.id, hexId: x.id, sinceDay: 120 }))).onConflictDoNothing();

    // ---- roll table on the eroding band
    const [table] = await tx.insert(rollTables).values({
      worldId: world.id, factionId: covenant.id, meterId: zeal.id, band: 'Eroding', name: 'Covenant: Faith Wavers',
    }).returning();
    await tx.insert(rollTableEntries).values([
      { tableId: table.id, kind: 'event', title: 'Flagellant march', text: 'Zealots march on the nearest Valcourt holding demanding the accord be burned.', weight: 3 },
      { tableId: table.id, kind: 'status', title: 'Schism whispers', text: 'Persistent: -1 Morale each week until the Prelate makes a public penance.', weight: 2 },
      { tableId: table.id, kind: 'calamity', title: 'The Ash Pyre', text: 'A heretic burning gets out of hand; a settled hex becomes Ruined.', weight: 1 },
      { tableId: table.id, kind: 'event', title: 'Defectors to the Charter', text: 'Disillusioned acolytes seek work with the party’s company.', weight: 2,
        approved: false, source: 'ai' },
    ]);
    await tx.insert(events).values([
      { worldId: world.id, gameDay: 120, kind: 'note', summary: 'The Long Charter campaign begins at Port Halvard', campaignId: camp.id },
      { worldId: world.id, gameDay: 141, kind: 'note', summary: 'Storm season closes the northern sea lanes', actor: 'gm' },
    ]);
    return world;
  });
}

export async function deleteWorld(db: Db, id: string) {
  await db.delete(worlds).where(eq(worlds.id, id));
}
