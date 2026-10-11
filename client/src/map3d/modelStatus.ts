import { useSyncExternalStore } from 'react';
export type MiniatureStatus = { state: 'loading' | 'ready' | 'error'; message?: string };
const states = new Map<string, MiniatureStatus>();
const listeners = new Set<() => void>();
export const miniatureStatus = (key: string) => states.get(key);
export function reportMiniature(key: string, status?: MiniatureStatus) {
  if (status) states.set(key, status); else states.delete(key);
  listeners.forEach(fn => fn());
}
export const retryMiniature = (world: string, id: string) => reportMiniature(`${world}/${id}`);
export function useMiniatureStatus(world: string, id: string | null) {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => id ? states.get(`${world}/${id}`) : undefined);
}
