/**
 * Crafted map markers: enamel-and-brass medallions with an engraved icon, rendered
 * once per (kind, color, size) into sprite canvases so a frame only blits them.
 */
import { __iconData as castle } from 'lucide-react/dist/esm/icons/castle.mjs';
import { __iconData as towerControl } from 'lucide-react/dist/esm/icons/tower-control.mjs';
import { __iconData as flag } from 'lucide-react/dist/esm/icons/flag.mjs';
import { __iconData as swords } from 'lucide-react/dist/esm/icons/swords.mjs';
import { __iconData as user } from 'lucide-react/dist/esm/icons/user.mjs';
import { __iconData as mapPin } from 'lucide-react/dist/esm/icons/map-pin.mjs';
import { __iconData as compass } from 'lucide-react/dist/esm/icons/compass.mjs';
import type { TokenKind } from '../types';

type IconNode = [string, Record<string, string>][];

/** Lucide's 24x24 stroke icons as a single Path2D. */
function iconPath(node: IconNode): Path2D {
  const p = new Path2D();
  for (const [tag, a] of node) {
    const n = (k: string) => Number(a[k] ?? 0);
    if (tag === 'path') p.addPath(new Path2D(a.d));
    else if (tag === 'circle') { p.moveTo(n('cx') + n('r'), n('cy')); p.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2); }
    else if (tag === 'ellipse') { p.moveTo(n('cx') + n('rx'), n('cy')); p.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2); }
    else if (tag === 'rect') p.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx'));
    else if (tag === 'line') { p.moveTo(n('x1'), n('y1')); p.lineTo(n('x2'), n('y2')); }
    else if (tag === 'polyline' || tag === 'polygon') {
      const pts = a.points.trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < pts.length; i += 2) (i ? p.lineTo(pts[i], pts[i + 1]) : p.moveTo(pts[i], pts[i + 1]));
      if (tag === 'polygon') p.closePath();
    }
  }
  return p;
}

const ICONS: Record<TokenKind, Path2D> = {
  city: iconPath(castle.node as IconNode),
  outpost: iconPath(towerControl.node as IconNode),
  party: iconPath(compass.node as IconNode),
  unit: iconPath(swords.node as IconNode),
  character: iconPath(user.node as IconNode),
  marker: iconPath(mapPin.node as IconNode),
};
export const FLAG_ICON = iconPath(flag.node as IconNode);

/** On-screen radius in CSS px for each kind, at the reference zoom. */
export const MARKER_RADIUS: Record<TokenKind, number> = { city: 17, outpost: 13, party: 14, unit: 12, character: 11, marker: 10 };

const cache = new Map<string, HTMLCanvasElement>();

function shade(hex: string, amt: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0x888888;
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/**
 * A sprite canvas with the marker centered; `pad` leaves room for the drop shadow.
 * Settlements are shields-in-a-ring, movers are round medallions, the party is a gilded compass.
 */
export function markerSprite(kind: TokenKind, color: string, r: number, dpr: number): { canvas: HTMLCanvasElement; pad: number } {
  const px = Math.max(4, Math.round(r * dpr));
  const pad = Math.ceil(px * 0.6);
  const k = `${kind}|${color}|${px}`;
  let c = cache.get(k);
  if (!c) {
    if (cache.size > 400) cache.clear();
    c = document.createElement('canvas');
    c.width = c.height = (px + pad) * 2;
    const g = c.getContext('2d')!;
    g.translate(px + pad, px + pad);
    drawMarker(g, kind, color, px);
    cache.set(k, c);
  }
  return { canvas: c, pad };
}

function drawMarker(g: CanvasRenderingContext2D, kind: TokenKind, color: string, r: number) {
  const settlement = kind === 'city' || kind === 'outpost';
  // Drop shadow.
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.65)'; g.shadowBlur = r * 0.45; g.shadowOffsetY = r * 0.18;
  g.fillStyle = '#0c1014';
  outline(g, kind, r); g.fill();
  g.restore();

  // Brass rim.
  const rim = g.createLinearGradient(-r, -r, r, r);
  rim.addColorStop(0, '#f6e3a6'); rim.addColorStop(0.35, '#c99a45'); rim.addColorStop(0.7, '#7a5622'); rim.addColorStop(1, '#d9b469');
  g.fillStyle = rim; outline(g, kind, r); g.fill();

  // Faction enamel ring, then the dark field.
  const inner = r * 0.86;
  g.fillStyle = kind === 'party' ? '#1a2a30' : shade(color, -0.15);
  outline(g, kind, inner); g.fill();
  const field = g.createRadialGradient(-inner * 0.3, -inner * 0.35, inner * 0.1, 0, 0, inner);
  field.addColorStop(0, kind === 'party' ? '#2b4650' : '#2a2f36'); field.addColorStop(1, kind === 'party' ? '#0f1c22' : '#101317');
  g.fillStyle = field; outline(g, kind, inner * (settlement ? 0.8 : 0.78)); g.fill();
  // Gloss.
  const gloss = g.createLinearGradient(0, -r, 0, 0);
  gloss.addColorStop(0, 'rgba(255,255,255,0.22)'); gloss.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gloss; outline(g, kind, inner * 0.8); g.fill();

  // Engraved icon.
  const s = (r * (settlement ? 1.05 : 1.0)) / 24;
  g.save();
  g.scale(s, s); g.translate(-12, kind === 'city' ? -12.5 : -12);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3.4; g.translate(0, 0.7); g.stroke(ICONS[kind]); g.translate(0, -0.7);
  g.strokeStyle = kind === 'party' ? '#f2d27a' : shade(color, 0.55); g.lineWidth = 2.1; g.stroke(ICONS[kind]);
  g.restore();
}

/** Marker silhouette: settlements are heraldic shields, everything else a disc. */
function outline(g: CanvasRenderingContext2D, kind: TokenKind, r: number) {
  g.beginPath();
  if (kind === 'city' || kind === 'outpost') {
    const w = r * 0.98, top = -r * 0.98, mid = r * 0.25, bot = r * 1.05;
    g.moveTo(-w, top + r * 0.12);
    g.quadraticCurveTo(-w, top, -w + r * 0.12, top);
    g.lineTo(w - r * 0.12, top);
    g.quadraticCurveTo(w, top, w, top + r * 0.12);
    g.lineTo(w, mid);
    g.quadraticCurveTo(w * 0.95, bot * 0.75, 0, bot);
    g.quadraticCurveTo(-w * 0.95, bot * 0.75, -w, mid);
    g.closePath();
  } else g.arc(0, 0, r, 0, Math.PI * 2);
}
