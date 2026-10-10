/**
 * Live sync: every open screen keeps one WebSocket (GET /api/live) and hears, as it happens, what changes in the
 * world it is viewing. After a mutating route answers, a `change` goes to everyone on that world: the rows that
 * changed for the high-frequency map edits (so screens patch their cache and the map redraws without a refetch),
 * and otherwise the parts of the cache to refetch ("scopes", which the client maps onto its query keys).
 * Marker drags stream as ephemeral `drag` messages, and each world keeps a list of who is looking at it.
 *
 * Player sockets hear the same world through their party's fog: `deliver` filters every message for them by the
 * rules in server/access.ts (the ones the HTTP routes apply), with what the socket knows of the fog and the markers.
 *
 * Changes travel over a LiveBus. LocalBus delivers in-process, which is all one replica needs; a Postgres
 * LISTEN/NOTIFY or Redis bus can take its place for several (NOTIFY caps payloads near 8 kB, so a big patch would
 * travel as its scopes instead). Presence is per process until then.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { GM_SCOPES, mayMoveToken, routeKey, seenClaim, seenToken, tokenSeen, type PlayerLive } from './access.js';

/** Parts of a screen's cache a change can make stale. The client maps each onto its query keys (client/src/live.ts). */
export const SCOPES = [
  'worlds', 'world', 'map', 'pages', 'page', 'search', 'factions', 'meters', 'mh', 'rolls', 'campaigns', 'events', 'fog', 'modelArchive',
  'players',
] as const;
export type Scope = (typeof SCOPES)[number];

type Row = Record<string, unknown>;
/** Changed rows, applied straight to the cache by the screens that hear them. */
export type Patch =
  | { op: 'hexes'; ids: string[]; set: { terrain?: string; state?: string } }
  /** `gmPage`: the hex links a GM-only page, which players' copies leave out (not sent on). */
  | { op: 'hex'; hex: Row; gmPage?: boolean }
  /** Every claim now on these hexes (control and the rest), replacing what was there. */
  | { op: 'claims'; hexIds: string[]; claims: Row[] }
  | { op: 'claim'; claim: Row }
  | { op: 'claimGone'; id: string }
  | { op: 'token'; token: Row }
  | { op: 'tokenGone'; id: string }
  /** A faction's name and color, as the map shows them. */
  | { op: 'faction'; faction: { id: string; name: string; color: string } }
  | { op: 'fog'; campaignId: string; hexIds: string[]; explored: boolean }
  | { op: 'art'; art: Row | null }
  | { op: 'model'; model: Row | null }
  /** Fields of the world row (clock, weather, name, palettes); `sweep` when the GM moved the day by hand. */
  | { op: 'world'; world: Row; sweep?: boolean };

export type Viewer = { conn: string; name: string; role: Role; since: number };
type Role = 'gm' | 'player';
type TokenRow = { id: string; hexId: string | null; visibleToPlayers: boolean; kind: string; campaignId: string | null };

export type ServerMsg =
  | { t: 'hello'; conn: string; you: Viewer }
  /** `seq` numbers changes in the order they were saved (see LiveHub.seq). */
  | { t: 'change'; world: string | null; seq: number; scopes: Scope[]; patches?: Patch[] }
  /**
   * A `sub` took effect: changes after `seq` reach this screen. One that read anything older may have missed
   * some (GET responses carry the seq they started at, as x-atlas-seq).
   */
  | { t: 'subbed'; world: string | null; seq: number }
  | { t: 'presence'; world: string; viewers: Viewer[] }
  | { t: 'drag'; world: string; conn: string; token: string; x: number; y: number; end?: boolean; to?: string | null }
  | { t: 'hb' };

/**
 * One message on the bus: for a world's viewers, or (world null) for every screen. `from` is a connection that
 * doesn't get it back; `origin`, the tab (and session, hashed) whose request made a change, which skips its own echo.
 */
export type LiveEvent = {
  world: string | null; from?: string; origin?: { client: string; session: string }; msg: ServerMsg;
  /** 'gm': about something players never see (a GM-only page), so their screens don't hear of it at all. */
  audience?: 'gm';
};

export interface LiveBus {
  publish(ev: LiveEvent): void;
  subscribe(fn: (ev: LiveEvent) => void): () => void;
}

export class LocalBus implements LiveBus {
  private fns = new Set<(ev: LiveEvent) => void>();
  publish(ev: LiveEvent) { for (const fn of this.fns) fn(ev); }
  subscribe(fn: (ev: LiveEvent) => void) { this.fns.add(fn); return () => { this.fns.delete(fn); }; }
}

type Conn = {
  id: string; ws: WebSocket; client: string | null; userId: string; name: string; role: Role;
  world: string | null; since: number; alive: boolean; token: string;
  /** Players: the campaign this screen asked to view the world as, and what it knows of that party's view. */
  want: string | null;
  view: PlayerLive | null;
  /** The session as it travels on the bus: hashed, so a shared bus never carries a usable cookie. */
  session: string;
  /** Messages this second, to keep one screen from flooding the rest. */
  budget: { at: number; drags: number; ends: number; subs: number };
  /** Bumped by each `sub`, so a slow access check can't apply an older one over a newer. */
  subs: number;
  /** Heartbeats in a row whose session check failed (the database was unreachable, say). */
  fails: number;
};

/**
 * Which route invalidates what, beyond the rows a handler patches itself (`changed` below). Every mutating route
 * under /api must be listed: registering one that isn't fails at boot, so a new route can't quietly skip live sync.
 */
export const ROUTE_SCOPES: Record<string, Scope[]> = {
  // worlds and the world clock (the clock routes also patch the world row)
  'POST /api/worlds': ['worlds'],
  'POST /api/worlds/reorder': ['worlds'],
  'PATCH /api/worlds/:w': ['worlds', 'events'],
  'DELETE /api/worlds/:w': ['worlds', 'world'],
  'PATCH /api/worlds/:w/daylight': ['worlds', 'events'],
  'PATCH /api/worlds/:w/weather': ['events'],
  'POST /api/worlds/:w/weather/roll': ['events'],
  'POST /api/worlds/:w/day': ['worlds', 'events'],
  // wiki
  'POST /api/worlds/:w/pages': ['pages', 'page', 'search', 'events'],
  'PATCH /api/worlds/:w/pages/:id': ['pages', 'page', 'search'],
  'DELETE /api/worlds/:w/pages/:id': ['pages', 'page', 'search', 'events', 'map', 'factions'],
  // map: hexes, claims, fog and markers patch rows; art and models patch the map's metadata
  'PATCH /api/worlds/:w/hexes/:id': ['events'],
  'POST /api/worlds/:w/hexes/paint': ['events', 'worlds'],
  'POST /api/worlds/:w/claims/control': ['factions', 'events'],
  'POST /api/worlds/:w/claims': ['factions', 'events'],
  'DELETE /api/worlds/:w/claims/:id': ['factions', 'events'],
  'POST /api/worlds/:w/campaigns/:id/fog': ['events'],
  'POST /api/worlds/:w/tokens': ['events'],
  'PATCH /api/worlds/:w/tokens/:id': ['events'],
  'DELETE /api/worlds/:w/tokens/:id': ['events'],
  'PUT /api/worlds/:w/map/art': ['events', 'worlds'],
  'PATCH /api/worlds/:w/map/art': [],
  'DELETE /api/worlds/:w/map/art': ['events', 'worlds'],
  'PUT /api/worlds/:w/map/model': ['events', 'modelArchive'],
  'PATCH /api/worlds/:w/map/model': [],
  'DELETE /api/worlds/:w/map/model': ['events', 'modelArchive'],
  'POST /api/worlds/:w/map/model/archive/:id/restore': ['events', 'modelArchive'],
  // factions, meters, roll tables, campaigns, settlements
  'POST /api/worlds/:w/factions': ['factions', 'map', 'events', 'mh'],
  'PATCH /api/worlds/:w/factions/:id': ['factions', 'events', 'mh'],
  'DELETE /api/worlds/:w/factions/:id': ['factions', 'map', 'events', 'rolls'],
  'POST /api/worlds/:w/meters': ['meters', 'factions'],
  'PATCH /api/worlds/:w/meters/:id': ['meters', 'factions'],
  'DELETE /api/worlds/:w/meters/:id': ['meters', 'factions', 'events', 'rolls', 'mh'],
  'POST /api/worlds/:w/factions/:id/meters/:m': ['factions', 'mh', 'events'],
  'POST /api/worlds/:w/roll-tables': ['rolls'],
  'PATCH /api/worlds/:w/roll-tables/:id': ['rolls'],
  'DELETE /api/worlds/:w/roll-tables/:id': ['rolls'],
  'POST /api/worlds/:w/roll-tables/:id/entries': ['rolls'],
  'PATCH /api/worlds/:w/roll-entries/:id': ['rolls', 'events'],
  'DELETE /api/worlds/:w/roll-entries/:id': ['rolls'],
  'POST /api/worlds/:w/roll-tables/:id/roll': ['events'],
  'POST /api/worlds/:w/campaigns': ['campaigns', 'map', 'events'],
  'PATCH /api/worlds/:w/campaigns/:id': ['campaigns', 'map'],
  'DELETE /api/worlds/:w/campaigns/:id': ['campaigns', 'map', 'fog', 'events'],
  'PATCH /api/worlds/:w/settlements/:id': ['map'],
  // chronicle
  'POST /api/worlds/:w/events': ['events'],
  // accounts (the GM's other screens keep the player list fresh)
  'POST /api/players': ['players'],
  'PATCH /api/players/:id': ['players'],
  'POST /api/players/:id/password': ['players'],
  'PUT /api/players/:id/campaigns': ['players'],
  'DELETE /api/players/:id': ['players'],
  'PATCH /api/account': ['players'],
  'POST /api/account/password': [],
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ClientId = z.string().regex(/^[\w-]{1,64}$/);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** What a request changed, as its route tells it (`changed`). */
type LiveChange = {
  patches: Patch[]; scopes: Scope[];
  /** About something only the GM sees: players' screens don't hear of it. */
  gmOnly?: boolean;
  /** Users whose screens must start over (what they may see changed), or who are signed out now. */
  restart?: string[]; signOut?: string[];
};

declare module 'fastify' {
  interface FastifyRequest {
    liveChange?: LiveChange;
    liveUser?: { id: string; name: string; role: Role; token: string };
    /** The hub's seq when a read began (sent back as x-atlas-seq). */
    liveSeq?: number;
    /** Lets the next write on this world go ahead, once this one's change is out. */
    liveUnlock?: () => void;
  }
}

/** A route's own account of what changed: rows for screens to patch, and scopes beyond its ROUTE_SCOPES entry. */
export function changed(req: FastifyRequest, c: { patches?: Patch[]; scopes?: Scope[]; gmOnly?: boolean; restart?: string[]; signOut?: string[] }) {
  const cur = req.liveChange ?? { patches: [], scopes: [] };
  req.liveChange = {
    patches: [...cur.patches, ...(c.patches ?? [])], scopes: [...cur.scopes, ...(c.scopes ?? [])],
    gmOnly: cur.gmOnly || c.gmOnly,
    restart: [...(cur.restart ?? []), ...(c.restart ?? [])], signOut: [...(cur.signOut ?? []), ...(c.signOut ?? [])],
  };
}

const Incoming = z.discriminatedUnion('t', [
  /** `campaign`: a player's choice of party to view the world as (their first, without one). */
  z.object({ t: z.literal('sub'), world: z.uuid().nullable(), campaign: z.uuid().nullable().optional() }),
  z.object({
    t: z.literal('drag'), token: z.uuid(), x: z.number().finite(), y: z.number().finite(),
    end: z.boolean().optional(), to: z.uuid().nullable().optional(),
  }),
]);

const HEARTBEAT_MS = 25_000;
const DRAGS_PER_SECOND = 60;
/** Let-gos are never dropped with the rest (a marker would hang mid-air), but they have a small budget of their own. */
const ENDS_PER_SECOND = 8;
const SUBS_PER_SECOND = 10;
/** Who's-here updates for a world are gathered this long, so screens coming and going don't flood the rest. */
const PRESENCE_MS = 120;
/** A screen that stops reading this far behind is dropped (it catches up when it reconnects), not buffered for. */
const MAX_BUFFERED = 2 * 1024 * 1024;
/** Sockets one session may hold; a new one beyond this replaces its oldest (a tab long gone, most likely). */
export const SOCKETS_PER_SESSION = 10;
const MAX_SOCKETS = 2000;
/** Session checks that may fail in a row (an unreachable database) before a socket is treated as signed out. */
const MAX_CHECK_FAILS = 3;

/**
 * Takes turns per key: writes to one world run one at a time, each broadcast before the next starts, so every
 * screen hears a world's changes in the order they were saved (two quick moves of one marker can't land swapped).
 */
class TurnLock {
  private tails = new Map<string, Promise<void>>();
  async take(key: string): Promise<() => void> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((r) => { open = r; });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    let done = false;
    // A request that never answers mustn't stall the world for good.
    const timer = setTimeout(() => release(), 15_000);
    timer.unref();
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    return release;
  }
}

export type LiveHubOptions = {
  /** Whether a connection's session still holds (checked on each heartbeat). */
  stillSignedIn?: (token: string) => Promise<boolean>;
  /** Whether the GM's connection may watch a world (one that exists). */
  canView?: (c: { userId: string; role: Role }, world: string) => Promise<boolean>;
  /**
   * A player's view of a world (as the campaign asked for, or their first): what the socket needs to filter what
   * it hears. Null when the world isn't theirs.
   */
  playerLive?: (userId: string, world: string, campaign: string | null) => Promise<PlayerLive | null>;
};

export class LiveHub {
  private conns = new Map<string, Conn>();
  private off: () => void;
  private beat: NodeJS.Timeout;
  private pending = new Map<string, NodeJS.Timeout>();
  private stillSignedIn: (token: string) => Promise<boolean>;
  private canView: (c: { userId: string; role: Role }, world: string) => Promise<boolean>;
  private playerLive: (userId: string, world: string, campaign: string | null) => Promise<PlayerLive | null>;
  /** Write turns per world (see TurnLock). Per process: several replicas would number changes on the shared bus. */
  readonly turns = new TurnLock();
  /** Changes broadcast so far: every change carries the next number, and every read reports where it began. */
  seq = 0;

  constructor(private bus: LiveBus, opts: LiveHubOptions = {}) {
    this.stillSignedIn = opts.stillSignedIn ?? (async () => true);
    this.canView = opts.canView ?? (async () => true);
    this.playerLive = opts.playerLive ?? (async () => null);
    this.off = bus.subscribe((ev) => { for (const c of this.conns.values()) this.deliver(c, ev); });
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.beat.unref();
  }

  /**
   * What one connection receives of an event. The GM sees everything on the world they view; a player hears it
   * through their party's fog (forPlayer), by the same rules as the HTTP routes.
   */
  private deliver(c: Conn, ev: LiveEvent) {
    if (ev.from === c.id) return;
    const here = ev.world === null || ev.world === c.world;
    let m: ServerMsg | null = ev.msg;
    if (c.role === 'player') {
      if (ev.audience === 'gm') return;
      // Filtered before the echo check: a player's own change still moves what their socket knows (their marker's hex).
      if (here) m = this.forPlayer(c, m);
      if (!m) return;
    }
    // The tab that made the change has it already. Matched on its session too, so naming another tab's id in a
    // request can't keep that tab from hearing about it.
    if (ev.origin && ev.origin.client === c.client && ev.origin.session === c.session) return;
    if (here) return this.send(c, m);
    // Screens on other worlds still keep the world list fresh.
    if (m.t === 'change' && m.scopes.includes('worlds')) this.send(c, { ...m, scopes: ['worlds'], patches: undefined });
  }

  /**
   * A message as a player's socket may hear it: changed rows on hexes their party hasn't explored are dropped, GM
   * notes stripped, hidden markers (and their drags) left out, and a marker that walks into the fog or is hidden
   * goes away. When the party's fog changes, the screen is told to read the map again, which brings what is now
   * explored (or leaves out what no longer is). Keeps the socket's own account of the fog and markers up to date.
   */
  private forPlayer(c: Conn, m: ServerMsg): ServerMsg | null {
    const v = c.view;
    if (m.t === 'drag') {
      const t = v?.tokens.get(m.token);
      return v && t && tokenSeen(t, v.revealed) ? m : null;
    }
    if (m.t !== 'change') return m;
    const scopes = new Set(m.scopes.filter((s) => !GM_SCOPES.has(s)));
    const patches: Patch[] = [];
    for (const p of m.patches ?? []) {
      const out = v ? playerPatch(v, p, scopes) : null;
      if (out) patches.push(out);
    }
    // A change whose rows are all out of the player's sight goes unheard: what else it names (its chronicle line,
    // the world list's counts) is about those same rows.
    if (m.patches?.length && !patches.length) return null;
    if (!patches.length && !scopes.size) return null;
    return { ...m, scopes: [...scopes], patches: patches.length ? patches : undefined };
  }

  private send(c: Conn, m: ServerMsg) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) { c.ws.terminate(); return; }
    c.ws.send(JSON.stringify(m));
  }

  publish(ev: LiveEvent) { this.bus.publish(ev); }

  /** Tell the screens on a world (or all, for the world list) what a request changed. */
  broadcast(world: string | null, origin: { client: string; token: string } | null, scopes: Scope[], patches: Patch[] = [], audience?: 'gm') {
    this.publish({
      world,
      ...(origin ? { origin: { client: origin.client, session: sha256(origin.token) } } : {}),
      ...(audience ? { audience } : {}),
      msg: { t: 'change', world, seq: ++this.seq, scopes: [...new Set(scopes)], ...(patches.length ? { patches } : {}) },
    });
  }

  viewers(world: string): Viewer[] {
    return [...this.conns.values()].filter((c) => c.world === world).sort((a, b) => a.since - b.since)
      .map((c) => ({ conn: c.id, name: c.name, role: c.role, since: c.since }));
  }

  /** Tell a world's screens who is there now, once things settle for a moment. */
  private presence(world: string | null) {
    if (!world || this.pending.has(world)) return;
    const t = setTimeout(() => {
      this.pending.delete(world);
      this.publish({ world, msg: { t: 'presence', world, viewers: this.viewers(world) } });
    }, PRESENCE_MS);
    t.unref();
    this.pending.set(world, t);
  }

  get size() { return this.conns.size; }

  /** Users with a screen open now. */
  online() { return new Set([...this.conns.values()].map((c) => c.userId)); }

  /** Sockets a session holds now. */
  sockets(token: string) { return [...this.conns.values()].filter((c) => c.token === token); }

  /** A session ended (signed out): its screens go back to the sign-in page now, not at the next heartbeat. */
  closeSession(token: string) {
    for (const c of this.sockets(token)) c.ws.close(4401, 'signed out');
  }

  /** A user was signed out everywhere (removed, or their password changed), but for the session `keep`. */
  signOutUser(userId: string, keep?: string) {
    for (const c of this.conns.values()) if (c.userId === userId && c.token !== keep) c.ws.close(4401, 'signed out');
  }

  /**
   * What a user may see changed (campaigns joined or left): their screens reconnect at once and read everything
   * again, checked afresh.
   */
  restartUser(userId: string) {
    for (const c of this.conns.values()) if (c.userId === userId) c.ws.close(4409, 'access changed');
  }

  /** A user's display name changed: their avatars say so. */
  rename(userId: string, name: string) {
    for (const c of this.conns.values()) if (c.userId === userId) { c.name = name; this.presence(c.world); }
  }

  /** A new socket from a signed-in user. */
  attach(ws: WebSocket, who: { userId: string; name: string; role: Role; token: string; client: string | null }) {
    // One session can't pile up sockets: the oldest (a tab gone quiet) makes way. And there is a ceiling for all.
    const mine = this.sockets(who.token).sort((a, b) => a.since - b.since);
    while (mine.length >= SOCKETS_PER_SESSION) { const old = mine.shift()!; old.ws.terminate(); this.drop(old); }
    if (this.conns.size >= MAX_SOCKETS) { ws.close(1013, 'busy'); return null; }
    const c: Conn = {
      id: crypto.randomUUID(), ws, ...who, session: sha256(who.token), world: null, since: Date.now(), alive: true,
      budget: { at: 0, drags: 0, ends: 0, subs: 0 }, subs: 0, fails: 0, want: null, view: null,
    };
    this.conns.set(c.id, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => { c.alive = true; this.receive(c, raw.toString()); });
    ws.on('close', () => this.drop(c));
    this.send(c, { t: 'hello', conn: c.id, you: { conn: c.id, name: c.name, role: c.role, since: c.since } });
    return c.id;
  }

  private drop(c: Conn) {
    if (!this.conns.delete(c.id)) return;
    this.presence(c.world);
  }

  private receive(c: Conn, raw: string) {
    let parsed: z.infer<typeof Incoming>;
    try { parsed = Incoming.parse(JSON.parse(raw)); } catch { return; }
    const now = Date.now();
    if (now - c.budget.at > 1000) c.budget = { at: now, drags: 0, ends: 0, subs: 0 };
    if (parsed.t === 'sub') {
      if (++c.budget.subs > SUBS_PER_SECOND) return;
      void this.join(c, parsed.world, parsed.campaign ?? null);
      return;
    }
    // A marker being dragged: relayed to the others on the world, never stored. The drop commits through PATCH.
    if (!c.world) return;
    if (parsed.end ? ++c.budget.ends > ENDS_PER_SECOND : ++c.budget.drags > DRAGS_PER_SECOND) return;
    // Players drag only their party's marker, as the PATCH that drops it allows.
    if (c.role === 'player') {
      const t = c.view?.tokens.get(parsed.token);
      if (!c.view || !t || !tokenSeen(t, c.view.revealed) || !mayMoveToken(t, c.view.campaign)) return;
    }
    const { t: _t, ...drag } = parsed;
    this.publish({ world: c.world, from: c.id, msg: { t: 'drag', world: c.world, conn: c.id, ...drag } });
  }

  /**
   * Move a connection to the world it now shows (null: the world list only), once it may see that world. A player
   * also says which of their parties they view it as; the socket loads that party's view to filter what it hears.
   */
  private async join(c: Conn, world: string | null, campaign: string | null) {
    const n = ++c.subs;
    if (world !== c.world || (c.role === 'player' && campaign !== c.want)) {
      // Leave at once; arrive once the check passes.
      const was = c.world;
      c.world = null;
      c.view = null;
      c.want = campaign;
      this.presence(was);
      let ok = world === null;
      if (world !== null && c.role === 'player') {
        // Read again if a change went out while reading, so the socket starts from the state its screen will read.
        let view: PlayerLive | null = null;
        for (let i = 0; i < 3; i++) {
          const seq = this.seq;
          view = await this.playerLive(c.userId, world, campaign).catch(() => null);
          if (seq === this.seq || n !== c.subs) break;
        }
        if (n !== c.subs || !this.conns.has(c.id)) return;
        c.view = view;
        ok = !!view;
      } else if (world !== null) ok = await this.canView(c, world).catch(() => false);
      if (n !== c.subs || !this.conns.has(c.id)) return;
      c.world = ok ? world : null;
      this.presence(c.world);
    }
    this.send(c, { t: 'subbed', world: c.world, seq: this.seq });
    if (c.world) this.send(c, { t: 'presence', world: c.world, viewers: this.viewers(c.world) });
  }

  /** Drop sockets that stopped answering pings or whose session ended; keep the rest (and proxies) awake. */
  private async heartbeat() {
    for (const c of [...this.conns.values()]) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
      this.send(c, { t: 'hb' });
      // A failed check counts as signed in a few times (a database blip shouldn't sign everyone out), not forever.
      const ok = await this.stillSignedIn(c.token).then((v) => { c.fails = 0; return v; }, () => ++c.fails < MAX_CHECK_FAILS);
      if (!ok) c.ws.close(4401, 'signed out');
    }
  }

  close() {
    clearInterval(this.beat);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.off();
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
  }
}

/** True when a browser's Origin is this site (or absent: only browsers send cookies cross-site, and they always send Origin). */
export function sameOrigin(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.host; } catch { return false; }
}

/**
 * A changed row as a player's socket may see it (null: not at all), by the rules in server/access.ts. `scopes`
 * gathers what the screen must read again: after a change to the party's fog, the map.
 */
function playerPatch(v: PlayerLive, p: Patch, scopes: Set<Scope>): Patch | null {
  switch (p.op) {
    case 'hexes': {
      const ids = p.ids.filter((id) => v.revealed.has(id));
      return ids.length ? { ...p, ids } : null;
    }
    case 'hex': {
      const hex = p.hex as { id: string; wikiPageId?: string | null };
      if (!v.revealed.has(hex.id)) return null;
      return { op: 'hex', hex: { ...hex, notes: '', data: {}, wikiPageId: p.gmPage ? null : hex.wikiPageId ?? null } };
    }
    case 'claims': {
      const hexIds = p.hexIds.filter((id) => v.revealed.has(id));
      if (!hexIds.length) return null;
      return { op: 'claims', hexIds, claims: p.claims.filter((c) => v.revealed.has(c.hexId as string)).map(seenClaim) };
    }
    case 'claim': return v.revealed.has(p.claim.hexId as string) ? { op: 'claim', claim: seenClaim(p.claim) } : null;
    case 'token': {
      const row = p.token as TokenRow;
      const was = v.tokens.get(row.id);
      const now = { hexId: row.hexId, visibleToPlayers: row.visibleToPlayers, kind: row.kind, campaignId: row.campaignId };
      v.tokens.set(row.id, now);
      if (tokenSeen(now, v.revealed)) return { op: 'token', token: seenToken(p.token) };
      // Hidden now, or gone into the fog: it leaves their map (if it was ever on it).
      return was && tokenSeen(was, v.revealed) ? { op: 'tokenGone', id: row.id } : null;
    }
    case 'tokenGone': {
      const was = v.tokens.get(p.id);
      v.tokens.delete(p.id);
      return was && tokenSeen(was, v.revealed) ? p : null;
    }
    case 'fog': {
      if (p.campaignId !== v.campaign) return null;
      for (const id of p.hexIds) { if (p.explored) v.revealed.add(id); else v.revealed.delete(id); }
      // What stands on the hexes now explored (or no longer) comes with a fresh read of the map.
      scopes.add('map'); scopes.add('events'); scopes.add('factions');
      return p;
    }
    // Map art and the 3D model show the whole map: players' screens never load them.
    case 'art': case 'model': return null;
    case 'claimGone': case 'faction': case 'world': return p;
  }
}

/**
 * The socket endpoint, and the hooks that tell the hub about every mutation. Register inside the authenticated
 * /api scope, before its routes, so each route registered after is checked against ROUTE_SCOPES.
 */
export function liveRoutes(app: FastifyInstance, hub: LiveHub, auth: {
  /** Who a request's session belongs to. */
  user: (req: FastifyRequest) => Promise<{ id: string; name: string; role: Role; token: string } | null>;
  /** The request's session token (its cookie), to tie the tab id it sends to the session that sent it. */
  token: (req: FastifyRequest) => string | undefined;
}) {
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (MUTATING.has(method) && !(`${method} ${r.url}` in ROUTE_SCOPES)) throw new Error(`Live sync: ${method} ${r.url} has no ROUTE_SCOPES entry`);
    }
  });

  // Reads note where the change count stood as they began (a screen compares it with its subscription's).
  app.addHook('onRequest', async (req) => { if (req.method === 'GET') req.liveSeq = hub.seq; });

  // Writes to one world take turns (after sign-in, so a stranger can't queue behind them).
  app.addHook('preHandler', async (req) => {
    if (!MUTATING.has(req.method) || !(routeKey(req) in ROUTE_SCOPES)) return;
    req.liveUnlock = await hub.turns.take((req.params as { w?: string }).w ?? '*');
  });

  // Sent as the answer goes out (not after it is delivered: a screen that stops listening mid-answer has still
  // made its change), then the next write on the world may go.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.liveSeq !== undefined) reply.header('x-atlas-seq', String(req.liveSeq));
    if (!req.liveUnlock) return payload;
    try {
      const scopes = ROUTE_SCOPES[routeKey(req)];
      if (reply.statusCode < 400 && scopes) {
        const world = (req.params as { w?: string }).w ?? null;
        const client = ClientId.safeParse(req.headers['x-atlas-client']);
        const token = auth.token(req);
        const ch = req.liveChange;
        hub.broadcast(world, client.success && token ? { client: client.data, token } : null,
          [...scopes, ...(ch?.scopes ?? [])], ch?.patches, ch?.gmOnly ? 'gm' : undefined);
        for (const u of ch?.signOut ?? []) hub.signOutUser(u, token);
        for (const u of ch?.restart ?? []) hub.restartUser(u);
      }
    } finally { req.liveUnlock(); }
    return payload;
  });

  app.get('/api/live', {
    websocket: true,
    preValidation: async (req, reply) => { if (!sameOrigin(req)) return reply.code(403).send({ error: 'Cross-site socket refused' }); },
    // After the scope's sign-in check; resolved before the upgrade so the socket's first messages aren't missed.
    preHandler: async (req, reply) => {
      const who = await auth.user(req);
      if (!who) return reply.code(401).send({ error: 'unauthenticated' });
      req.liveUser = who;
    },
  }, (ws, req) => {
    const client = ClientId.safeParse((req.query as { client?: string }).client);
    const who = req.liveUser!;
    hub.attach(ws, { userId: who.id, name: who.name, role: who.role, token: who.token, client: client.success ? client.data : null });
  });
}
