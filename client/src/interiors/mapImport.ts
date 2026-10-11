import { clientHeaders, pendingWrites } from '../api';
import type { Interior } from '../../../shared/interiors';

export async function uploadInteriorMap(path: string, file: File): Promise<NonNullable<Interior['asset']>> {
  if (file.size > 40 * 1024 * 1024) throw Error('Local maps must be under 40 MB.');
  // Some file pickers omit MIME types; the server validates the actual bytes.
  const response = await pendingWrites.track(fetch(path, {
    method: 'PUT', headers: { ...clientHeaders, 'content-type': 'application/octet-stream', 'x-file-name': file.name.slice(0, 120).replace(/[^\x20-\x7e]/g, '_'), 'x-file-name-encoded': encodeURIComponent(file.name.slice(0, 120)) }, body: file,
  }));
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'The map could not be uploaded.');
  return result;
}

export type ImageGrid = { size: number; x: number; y: number };
export function gridDimensions(width: number, height: number, grid: ImageGrid) {
  return { cols: Math.ceil((width + grid.x) / grid.size - 1e-8), rows: Math.ceil((height + grid.y) / grid.size - 1e-8) };
}

/** Pad the art to whole squares without drawing grid lines into the image. */
export async function alignMapImage(file: File, image: HTMLImageElement, grid: ImageGrid) {
  const { cols, rows } = gridDimensions(image.naturalWidth, image.naturalHeight, grid);
  if (cols > 200 || rows > 200) throw Error('Increase square size to keep the map within 200 squares per side.');
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cols * grid.size); canvas.height = Math.round(rows * grid.size);
  if (canvas.width * canvas.height > 40_000_000) throw Error('The aligned map must be under 40 megapixels. Increase square size or import a smaller image.');
  const ctx = canvas.getContext('2d'); if (!ctx) throw Error('The map preview could not be prepared.');
  // Fractional square sizes still map exactly to the saved tactical grid.
  ctx.scale(canvas.width / (cols * grid.size), canvas.height / (rows * grid.size));
  ctx.drawImage(image, grid.x, grid.y);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('The map image could not be prepared.')), 'image/png'));
  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.png`, { type: 'image/png' });
}
