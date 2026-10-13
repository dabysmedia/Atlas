# Campaign Atlas

A personal world atlas and hexcrawl VTT: every world gets a hex map (the source of truth),
a wiki, factions with meters, campaigns with party fog, and an append-only chronicle.

## Stack

- **Server:** Node 22, Fastify 5, Drizzle ORM on PostgreSQL. One process serves the API and the built client.
- **Client:** React 19 + Vite, TanStack Query, TipTap (wiki editor), Motion (animation), Three.js terrain with a canvas HUD.
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
- **Marker drags** stream GM positions (about 25 a second, never stored) to other GMs. Moving pieces commit through
  the movement endpoint; place markers use `PATCH`. Player movement reaches the DM when committed, and remote moves glide.
- **Presence.** The top bar shows who has the world open, one avatar per screen, and whether this one is live.
- **Reconnects.** Heartbeats drop dead sockets on both ends; screens reconnect with backoff and refetch the world they
  show. While disconnected, the world (clock and weather) is polled every 30 s.

The hub delivers in-process, which suits the single Railway replica. Its `LiveBus` interface is where Postgres
`LISTEN/NOTIFY` or Redis would go for more than one. Player sockets receive cache invalidations rather than raw
GM patches, and never receive ephemeral drag coordinates. Their map reads filter hidden tokens and campaign fog.

## Settlements

Choose **Settlements** in the map tool dock (shortcut **6**), click or paint connected hexes, then **Create settlement**.
Choose a type and ruling faction, name the place, and found it. Supported types are hamlet, village, town, city,
metropolis, outpost, and military base. The tool's directory opens existing settlements; **Edit hex footprint**
adds or removes hexes later. A hex can belong to one newly designated settlement, and can also contain ordinary POIs.
Existing settlement records and their original locations survive the migration, including older overlapping locations.

Settlements use a faction-colored skyline plaque rather than a POI diamond. **Appearance** can upload or select a
GLB miniature (10 MB maximum); the model replaces the badge once ready in the detailed view, with a badge fallback
in overview or if loading fails. Settlement miniatures rest on the terrain without the moving tokens' idle wobble.

The sheet separates **settlement type** (civilian or military identity) from **Kingmaker tier** (village, town, city,
metropolis). **Development** records structures in four-lot urban blocks, residential lots, rubble, consumption
modifiers, and activity item bonuses. It calculates settlement level, consumption, maximum item bonus, influence,
and housing-related Unrest using the [Kingmaker settlement rules](https://2e.aonprd.com/Rules.aspx?ID=1819).
Map hex footprint does not imply an urban block count or population. Exact population and level overrides are editable.
Structure names, types, and effects are entered from the campaign's rules; this is not a structure compendium or an automated kingdom turn.

Additional fields cover government, leaders, demographics, languages, religions, services, trade, threats, defenses,
water/walled borders, island bridges, founding day, linked wiki lore, and private GM notes. Each faction can have one
capital. **Show influence** highlights claimed hexes within range (all claimed territory for capital structure benefits).
Designation and ruler changes do not rewrite terrain or transfer faction control; manage control with the Control tool.
Faction inspectors summarize population, settlement consumption, and housing Unrest contributions.

Players can read visible settlement sheets and models but cannot edit them or read GM notes. Changes sync to other
screens, use revision checks to protect sheets from concurrent overwrites, and are recorded in the chronicle.
Removing a settlement removes its footprint and structures while keeping the hexes, claims, POIs, and wiki pages.

## Hex interiors

Select a hex and use **Interiors → Link** at the bottom of its sidebar. Name the interior, choose a
**2D image** or **3D model**, set its grid dimensions, and upload a PNG/JPEG/WebP/GIF or self-contained
GLB (40 MB maximum). Every square represents 5 feet. Click a square in the preview to set the party's
entry point, then save. Several interiors can be linked to the same hex; no locations are seeded.

**Enter** carries the faction's main party into its entry square. With no party on the hex, GMs can
preview the map. Click or drag to move the party on the tactical grid. **Back to world** saves its exit
and reverses the zoom-fade, returning to the same selected hex. The island renderer remains mounted
and keeps its camera and resources; world overlays and weather controls are hidden inside.

Links, uploaded bytes and tactical positions live in separate Postgres tables, survive redeploys,
and synchronize between DM and player screens. Tactical movement does not edit hex data or add world
trail visits. Players can enter only with their own main party, on its parent hex, into a map marked
**Visible to players**; campaign fog also limits discoverable interiors. There is no tactical fog,
collision, pathfinding, or multi-floor navigation yet. Use open-floor/cutaway GLBs: the grid and party
footing follow the highest visible surface. Uploaded interior files also appear in the GM file manager.

`scripts/smoke-interiors.mjs` checks linking, upload, entry-square selection, both map formats, party
miniatures, live movement, reload recovery, mobile exit, and reuse of the world camera and renderer.

## Faction token drawers and party movement

Open **Token drawer**, choose a faction, and use **Add token** to select a role, model or saved-piece preset.
Selecting a drawer card opens its sheet. **Deploy on map** places a reserve piece; choosing a deployed saved-piece
preset adds an independent copy. The original entry stays in the drawer.
Generic scouting, soldiers, envoy, caravan, fleet, character and party choices do not seed any lore or locations.
Create factions in the Factions module; **Designate as player party** creates that faction's unique main party token.

Token selection opens a portrait-led dossier with **Sheet**, **Appearance**, and **Journey** tabs. Drawer pieces
automatically receive actual stat sheets, independent of wiki pages. Portrait art can be uploaded (PNG/JPEG/WebP/GIF,
8 MB limit), selected from a world gallery, and renamed/deleted in Uploaded files. Existing wiki links are retained
as legacy data, never parsed as statistics. Models and portraits persist in Railway Postgres across redeploys.

**World settings → Rules & stat sheets** starts with an editable PF2e Remastered + Kingmaker mechanics pack:
character/creature sheets, attributes, proficiency, AC, saves, skills, spell checks, dice checks with degrees of
success, party roster/travel pacing, and kingdom statistics/control DC/resource tiers. Source references are
linked in the pack. The rules implementation and UI labels are original; rulebook text, artwork and adventure
lore are not bundled. This is a mechanics/sheet foundation, not a complete compendium or automated character builder.
Feats, spells, conditions, inventory effects, camping/forced-march exceptions and kingdom turns are manual in this pass.
The party travel planner uses roster speeds; activities used are recorded by the GM, without forcing map moves.

Worlds can create custom rulesets, edit fields/defaults/check dice/proficiency/travel tables, and import/export JSON.
Definitions use bounded declarative expressions; no code evaluation. Each token keeps an independent sheet for each
ruleset, so hot swapping restores its previous stats. New copies inherit all source sheets but edit independently.
Player sheet access is restricted to their visible faction pieces; opposing and hidden statistics stay private.
Edits use revision guards and update other screens live. `scripts/smoke-token-sheets.mjs` verifies the full flow,
art/reload persistence, party pacing, hot swapping with the renderer still mounted, and mobile layout.

Appearance allows a self-contained **GLB miniature** (10 MB limit), a model from the world's existing library,
or a faction-colored 2D indicator. Models float slightly above sampled terrain. Hover adds a silhouette border without tinting model materials.
Picking uses cached model bounds and an 8px margin, avoiding per-frame triangle raycasts on dense GLBs. HUD indicators and names remain readable at
every zoom; pieces sharing a hex get separate slots and can also be selected from the hex's contents or drawer. Overview uses 2D indicators sized to their projected hex; exploration restores assigned
miniatures. Both use the same world slots, with model footprints fitted inside the hex. Exploration nameplates sit
below their own model silhouettes, with a 20px icon. Names remain pinned to their markers; overlaps are allowed,
and hovering brings that token and its nameplate to the front. Token names are hidden in overview and appear in exploration.
`scripts/smoke-token-zoom.mjs` checks zoom-mode switching, terrain anchors, shared-hex selection, and label clearance.
`scripts/smoke-token-performance.mjs` checks picking with a 480,000-triangle fixture and guards against triangle raycasts returning.


Use **Move to next hex** or drag a moving piece to an adjacent hex. The server stores ordered visits and appends
each movement to the chronicle atomically. Main-party trails draw on the map and reveal their campaign's visited
hexes. The movement endpoint accepts explicit paths of up to 100 adjacent hexes and rejects stale starting positions.
Direct GM repositioning/returning a piece to its drawer creates a trail break instead of inventing travel.

Under a faction drawer's **Player access**, choose an optional fog campaign and create a separate player login.
Players can view assigned worlds, deploy and move their own visible faction pieces, and see movement logs. They
cannot edit lore, terrain, factions, models or visibility. Player access can be revoked from the same drawer.
Explicitly hidden tokens are omitted from player API responses. With a fog campaign, other factions' tokens are
shown only on explored hexes; with no campaign, all deployed non-hidden tokens are public. Own visible pieces
remain available regardless of fog. GM credentials always see all pieces; do not share GM credentials with players.

`scripts/smoke-pieces.mjs` verifies deployment, miniature footing, shared-hex picking, player movement, DM live
updates, hiding, reload persistence and unchanged hex rows in a disposable local world.

## Uploaded files

GM **World settings → Uploaded files**, also linked by **Manage files** in the token drawer, lists each world's
miniatures, wiki images, map art, terrain and archived terrain. Search/filter/sort, rename, download, and two-step
permanent deletion are available. Renaming preserves asset IDs and existing links. Deleting an assigned miniature
keeps its pieces, positions, sheets and trails, switching them to 2D indicators. Referenced wiki images must first
be removed from their pages; active terrain must first be removed in Layers and can then be deleted as an archive.
Older wiki images and map art use generic names because the original upload names were not retained.

File bytes and names are stored in Postgres, on Railway's persistent Postgres volume, not the app container.
App redeploys do not remove them. Asset version counters survive permanent deletion to prevent cached old files
being shown when a new terrain model or map image is uploaded. `scripts/smoke-files.mjs` exercises the file manager
in a disposable local world, including downloads, reference protection, live miniature fallback, and reload persistence.

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


## Hex field atlas

Selecting a hex opens a read-first field atlas: a hero illustration, authored lore, terrain and state,
diamond POI cards, resource cards, pieces present, territory, and linked interiors. **Edit** enables
name/terrain/state/wiki-link/GM-note fields, image uploads and resource editing; **Save details** commits
them together and **Cancel** discards the draft. Artwork has adjustable vertical framing and can return
to the rendered map illustration. No lore, resources or locations are seeded by this feature.

Artwork (PNG/JPEG/WebP/GIF, up to 8 MB and 24 megapixels), lore and resources live in separate world-scoped
presentation tables, with revision guards and live updates. They do not rewrite canonical hex data.
Changes to hex properties happen only when the GM explicitly edits those fields. Images persist in
Railway Postgres and appear under **Uploaded files → Hex artwork** for rename/download/two-step removal.
Deleting artwork restores the map illustration and retains the lore/resources. GM notes are private;
players read authored details and art only for explored hexes when their campaign uses fog.

Resources are descriptive entries (name, kind, availability, notes), ready for GM input; gathering,
yield and economy automation are not added. Territory/fog/POI actions remain available in Edit mode and
apply immediately; POI creation keeps the hex draft open. `scripts/smoke-hex-dossiers.mjs` verifies the
read/edit flow, upload/persistence, resources, conflicts/live refresh, POI navigation, desktop/mobile
and player layouts, and preservation of canonical hex data and the mounted world renderer.
