import { useQuery } from '@tanstack/react-query';
import { api, qk } from './api';

/** Who is signed in. The GM sees and changes everything; a player sees their party's view (server/access.ts). */
export type Me = { id: string; username: string; displayName: string; name: string; role: 'gm' | 'player' };

export const fetchMe = () => api<Me>('/api/auth/me');

export function useMe(): Me | null {
  return useQuery({ queryKey: qk.me, queryFn: fetchMe, retry: false, staleTime: Infinity }).data ?? null;
}

/** True for the GM (and while the account is still loading, which the app waits out before showing anything). */
export function useIsGM() {
  return useMe()?.role !== 'player';
}
