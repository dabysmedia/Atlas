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
  'worlds', 'world', 'map', 'pages', 'page', 'search', 'factions', 'meters', 'mh', 'rolls', 'campaigns', 'events', 'fog', 'modelArchive',
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
  | { op: 'fog'; campaignId: string; hexIds: string[]; explored: boolean }
  | { op: 'art'; art: Row | null }
  | { op: 'model'; model: Row | null }
  /** Fields of the world row (clock, weather, name, palettes); `sweep` when the GM moved the day by hand. */
  | { op: 'world'; world: Row; sweep?: boolean };

export type Viewer = { conn: string; name: string; role: Role; since: number };
type Role = 'gm' | 'player';

export type ServerMsg =
  | { t: 'hello'; conn: string; you: Viewer }
  /** `origin` is the client id of the tab that made the change, which skips its own echo. */
  | { t: 'change'; world: string | null; origin: string | null; scopes: Scope[]; patches?: Patch[] }
  | { t: 'presence'; world: string; viewers: Viewer[] }
  | { t: 'drag'; world: string; conn: string; token: string; x: number; y: number; end?: boolean; to?: string | null }
  | { t: 'hb' };

/** One message on the bus: for a world's viewers, or (world null) for every screen. */
export type LiveEvent = { world: string | null; from?: string; msg: ServerMsg };

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
  /** Drag messages this second, to keep one screen from flooding the rest. */
  budget: { at: number; n: number };
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
  'PATCH /api/worlds/:w/factions/:id': ['factions', 'map', 'events', 'mh'],
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
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ClientId = z.string().regex(/^[\w-]{1,64}$/);

declare module 'fastify' {
  interface FastifyRequest { liveChange?: { patches: Patch[]; scopes: Scope[] }; liveUser?: { name: string; token: string } }
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

export class LiveHub {
  private conns = new Map<string, Conn>();
  private off: () => void;
  private beat: NodeJS.Timeout;

  constructor(
    private bus: LiveBus,
    /** Whether a connection's session still holds (checked on each heartbeat, so signing out closes its sockets). */
    private stillSignedIn: (token: string) => Promise<boolean> = async () => true,
  ) {
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
    const m = ev.msg;
    if (ev.world === null || ev.world === c.world) return this.send(c, m);
    // Screens on other worlds still keep the world list fresh.
    if (m.t === 'change' && m.scopes.includes('worlds')) this.send(c, { ...m, scopes: ['worlds'], patches: undefined });
  }

  private send(c: Conn, m: ServerMsg) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m));
  }

  publish(ev: LiveEvent) { this.bus.publish(ev); }

  /** Tell the screens on a world (or all, for the world list) what a request changed. */
  broadcast(world: string | null, origin: string | null, scopes: Scope[], patches: Patch[] = []) {
    this.publish({ world, msg: { t: 'change', world, origin, scopes: [...new Set(scopes)], ...(patches.length ? { patches } : {}) } });
  }

  viewers(world: string): Viewer[] {
    return [...this.conns.values()].filter((c) => c.world === world).sort((a, b) => a.since - b.since)
      .map((c) => ({ conn: c.id, name: c.name, role: c.role, since: c.since }));
  }

  private presence(world: string | null) {
    if (world) this.publish({ world, msg: { t: 'presence', world, viewers: this.viewers(world) } });
  }

  get size() { return this.conns.size; }

  /** A new socket from a signed-in user. */
  attach(ws: WebSocket, who: { userId: string; name: string; role: Role; token: string; client: string | null }) {
    const c: Conn = { id: crypto.randomUUID(), ws, ...who, world: null, since: Date.now(), alive: true, budget: { at: 0, n: 0 } };
    this.conns.set(c.id, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => { c.alive = true; this.receive(c, raw.toString()); });
    ws.on('close', () => {
      this.conns.delete(c.id);
      this.presence(c.world);
    });
    this.send(c, { t: 'hello', conn: c.id, you: { conn: c.id, name: c.name, role: c.role, since: c.since } });
    return c.id;
  }

  private receive(c: Conn, raw: string) {
    let parsed: z.infer<typeof Incoming>;
    try { parsed = Incoming.parse(JSON.parse(raw)); } catch { return; }
    if (parsed.t === 'sub') {
      if (parsed.world === c.world) return this.send(c, { t: 'presence', world: c.world!, viewers: this.viewers(c.world!) });
      const was = c.world;
      c.world = parsed.world;
      this.presence(was);
      this.presence(c.world);
      return;
    }
    // A marker being dragged: relayed to the others on the world, never stored. The drop commits through PATCH.
    if (!c.world) return;
    const now = Date.now();
    if (now - c.budget.at > 1000) c.budget = { at: now, n: 0 };
    if (++c.budget.n > DRAGS_PER_SECOND && !parsed.end) return;
    const { t: _t, ...drag } = parsed;
    this.publish({ world: c.world, from: c.id, msg: { t: 'drag', world: c.world, conn: c.id, ...drag } });
  }

  /** Drop sockets that stopped answering pings or whose session ended; keep the rest (and proxies) awake. */
  private async heartbeat() {
    for (const c of [...this.conns.values()]) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing */ }
      this.send(c, { t: 'hb' });
      if (!(await this.stillSignedIn(c.token).catch(() => true))) c.ws.close(4401, 'signed out');
    }
  }

  close() {
    clearInterval(this.beat);
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
 * The socket endpoint, and the hooks that tell the hub about every mutation. Register inside the authenticated
 * /api scope, before its routes, so each route registered after is checked against ROUTE_SCOPES.
 */
export function liveRoutes(app: FastifyInstance, hub: LiveHub, user: (req: FastifyRequest) => Promise<{ name: string; token: string } | null>) {
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (MUTATING.has(method) && !(`${method} ${r.url}` in ROUTE_SCOPES)) throw new Error(`Live sync: ${method} ${r.url} has no ROUTE_SCOPES entry`);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method) || reply.statusCode >= 400) return;
    const scopes = ROUTE_SCOPES[`${req.method} ${req.routeOptions.url}`];
    if (!scopes) return;
    const world = (req.params as { w?: string }).w ?? null;
    const origin = ClientId.safeParse(req.headers['x-atlas-client']);
    hub.broadcast(world, origin.success ? origin.data : null, [...scopes, ...(req.liveChange?.scopes ?? [])], req.liveChange?.patches);
  });

  app.get('/api/live', {
    websocket: true,
    preValidation: async (req, reply) => { if (!sameOrigin(req)) return reply.code(403).send({ error: 'Cross-site socket refused' }); },
    // After the scope's sign-in check; resolved before the upgrade so the socket's first messages aren't missed.
    preHandler: async (req, reply) => {
      const who = await user(req);
      if (!who) return reply.code(401).send({ error: 'unauthenticated' });
      req.liveUser = who;
    },
  }, (ws, req) => {
    const client = ClientId.safeParse((req.query as { client?: string }).client);
    hub.attach(ws, { userId: req.userId!, name: req.liveUser!.name, role: 'gm', token: req.liveUser!.token, client: client.success ? client.data : null });
  });
}
