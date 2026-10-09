// Browser smoke test: drives the real app and saves screenshots.
// Usage: BASE_URL=http://localhost:3001 ATLAS_USER=gm ATLAS_PASS=... SHOTS=/tmp/shots node scripts/smoke.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const DIR = process.env.SHOTS ?? './shots';
mkdirSync(DIR, { recursive: true });
const S = (n) => `${DIR}/${n}.png`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errs.push(m.text()); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: S('fail-' + name) }); }
};
const nav = (label) => p.click(`.rail a[aria-label="${label}"]`);
const ART = fileURLToPath(new URL('../server/assets/demo-map.webp', import.meta.url));

await step('login', async () => {
  await p.goto(BASE);
  await p.fill('#u', process.env.ATLAS_USER ?? 'gm');
  await p.fill('#p', process.env.ATLAS_PASS ?? 'correcthorse1');
  await p.click('button:has-text("Sign in")');
  await p.waitForSelector('canvas.map');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S('02-map') });
});

await step('zoom', async () => {
  await p.mouse.move(600, 470);
  for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, -300); await p.waitForTimeout(60); }
  await p.waitForTimeout(900);
  await p.screenshot({ path: S('03-zoomed') });
  for (let i = 0; i < 16; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(40); }
  await p.waitForTimeout(900);
  await p.screenshot({ path: S('04-continental') });
  await p.keyboard.press('f');
  await p.waitForTimeout(900);
});

await step('inspect-hex', async () => {
  await p.mouse.click(700, 650);
  await p.waitForSelector('.inspector');
  await p.waitForTimeout(500);
  await p.screenshot({ path: S('05-inspector') });
  await p.click('.inspector .prop:has(.prop-label:text-is("Terrain")) .prop-value');
  await p.click('.inspector .terrain-opt:has-text("Swamp")');
  await p.click('.inspector .notes-read');
  await p.fill('.inspector textarea.textarea', 'Bog witch lives here.');
  await p.waitForTimeout(1200);
  await p.screenshot({ path: S('06-inspector-edited') });
  await p.keyboard.press('Escape');
});

await step('paint', async () => {
  await p.keyboard.press('2');
  await p.click('.brush:has-text("Mountains")');
  await p.mouse.move(400, 300);
  await p.mouse.down();
  for (let x = 400; x < 560; x += 20) await p.mouse.move(x, 300 + (x - 400) / 4);
  await p.mouse.up();
  await p.waitForTimeout(150);
  await p.screenshot({ path: S('07-painting') });
  await p.waitForTimeout(800);
  await p.keyboard.press('4');
  await p.waitForTimeout(300);
  await p.mouse.move(820, 620);
  await p.mouse.down();
  for (let x = 820; x < 900; x += 15) await p.mouse.move(x, 620);
  await p.mouse.up();
  await p.waitForTimeout(800);
  await p.screenshot({ path: S('08-claims') });
  await p.keyboard.press('1');
});

await step('switcher', async () => {
  await p.click('.world-button');
  await p.waitForTimeout(900);
  await p.screenshot({ path: S('09-switcher') });
});

await step('create-world', async () => {
  await p.click('.world-card.new');
  await p.fill('.dialog input.input', 'Test Realm');
  await p.click('.dialog button:has-text("Create world")');
  await p.waitForURL(/\/w\/.*\/map/);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S('10-blank-world') });
});

await step('map-art', async () => {
  await p.click('button[aria-label="Layers"]');
  await p.waitForSelector('.layers .dropzone');
  await p.setInputFiles('.mapview input[type=file]', ART);
  // A fresh upload opens straight into alignment.
  await p.waitForSelector('.alignbar', { timeout: 20000 });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: S('10b-art-uploaded') });
  await p.mouse.move(700, 500); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(700 + i * 6, 500 + i * 3);
  await p.mouse.up();
  await p.waitForTimeout(300);
  await p.screenshot({ path: S('10c-aligning') });
  await p.click('.alignbar button:has-text("Fit to grid")');
  await p.waitForTimeout(400);
  await p.click('.alignbar button:has-text("Save alignment")');
  await p.waitForSelector('.alignbar', { state: 'detached' });
  await p.waitForTimeout(600);
  await p.screenshot({ path: S('10d-art-saved') });
  await p.click('button[aria-label="Layers"]');
  await p.waitForSelector('.layers .art-thumb img');
  await p.click('button[aria-label="Layers"]');
});

await step('wiki-new-world', async () => {
  await nav('Wiki');
  await p.waitForTimeout(500);
  await p.click('.wiki-side button[title="New page"]');
  await p.waitForSelector('.ProseMirror');
  await p.keyboard.type('The Iron Coast');
  await p.keyboard.press('Enter');
  await p.keyboard.type('A cold shore ruled by ');
  await p.keyboard.type('[[Duke Harrow');
  await p.waitForTimeout(400);
  await p.screenshot({ path: S('11-wiki-suggest') });
  await p.keyboard.press('Enter');
  await p.keyboard.type('who hates the sea.');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: S('12-wiki-linked') });
  await p.click('.wikilink');
  await p.waitForTimeout(800);
  await p.screenshot({ path: S('13-wiki-target') });
});

await step('search-palette', async () => {
  await p.keyboard.press('Control+k');
  await p.keyboard.type('hates');
  await p.waitForTimeout(800);
  await p.screenshot({ path: S('14-palette') });
  await p.keyboard.press('Escape');
});

await step('demo-wiki', async () => {
  await p.click('.world-button');
  await p.waitForTimeout(600);
  await p.click('.world-card:has-text("The Sundered Reach")');
  await p.waitForTimeout(1000);
  await nav('Wiki');
  await p.waitForTimeout(500);
  await p.click('.wiki-item:has-text("The Ashen Covenant")');
  await p.waitForTimeout(800);
  await p.screenshot({ path: S('15-demo-wiki') });
});

await step('factions', async () => {
  await nav('Factions');
  await p.waitForTimeout(1000);
  await p.screenshot({ path: S('16-factions') });
  await p.click('.fr-head:has-text("House Valcourt")');
  await p.waitForSelector('.faction-row.open .meter');
  const before = await p.textContent('.faction-row.open .meter:has-text("Morale") .val');
  await p.click('.faction-row.open .meter:has-text("Morale") .adj button:has-text("+1")');
  await p.waitForFunction((b) => document.querySelector('.faction-row.open .meter .val')?.textContent !== b, before, { timeout: 5000 }).catch(() => {});
  await p.screenshot({ path: S('16b-faction-open') });
  await p.click('.tabs button:has-text("Roll tables")');
  await p.waitForTimeout(500);
  await p.screenshot({ path: S('17-rolltables') });
});

await step('chronicle', async () => {
  await nav('Chronicle');
  await p.waitForTimeout(800);
  await p.screenshot({ path: S('18-chronicle') });
});

await step('search-to-map', async () => {
  await p.keyboard.press('Control+k');
  await p.keyboard.type('Port Halvard');
  await p.waitForSelector('.palette li .cat:text-is("Settlement")');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.inspector.token-panel');
  await p.waitForTimeout(900);
  await p.screenshot({ path: S('19-search-to-map') });
});

await step('import-lore', async () => {
  await p.click('.world-button');
  await p.click('.world-card.new');
  await p.fill('.dialog input.input', 'Lore Import Check');
  await p.click('.dialog button:has-text("The New World lore")');
  await p.click('.dialog button:has-text("Create world")');
  await p.waitForURL(/\/w\/.*\/map/);
  await p.waitForSelector('canvas.map');
  await p.waitForTimeout(1200);
  await p.screenshot({ path: S('20-lore-island') });
});

await step('lore-wiki-ambient', async () => {
  await nav('Wiki');
  await p.waitForSelector('.ambient.on');
  await p.click('.wiki-item:has-text("The Flesh-Shapers")');
  await p.waitForSelector('.ProseMirror:has-text("They broke from orthodox")');
  await p.waitForSelector('.ProseMirror .wikilink:text-is("Nhal’Kesh")');
  await p.waitForTimeout(600);
  await p.screenshot({ path: S('21-lore-wiki') });
});

await step('lore-factions', async () => {
  await nav('Factions');
  await p.waitForSelector('.faction-row >> nth=6');
  const n = await p.locator('.faction-row').count();
  if (n !== 7) throw new Error(`expected 7 factions, saw ${n}`);
  await p.waitForSelector('.fr-meter:has-text("Attunement")');
  await p.waitForSelector('.ambient.on');
  await p.screenshot({ path: S('22-lore-factions') });
  await nav('Map');
  await p.waitForSelector('.ambient:not(.on)', { state: 'attached' });
});

console.log('console errors:', errs.length ? '\n' + errs.join('\n') : 'none');
await b.close();
if (failed || errs.length) process.exit(1);
