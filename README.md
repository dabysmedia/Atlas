# Campaign Atlas

A personal world atlas and hexcrawl VTT: every world gets a hex map (the source of truth),
a wiki, factions with meters, campaigns with party fog, and an append-only chronicle.

## Stack

- **Server:** Node 22, Fastify 5, Drizzle ORM on PostgreSQL. One process serves the API and the built client.
- **Client:** React 19 + Vite, TanStack Query, TipTap (wiki editor), Motion (animation), Canvas 2D hex renderer.
- **Search:** Postgres full-text search (weighted title + body, prefix matching) plus trigram fuzzy title matching.

## Run locally

```bash
npm install
cp .env.example .env                 # point DATABASE_URL at a local Postgres
export $(grep -v '^#' .env | xargs)
npm run dev:server                   # API on :3000, runs migrations, seeds the demo world on an empty DB
npm run dev:client                   # Vite on :5173, proxies /api to :3000
```

Production build: `npm run build && npm start`.

Tests: `TEST_DATABASE_URL=postgres://… npm test` (wipes and rebuilds the schema in that database).
Browser smoke test: `BASE_URL=… ATLAS_PASS=… node scripts/smoke.mjs` (needs Playwright's Chromium).

## Deploy (Railway)

1. A Postgres service, and a service built from this repo (it uses the `Dockerfile`; `railway.json` sets the health check).
2. Variables on the app service:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_USERNAME` (default `gm`) and `ADMIN_PASSWORD` (10+ characters)
3. Generate a domain. Migrations run on boot; the demo world is created the first time the database is empty
   (`SEED_DEMO=false` to skip).

To change the password, change `ADMIN_PASSWORD` and redeploy; existing sessions are signed out.

## Data model in one screen

Everything below a world carries `world_id` and cascades on delete, so worlds never share rows.

| Table | What it holds |
| --- | --- |
| `worlds` | name, world clock (`current_day`), per-world terrain palette and hex states |
| `maps` / `hexes` | dense axial grid; each hex has terrain, state, name, notes, wiki link, `data` bag. `maps.parent_hex_id` leaves room for inside-a-hex maps |
| `claims` | faction claims over hexes; one `control` claim per hex decides the controller and borders; `contested` / `influence` recorded alongside |
| `campaigns` / `campaign_fog` | campaigns share world lore; each has its own shared party fog (explored hex set) |
| `factions` | color, description, exactly one `signature_meter_id` |
| `meter_definitions` / `meter_values` / `meter_changes` | generic meters per world (core, signature, resource) with bands; values per faction; every change logged with cause, in-game day and source |
| `tokens` / `settlements` | anything on a hex (party, city, outpost, unit, character, marker); cities and outposts link to a settlement row |
| `roll_tables` / `roll_table_entries` | weighted tables per faction + meter + band; entries carry `approved` and `source` (gm / ai) |
| `events` | append-only chronicle; a trigger rejects UPDATE/DELETE (FK cascades excepted) |
| `wiki_pages` / `wiki_links` | ProseMirror JSON + extracted text + generated `tsvector`; links rebuilt on save for backlinks |
