import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qk } from '../api';
import type { PageIndex, SearchHit } from '../types';

export function usePageIndex(worldId: string) {
  return useQuery({ queryKey: qk.pages(worldId), queryFn: () => api<PageIndex[]>(`/api/worlds/${worldId}/pages`), staleTime: 60_000 });
}

/** Instant client-side title match, ranked: exact, prefix, word-prefix, substring, subsequence. */
export function rankTitles(pages: PageIndex[], q: string, limit = 12): PageIndex[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return pages.slice(0, limit);
  const scored: [number, PageIndex][] = [];
  for (const p of pages) {
    const t = p.title.toLowerCase();
    let s = 0;
    if (t === needle) s = 100;
    else if (t.startsWith(needle)) s = 80;
    else if (t.split(/\s+/).some((w) => w.startsWith(needle))) s = 60;
    else if (t.includes(needle)) s = 40;
    else {
      let i = 0;
      for (const ch of t) if (ch === needle[i]) i++;
      if (i === needle.length) s = 10;
    }
    if (s) scored.push([s - t.length * 0.01, p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

export function useSearch(worldId: string, q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: qk.search(worldId, term),
    queryFn: ({ signal }) => api<SearchHit[]>(`/api/worlds/${worldId}/search?q=${encodeURIComponent(term)}`, { signal }),
    enabled: term.length >= 2,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

/** Merge instant title hits with server full-text hits, titles first. */
export function useCombinedSearch(worldId: string, q: string) {
  const index = usePageIndex(worldId);
  const search = useSearch(worldId, q);
  return useMemo(() => {
    const titles = rankTitles(index.data ?? [], q, 8);
    const seen = new Set(titles.map((t) => t.id));
    const body = q.trim().length >= 2 ? (search.data ?? []).filter((h) => !seen.has(h.id)) : [];
    const snippets = new Map((search.data ?? []).map((h) => [h.id, h.snippet]));
    return [...titles.map((t) => ({ ...t, snippet: snippets.get(t.id) ?? '' })), ...body].slice(0, 20);
  }, [index.data, search.data, q]);
}

export function useCreatePage(worldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { title: string; category?: string }) => {
      try {
        return await api<PageIndex>(`/api/worlds/${worldId}/pages`, { body: p });
      } catch (e) {
        // Creating a title that exists just opens the existing page.
        if (e instanceof ApiError && e.status === 409 && (e.body as { page?: PageIndex })?.page) return (e.body as { page: PageIndex }).page;
        throw e;
      }
    },
    onSuccess: (page) => {
      qc.setQueryData<PageIndex[]>(qk.pages(worldId), (xs) => (xs?.some((x) => x.id === page.id) ? xs : [page, ...(xs ?? [])]));
    },
  });
}

/** Render ts_headline output (<<match>>) safely as React nodes. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<<.*?>>)/g);
  return <>{parts.map((p, i) => (p.startsWith('<<') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}
