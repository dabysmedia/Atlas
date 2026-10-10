# Campaign Atlas

A personal world atlas and hexcrawl VTT: every world gets a hex map (the source of truth),
a wiki, factions with meters, campaigns with party fog, and an append-only chronicle.

## Stack

- **Server:** Node 22, Fastify 5, Drizzle ORM on PostgreSQL. One process serves the API and the built client.
- **Client:** React 19 + Vite, TanStack Query, TipTap (wiki editor), Motion (animation), Canvas 2D hex renderer.
- **Search:** Postgres full-text search (weighted title + body, prefix matching) plus trigram fuzzy title matching.
- **Live sync:** a WebSocket per open screen (`@fastify/websocket`), so every edit reaches everyone viewing the world at once.

## Live sync

Every screen keeps one socket, `GET /api/live`, signed in with the same session cookie (a cross-site Origin is refused)
and subscribed to the world it shows. The server half is `server/live.ts`, the client half `client/src/live.ts`.

- **Changes.** After a mutating route answers, everyone on that world hears what changed. Map edits that come in
  bursts (hex paint and edits, claims, markers, fog, map art and models) carry the changed rows, which screens patch
  into their query cache, so the map redraws without refetching. The world clock and weather carry the world's
  fields. Everything else names the parts of the cache to refetch ("scopes"). `ROUTE_SCOPES` lists every mutating
  route; one missing from it stops the server at boot.
- **Order.** Writes to one world take turns, each broadcast before the next runs, so every screen hears a world's
  changes in the order they were saved, numbered (`seq`). Reads say where the count stood as they began
  (`x-atlas-seq`) and a subscription says where it took effect, so a screen that read something before subscribing
  refetches if a change slipped in between.
- **Echoes.** Each tab sends an `x-atlas-client` id with its requests (and on its socket); the server leaves the tab's
  own changes out of what it sends that tab, matching the session too. Refetches heard while the tab has a write of
  its own in flight wait for it to land, and form fields keep what is being typed (`useDraft`); the last save wins.
- **Limits.** Per socket, drags, let-gos and subscriptions have budgets; presence updates are gathered per world; a
  socket that stops reading is dropped rather than buffered for; a session holds at most 10 sockets; signing out
  closes the session's sockets at once.
- **Marker drags** stream positions (about 25 a second, never stored) so others see the marker move; the drop saves
  through the usual `PATCH`, and remote moves glide rather than jump.
- **Presence.** The top bar shows who has the world open, one avatar per screen, and whether this one is live.
- **Reconnects.** Heartbeats drop dead sockets on both ends; screens reconnect with backoff and refetch the world they
  show. While disconnected, the world (clock and weather) is polled every 30 s.

The hub delivers in-process, which suits the single Railway replica. Its `LiveBus` interface is where Postgres
`LISTEN/NOTIFY` or Redis would go for more than one, and its `deliver` is where player accounts will filter what each
connection receives.

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
Live sync across browsers: `BASE_URL=… ATLAS_PASS=… node scripts/live.mjs` (`RESTART_CMD` also checks reconnecting
after a server restart; `LIVE_3D=1` adds the 3D map).

## Deploy (Railway)

1. A Postgres service, and a service built from this repo (it uses the `Dockerfile`; `railway.json` sets the health check).
2. Variables on the app service:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_USERNAME` (default `gm`) and `ADMIN_PASSWORD` (10+ characters)
3. Generate a domain. Migrations run on boot; the demo world is created the first time the database is empty
   (`SEED_DEMO=false` to skip).
4. The owner's setting, "The New World", is imported once from `server/assets/lore/the-new-world-island.md`
   (`server/lore/newworld.ts`; `SEED_LORE=false` to skip). The `app_meta` table remembers it ran, so deleting the
   world keeps it deleted. "New world → The New World lore" imports a fresh copy at any time.

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
