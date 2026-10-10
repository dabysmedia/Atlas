import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
/** This tab. Sent with every request, so live sync (live.ts) can tell this tab's own changes when they come back. */
export const CLIENT_ID = uuid();
export const clientHeaders = { 'x-atlas-client': CLIENT_ID };

/** Writes this tab has in flight; live sync holds back refetches until they land, so none brings back an older value. */
export const pendingWrites = {
  count: 0,
  waiting: new Set<() => void>(),
  whenSettled(fn: () => void) { if (this.count === 0) fn(); else this.waiting.add(fn); },
  async track<T>(p: Promise<T>): Promise<T> {
    this.count++;
    try { return await p; } finally {
      if (--this.count === 0) { const fns = [...this.waiting]; this.waiting.clear(); fns.forEach((f) => f()); }
    }
  },
};

/**
 * Where the server's change count stood when each read began (x-atlas-seq). Live sync compares it with the count its
 * subscription started from, to tell a read that may have missed a change from one that can't have.
 */
export const reads = { onSeq: null as ((seq: number) => void) | null };

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  const req = fetch(path, {
    method,
    headers: { ...clientHeaders, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init?.signal,
  });
  const res = await (method === 'GET' ? req : pendingWrites.track(req));
  const seq = res.headers.get('x-atlas-seq');
  if (seq && res.ok) reads.onSeq?.(Number(seq));
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('atlas:unauthenticated'));
    throw new ApiError(res.status, data?.error ?? res.statusText, data);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 },
  },
});

/** Query keys, all scoped by world so two worlds never share cache entries. */
export const qk = {
  me: ['me'] as const,
  worlds: ['worlds'] as const,
  world: (w: string) => ['w', w] as const,
  pages: (w: string) => ['w', w, 'pages'] as const,
  page: (w: string, id: string) => ['w', w, 'page', id] as const,
  search: (w: string, q: string) => ['w', w, 'search', q] as const,
  map: (w: string) => ['w', w, 'map'] as const,
  fog: (w: string, c: string) => ['w', w, 'fog', c] as const,
  factions: (w: string) => ['w', w, 'factions'] as const,
  meters: (w: string) => ['w', w, 'meters'] as const,
  meterHistory: (w: string, f: string, m: string) => ['w', w, 'mh', f, m] as const,
  rollTables: (w: string) => ['w', w, 'rolls'] as const,
  campaigns: (w: string) => ['w', w, 'campaigns'] as const,
  events: (w: string) => ['w', w, 'events'] as const,
};
