/**
 * Live sync, client side: one WebSocket per tab (server/live.ts) that keeps this screen's cache in step with every
 * other screen's edits. Changed map rows are patched straight into the cache, so the map redraws without a refetch;
 * everything else arrives as scopes, which become invalidations. This tab's own changes come back tagged with its
 * client id and are skipped, since it already applied them.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { QueryClient, QueryFilters } from '@tanstack/react-query';
import { CLIENT_ID, qk, pendingWrites } from './api';
import type { Claim, Hex, MapArt, MapData, MapModel, Token, World } from './types';
import { daySweep } from './daylight';

/** Who is looking at a world: one entry per open screen. */
export type Viewer = { conn: string; name: string; role: 'gm' | 'player'; since: number };
type Scope = 'worlds' | 'world' | 'map' | 'pages' | 'page' | 'search' | 'factions' | 'meters' | 'mh' | 'rolls' | 'campaigns' | 'events' | 'fog' | 'modelArchive';
type Patch =
  | { op: 'hexes'; ids: string[]; set: Partial<Pick<Hex, 'terrain' | 'state'>> }
  | { op: 'hex'; hex: Hex }
  | { op: 'claims'; hexIds: string[]; claims: Claim[] }
  | { op: 'claim'; claim: Claim }
  | { op: 'claimGone'; id: string }
  | { op: 'token'; token: Token }
  | { op: 'tokenGone'; id: string }
  | { op: 'fog'; campaignId: string; hexIds: string[]; explored: boolean }
  | { op: 'art'; art: MapArt | null }
  | { op: 'model'; model: MapModel | null }
  | { op: 'world'; world: Partial<World>; sweep?: boolean };
export type DragMsg = { t: 'drag'; world: string; conn: string; token: string; x: number; y: number; end?: boolean; to?: string | null };
type ServerMsg =
  | { t: 'hello'; conn: string }
  | { t: 'change'; world: string | null; origin: string | null; scopes: Scope[]; patches?: Patch[] }
  | { t: 'presence'; world: string; viewers: Viewer[] }
  | DragMsg
  | { t: 'hb' };

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';
type Snapshot = { status: LiveStatus; viewers: Viewer[]; me: string | null };

/** The cache a scope stands for, on one world. */
function filterFor(world: string | null, s: Scope): QueryFilters | null {
  if (s === 'worlds') return { queryKey: qk.worlds };
  if (!world) return null;
  if (s === 'world') return { queryKey: qk.world(world), exact: true };
  if (s === 'modelArchive') return { queryKey: ['modelArchive', world] };
  // The rest are named for the third part of their query keys (qk in api.ts): ['w', world, 'map'], ['w', world, 'page', id]…
  return { queryKey: ['w', world, s] };
}

const QUIET_MS = 70_000; // the server says something every 25 s; this long without a word means the line is dead

class Live {
  private qc: QueryClient | null = null;
  private ws: WebSocket | null = null;
  private users = 0;
  private tries = 0;
  private opened = 0;
  private retry = 0;
  private watchdog = 0;
  private world: string | null = null;
  private snap: Snapshot = { status: 'connecting', viewers: [], me: null };
  private subs = new Set<() => void>();
  private drags = new Set<(m: DragMsg) => void>();
  /** Scopes heard while this tab had writes of its own in flight, refetched once they land. */
  private held = new Map<string, QueryFilters>();

  get snapshot() { return this.snap; }
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  private set(p: Partial<Snapshot>) { this.snap = { ...this.snap, ...p }; this.subs.forEach((f) => f()); }

  /** Start (or join) the connection; returns the matching stop. Counted, so StrictMode's double mount is harmless. */
  start(qc: QueryClient) {
    this.qc = qc;
    if (this.users++ === 0) {
      this.connect();
      window.addEventListener('online', this.now);
      document.addEventListener('visibilitychange', this.now);
    }
    return () => {
      if (--this.users > 0) return;
      window.removeEventListener('online', this.now);
      document.removeEventListener('visibilitychange', this.now);
      window.clearTimeout(this.retry); window.clearTimeout(this.watchdog);
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      this.set({ status: 'connecting', viewers: [], me: null });
    };
  }

  /** Back online, or back on this tab: waiting out the backoff would only delay catching up. */
  private now = () => {
    if (this.ws || this.users === 0 || document.hidden) return;
    window.clearTimeout(this.retry);
    this.tries = 0;
    this.connect();
  };

  /** The world this screen is showing; its changes and its viewers are what the socket carries. */
  view(world: string | null) {
    if (world === this.world) return;
    // Nothing from the world being left arrives from now on: its cache must be read fresh next visit.
    if (this.world) void this.qc?.invalidateQueries({ queryKey: ['w', this.world], refetchType: 'none' });
    this.world = world;
    this.set({ viewers: [] });
    this.sendRaw({ t: 'sub', world });
  }

  onDrag(fn: (m: DragMsg) => void) { this.drags.add(fn); return () => { this.drags.delete(fn); }; }

  /** A marker this screen is dragging (positions in map units); others see it move. Not stored. */
  drag(m: { token: string; x: number; y: number; end?: boolean; to?: string | null }) { this.sendRaw({ t: 'drag', ...m }); }

  private sendRaw(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/live?client=${encodeURIComponent(CLIENT_ID)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.tries = 0;
      this.sendRaw({ t: 'sub', world: this.world });
      // Back after a gap: whatever changed meanwhile was missed, so read it all again.
      if (this.opened++ > 0) this.resync();
      this.set({ status: 'live' });
      this.feed();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.feed();
      let m: ServerMsg;
      try { m = JSON.parse(e.data as string); } catch { return; }
      this.receive(m);
    };
    ws.onclose = (e) => {
      // The session ended (signed out elsewhere, or expired): the app goes back to its sign-in screen.
      if (e.code === 4401 && this.ws === ws) window.dispatchEvent(new Event('atlas:unauthenticated'));
      this.lost(ws);
    };
  }

  /** The line dropped (or went quiet): show it, and try again after a backoff with jitter, so a restarted server isn't met by every screen at once. */
  private lost(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    ws.close();
    window.clearTimeout(this.watchdog);
    // Who was here stays on show, dimmed, until the line is back and says who still is.
    this.set({ status: 'reconnecting' });
    const wait = Math.min(15_000, 600 * 2 ** this.tries++) * (0.75 + Math.random() * 0.5);
    this.retry = window.setTimeout(() => { if (this.users > 0 && !this.ws) this.connect(); }, wait);
  }

  /** Anything heard proves the line alive; a dead one (a sleeping laptop, a dropped proxy) can stay "open" for minutes. */
  private feed() {
    window.clearTimeout(this.watchdog);
    const ws = this.ws;
    this.watchdog = window.setTimeout(() => { if (ws) this.lost(ws); }, QUIET_MS);
  }

  private resync() {
    const qc = this.qc!;
    void qc.invalidateQueries({ queryKey: qk.worlds });
    if (this.world) {
      void qc.invalidateQueries({ queryKey: ['w', this.world] });
      void qc.invalidateQueries({ queryKey: ['modelArchive', this.world] });
    }
  }

  private receive(m: ServerMsg) {
    const qc = this.qc!;
    if (m.t === 'hello') this.set({ me: m.conn });
    else if (m.t === 'presence') { if (m.world === this.world) this.set({ viewers: m.viewers }); }
    else if (m.t === 'drag') { if (m.world === this.world) this.drags.forEach((f) => f(m)); }
    else if (m.t === 'change') {
      if (m.origin === CLIENT_ID) return;
      for (const p of m.patches ?? []) applyPatch(qc, m.world!, p);
      for (const s of m.scopes) {
        const f = filterFor(m.world, s);
        if (!f) continue;
        // A refetch that starts before this tab's own write lands could bring back the value it is replacing.
        if (pendingWrites.count > 0) this.held.set(JSON.stringify(f), f);
        else void qc.invalidateQueries(f);
      }
      if (this.held.size) pendingWrites.whenSettled(() => this.release());
    }
  }

  private release() {
    const held = [...this.held.values()];
    this.held.clear();
    for (const f of held) void this.qc?.invalidateQueries(f);
  }
}

export const live = new Live();
// For the browser checks (scripts/live.mjs), like window.__atlasMap.
(globalThis as { __atlasLive?: unknown }).__atlasLive = { live, pendingWrites, cache: () => live['qc'] };

/** Connection state, the open world's viewers, and which of them is this screen. */
export function useLive(): Snapshot {
  return useSyncExternalStore(live.subscribe, () => live.snapshot);
}

/** JSON with object keys in order, so values that went through Postgres jsonb (which reorders them) compare equal. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
}

/**
 * A field's own copy of a value other screens can change too. It follows the stored value, so their edits show at
 * once, until this screen edits it; from then on the edit stands until it is saved (or the save fails and the stored
 * value returns), and the last save wins. A new `key` (another record) starts over.
 */
export function useDraft<T>(value: T, key?: unknown): [T, (v: T) => void] {
  const [draft, setDraft] = useState(value);
  const base = useRef(value);
  const sig = canonical(value);
  useEffect(() => {
    const was = canonical(base.current);
    base.current = value;
    setDraft((d) => (canonical(d) === was ? value : d));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    base.current = value;
    setDraft(value);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, setDraft];
}

const patchMap = (qc: QueryClient, world: string, fn: (d: MapData) => MapData) =>
  qc.setQueryData<MapData>(qk.map(world), (d) => (d ? fn(d) : d));
const upsert = <T extends { id: string }>(xs: T[], x: T) => (xs.some((y) => y.id === x.id) ? xs.map((y) => (y.id === x.id ? { ...y, ...x } : y)) : [...xs, x]);

/** Another screen's change, put straight into this one's cache; the map and the clock redraw from there. */
function applyPatch(qc: QueryClient, world: string, p: Patch) {
  switch (p.op) {
    case 'hexes': {
      const ids = new Set(p.ids);
      return patchMap(qc, world, (d) => ({ ...d, hexes: d.hexes.map((h) => (ids.has(h.id) ? { ...h, ...p.set } : h)) }));
    }
    case 'hex': return patchMap(qc, world, (d) => ({ ...d, hexes: d.hexes.map((h) => (h.id === p.hex.id ? { ...h, ...p.hex } : h)) }));
    case 'claims': {
      const ids = new Set(p.hexIds);
      return patchMap(qc, world, (d) => ({ ...d, claims: [...d.claims.filter((c) => !ids.has(c.hexId)), ...p.claims] }));
    }
    case 'claim': return patchMap(qc, world, (d) => ({ ...d, claims: upsert(d.claims, p.claim) }));
    case 'claimGone': return patchMap(qc, world, (d) => ({ ...d, claims: d.claims.filter((c) => c.id !== p.id) }));
    case 'token': return patchMap(qc, world, (d) => ({ ...d, tokens: upsert(d.tokens, p.token) }));
    case 'tokenGone': return patchMap(qc, world, (d) => ({ ...d, tokens: d.tokens.filter((t) => t.id !== p.id) }));
    case 'fog': {
      return qc.setQueryData<string[]>(qk.fog(world, p.campaignId), (xs) => {
        if (!xs) return xs;
        const s = new Set(xs);
        p.hexIds.forEach((id) => (p.explored ? s.add(id) : s.delete(id)));
        return [...s];
      });
    }
    case 'art': return patchMap(qc, world, (d) => ({ ...d, map: { ...d.map, art: p.art } }));
    case 'model': return patchMap(qc, world, (d) => ({ ...d, map: { ...d.map, model: p.model } }));
    case 'world': {
      const before = qc.getQueryData<World>(qk.world(world));
      qc.setQueryData<World>(qk.world(world), (w) => (w ? { ...w, ...p.world } : w));
      if (p.sweep && before && p.world.currentDay !== undefined && p.world.currentDay !== before.currentDay) daySweep.emit();
      // This tab's own clock or weather change in flight may land after this one: read the world again once it has.
      if (pendingWrites.count > 0) pendingWrites.whenSettled(() => void qc.invalidateQueries({ queryKey: qk.world(world), exact: true }));
    }
  }
}
