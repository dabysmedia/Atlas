/**
 * Painted terrain for maps without art.
 *
 * The map is cut into world-space tiles per level of detail (2^L pixels per world
 * unit). Each tile is painted once into a 512px canvas: soft-edged terrain washes,
 * shallows and surf along coasts, a paper grain, and hand-drawn terrain stamps
 * (canopies, peaks, mounds, reeds, dunes). Frames only blit finished tiles, so pan
 * and zoom cost the same as flat fills; tiles are (re)painted within a small time
 * budget per frame, newest edits first.
 */
import { corner, DIRS, type Orientation } from '../../../shared/hex';

export type PaintHex = { id: string; q: number; r: number; cx: number; cy: number; terrain: string };
export type PainterSource = {
  orientation: Orientation;
  size: number;
  hexesIn(minX: number, minY: number, maxX: number, maxY: number): PaintHex[];
  neighbor(h: PaintHex, dir: number): PaintHex | undefined;
  color(terrain: string): string;
  glyph(terrain: string): string;
};

const TILE = 512;
const MIN_L = -5, MAX_L = 2;
const MAX_TILES = 110;
const BUDGET_MS = 9;

type Tile = { L: number; tx: number; ty: number; canvas: HTMLCanvasElement | null; stale: Set<string> | null };

export class TerrainPainter {
  private tiles = new Map<string, Tile>();
  private pool: HTMLCanvasElement[] = [];
  private scratchA = document.createElement('canvas');
  private scratchB = document.createElement('canvas');
  private grain: CanvasPattern | null = null;
  private src: PainterSource | null = null;
  private hexPath = new Path2D();

  setSource(src: PainterSource) {
    this.src = src;
    this.hexPath = new Path2D();
    for (let i = 0; i < 6; i++) { const c = corner(i, src.size, src.orientation); i ? this.hexPath.lineTo(c.x, c.y) : this.hexPath.moveTo(c.x, c.y); }
    this.hexPath.closePath();
    this.clear();
  }

  clear() {
    for (const t of this.tiles.values()) if (t.canvas) this.pool.push(t.canvas);
    this.tiles.clear();
  }

  /** Mark tiles covering these hexes stale; they keep drawing (with flat patches) until repainted. */
  invalidate(hexes: { id: string; cx: number; cy: number }[]) {
    const R = this.src?.size ?? 40;
    for (const t of this.tiles.values()) {
      const tw = TILE / 2 ** t.L, x0 = t.tx * tw, y0 = t.ty * tw, m = R * 2.2;
      for (const h of hexes) {
        if (h.cx < x0 - m || h.cx > x0 + tw + m || h.cy < y0 - m || h.cy > y0 + tw + m) continue;
        (t.stale ??= new Set()).add(h.id);
      }
    }
  }

  static levelFor(zoom: number, dpr: number) {
    return Math.max(MIN_L, Math.min(MAX_L, Math.round(Math.log2(zoom * dpr) + 0.25)));
  }

  /**
   * Draw painted terrain for the view (world rect). Returns true while tiles are
   * still being painted, so the caller keeps frames coming. `flat` draws a quick
   * flat-color stand-in for a world rect (or for specific hexes) while waiting.
   */
  draw(ctx: CanvasRenderingContext2D, view: { minX: number; minY: number; maxX: number; maxY: number }, zoom: number, dpr: number,
    flat: (rect: { minX: number; minY: number; maxX: number; maxY: number } | null, hexIds?: Set<string>) => void): boolean {
    if (!this.src) return false;
    const L = TerrainPainter.levelFor(zoom, dpr);
    const tw = TILE / 2 ** L;
    const tx0 = Math.floor(view.minX / tw), tx1 = Math.floor(view.maxX / tw);
    const ty0 = Math.floor(view.minY / tw), ty1 = Math.floor(view.maxY / tw);
    const start = performance.now();
    let pending = false;
    const need: Tile[] = [];
    // Repaint stale tiles first (edits), then missing ones, nearest the center first.
    const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
    const order: [number, number][] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) order.push([tx, ty]);
    order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [tx, ty] of order) {
      const k = `${L}:${tx}:${ty}`;
      let t = this.tiles.get(k);
      if (!t || t.stale) need.push(t ?? { L, tx, ty, canvas: null, stale: null });
      else { this.tiles.delete(k); this.tiles.set(k, t); } // LRU touch
    }
    need.sort((a, b) => (b.stale ? 1 : 0) - (a.stale ? 1 : 0));
    for (const t of need) {
      if (performance.now() - start > BUDGET_MS) { pending = true; break; }
      this.paint(t);
      t.stale = null;
      this.tiles.set(`${t.L}:${t.tx}:${t.ty}`, t);
      this.evict();
    }

    ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = this.tiles.get(`${L}:${tx}:${ty}`);
      const rect = { minX: tx * tw, minY: ty * tw, maxX: (tx + 1) * tw, maxY: (ty + 1) * tw };
      if (!t) {
        // Not painted yet: borrow a coarser level if we have one, else flat color.
        if (!this.drawCoarser(ctx, L, rect)) flat(rect);
        continue;
      }
      if (t.canvas) ctx.drawImage(t.canvas, rect.minX, rect.minY, tw, tw);
      if (t.stale) flat(null, t.stale);
    }
    return pending;
  }

  private drawCoarser(ctx: CanvasRenderingContext2D, L: number, rect: { minX: number; minY: number; maxX: number; maxY: number }) {
    for (let l = L - 1; l >= Math.max(MIN_L, L - 3); l--) {
      const tw = TILE / 2 ** l;
      const tx = Math.floor(rect.minX / tw), ty = Math.floor(rect.minY / tw);
      const t = this.tiles.get(`${l}:${tx}:${ty}`);
      if (!t || t.stale) continue;
      if (!t.canvas) return true;
      const sx = ((rect.minX - tx * tw) / tw) * TILE, sy = ((rect.minY - ty * tw) / tw) * TILE;
      const sw = ((rect.maxX - rect.minX) / tw) * TILE;
      ctx.drawImage(t.canvas, sx, sy, sw, sw, rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
      return true;
    }
    return false;
  }

  private evict() {
    while (this.tiles.size > MAX_TILES) {
      const [k, t] = this.tiles.entries().next().value!;
      this.tiles.delete(k);
      if (t.canvas) this.pool.push(t.canvas);
    }
  }

  private grainPattern(ctx: CanvasRenderingContext2D) {
    if (this.grain) return this.grain;
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d')!;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2600; i++) {
      const light = rnd() > 0.5;
      g.fillStyle = light ? `rgba(255,248,230,${0.05 + rnd() * 0.07})` : `rgba(0,0,0,${0.06 + rnd() * 0.1})`;
      const r = 0.5 + rnd() * 1.6;
      g.beginPath(); g.arc(rnd() * 160, rnd() * 160, r, 0, Math.PI * 2); g.fill();
    }
    this.grain = ctx.createPattern(c, 'repeat');
    return this.grain;
  }

  // ---------------------------------------------------------------- painting one tile
  private paint(t: Tile) {
    const src = this.src!;
    const R = src.size;
    const s = 2 ** t.L; // px per world unit
    const tw = TILE / s;
    const x0 = t.tx * tw, y0 = t.ty * tw;
    const marginW = R * 1.6; // world margin so blurs and stamps cross tile seams cleanly
    const hexes = src.hexesIn(x0 - marginW, y0 - marginW, x0 + tw + marginW, y0 + tw + marginW);
    if (!hexes.length) { if (t.canvas) this.pool.push(t.canvas); t.canvas = null; return; }

    const mpx = Math.ceil(marginW * s);
    const W = TILE + mpx * 2;
    const A = this.scratchA, B = this.scratchB;
    if (A.width !== W) { A.width = A.height = W; B.width = B.height = W; }
    const a = A.getContext('2d')!, b = B.getContext('2d')!;
    const setT = (g: CanvasRenderingContext2D) => g.setTransform(s, 0, 0, s, mpx - x0 * s, mpx - y0 * s);
    const clearT = (g: CanvasRenderingContext2D) => { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, W); g.filter = 'none'; g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; };
    const blit = (blurWorld: number, alpha = 1) => {
      b.setTransform(1, 0, 0, 1, 0, 0);
      const px = blurWorld * s;
      b.filter = px >= 0.6 ? `blur(${px.toFixed(1)}px)` : 'none';
      b.globalAlpha = alpha;
      b.drawImage(A, 0, 0);
      b.filter = 'none'; b.globalAlpha = 1;
    };
    clearT(b);
    const water = (h: PaintHex) => src.glyph(h.terrain) === 'waves';
    const at = (h: PaintHex, sc: number) => new DOMMatrix([sc, 0, 0, sc, h.cx, h.cy]);

    // 1. Water washes.
    clearT(a); setT(a);
    groupFill(a, hexes.filter(water), (h) => src.color(h.terrain), this.hexPath, (h) => at(h, 1.04));
    blit(R * 0.22);

    // 2. Shallows: a turquoise glow along every land/water edge, on the water side.
    clearT(a); setT(a);
    const dirs = DIRS[src.orientation];
    const coast: [PaintHex, number][] = [];
    for (const h of hexes) {
      if (water(h)) continue;
      for (let d = 0; d < 6; d++) {
        const n = src.neighbor(h, d);
        if (n && water(n)) coast.push([h, d]);
      }
    }
    a.lineCap = 'round';
    a.strokeStyle = 'rgba(92, 170, 168, 0.75)'; a.lineWidth = R * 0.55;
    a.beginPath(); edgePath(a, coast, R, src.orientation); a.stroke();
    blit(R * 0.2);

    // 3. Land washes, soft-edged so neighbors bleed into each other like watercolor.
    clearT(a); setT(a);
    groupFill(a, hexes.filter((h) => !water(h)), (h) => src.color(h.terrain), this.hexPath, (h) => at(h, 1.05));
    blit(R * 0.14);
    // A second, tighter pass keeps hex identity readable under the blur.
    clearT(a); setT(a);
    groupFill(a, hexes.filter((h) => !water(h)), (h) => src.color(h.terrain), this.hexPath, (h) => at(h, 0.82));
    blit(R * 0.08, 0.55);

    // 4. Paper grain, only where there is paint.
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-atop';
    b.fillStyle = this.grainPattern(b)!;
    b.fillRect(0, 0, W, W);
    // Low-frequency light: a gentle north-west sheen across land.
    b.globalCompositeOperation = 'source-over';

    // 5. Surf line on the coast.
    if (R * s > 5) {
      clearT(a); setT(a);
      a.lineCap = 'round';
      a.strokeStyle = 'rgba(214, 236, 226, 0.55)'; a.lineWidth = Math.max(1.2 / s, R * 0.04);
      a.beginPath(); edgePath(a, coast, R * 0.97, src.orientation); a.stroke();
      blit(R * 0.02);
    }

    // 6. Terrain stamps.
    const Rpx = R * s;
    if (Rpx >= 6) {
      setT(b);
      const sorted = [...hexes].sort((p, q) => p.cy - q.cy);
      const detail = Rpx >= 16;
      for (const h of sorted) stamp(b, src.glyph(h.terrain), h.terrain, src.color(h.terrain), h, R, detail);
    }

    // Copy the center into the tile.
    if (!t.canvas) { t.canvas = this.pool.pop() ?? document.createElement('canvas'); t.canvas.width = t.canvas.height = TILE; }
    const out = t.canvas.getContext('2d')!;
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, TILE, TILE);
    out.drawImage(B, mpx, mpx, TILE, TILE, 0, 0, TILE, TILE);
  }
}

function groupFill(g: CanvasRenderingContext2D, hexes: PaintHex[], color: (h: PaintHex) => string, unit: Path2D, m: (h: PaintHex) => DOMMatrix) {
  const groups = new Map<string, Path2D>();
  for (const h of hexes) {
    const c = color(h);
    let p = groups.get(c);
    if (!p) { p = new Path2D(); groups.set(c, p); }
    p.addPath(unit, m(h));
  }
  for (const [c, p] of groups) { g.fillStyle = c; g.fill(p); }
}

function edgePath(g: CanvasRenderingContext2D, edges: [PaintHex, number][], R: number, o: Orientation) {
  for (const [h, d] of edges) {
    const p = corner(d, R, o), q = corner((d + 1) % 6, R, o);
    g.moveTo(h.cx + p.x, h.cy + p.y); g.lineTo(h.cx + q.x, h.cy + q.y);
  }
}

// ---------------------------------------------------------------- stamps
type RGB = [number, number, number];
const rgbCache = new Map<string, RGB>();
function rgb(hex: string): RGB {
  let v = rgbCache.get(hex);
  if (!v) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0x777777;
    v = [n >> 16, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}
function tone(hex: string, amt: number, alpha = 1) {
  const [r, g, b] = rgb(hex);
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgba(${f(r)},${f(g)},${f(b)},${alpha})`;
}

/** Deterministic per-hex random stream. */
function rng(h: PaintHex) {
  let s = (Math.imul(h.q, 73856093) ^ Math.imul(h.r, 19349663)) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function stamp(g: CanvasRenderingContext2D, glyph: string, key: string, color: string, h: PaintHex, R: number, detail: boolean) {
  const rnd = rng(h);
  const inHex = (rad: number): [number, number] => {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * rad;
    return [h.cx + Math.cos(a) * d, h.cy + Math.sin(a) * d];
  };
  switch (glyph) {
    case 'trees': {
      const n = key === 'jungle' ? 13 : 10;
      const pts = Array.from({ length: n }, () => { const [x, y] = inHex(R * 0.72); return { x, y, r: R * (0.12 + rnd() * 0.07) }; }).sort((a, b) => a.y - b.y);
      for (const t of pts) {
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.beginPath(); g.ellipse(t.x + t.r * 0.35, t.y + t.r * 0.55, t.r * 1.05, t.r * 0.7, 0, 0, Math.PI * 2); g.fill();
      }
      for (const t of pts) {
        if (detail) {
          const gr = g.createRadialGradient(t.x - t.r * 0.35, t.y - t.r * 0.45, t.r * 0.1, t.x, t.y, t.r * 1.05);
          gr.addColorStop(0, tone(color, 0.32)); gr.addColorStop(0.55, tone(color, -0.05)); gr.addColorStop(1, tone(color, -0.5));
          g.fillStyle = gr;
        } else g.fillStyle = tone(color, -0.12);
        g.beginPath(); g.arc(t.x, t.y, t.r, 0, Math.PI * 2); g.fill();
      }
      break;
    }
    case 'peaks': {
      const snow = key === 'mountains' || key === 'tundra' || rgb(color)[0] > 180;
      const peaks = [{ dx: -0.18, dy: 0.1, sc: 0.8 }, { dx: 0.12, dy: -0.05, sc: 1 }, { dx: 0.32, dy: 0.22, sc: 0.62 }]
        .map((p) => ({ x: h.cx + (p.dx + (rnd() - 0.5) * 0.12) * R, y: h.cy + (p.dy + (rnd() - 0.5) * 0.1) * R + R * 0.22, sc: p.sc * (0.9 + rnd() * 0.2) }))
        .sort((a, b) => a.y - b.y);
      for (const p of peaks) mountain(g, p.x, p.y, R * 0.62 * p.sc, R * 0.62 * p.sc, color, snow, rnd, detail);
      break;
    }
    case 'hills': {
      const mounds = [{ dx: -0.25, dy: 0.1 }, { dx: 0.2, dy: -0.12 }, { dx: 0.12, dy: 0.3 }]
        .map((p) => ({ x: h.cx + (p.dx + (rnd() - 0.5) * 0.12) * R, y: h.cy + (p.dy + (rnd() - 0.5) * 0.1) * R, w: R * (0.28 + rnd() * 0.1) }))
        .sort((a, b) => a.y - b.y);
      for (const m of mounds) {
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.beginPath(); g.ellipse(m.x + m.w * 0.15, m.y + m.w * 0.05, m.w * 1.05, m.w * 0.28, 0, 0, Math.PI * 2); g.fill();
        const gr = g.createLinearGradient(m.x - m.w, m.y - m.w * 0.6, m.x + m.w * 0.6, m.y);
        gr.addColorStop(0, tone(color, 0.28)); gr.addColorStop(1, tone(color, -0.35));
        g.fillStyle = detail ? gr : tone(color, -0.1);
        g.beginPath(); g.ellipse(m.x, m.y, m.w, m.w * 0.62, 0, Math.PI, 0); g.closePath(); g.fill();
      }
      break;
    }
    case 'grass': {
      if (!detail) break;
      g.strokeStyle = tone(color, -0.38, 0.5); g.lineWidth = R * 0.022; g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i < 7; i++) {
        const [x, y] = inHex(R * 0.75), l = R * 0.08;
        g.moveTo(x - l * 0.5, y); g.lineTo(x - l * 0.75, y - l);
        g.moveTo(x, y); g.lineTo(x, y - l * 1.2);
        g.moveTo(x + l * 0.5, y); g.lineTo(x + l * 0.75, y - l);
      }
      g.stroke();
      g.fillStyle = tone(color, 0.3, 0.35);
      for (let i = 0; i < 5; i++) { const [x, y] = inHex(R * 0.8); g.beginPath(); g.arc(x, y, R * 0.05, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case 'reeds': {
      for (let i = 0; i < 3; i++) {
        const [x, y] = inHex(R * 0.5), w = R * (0.12 + rnd() * 0.1);
        g.fillStyle = 'rgba(38, 62, 60, 0.85)';
        g.beginPath(); g.ellipse(x, y, w * 1.6, w * 0.8, 0, 0, Math.PI * 2); g.fill();
        if (detail) { g.strokeStyle = 'rgba(160, 200, 190, 0.35)'; g.lineWidth = R * 0.02; g.stroke(); }
      }
      if (detail) {
        g.strokeStyle = tone(color, -0.45, 0.8); g.lineWidth = R * 0.025; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i < 10; i++) { const [x, y] = inHex(R * 0.75); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * R * 0.06, y - R * (0.12 + rnd() * 0.08)); }
        g.stroke();
      }
      break;
    }
    case 'dunes': {
      g.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const x = h.cx + (rnd() - 0.5) * R * 0.9, y = h.cy + (i - 1) * R * 0.32 + (rnd() - 0.5) * R * 0.1, w = R * (0.3 + rnd() * 0.15);
        g.strokeStyle = tone(color, -0.3, 0.7); g.lineWidth = R * 0.05;
        g.beginPath(); g.moveTo(x - w, y + w * 0.15); g.quadraticCurveTo(x, y - w * 0.45, x + w, y + w * 0.15); g.stroke();
        g.strokeStyle = tone(color, 0.35, 0.6); g.lineWidth = R * 0.025;
        g.beginPath(); g.moveTo(x - w * 0.9, y + w * 0.05); g.quadraticCurveTo(x - w * 0.1, y - w * 0.5, x + w * 0.6, y - w * 0.05); g.stroke();
      }
      break;
    }
    case 'waves': {
      if (!detail) break;
      g.strokeStyle = 'rgba(190, 225, 225, 0.16)'; g.lineWidth = R * 0.025; g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const [x, y] = inHex(R * 0.7), w = R * 0.12;
        g.moveTo(x - w, y); g.quadraticCurveTo(x - w * 0.5, y - w * 0.5, x, y); g.quadraticCurveTo(x + w * 0.5, y - w * 0.5, x + w, y);
      }
      g.stroke();
      break;
    }
    default: {
      if (key === 'wasteland') {
        g.strokeStyle = 'rgba(20, 14, 12, 0.55)'; g.lineWidth = R * 0.03; g.lineJoin = 'round';
        for (let i = 0; i < 3; i++) {
          let [x, y] = inHex(R * 0.6);
          g.beginPath(); g.moveTo(x, y);
          for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * R * 0.3; y += (rnd() - 0.5) * R * 0.3; g.lineTo(x, y); }
          g.stroke();
        }
        if (detail) {
          for (let i = 0; i < 4; i++) {
            const [x, y] = inHex(R * 0.7);
            g.fillStyle = 'rgba(255, 110, 40, 0.75)';
            g.beginPath(); g.arc(x, y, R * 0.025, 0, Math.PI * 2); g.fill();
          }
        }
      } else if (detail) {
        g.fillStyle = tone(color, -0.25, 0.25);
        for (let i = 0; i < 6; i++) { const [x, y] = inHex(R * 0.8); g.beginPath(); g.arc(x, y, R * 0.035, 0, Math.PI * 2); g.fill(); }
      }
    }
  }
}

function mountain(g: CanvasRenderingContext2D, x: number, y: number, w: number, ht: number, color: string, snow: boolean, rnd: () => number, detail: boolean) {
  const apex = { x: x + (rnd() - 0.5) * w * 0.2, y: y - ht };
  const left = { x: x - w * 0.62, y }, right = { x: x + w * 0.62, y };
  const ridgeFoot = { x: x + w * (0.05 + rnd() * 0.12), y };
  // Shadow on the ground.
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.beginPath(); g.ellipse(x + w * 0.2, y, w * 0.75, w * 0.14, 0, 0, Math.PI * 2); g.fill();
  // Sunlit west face and shadowed east face, split by the ridge line.
  const lit = new Path2D(), dark = new Path2D();
  lit.moveTo(left.x, left.y);
  const shoulder = { x: x - w * 0.3, y: y - ht * (0.42 + rnd() * 0.12) };
  lit.lineTo(shoulder.x, shoulder.y); lit.lineTo(apex.x, apex.y); lit.lineTo(ridgeFoot.x, ridgeFoot.y); lit.closePath();
  dark.moveTo(apex.x, apex.y);
  const shoulder2 = { x: x + w * 0.34, y: y - ht * (0.38 + rnd() * 0.12) };
  dark.lineTo(shoulder2.x, shoulder2.y); dark.lineTo(right.x, right.y); dark.lineTo(ridgeFoot.x, ridgeFoot.y); dark.closePath();
  g.fillStyle = tone(color, 0.18); g.fill(lit);
  g.fillStyle = tone(color, -0.42); g.fill(dark);
  if (snow) {
    const t = 0.34;
    const cap = new Path2D();
    const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, k: number) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
    const a = lerp(apex, shoulder, t * 1.3), b = lerp(apex, ridgeFoot, t), c = lerp(apex, shoulder2, t * 1.2);
    cap.moveTo(apex.x, apex.y); cap.lineTo(a.x, a.y);
    cap.lineTo((a.x + b.x) / 2, (a.y + b.y) / 2 - ht * 0.04); cap.lineTo(b.x, b.y);
    cap.lineTo((b.x + c.x) / 2, (b.y + c.y) / 2 - ht * 0.05); cap.lineTo(c.x, c.y); cap.closePath();
    g.save(); g.clip(lit); g.fillStyle = 'rgba(244,246,244,0.95)'; g.fill(cap); g.restore();
    g.save(); g.clip(dark); g.fillStyle = 'rgba(170,184,196,0.9)'; g.fill(cap); g.restore();
  }
  if (detail) {
    g.strokeStyle = tone(color, -0.6, 0.55); g.lineWidth = w * 0.035; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(left.x, left.y); g.lineTo(shoulder.x, shoulder.y); g.lineTo(apex.x, apex.y); g.lineTo(shoulder2.x, shoulder2.y); g.lineTo(right.x, right.y); g.stroke();
  }
}
