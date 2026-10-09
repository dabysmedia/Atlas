import type { ModelPlacement } from './db/schema.js';
import { gridBounds, type Orientation } from '../shared/hex.js';

/** A model's square footprint, centred on the grid and as large as fits inside it. */
export function fitModelPlacement(layout: { cols: number; rows: number; orientation: Orientation }): ModelPlacement {
  const b = gridBounds(layout.cols, layout.rows, layout.orientation);
  const side = Math.min(b.maxX - b.minX, b.maxY - b.minY);
  return { x: (b.minX + b.maxX - side) / 2, y: (b.minY + b.maxY - side) / 2, w: side, h: side, heightScale: 1 };
}
