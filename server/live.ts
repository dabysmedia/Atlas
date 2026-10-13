/**
 * Live sync: every open screen keeps one WebSocket (GET /api/live) and hears, as it happens, what changes in the
 * world it is viewing. After a mutating route answers, a `change` goes to everyone on that world: the rows that
 * changed for the high-frequency map edits (so screens patch their cache and the map redraws without a refetch),
 * and otherwise the parts of the cache to refetch ("scopes", which the client maps onto its query keys).
 * Marker drags stream as ephemeral `drag` messages, and each world keeps a list of who is looking at it.
 *
 * Changes travel over a LiveBus. LocalBus delivers in-process, which is all one replica needs; a Postgres
 * LISTEN/NOTIFY or Redis bus can take its place for several (NOTIFY caps payloads near 8 kB, so a big patch would
 * travel as its scopes instead). Presence is per process until then.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';

/** Parts of a screen's cache a change can make stale. The client maps each onto its query keys (client/src/live.ts). */
export const SCOPES = [
  'worlds', 'world', 'map', 'pages', 'page', 'search', 'factions', 'meters', 'mh', 'rolls', 'campaigns', 'events', 'fog', 'modelArchive', 'files', 'tokenModels', 'interiors', 'rules', 'sheets', 'portraits', 'hexPresentation',
] as const;
export type Scope = (typeof SCOPES)[number];

type Row = Record<string, unknown>;
/** Changed rows, applied straight to the cache by the screens that hear them. */
export type Patch =
  | { op: 'hexes'; ids: string[]; set: { terrain?: string; state?: string } }
  | { op: 'hex'; hex: Row }
  /** Every claim now on these hexes (control and the rest), replacing what was there. */
  | { op: 'claims'; hexIds: string[]; claims: Row[] }
  | { op: 'claim'; claim: Row }
  | { op: 'claimGone'; id: string }
  | { op: 'token'; token: Row }
  | { op: 'tokenGone'; id: string }
  /** A faction's name and color, as the map shows them. */
  | { op: 'faction'; faction: { id: string; name: string; color: string; settlementArtStyle?: string | null } }
  | { op: 'fog'; campaignId: string; hexIds: string[]; explored: boolean }
  | { op: 'art'; art: Row | null }
  | { op: 'model'; model: Row | null }
  /** Fields of the world row (clock, weather, name, palettes); `sweep` when the GM moved the day by hand. */
  | { op: 'world'; world: Row; sweep?: boolean };

export type Viewer = { conn: string; name: string; role: Role; since: number };
type Role = 'gm' | 'player';

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
export type LiveEvent = { world: string | null; from?: string; origin?: { client: string; session: string }; msg: ServerMsg };

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
  'POST /api/worlds/:w/pages': ['pages', 'page', 'search', 'events', 'files'],
  'POST /api/worlds/:w/pages/reorder': ['pages', 'page'],
  'POST /api/worlds/:w/wiki-images': ['files'],
  'PATCH /api/worlds/:w/pages/:id': ['pages', 'page', 'search', 'files'],
  'DELETE /api/worlds/:w/pages/:id': ['pages', 'page', 'search', 'events', 'map', 'factions', 'files'],
  // map: hexes, claims, fog and markers patch rows; art and models patch the map's metadata
  'PATCH /api/worlds/:w/hexes/:id/presentation': ['hexPresentation', 'events', 'files'],
  'POST /api/worlds/:w/hex-artwork': ['files'],
  'PATCH /api/worlds/:w/hexes/:id': ['events'],
  'POST /api/worlds/:w/hexes/paint': ['events', 'worlds'],
  'POST /api/worlds/:w/claims/control': ['factions', 'events'],
  'POST /api/worlds/:w/claims': ['factions', 'events'],
  'DELETE /api/worlds/:w/claims/:id': ['factions', 'events'],
  'POST /api/worlds/:w/campaigns/:id/fog': ['events'],
  'POST /api/worlds/:w/tokens': ['events', 'files'],
  'PATCH /api/worlds/:w/tokens/:id': ['events', 'files'],
  'DELETE /api/worlds/:w/tokens/:id': ['events', 'files'],
  'POST /api/worlds/:w/tokens/:id/move': ['events'],
  'POST /api/worlds/:w/tokens/:id/deploy': ['events', 'files'],
  'POST /api/worlds/:w/token-models': ['map', 'files', 'tokenModels', 'interiors'],
  'POST /api/worlds/:w/interiors': ['interiors'],
  'PATCH /api/worlds/:w/interiors/:id': ['interiors'],
  'DELETE /api/worlds/:w/interiors/:id': ['interiors', 'files'],
  'PUT /api/worlds/:w/interiors/:id/asset': ['interiors', 'files'],
  'DELETE /api/worlds/:w/interiors/:id/asset': ['interiors', 'files'],
  'POST /api/worlds/:w/interiors/:id/enter': ['interiors', 'events'],
  'POST /api/worlds/:w/interiors/:id/move': ['interiors', 'events'],
  'POST /api/worlds/:w/interiors/:id/leave': ['interiors', 'events'],
  'PATCH /api/worlds/:w/files/:kind/:id': ['files', 'map', 'modelArchive', 'tokenModels', 'events', 'interiors', 'portraits', 'hexPresentation'],
  'DELETE /api/worlds/:w/files/:kind/:id': ['files', 'map', 'modelArchive', 'tokenModels', 'events', 'interiors', 'portraits', 'hexPresentation'],
  'POST /api/worlds/:w/rules': ['rules'],
  'PATCH /api/worlds/:w/rules/:id': ['rules', 'sheets'],
  'PUT /api/worlds/:w/rules/active': ['rules', 'sheets', 'events'],
  'PATCH /api/worlds/:w/tokens/:id/sheet': ['sheets'],
  'POST /api/worlds/:w/tokens/:id/sheet/roll': ['events'],
  'POST /api/worlds/:w/token-portraits': ['portraits', 'files'],
  'POST /api/worlds/:w/players': ['map'],
  'DELETE /api/worlds/:w/players/:id': ['map'],
  'PUT /api/worlds/:w/map/art': ['events', 'worlds', 'files'],
  'PATCH /api/worlds/:w/map/art': [],
  'DELETE /api/worlds/:w/map/art': ['events', 'worlds', 'files'],
  'PUT /api/worlds/:w/map/model': ['events', 'modelArchive', 'files'],
  'PATCH /api/worlds/:w/map/model': [],
  'DELETE /api/worlds/:w/map/model': ['events', 'modelArchive', 'files'],
  'POST /api/worlds/:w/map/model/archive/:id/restore': ['events', 'modelArchive', 'files'],
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
  'POST /api/worlds/:w/settlements': ['map', 'events'],
  'PATCH /api/worlds/:w/settlements/:id': ['map', 'events'],
  // chronicle
  'POST /api/worlds/:w/events': ['events'],
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ClientId = z.string().regex(/^[\w-]{1,64}$/);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

declare module 'fastify' {
  interface FastifyRequest {
    liveChange?: { patches: Patch[]; scopes: Scope[] };
    liveUser?: { name: string; token: string };
    /** The hub's seq when a read began (sent back as x-atlas-seq). */
    liveSeq?: number;
    /** Lets the next write on this world go ahead, once this one's change is out. */
    liveUnlock?: () => void;
  }
}

/** A route's own account of what changed: rows for screens to patch, and scopes beyond its ROUTE_SCOPES entry. */
export function changed(req: FastifyRequest, c: { patches?: Patch[]; scopes?: Scope[] }) {
  const cur = req.liveChange ?? { patches: [], scopes: [] };
  req.liveChange = { patches: [...cur.patches, ...(c.patches ?? [])], scopes: [...cur.scopes, ...(c.scopes ?? [])] };
}

const Incoming = z.discriminatedUnion('t', [
  z.object({ t: z.literal('sub'), world: z.uuid().nullable() }),
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
  /**
   * Whether a connection may watch a world. Today that is anyone signed in, for a world that exists; player
   * accounts will check membership here.
   */
  canView?: (c: { userId: string; role: Role }, world: string) => Promise<boolean>;
};

export class LiveHub {
  private conns = new Map<string, Conn>();
  private off: () => void;
  private beat: NodeJS.Timeout;
  private pending = new Map<string, NodeJS.Timeout>();
  private stillSignedIn: (token: string) => Promise<boolean>;
  private canView: (c: { userId: string; role: Role }, world: string) => Promise<boolean>;
  /** Write turns per world (see TurnLock). Per process: several replicas would number changes on the shared bus. */
  readonly turns = new TurnLock();
  /** Changes broadcast so far: every change carries the next number, and every read reports where it began. */
  seq = 0;

  constructor(private bus: LiveBus, opts: LiveHubOptions = {}) {
    this.stillSignedIn = opts.stillSignedIn ?? (async () => true);
    this.canView = opts.canView ?? (async () => true);
    this.off = bus.subscribe((ev) => { for (const c of this.conns.values()) this.deliver(c, ev); });
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.beat.unref();
  }

  /**
   * What one connection receives of an event. Today everyone signed in is the GM and sees everything on the world
   * they view; player accounts will filter here by `c.role` (hidden tokens, other campaigns' fog).
   */
  private deliver(c: Conn, ev: LiveEvent) {
    if (ev.from === c.id) return;
    // The tab that made the change has it already. Matched on its session too, so naming another tab's id in a
    // request can't keep that tab from hearing about it.
    if (ev.origin && ev.origin.client === c.client && ev.origin.session === c.session) return;
    const m = ev.msg;
    if (c.role === 'player') {
      if (m.t === 'drag') return;
      if (m.t === 'change') {
        if (ev.world === null || ev.world === c.world) this.send(c, { ...m, scopes: ['map', 'world', 'worlds', 'fog', 'interiors', 'rules', 'sheets', 'portraits', 'hexPresentation'], patches: undefined });
        return;
      }
    }
    if (ev.world === null || ev.world === c.world) return this.send(c, m);
    // Screens on other worlds still keep the world list fresh.
    if (m.t === 'change' && m.scopes.includes('worlds')) this.send(c, { ...m, scopes: ['worlds'], patches: undefined });
  }

  private send(c: Conn, m: ServerMsg) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED) { c.ws.terminate(); return; }
    c.ws.send(JSON.stringify(m));
  }

  publish(ev: LiveEvent) { this.bus.publish(ev); }

  /** Tell the screens on a world (or all, for the world list) what a request changed. */
  broadcast(world: string | null, origin: { client: string; token: string } | null, scopes: Scope[], patches: Patch[] = []) {
    this.publish({
      world,
      ...(origin ? { origin: { client: origin.client, session: sha256(origin.token) } } : {}),
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

  /** Sockets a session holds now. */
  sockets(token: string) { return [...this.conns.values()].filter((c) => c.token === token); }

  /** A session ended (signed out): its screens go back to the sign-in page now, not at the next heartbeat. */
  closeSession(token: string) {
    for (const c of this.sockets(token)) c.ws.close(4401, 'signed out');
  }

  /** A new socket from a signed-in user. */
  attach(ws: WebSocket, who: { userId: string; name: string; role: Role; token: string; client: string | null }) {
    // One session can't pile up sockets: the oldest (a tab gone quiet) makes way. And there is a ceiling for all.
    const mine = this.sockets(who.token).sort((a, b) => a.since - b.since);
    while (mine.length >= SOCKETS_PER_SESSION) { const old = mine.shift()!; old.ws.terminate(); this.drop(old); }
    if (this.conns.size >= MAX_SOCKETS) { ws.close(1013, 'busy'); return null; }
    const c: Conn = {
      id: crypto.randomUUID(), ws, ...who, session: sha256(who.token), world: null, since: Date.now(), alive: true,
      budget: { at: 0, drags: 0, ends: 0, subs: 0 }, subs: 0, fails: 0,
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
      void this.join(c, parsed.world);
      return;
    }
    // A marker being dragged: relayed to the others on the world, never stored. The drop commits through PATCH.
    if (!c.world || c.role === 'player') return;
    if (parsed.end ? ++c.budget.ends > ENDS_PER_SECOND : ++c.budget.drags > DRAGS_PER_SECOND) return;
    const { t: _t, ...drag } = parsed;
    this.publish({ world: c.world, from: c.id, msg: { t: 'drag', world: c.world, conn: c.id, ...drag } });
  }

  /** Move a connection to the world it now shows (null: the world list only), once it may see that world. */
  private async join(c: Conn, world: string | null) {
    const n = ++c.subs;
    if (world !== c.world) {
      // Leave at once; arrive once the check passes.
      const was = c.world;
      c.world = null;
      this.presence(was);
      const ok = world === null || (await this.canView(c, world).catch(() => false));
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

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url}`;

/**
 * The socket endpoint, and the hooks that tell the hub about every mutation. Register inside the authenticated
 * /api scope, before its routes, so each route registered after is checked against ROUTE_SCOPES.
 */
export function liveRoutes(app: FastifyInstance, hub: LiveHub, auth: {
  /** Who a request's session belongs to. */
  user: (req: FastifyRequest) => Promise<{ name: string; token: string } | null>;
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
        hub.broadcast(world, client.success && token ? { client: client.data, token } : null,
          [...scopes, ...(req.liveChange?.scopes ?? [])], req.liveChange?.patches);
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
    hub.attach(ws, { userId: req.userId!, name: req.liveUser!.name, role: req.userRole ?? 'gm', token: req.liveUser!.token, client: client.success ? client.data : null });
  });
}
