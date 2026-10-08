import fs from 'node:fs';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from './db/index.js';
import {
  campaigns, campaignFog, claims, factions, hexes, maps, meterDefinitions, meterValues,
  rollTableEntries, rollTables, settlements, tokens, wikiLinks, wikiPages, worlds, events, meterChanges, mapArt,
} from './db/schema.js';
import { DEFAULT_HEX_STATES, DEFAULT_TERRAIN, MORALE_BANDS, SIGNATURE_BANDS } from './defaults.js';
import { rectangle, key, distance, hexLabel, axialToOffset, offsetToAxial, DIRS, type Orientation } from '../shared/hex.js';
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

/** The demo's painted map and the per-hex terrain classified from it (see scripts/bake-demo-art.mjs). */
type DemoArt = { cols: number; rows: number; width: number; height: number; rect: { x: number; y: number; w: number; h: number }; terrain: string[] };
export const DEMO_VERSION = 'reach-v2';
function demoAsset(name: string) { return fs.readFileSync(new URL(`./assets/${name}`, import.meta.url)); }

export async function seedDemoWorld(db: Db, opts: { name?: string; sortOrder?: number; replaces?: string } = {}) {
  const art = JSON.parse(demoAsset('demo-map.json').toString('utf8')) as DemoArt;
  const image = demoAsset('demo-map.webp');
  return db.transaction(async (tx) => {
    if (opts.replaces) await tx.delete(worlds).where(eq(worlds.id, opts.replaces));
    const { world, map } = await createWorld(tx, {
      name: opts.name ?? 'The Sundered Reach', cols: art.cols, rows: art.rows, orientation: 'flat', accent: '#d4a64a',
      description: 'A storm-cut frontier where a chartered company carves out holdings between a zealot covenant and a proud old house.',
    });
    await tx.update(worlds).set({ currentDay: 142, demo: DEMO_VERSION, sortOrder: opts.sortOrder ?? 0 }).where(eq(worlds.id, world.id));
    await tx.insert(mapArt).values({
      mapId: map.id, mime: 'image/webp', bytes: image, width: art.width, height: art.height,
      placement: { ...art.rect, opacity: 1 },
    });

    // Terrain comes from the painting, so the hexes read true over the art.
    const rows = await tx.select().from(hexes).where(eq(hexes.mapId, map.id));
    const byKey = new Map(rows.map((r) => [key(r.q, r.r), r]));
    const byTerrain = new Map<string, string[]>();
    for (const r of rows) {
      const { col, row } = axialToOffset(r.q, r.r, 'flat');
      r.terrain = art.terrain[row * art.cols + col] ?? 'unknown';
      byTerrain.set(r.terrain, [...(byTerrain.get(r.terrain) ?? []), r.id]);
    }
    for (const [terrain, ids] of byTerrain) await tx.update(hexes).set({ terrain }).where(inArray(hexes.id, ids));
    const isLand = (x: { terrain: string } | undefined) => !!x && x.terrain !== 'water' && x.terrain !== 'deep';
    const at = (col: number, row: number) => { const a = offsetToAxial(col, row, 'flat'); return byKey.get(key(a.q, a.r)); };
    const coastal = (x: typeof rows[number]) => DIRS.flat.some((d) => { const n = byKey.get(key(x.q + d.q, x.r + d.r)); return n && !isLand(n); });
    // Nearest hex to an offset position that passes a test.
    const nearest = (col: number, row: number, ok: (x: typeof rows[number]) => boolean) => {
      const c = at(col, row)!;
      return rows.filter(ok).sort((a, b) => distance(a, c) - distance(b, c))[0];
    };
    const valcourtSeat = nearest(5, 9, (x) => isLand(x) && coastal(x) && x.terrain !== 'mountains');
    const covenantSeat = nearest(21, 7, (x) => isLand(x) && (x.terrain === 'hills' || x.terrain === 'plains'));

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
        para('A militant faith that believes the Reach was sundered as punishment. Led by ', link(P['Prelate Siris Vane'], 'Prelate Siris Vane'), ' from Cinderhold, in the shadow of the fire mountain.'),
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

    // ---- claims: each house spreads over land from its seat; where the fronts meet is contested.
    const reach = (seat: typeof rows[number], max: number) => {
      const dist = new Map([[seat.id, 0]]);
      let frontier = [seat];
      for (let d = 1; d <= max; d++) {
        const next: typeof rows = [];
        for (const h0 of frontier) for (const dd of DIRS.flat) {
          const n = byKey.get(key(h0.q + dd.q, h0.r + dd.r));
          if (!n || !isLand(n) || dist.has(n.id) || n.terrain === 'tundra') continue;
          dist.set(n.id, d); next.push(n);
        }
        frontier = next;
      }
      return dist;
    };
    const dV = reach(valcourtSeat, 10), dC = reach(covenantSeat, 10);
    const ctrlV: string[] = [], ctrlC: string[] = [], front: typeof rows = [];
    for (const x of rows) {
      const v = dV.get(x.id), c = dC.get(x.id);
      if (v === undefined && c === undefined) continue;
      if (v !== undefined && c !== undefined && Math.abs(v - c) <= 1 && v >= 3) { front.push(x); continue; }
      if (v !== undefined && (c === undefined || v < c) && v <= 7) ctrlV.push(x.id);
      else if (c !== undefined && (v === undefined || c < v) && c <= 7) ctrlC.push(x.id);
    }
    await tx.insert(claims).values([
      ...ctrlV.map((hexId) => ({ hexId, factionId: valcourt.id, kind: 'control' as const, sinceDay: 90 })),
      ...ctrlC.map((hexId) => ({ hexId, factionId: covenant.id, kind: 'control' as const, sinceDay: 100 })),
    ]).onConflictDoNothing();
    const settled = rows.filter((x) => distance(x, valcourtSeat) <= 1 || distance(x, covenantSeat) <= 1).map((x) => x.id).filter((id) => ctrlV.includes(id) || ctrlC.includes(id));
    await tx.update(hexes).set({ state: 'settled' }).where(inArray(hexes.id, settled));
    // The contested front: the three most central hexes where both houses reach each other.
    const mid = front.sort((a, b) => Math.abs(dV.get(a.id)! - dC.get(a.id)!) - Math.abs(dV.get(b.id)! - dC.get(b.id)!)).slice(0, 3);
    for (const x of mid) {
      await tx.insert(claims).values([
        { hexId: x.id, factionId: covenant.id, kind: 'contested', sinceDay: 136 },
        { hexId: x.id, factionId: valcourt.id, kind: 'contested', sinceDay: 136 },
      ]).onConflictDoNothing();
    }
    await tx.update(hexes).set({ state: 'contested' }).where(inArray(hexes.id, mid.map((x) => x.id)));
    const pass = mid[0];
    await tx.update(hexes).set({ name: 'Cinder Ford', notes: 'Both houses run patrols through here. Grain caravans pass on the old road.' }).where(eq(hexes.id, pass.id));
    await tx.insert(events).values([
      { worldId: world.id, gameDay: 90, kind: 'claim.changed', summary: `House Valcourt claims ${ctrlV.length} hexes around Port Halvard` },
      { worldId: world.id, gameDay: 100, kind: 'claim.changed', summary: `The Ashen Covenant claims ${ctrlC.length} hexes in the eastern moors` },
      { worldId: world.id, gameDay: 136, kind: 'claim.changed', summary: `${mid.map((x) => hexLabel(x.q, x.r, 'flat')).join(', ')} become contested between the Covenant and Valcourt` },
    ]);

    // ---- settlements and markers
    await tx.update(hexes).set({ name: 'Saltgate', wikiPageId: P['Port Halvard'], notes: 'Walled harbor. Company warehouse on the wharf.' }).where(eq(hexes.id, valcourtSeat.id));
    await tx.update(hexes).set({ name: 'Cinderhold', notes: 'Seat of the Prelate. The pyres never quite go out.' }).where(eq(hexes.id, covenantSeat.id));
    const outpostV = rows.filter((x) => ctrlV.includes(x.id) && distance(x, valcourtSeat) === 3 && x.terrain !== 'mountains')
      .sort((a, b) => (dC.get(a.id) ?? 99) - (dC.get(b.id) ?? 99))[0];
    const outpostC = rows.filter((x) => ctrlC.includes(x.id) && distance(x, covenantSeat) === 3 && x.terrain !== 'mountains')
      .sort((a, b) => (dV.get(a.id) ?? 99) - (dV.get(b.id) ?? 99))[0];
    const [halvard, cinderhold, greywatch, emberfast] = await tx.insert(settlements).values([
      { worldId: world.id, name: 'Port Halvard', size: 'city', population: 8000, factionId: valcourt.id, wikiPageId: P['Port Halvard'], notes: 'Seat of House Valcourt.' },
      { worldId: world.id, name: 'Cinderhold', size: 'city', population: 3500, factionId: covenant.id, notes: 'Seat of the Ashen Covenant.' },
      { worldId: world.id, name: 'Greywatch', size: 'outpost', population: 120, factionId: valcourt.id, notes: 'Valcourt watchtower facing the moors.' },
      { worldId: world.id, name: 'Emberfast', size: 'outpost', population: 80, factionId: covenant.id, notes: 'Covenant shrine-fort on the western road.' },
    ]).returning();
    const tokenRows: (typeof tokens.$inferInsert)[] = [
      { worldId: world.id, mapId: map.id, hexId: valcourtSeat.id, kind: 'city', name: 'Port Halvard', factionId: valcourt.id, settlementId: halvard.id },
      { worldId: world.id, mapId: map.id, hexId: covenantSeat.id, kind: 'city', name: 'Cinderhold', factionId: covenant.id, settlementId: cinderhold.id },
    ];
    if (outpostV) tokenRows.push({ worldId: world.id, mapId: map.id, hexId: outpostV.id, kind: 'outpost', name: 'Greywatch', factionId: valcourt.id, settlementId: greywatch.id });
    if (outpostC) tokenRows.push({ worldId: world.id, mapId: map.id, hexId: outpostC.id, kind: 'outpost', name: 'Emberfast', factionId: covenant.id, settlementId: emberfast.id });
    const near = rows.filter((x) => ctrlC.includes(x.id) && distance(x, pass) === 1)[0];
    if (near) tokenRows.push({ worldId: world.id, mapId: map.id, hexId: near.id, kind: 'unit', name: 'Ash Wardens', factionId: covenant.id });
    await tx.insert(tokens).values(tokenRows);

    // ---- campaign, party, fog
    const [camp] = await tx.insert(campaigns).values({ worldId: world.id, name: 'The Long Charter', system: 'Pathfinder 2e', notes: 'Main campaign.' }).returning();
    await tx.insert(tokens).values({
      worldId: world.id, mapId: map.id, hexId: valcourtSeat.id, kind: 'party', name: 'Charter Company', campaignId: camp.id, color: '#f2d27a',
    });
    const explored = rows.filter((x) => distance(x, valcourtSeat) <= 3 || mid.some((m) => distance(x, m) <= 1));
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

/**
 * Brings an older bundled demo up to the current one. An untouched demo is replaced
 * in place; one the GM has worked in is kept as is and the new demo is added beside it.
 */
export async function upgradeDemo(db: Db): Promise<string[]> {
  const notes: string[] = [];
  const old = await db.select().from(worlds).where(and(sql`${worlds.demo} is not null`, ne(worlds.demo, DEMO_VERSION), sql`${worlds.demo} not like '%-kept'`));
  for (const w of old) {
    const since = new Date(w.createdAt.getTime() + 10 * 60_000);
    const [{ n }] = await db.select({ n: sql<number>`(
      (select count(*) from ${events} where ${events.worldId} = ${w.id} and ${events.createdAt} > ${since}) +
      (select count(*) from ${hexes} h join ${maps} m on m.id = h.map_id where m.world_id = ${w.id} and h.updated_at > ${since}) +
      (select count(*) from ${wikiPages} where ${wikiPages.worldId} = ${w.id} and ${wikiPages.updatedAt} > ${since}) +
      (select count(*) from ${meterChanges} where ${meterChanges.worldId} = ${w.id} and ${meterChanges.createdAt} > ${since})
    )::int` }).from(sql`(select 1) as one`);
    if (n === 0 && w.updatedAt <= since) {
      await seedDemoWorld(db, { replaces: w.id, name: w.name, sortOrder: w.sortOrder });
      notes.push(`replaced untouched demo "${w.name}" with ${DEMO_VERSION}`);
    } else {
      await db.update(worlds).set({ demo: `${w.demo}-kept` }).where(eq(worlds.id, w.id));
      await seedDemoWorld(db, { name: `${w.name} (painted)`, sortOrder: w.sortOrder });
      notes.push(`kept edited demo "${w.name}" and added ${DEMO_VERSION} beside it`);
    }
  }
  return notes;
}

export async function deleteWorld(db: Db, id: string) {
  await db.delete(worlds).where(eq(worlds.id, id));
}
