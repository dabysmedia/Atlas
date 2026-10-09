/**
 * Imports the owner's setting document (server/assets/lore/the-new-world-island.md) as an ordinary world:
 * linked wiki pages, the seven factions with their signature meters, and an unclaimed island grid.
 *
 * The text is carried over line for line. The only things added are clearly labelled import notes
 * (where the source marks something open, unfinished, or missing), a source line on every page, and links.
 * The only things changed are listed in FIXES. Re-running it creates another world; deleting that world removes it all.
 */
import fs from 'node:fs';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/index.js';
import { appMeta, events, factions, hexes, mapModel, mapModelArchive, maps, meterDefinitions, wikiLinks, wikiPages, worlds } from '../db/schema.js';
import { fitModelPlacement } from '../placement.js';
import { installModel } from '../modelArchive.js';
import { SIGNATURE_BANDS } from '../defaults.js';
import { setMeter, logEvent } from '../history.js';
import { axialToOffset } from '../../shared/hex.js';
import { createWorld } from '../worlds.js';
import { docLinks, docText } from '../wikidoc.js';

export const LORE_FILE = 'the-new-world-island.md';
export const LORE_SEED_KEY = 'seed:the-new-world';

type Node = Record<string, unknown>;
const t = (text: string, marks?: Node[]): Node => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const bold = [{ type: 'bold' }];
const italic = [{ type: 'italic' }];

// ---------------------------------------------------------------- source lines

/** Repairs to the text, keyed by 1-based source line. Each is reported back to the owner. */
export const FIXES: Record<number, { from: string; to: string; why: string }> = {
  887: { from: 'hey broke', to: 'They broke', why: 'first letter dropped' },
  907: { from: 'ther modifications', to: 'Other modifications', why: 'first letter dropped' },
  924: { from: 'Placeholder name: The AelariT', to: 'Placeholder name: The Aelari', why: 'the "T" of the next line\'s "The" landed here' },
  926: { from: 'e Aelari see', to: 'The Aelari see', why: 'first letters landed on the line above' },
  978: { from: 'heir internal', to: 'Their internal', why: 'first letter dropped' },
  2024: { from: 'Campaign Structure****', to: 'Campaign Structure', why: 'stray asterisks in the heading' },
};

type Line = { n: number; text: string };

function sourceLines(): Line[] {
  const raw = fs.readFileSync(new URL(`../assets/lore/${LORE_FILE}`, import.meta.url), 'utf8').replace(/\r\n?/g, '\n').split('\n');
  return raw.map((text, i) => {
    const n = i + 1;
    const fix = FIXES[n];
    if (fix) {
      if (!text.includes(fix.from)) throw new Error(`lore import: line ${n} no longer reads "${fix.from}"; the bundled file changed`);
      text = text.replace(fix.from, fix.to);
    }
    return { n, text: text.trimEnd() };
  });
}

// ---------------------------------------------------------------- manifest

type PageKey =
  | 'index' | 'core' | 'geo' | 'mendoza' | 'dupont' | 'qadir' | 'nhalkesh' | 'flesh' | 'aelari' | 'canopy'
  | 'hub' | 'precursor' | 'spine' | 'entrances' | 'colonial' | 'campaign' | 'loop' | 'facts' | 'unresolved'
  | 'time' | 'magic' | 'ancient' | 'tone' | 'open';

type Callout = { label: string; text: string };
type PageSpec = {
  key: PageKey; title: string; category: string;
  /** Callouts shown at the top of the page, before the source text. */
  notes?: Callout[];
  /** Child headings become a bullet list (the source typed list items as headings). */
  headingsAsList?: boolean;
};

/** Pages in source order. Titles are the source's own headings, or the name the source gives the faction. */
const PAGES: PageSpec[] = [
  { key: 'core', title: 'Core Setting', category: 'Lore', notes: [
    { label: 'Unresolved in the source', text: 'Two sentences end in blanks ("beyond the ______" and "because of ______"). Why the seas were impassable, and why they opened, are not settled yet; the source lists possibilities in brackets.' },
  ] },
  { key: 'geo', title: 'Geography of the Island', category: 'Place' },
  { key: 'mendoza', title: 'Casa de Mendoza', category: 'Faction' },
  { key: 'dupont', title: 'Company DuPont', category: 'Faction' },
  { key: 'qadir', title: 'The Qadir Ascendancy', category: 'Faction' },
  { key: 'nhalkesh', title: 'The Nhal’Kesh', category: 'Faction' },
  { key: 'flesh', title: 'The Flesh-Shapers', category: 'Faction' },
  { key: 'aelari', title: 'The Aelari', category: 'Faction' },
  { key: 'canopy', title: 'The Canopy People', category: 'Faction', notes: [
    { label: 'Unfinished in the source', text: 'The Canopy People are marked WIP elsewhere in the document (their section on the mage city and their place in the shared history). What is below is everything the source says about them so far.' },
  ] },
  { key: 'hub', title: 'The Mage City Within the Mountain', category: 'Place' },
  { key: 'precursor', title: 'The Precursor Mages', category: 'Lore' },
  { key: 'spine', title: 'A Shared Historical Spine', category: 'Lore' },
  { key: 'entrances', title: 'Entrances, Routes, and Native Knowledge', category: 'Place' },
  { key: 'colonial', title: 'Colonial Discovery and Campaign Escalation', category: 'Lore' },
  { key: 'campaign', title: 'Campaign Structure', category: 'Campaign' },
  { key: 'loop', title: 'Core Campaign Loop', category: 'Campaign' },
  { key: 'facts', title: 'Established Facts About the Precursor City', category: 'Lore', headingsAsList: true },
  { key: 'unresolved', title: 'Still Intentionally Unresolved', category: 'Lore', headingsAsList: true, notes: [
    { label: 'Open by design', text: 'The source deliberately leaves everything on this page unresolved. None of it is canon yet.' },
  ] },
  { key: 'time', title: 'Time Period and Technology', category: 'Lore' },
  { key: 'magic', title: 'Magic Level', category: 'Lore' },
  { key: 'ancient', title: 'Ancient Magic', category: 'Lore' },
  { key: 'tone', title: 'Tone of the Setting', category: 'Lore' },
  { key: 'open', title: 'Open Questions / Co-DM Discussion', category: 'Lore', notes: [
    { label: 'Discussion, not canon', text: 'This is the source’s running list of questions and ideas between co-DMs. The answers jotted under some questions are suggestions, not decisions. Two questions (what caused the teleportation, and when the city arrived) are answered on Established Facts About the Precursor City; the source doesn’t say whether those answers settle them.' },
  ] },
];

/**
 * Where each page's text starts, by exact source line. A page runs until the next entry.
 * The mage city appears twice: its chronology is long enough to be its own page, and the
 * sections after it return to the city.
 */
const SEGMENTS: { key: PageKey; line: string; level: number; continues?: boolean }[] = [
  { key: 'core', line: '### Core Setting', level: 3 },
  { key: 'geo', line: '## Geography of the Island', level: 2 },
  { key: 'mendoza', line: '## Chartered Company: Mendoza', level: 2 },
  { key: 'dupont', line: '## Chartered Company: Company DuPont', level: 2 },
  { key: 'qadir', line: '## Chartered Company — The Qadir Ascendancy', level: 2 },
  { key: 'nhalkesh', line: '## Native Civilization I — The Ritualistic People', level: 2 },
  { key: 'flesh', line: '### The Flesh-Shapers — a Nhal’Kesh splinter sect', level: 3 },
  { key: 'aelari', line: '## Native Civilization II — The Spiritual / Nature-Oriented People', level: 2 },
  { key: 'canopy', line: 'Native Civilization III — The Canopy People', level: 2 },
  { key: 'hub', line: '## The Mage City Within the Mountain', level: 2 },
  { key: 'precursor', line: '### The Precursor Mages — Chronological Summary', level: 3 },
  { key: 'hub', line: '### The Arrival (how the natives react)', level: 2, continues: true },
  { key: 'spine', line: '### A Shared Historical Spine', level: 3 },
  { key: 'entrances', line: '### Entrances, Routes, and Native Knowledge', level: 3 },
  { key: 'colonial', line: '### Colonial Discovery and Campaign Escalation', level: 3 },
  { key: 'campaign', line: '### Campaign Structure', level: 3 },
  { key: 'loop', line: '### Core Campaign Loop', level: 3 },
  { key: 'facts', line: '### Established Facts About the Precursor City', level: 3 },
  { key: 'unresolved', line: '### Still Intentionally Unresolved', level: 3 },
  { key: 'time', line: '### Time Period and Technology', level: 3 },
  { key: 'magic', line: '### Magic Level', level: 3 },
  { key: 'ancient', line: '### Ancient Magic', level: 3 },
  { key: 'tone', line: '### Tone of the Setting', level: 3 },
  { key: 'open', line: '### Open Questions / Co-DM Discussion', level: 3 },
];

/** Single lines that need a label rather than plain prose. */
const LINE_NOTES: Record<number, Callout> = {
  198: { label: 'Image not included', text: 'The source has an image here, captioned: “The golden fortress and radiant sun of Casa de Mendoza”.' },
  396: { label: 'Image not included', text: 'The source has an image here, captioned: “The book, astrolabe, fleur-de-lis, and laurels of Company DuPont”.' },
  604: { label: 'Image not included', text: 'The source has an image here, captioned: “The ordered star and hidden crescent of the Qadir Ascendancy”.' },
  802: { label: 'Placeholder name', text: 'The Nhal’Kesh' },
  924: { label: 'Placeholder name', text: 'The Aelari' },
  946: { label: 'Working note in the source', text: 'Fey type shit? The Na’Vi from avatar' },
  1014: { label: 'Working note in the source', text: 'Planet of the apes? Humanoid Ape-men and Bigass Birds' },
  1961: { label: 'Unfinished in the source', text: 'WIP. The source hasn’t written how the Canopy People relate to the mage city yet.' },
  1991: { label: 'Unfinished in the source', text: 'Canopy People: WIP.' },
};

/** Source lines typed as headings that read as a subtitle. */
const SUBTITLES = new Set([2342]);

/** Names in running text that link to a page. Longest first; each page links a target once. */
const ALIASES: [string, PageKey, boolean?][] = [
  ['The New World', 'index'],
  ['Casa de Mendoza', 'mendoza'], ['Mendoza', 'mendoza'],
  ['Company DuPont', 'dupont'], ['DuPont', 'dupont'],
  ['Qadir Ascendancy', 'qadir'], ['Qadir', 'qadir'],
  ['Flesh-Shapers', 'flesh'], ['Flesh-Shaper', 'flesh'],
  ['Nhal’Kesh', 'nhalkesh'], ['Nhal’kesh', 'nhalkesh'],
  ['Aelari', 'aelari'],
  ['Canopy People', 'canopy'],
  ['College of Mages', 'precursor'], ['Council of Thirteen', 'precursor'],
  ['Precursor City', 'hub'], ['mage city', 'hub', true],
  ['Established Facts About the Precursor City', 'facts'],
];

// ---------------------------------------------------------------- conversion

type Block =
  | { kind: 'heading'; level: number; text: string; n: number }
  | { kind: 'para'; text: string; n: number; italic?: boolean }
  | { kind: 'list'; items: { text: string; n: number }[] }
  | { kind: 'note'; note: Callout; n: number };

/** One source line is one paragraph. A line ending in ":" followed by comma-ended lines is an enumerated list. */
function blocksOf(lines: Line[], spec: PageSpec, baseLevel: number): Block[] {
  const out: Block[] = [];
  const body = lines.filter((l) => l.text.trim() !== '');
  for (let i = 0; i < body.length; i++) {
    const { n, text } = body[i];
    if (LINE_NOTES[n]) { out.push({ kind: 'note', note: LINE_NOTES[n], n }); continue; }
    const hm = /^(#{1,6})\s+(.*)$/.exec(text);
    if (hm && SUBTITLES.has(n)) { out.push({ kind: 'para', text: hm[2].trim(), n, italic: true }); continue; }
    if (hm) {
      const level = hm[1].length;
      const htext = hm[2].trim();
      if (spec.headingsAsList && level >= baseLevel) {
        const prev = out[out.length - 1];
        const item = { text: htext, n };
        if (prev?.kind === 'list') prev.items.push(item); else out.push({ kind: 'list', items: [item] });
      } else {
        out.push({ kind: 'heading', level: Math.min(3, Math.max(2, level - baseLevel + 1)), text: htext, n });
      }
      continue;
    }
    out.push({ kind: 'para', text: text.trim(), n });
    if (text.trim().endsWith(':')) {
      const items: { text: string; n: number }[] = [];
      let j = i + 1;
      while (j < body.length && body[j].text.trim().endsWith(',') && body[j].text.length < 90 && !body[j].text.startsWith('#')) items.push({ text: body[j].text.trim(), n: body[j++].n });
      if (items.length && j < body.length && /\.$/.test(body[j].text.trim()) && body[j].text.length < 90) items.push({ text: body[j].text.trim(), n: body[j++].n });
      if (items.length >= 2) { out.push({ kind: 'list', items }); i = j - 1; }
    }
  }
  return out;
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const aliasRe = new RegExp(`(?<![\\p{L}\\p{N}])(${ALIASES.map(([a]) => escapeRe(a)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

/** Turns a run of text into text and link nodes, linking each target page once per page. */
const titles: Record<string, string> = { index: 'The New World', ...Object.fromEntries(PAGES.map((p) => [p.key, p.title])) };

function linkify(text: string, self: PageKey, ids: Record<string, string>, used: Set<string>): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(aliasRe)) {
    const alias = ALIASES.find(([a, , ci]) => (ci ? a.toLowerCase() === m[0].toLowerCase() : a === m[0]));
    if (!alias) continue;
    const target = alias[1];
    if (target === self || used.has(target) || !ids[target]) continue;
    used.add(target);
    if (m.index! > last) out.push(t(text.slice(last, m.index)));
    // The link keeps the source's own wording; the page title is only shown where they match.
    const title = titles[target];
    out.push({ type: 'wikiLink', attrs: { pageId: ids[target], label: title, ...(title === m[0] ? {} : { text: m[0] }) } });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(t(text.slice(last)));
  return out;
}

/** "Origin: the civilization began..." keeps its label in bold, as the source's list reads. */
function labelled(text: string, self: PageKey, ids: Record<string, string>, used: Set<string>): Node[] {
  const m = /^([A-Z][\w ’'-]{0,40}):\s(.*)$/.exec(text);
  if (!m) return linkify(text, self, ids, used);
  return [t(`${m[1]}:`, bold), t(' '), ...linkify(m[2], self, ids, used)];
}

const callout = (c: Callout): Node => ({
  type: 'blockquote',
  content: [{ type: 'paragraph', content: [t(`${c.label}. `, bold), t(c.text)] }],
});
const para = (content: Node[]): Node => ({ type: 'paragraph', ...(content.length ? { content } : {}) });

function toDoc(blocks: Block[], self: PageKey, ids: Record<string, string>, head: Node[]) {
  const used = new Set<string>();
  const content: Node[] = [...head];
  for (const b of blocks) {
    if (b.kind === 'heading') content.push({ type: 'heading', attrs: { level: b.level }, content: [t(b.text)] });
    else if (b.kind === 'para') content.push(para(b.italic ? [t(b.text, italic)] : linkify(b.text, self, ids, used)));
    else if (b.kind === 'note') content.push(callout(b.note));
    else content.push({ type: 'bulletList', content: b.items.map((i) => ({ type: 'listItem', content: [para(labelled(i.text, self, ids, used))] })) });
  }
  return { type: 'doc', content };
}

const sourceLine = (heading: string, ranges: [number, number][]) => para([
  t(`Source: “${heading}”, ${ranges.map(([a, b]) => (a === b ? `line ${a}` : `lines ${a}–${b}`)).join(' and ')} of ${LORE_FILE}.`, italic),
]);

/** Splits the source into pages. Exported for tests. */
export function loreSections() {
  const lines = sourceLines();
  const starts = SEGMENTS.map((s) => {
    const idx = lines.findIndex((l) => l.text.trim() === s.line);
    if (idx < 0) throw new Error(`lore import: can't find the section "${s.line}" in ${LORE_FILE}`);
    return { ...s, idx };
  });
  for (let i = 1; i < starts.length; i++) if (starts[i].idx <= starts[i - 1].idx) throw new Error(`lore import: "${starts[i].line}" is out of order`);
  const sections = new Map<PageKey, { heading: string; ranges: [number, number][]; blocks: Block[] }>();
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].idx : lines.length;
    const spec = PAGES.find((p) => p.key === s.key)!;
    // The opening heading becomes the page title; a continuation keeps its heading in the text.
    const slice = lines.slice(s.continues ? s.idx : s.idx + 1, end);
    let last = end;
    while (last > s.idx && lines[last - 1].text.trim() === '') last--;
    const sec = sections.get(s.key) ?? { heading: s.line.replace(/^#+\s*/, ''), ranges: [], blocks: [] };
    sec.ranges.push([s.idx + 1, last]);
    sec.blocks.push(...blocksOf(slice, spec, s.level));
    sections.set(s.key, sec);
  }
  return sections;
}

// ---------------------------------------------------------------- factions

/**
 * The owner's pairings. Colours and sigils come from each company's described heraldry; the
 * native peoples have none described, so theirs are picks the GM should replace.
 */
const FACTIONS: { page: PageKey; name: string; color: string; sigil: string; meter: { key: string; name: string; description: string }; description: string }[] = [
  { page: 'mendoza', name: 'Casa de Mendoza', color: '#a3242c', sigil: 'sun',
    meter: { key: 'zeal', name: 'Zeal', description: 'Signature meter for Casa de Mendoza.' },
    description: 'Chartered company. Crest: a golden fortress beneath a radiant sun on a crimson shield. Colours: crimson, ivory, and gold.' },
  { page: 'dupont', name: 'Company DuPont', color: '#22386b', sigil: 'book',
    meter: { key: 'grandeur', name: 'Grandeur', description: 'Signature meter for Company DuPont.' },
    description: 'Chartered company. Crest: a golden fleur-de-lis above an open book, framed by laurel branches and an astrolabe. Colours: deep navy, ivory, and gold.' },
  { page: 'qadir', name: 'The Qadir Ascendancy', color: '#1f7a5a', sigil: 'star',
    meter: { key: 'attunement', name: 'Attunement', description: 'Signature meter for the Qadir Ascendancy.' },
    description: 'Chartered company. Crest: a golden eight-pointed star surrounding a black crescent, set over a deep emerald field. Colours: emerald green, black, gold, and deep teal.' },
  { page: 'nhalkesh', name: 'The Nhal’Kesh', color: '#9a5a2c', sigil: 'flame',
    meter: { key: 'vigil', name: 'Vigil', description: 'Signature meter for the Nhal’Kesh.' },
    description: 'Native people (placeholder name). No heraldry described; colour and sigil are placeholders.' },
  { page: 'flesh', name: 'The Flesh-Shapers', color: '#7b3f6e', sigil: 'eye',
    meter: { key: 'transcendence', name: 'Transcendence', description: 'Signature meter for the Flesh-Shapers.' },
    description: 'Nhal’Kesh splinter sect. No heraldry described; colour and sigil are placeholders.' },
  { page: 'aelari', name: 'The Aelari', color: '#6f9a3c', sigil: 'leaf',
    meter: { key: 'communion', name: 'Communion', description: 'Signature meter for the Aelari.' },
    description: 'Native people (placeholder name). No heraldry described; colour and sigil are placeholders.' },
  { page: 'canopy', name: 'The Canopy People', color: '#c48a2c', sigil: 'feather',
    meter: { key: 'canopy-provisional', name: 'Provisional',
      description: 'Placeholder. The Canopy People’s lore is unfinished in the source, so their signature meter has no name yet. Rename it once their identity is settled.' },
    description: 'Native people; lore unfinished in the source. No heraldry described; colour and sigil are placeholders.' },
];

// ---------------------------------------------------------------- island

/**
 * The island is the owner's 3D model (server/assets/island.glb, baked from the Meshy export by
 * scripts/bake-model.mjs). Each hex's terrain was read off the model by scripts/model-terrain.mjs,
 * so the grid describes the land it sits on. No claims, settlements or names: the lore gives none.
 */
type IslandTerrain = { cols: number; rows: number; terrain: string[] };
const islandTerrainData = () => JSON.parse(fs.readFileSync(new URL('../assets/lore/new-world-terrain.json', import.meta.url), 'utf8')) as IslandTerrain;
const islandModel = () => fs.readFileSync(new URL('../assets/island.glb', import.meta.url));
export const ISLAND = { cols: 48, rows: 32 };

// ---------------------------------------------------------------- seed

export async function seedNewWorld(db: Db, opts: { name?: string } = {}) {
  const sections = loreSections();
  return db.transaction(async (tx) => {
    const { world, map } = await createWorld(tx, {
      name: opts.name ?? 'The New World', cols: ISLAND.cols, rows: ISLAND.rows, orientation: 'flat', accent: '#c9a24e',
      description: 'What explorers found was an enormous tropical island or isolated continent covered almost entirely in rainforest.',
    });
    await paintIsland(tx, map.id);
    await tx.insert(mapModel).values({ mapId: map.id, bytes: islandModel(), name: 'island.glb', placement: fitModelPlacement(map.layout) });

    // Pages first, so links have ids to point at.
    const specs: PageSpec[] = [{ key: 'index', title: opts.name ?? 'The New World', category: 'Lore' }, ...PAGES];
    const rows = await tx.insert(wikiPages).values(specs.map((p) => ({ worldId: world.id, title: p.title, category: p.category }))).returning();
    const ids = Object.fromEntries(specs.map((p, i) => [p.key, rows[i].id])) as Record<PageKey, string>;

    const docs = new Map<PageKey, ReturnType<typeof toDoc>>();
    for (const spec of PAGES) {
      const sec = sections.get(spec.key)!;
      const head: Node[] = (spec.notes ?? []).map(callout);
      if (spec.key === 'hub') {
        head.push({ type: 'heading', attrs: { level: 2 }, content: [t('The Precursor Mages — Chronological Summary')] });
        head.push(para([t('The chronology has its own page: '), { type: 'wikiLink', attrs: { pageId: ids.precursor, label: 'The Precursor Mages' } }, t('.')]));
      }
      const d = toDoc(sec.blocks, spec.key, ids, head);
      // Where it came from, at the foot of the page.
      d.content.push({ type: 'horizontalRule' }, sourceLine(sec.heading, sec.ranges));
      docs.set(spec.key, d);
    }
    docs.set('index', {
      type: 'doc',
      content: [
        callout({ label: 'Imported', text: `Every page in this world comes from ${LORE_FILE}. Notes in bold, like this one, were added by the import to mark what the source leaves open, unfinished, or missing; everything else is the source’s own text.` }),
        para([t('For now, foreigners simply call it something like The New World, though every native civilization has its own name for it. ('), { type: 'wikiLink', attrs: { pageId: ids.core, label: 'Core Setting' } }, t(')')]),
        { type: 'heading', attrs: { level: 2 }, content: [t('Pages, in the order of the source')] },
        { type: 'bulletList', content: PAGES.map((p) => ({ type: 'listItem', content: [para([{ type: 'wikiLink', attrs: { pageId: ids[p.key], label: p.title } }])] })) },
      ],
    });
    for (const [key, content] of docs) {
      await tx.update(wikiPages).set({ content, contentText: docText(content) }).where(eq(wikiPages.id, ids[key]));
      const targets = docLinks(content).filter((to) => to !== ids[key]);
      if (targets.length) await tx.insert(wikiLinks).values(targets.map((to) => ({ fromPageId: ids[key], toPageId: to }))).onConflictDoNothing();
    }

    // Factions, each with Morale, Treasury, and exactly one signature meter.
    const defs = await tx.insert(meterDefinitions).values(FACTIONS.map((f, i) => ({
      worldId: world.id, key: f.meter.key, name: f.meter.name, kind: 'signature', min: 0, max: 100, defaultValue: 60,
      bands: SIGNATURE_BANDS, sortOrder: 2 + i, description: f.meter.description,
    }))).returning();
    const all = await tx.select().from(meterDefinitions).where(eq(meterDefinitions.worldId, world.id));
    const core = all.filter((d) => d.kind !== 'signature');
    for (const [i, f] of FACTIONS.entries()) {
      const [row] = await tx.insert(factions).values({
        worldId: world.id, name: f.name, color: f.color, sigil: f.sigil, description: f.description,
        signatureMeterId: defs[i].id, wikiPageId: ids[f.page],
      }).returning();
      for (const d of [...core, defs[i]]) {
        await setMeter(tx, { worldId: world.id, factionId: row.id, factionName: row.name, meterId: d.id, value: d.defaultValue, cause: 'Faction founded', source: 'gm' });
      }
    }
    await logEvent(tx, { worldId: world.id, kind: 'note', actor: 'system', summary: `Lore imported from ${LORE_FILE}: ${PAGES.length + 1} pages, ${FACTIONS.length} factions` });
    return world;
  });
}

export async function paintIsland(tx: DbOrTx, mapId: string) {
  const data = islandTerrainData();
  const rows = await tx.select({ id: hexes.id, q: hexes.q, r: hexes.r }).from(hexes).where(eq(hexes.mapId, mapId));
  const by = new Map<string, string[]>();
  for (const h of rows) {
    const { col, row } = axialToOffset(h.q, h.r, 'flat');
    const terrain = data.terrain[row * data.cols + col] ?? 'deep';
    by.set(terrain, [...(by.get(terrain) ?? []), h.id]);
  }
  for (const [terrain, ids] of by) await tx.update(hexes).set({ terrain }).where(inArray(hexes.id, ids));
}

/** First boot after this release: import once. Deleting the world afterwards keeps it deleted. */
export async function seedNewWorldOnce(db: Db): Promise<string | null> {
  const done = await db.select().from(appMeta).where(eq(appMeta.key, LORE_SEED_KEY));
  if (done.length) return null;
  const world = await seedNewWorld(db);
  await db.update(worlds).set({ sortOrder: -1 }).where(eq(worlds.id, world.id));
  await db.insert(appMeta).values({ key: LORE_SEED_KEY, value: world.id }).onConflictDoNothing();
  return `imported "${world.name}" from ${LORE_FILE}`;
}

/**
 * Worlds imported before the island model existed get it once: the model goes under the map, and if
 * nobody has touched the placeholder terrain yet, the hexes are re-read from the model so they agree.
 */
export async function upgradeNewWorldIsland(db: Db): Promise<string[]> {
  const notes: string[] = [];
  const imported = await db.selectDistinct({ worldId: events.worldId }).from(events)
    .where(and(eq(events.kind, 'note'), like(events.summary, `Lore imported from ${LORE_FILE}%`)));
  for (const { worldId } of imported) {
    const key = `upgrade:island-model:${worldId}`;
    if ((await db.select().from(appMeta).where(eq(appMeta.key, key))).length) continue;
    const [map] = await db.select().from(maps).where(and(eq(maps.worldId, worldId), isNull(maps.parentHexId)));
    if (!map) continue;
    const has = await db.select({ v: mapModel.version }).from(mapModel).where(eq(mapModel.mapId, map.id));
    if (has.length) { await db.insert(appMeta).values({ key, value: 'done' }).onConflictDoNothing(); continue; } // imported with the model already
    await db.transaction(async (tx) => {
      await tx.insert(mapModel).values({ mapId: map.id, bytes: islandModel(), name: 'island.glb', placement: fitModelPlacement(map.layout) });
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(events)
        .where(and(eq(events.worldId, worldId), inArray(events.kind, ['hex.edited', 'hex.painted', 'hexes.painted'])));
      const layout = map.layout as { cols: number; rows: number };
      const fits = layout.cols === ISLAND.cols && layout.rows === ISLAND.rows;
      if (n === 0 && fits) { await paintIsland(tx, map.id); notes.push(`re-read the hexes of world ${worldId} from the island model`); }
      else notes.push(`added the island model under world ${worldId}; its edited terrain was kept`);
      await tx.insert(appMeta).values({ key, value: 'done' }).onConflictDoNothing();
    });
  }
  return notes;
}

/**
 * Before removed models were archived, removing The New World's island deleted it outright. Once,
 * a world that lost its island that way gets it back: onto the map if the map has no model now,
 * otherwise into the model archive. Its hexes are left as they are.
 */
export async function recoverRemovedIsland(db: Db): Promise<string[]> {
  const notes: string[] = [];
  const imported = await db.selectDistinct({ worldId: events.worldId }).from(events)
    .where(and(eq(events.kind, 'note'), like(events.summary, `Lore imported from ${LORE_FILE}%`)));
  for (const { worldId } of imported) {
    const key = `recover:island-model:${worldId}`;
    if ((await db.select().from(appMeta).where(eq(appMeta.key, key))).length) continue;
    const [map] = await db.select().from(maps).where(and(eq(maps.worldId, worldId), isNull(maps.parentHexId)));
    const removed = await db.select({ id: events.id }).from(events)
      .where(and(eq(events.worldId, worldId), eq(events.kind, 'map.model'), eq(events.summary, 'Removed the 3D terrain model')));
    await db.transaction(async (tx) => {
      if (map && removed.length) {
        const live = await tx.select({ v: mapModel.version }).from(mapModel).where(eq(mapModel.mapId, map.id));
        const island = { bytes: islandModel(), name: 'island.glb', placement: fitModelPlacement(map.layout) };
        if (!live.length) {
          await installModel(tx, map.id, island);
          await logEvent(tx, { worldId, kind: 'map.model', summary: 'Restored the island model that was removed' });
          notes.push(`put the removed island model back on world ${worldId}`);
        } else {
          await tx.insert(mapModelArchive).values({ mapId: map.id, ...island, version: 0, reason: 'removed' });
          notes.push(`kept the removed island model of world ${worldId} in its model archive`);
        }
      }
      await tx.insert(appMeta).values({ key, value: 'done' }).onConflictDoNothing();
    });
  }
  return notes;
}
