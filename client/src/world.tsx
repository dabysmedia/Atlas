import { createContext, useContext } from 'react';
import type { World } from './types';

export const WorldCtx = createContext<World | null>(null);
export function useWorld(): World {
  const w = useContext(WorldCtx);
  if (!w) throw new Error('useWorld outside a world');
  return w;
}
