import type { HexMapRenderer } from '../map/renderer';
import type { HexMapRenderer3D } from './renderer3d';

export function webgl2Available() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

/** The 3D renderer and three.js load as their own chunk, fetched as soon as the map module loads. */
let chunk: Promise<typeof import('./renderer3d')> | null = null;
export const load3d = () => (chunk ??= import('./renderer3d'));

export const is3d = (r: HexMapRenderer | null | undefined): r is HexMapRenderer3D => !!r && 'focusOn' in r;
