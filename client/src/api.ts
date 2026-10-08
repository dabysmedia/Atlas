import { QueryClient } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init?.signal,
  });
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
