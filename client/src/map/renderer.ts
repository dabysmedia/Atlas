/**
 * Canvas 2D hex map renderer.
 *
 * Hexes are batched into Path2D objects per (chunk, fill color) so a frame is a
 * few dozen fills regardless of map size, and only chunks in view are drawn.
 * The camera eases toward a target every frame, which gives zoom and pan their
 * weight; zoom stays anchored to the point under the cursor.
 */
import { axialToOffset, corner, DIRS, hexLabel, hexToPixel, key, pixelToHex, type Orientation } from '../../../shared/hex';
import type { Claim, FactionLite, Hex, HexStateType, TerrainType, Token } from '../types';

export const HEX_SIZE = 40; // world units (circumradius)
const CHUNK = 12; // hexes per chunk side, in offset coordinates
export const MIN_ZOOM = 0.06;
export const MAX_ZOOM = 4;

export type Camera = { x: number; y: number; zoom: number };

type HexR = Hex & { cx: number; cy: number; col: number; row: number; chunk: string };
type Chunk = { minX: number; minY: number; maxX: number; maxY: number; hexes: HexR[]; fills: Map<string, Path2D> | null };

export type RenderInput = {
  orientation: Orientation;
  hexes: Hex[];
  claims: Claim[];
  tokens: Token[];
  factions: FactionLite[];
  terrain: TerrainType[];
  states: HexStateType[];
  fog: Set<string> | null; // explored hex ids for the shown campaign; null = no fog layer
};

export class HexMapRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;

  cam: Camera = { x: 0, y: 0, zoom: 1 };
  target: Camera = { x: 0, y: 0, zoom: 1 };
  private anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private velocity = { x: 0, y: 0 };

  private o: Orientation = 'flat';
  private hexes: HexR[] = [];
  private byKey = new Map<string, HexR>();
  private byId = new Map<string, HexR>();
  private chunks = new Map<string, Chunk>();
  private hexPath!: Path2D; // unit hex at origin
  private terrainColor = new Map<string, string>();
  private terrainGlyph = new Map<string, string>();
  private stateColor = new Map<string, string>();
  private factionColor = new Map<string, string>();
  private factions: FactionLite[] = [];
  private control = new Map<string, string>(); // hexId -> factionId
  private contested = new Map<string, string[]>(); // hexId -> factionIds
  private borders = new Map<string, Path2D>(); // factionId -> border segments
  private claimFill = new Map<string, Path2D>(); // factionId -> hex fills
  private factionLabels: { id: string; name: string; x: number; y: number; n: number; width: number }[] = [];
  private tokens: Token[] = [];
  private fog: Set<string> | null = null;
  private fogPath: Path2D | null = null;
  showFog = true;

  hoverId: string | null = null;
  selectedId: string | null = null;
  brushIds: Set<string> = new Set();
  dragToken: { token: Token; x: number; y: number } | null = null;
  private flashes = new Map<string, number>();
  private raf = 0;
  private last = performance.now();
  private dirty = true;
  private settledFrames = 0;
  onCameraChange?: (c: Camera) => void;
  onAfterFrame?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  resize(w: number, h: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.dirty = true;
  }

  get viewport() { return { w: this.w, h: this.h }; }

  // ---------------------------------------------------------------- data
  setData(d: RenderInput) {
    const orientationChanged = d.orientation !== this.o;
    this.o = d.orientation;
    this.hexPath = new Path2D();
    for (let i = 0; i < 6; i++) { const c = corner(i, HEX_SIZE, this.o); i ? this.hexPath.lineTo(c.x, c.y) : this.hexPath.moveTo(c.x, c.y); }
    this.hexPath.closePath();
    this.terrainColor = new Map(d.terrain.map((t) => [t.key, t.color]));
    this.terrainGlyph = new Map(d.terrain.map((t) => [t.key, t.glyph ?? 'none']));
    this.stateColor = new Map(d.states.filter((s) => s.color).map((s) => [s.key, s.color!]));
    this.factionColor = new Map(d.factions.map((f) => [f.id, f.color]));
    this.factions = d.factions;
    const prevIds = this.byId;
    this.hexes = d.hexes.map((h) => {
      const p = hexToPixel(h.q, h.r, HEX_SIZE, this.o);
      const { col, row } = axialToOffset(h.q, h.r, this.o);
      return { ...h, cx: p.x, cy: p.y, col, row, chunk: `${Math.floor(col / CHUNK)},${Math.floor(row / CHUNK)}` };
    });
    this.byKey = new Map(this.hexes.map((h) => [key(h.q, h.r), h]));
    this.byId = new Map(this.hexes.map((h) => [h.id, h]));
    // Flash hexes whose terrain changed since the last data set.
    if (!orientationChanged) {
      for (const h of this.hexes) { const was = prevIds.get(h.id); if (was && was.terrain !== h.terrain) this.flash(h.id); }
    }
    this.chunks = new Map();
    for (const h of this.hexes) {
      let c = this.chunks.get(h.chunk);
      if (!c) { c = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hexes: [], fills: null }; this.chunks.set(h.chunk, c); }
      c.hexes.push(h);
      c.minX = Math.min(c.minX, h.cx - HEX_SIZE); c.maxX = Math.max(c.maxX, h.cx + HEX_SIZE);
      c.minY = Math.min(c.minY, h.cy - HEX_SIZE); c.maxY = Math.max(c.maxY, h.cy + HEX_SIZE);
    }
    this.setClaims(d.claims, false);
    this.tokens = d.tokens;
    this.setFog(d.fog);
    this.dirty = true;
  }

  setClaims(claims: Claim[], flashChanges = true) {
    const before = this.control;
    this.control = new Map();
    this.contested = new Map();
    for (const c of claims) {
      if (c.kind === 'control') this.control.set(c.hexId, c.factionId);
      else if (c.kind === 'contested') this.contested.set(c.hexId, [...(this.contested.get(c.hexId) ?? []), c.factionId]);
    }
    if (flashChanges) {
      for (const h of this.hexes) if ((before.get(h.id) ?? null) !== (this.control.get(h.id) ?? null)) this.flash(h.id);
    }
    this.rebuildClaims();
    this.dirty = true;
  }

  setTokens(tokens: Token[]) { this.tokens = tokens; this.dirty = true; }

  setFog(fog: Set<string> | null) {
    this.fog = fog;
    this.fogPath = null;
    if (fog) {
      const p = new Path2D();
      for (const h of this.hexes) if (!fog.has(h.id)) p.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
      this.fogPath = p;
    }
    this.dirty = true;
  }

  /** Optimistic local edit while a brush stroke is in progress. */
  patchHexes(ids: Iterable<string>, patch: Partial<Pick<Hex, 'terrain' | 'state'>>) {
    for (const id of ids) {
      const h = this.byId.get(id);
      if (!h) continue;
      if (patch.terrain && h.terrain !== patch.terrain) { h.terrain = patch.terrain; this.chunks.get(h.chunk)!.fills = null; this.flash(id); }
      if (patch.state && h.state !== patch.state) { h.state = patch.state; this.flash(id); }
    }
    this.dirty = true;
  }

  previewControl(ids: Iterable<string>, factionId: string | null) {
    for (const id of ids) {
      if ((this.control.get(id) ?? null) === factionId) continue;
      if (factionId) this.control.set(id, factionId); else this.control.delete(id);
      this.flash(id);
    }
    this.rebuildClaims();
    this.dirty = true;
  }

  previewFog(ids: Iterable<string>, explored: boolean) {
    if (!this.fog) return;
    for (const id of ids) { if (explored) this.fog.add(id); else this.fog.delete(id); }
    this.setFog(this.fog);
  }

  private flash(id: string) { this.flashes.set(id, performance.now()); this.dirty = true; }

  private rebuildClaims() {
    this.borders = new Map();
    this.claimFill = new Map();
    const dirs = DIRS[this.o];
    const sums = new Map<string, { x: number; y: number; n: number; minX: number; maxX: number }>();
    const inset = 0.9;
    for (const [hexId, fid] of this.control) {
      const h = this.byId.get(hexId);
      if (!h) continue;
      let fill = this.claimFill.get(fid);
      if (!fill) { fill = new Path2D(); this.claimFill.set(fid, fill); }
      fill.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
      const s = sums.get(fid) ?? { x: 0, y: 0, n: 0, minX: Infinity, maxX: -Infinity };
      s.x += h.cx; s.y += h.cy; s.n++; s.minX = Math.min(s.minX, h.cx); s.maxX = Math.max(s.maxX, h.cx); sums.set(fid, s);
      let border = this.borders.get(fid);
      for (let d = 0; d < 6; d++) {
        const n = this.byKey.get(key(h.q + dirs[d].q, h.r + dirs[d].r));
        if (n && this.control.get(n.id) === fid) continue;
        if (!border) { border = new Path2D(); this.borders.set(fid, border); }
        const a = corner(d, HEX_SIZE * inset, this.o), b = corner((d + 1) % 6, HEX_SIZE * inset, this.o);
        border.moveTo(h.cx + a.x, h.cy + a.y);
        border.lineTo(h.cx + b.x, h.cy + b.y);
      }
    }
    this.factionLabels = [...sums.entries()].map(([id, s]) => ({
      id, name: this.factions.find((f) => f.id === id)?.name ?? '', x: s.x / s.n, y: s.y / s.n, n: s.n, width: s.maxX - s.minX + HEX_SIZE * 1.5,
    }));
  }

  // ---------------------------------------------------------------- camera
  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.w / 2) / this.cam.zoom + this.cam.x, y: (sy - this.h / 2) / this.cam.zoom + this.cam.y };
  }
  worldToScreen(x: number, y: number) {
    return { x: (x - this.cam.x) * this.cam.zoom + this.w / 2, y: (y - this.cam.y) * this.cam.zoom + this.h / 2 };
  }
  hexAt(sx: number, sy: number): HexR | undefined {
    const p = this.screenToWorld(sx, sy);
    const a = pixelToHex(p.x, p.y, HEX_SIZE, this.o);
    return this.byKey.get(key(a.q, a.r));
  }
  hexById(id: string) { return this.byId.get(id); }
  label(h: { q: number; r: number }) { return hexLabel(h.q, h.r, this.o); }

  tokenAt(sx: number, sy: number): Token | undefined {
    const z = this.cam.zoom;
    for (const t of [...this.tokens].reverse()) {
      const pos = this.tokenPos(t);
      if (!pos) continue;
      const s = this.worldToScreen(pos.x, pos.y);
      const r = Math.max(9, this.tokenRadius(t) * z);
      if ((sx - s.x) ** 2 + (sy - s.y) ** 2 <= r * r) return t;
    }
    return undefined;
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z = clamp(this.target.zoom * factor, this.minZoom(), MAX_ZOOM);
    const w = this.screenToWorld(sx, sy);
    this.anchor = { sx, sy, wx: w.x, wy: w.y };
    this.target.zoom = z;
    this.velocity = { x: 0, y: 0 };
    this.dirty = true;
  }

  panBy(dx: number, dy: number) {
    this.anchor = null;
    this.cam.x -= dx / this.cam.zoom; this.cam.y -= dy / this.cam.zoom;
    this.target.x = this.cam.x; this.target.y = this.cam.y;
    this.target.zoom = this.cam.zoom;
    this.dirty = true;
  }

  fling(vx: number, vy: number) { this.velocity = { x: vx, y: vy }; this.dirty = true; }

  flyTo(x: number, y: number, zoom?: number) {
    this.anchor = null;
    this.velocity = { x: 0, y: 0 };
    this.target = { x, y, zoom: clamp(zoom ?? this.target.zoom, this.minZoom(), MAX_ZOOM) };
    this.dirty = true;
  }

  setCamera(c: Camera) { this.cam = { ...c }; this.target = { ...c }; this.anchor = null; this.dirty = true; }

  /** Camera that fits the whole map in view. */
  fitCamera(padding = 60): Camera {
    if (!this.hexes.length) return { x: 0, y: 0, zoom: 1 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of this.chunks.values()) { minX = Math.min(minX, c.minX); minY = Math.min(minY, c.minY); maxX = Math.max(maxX, c.maxX); maxY = Math.max(maxY, c.maxY); }
    const zoom = clamp(Math.min((this.w - padding * 2) / (maxX - minX), (this.h - padding * 2) / (maxY - minY)), MIN_ZOOM, MAX_ZOOM);
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
  }

  /** Never zoom out past half of "whole map in view": a map, not a speck. */
  minZoom() { return Math.max(MIN_ZOOM, this.w ? this.fitCamera().zoom * 0.5 : MIN_ZOOM); }

  invalidate() { this.dirty = true; }

  // ---------------------------------------------------------------- frame
  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const moving = this.step(dt);
    const animating = moving || this.flashes.size > 0 || this.selectedId !== null || this.dragToken !== null || this.tokens.some((t) => t.kind === 'party');
    if (!this.dirty && !animating) return;
    // Throttle idle ambient animation (selection pulse, party glow) to ~30fps.
    if (!this.dirty && !moving && this.flashes.size === 0 && (this.settledFrames++ & 1)) return;
    this.dirty = false;
    this.draw(now);
    this.onAfterFrame?.();
  }

  /** Ease the camera toward its target. Returns true while still moving. */
  private step(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 14);
    let moving = false;
    if (Math.abs(this.velocity.x) + Math.abs(this.velocity.y) > 2) {
      this.cam.x -= (this.velocity.x * dt) / this.cam.zoom; this.cam.y -= (this.velocity.y * dt) / this.cam.zoom;
      this.target.x = this.cam.x; this.target.y = this.cam.y;
      const decay = Math.exp(-dt * 5);
      this.velocity.x *= decay; this.velocity.y *= decay;
      moving = true;
    }
    const zDiff = Math.log(this.target.zoom / this.cam.zoom);
    if (Math.abs(zDiff) > 0.0005) {
      this.cam.zoom *= Math.exp(zDiff * k);
      moving = true;
    } else this.cam.zoom = this.target.zoom;
    if (this.anchor) {
      // Keep the anchored world point under the cursor.
      this.cam.x = this.anchor.wx - (this.anchor.sx - this.w / 2) / this.cam.zoom;
      this.cam.y = this.anchor.wy - (this.anchor.sy - this.h / 2) / this.cam.zoom;
      this.target.x = this.cam.x; this.target.y = this.cam.y;
      if (this.cam.zoom === this.target.zoom) this.anchor = null;
    } else {
      const dx = this.target.x - this.cam.x, dy = this.target.y - this.cam.y;
      if (Math.abs(dx) * this.cam.zoom > 0.3 || Math.abs(dy) * this.cam.zoom > 0.3) {
        this.cam.x += dx * k; this.cam.y += dy * k; moving = true;
      } else { this.cam.x = this.target.x; this.cam.y = this.target.y; }
    }
    if (moving) this.onCameraChange?.(this.cam);
    return moving;
  }

  private draw(now: number) {
    const { ctx, cam } = this;
    const z = cam.zoom;
    const R = HEX_SIZE * z; // on-screen hex radius
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, this.w, this.h);

    // Level-of-detail weights: 0 = continental, 1 = hexcrawl detail.
    const detail = smoothstep(7, 22, R);
    const glyphs = smoothstep(18, 30, R);
    const fine = smoothstep(46, 70, R);

    ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, this.dpr * (this.w / 2 - cam.x * z), this.dpr * (this.h / 2 - cam.y * z));
    const view = {
      minX: cam.x - this.w / 2 / z, maxX: cam.x + this.w / 2 / z,
      minY: cam.y - this.h / 2 / z, maxY: cam.y + this.h / 2 / z,
    };
    const visible: Chunk[] = [];
    for (const c of this.chunks.values()) {
      if (c.maxX < view.minX || c.minX > view.maxX || c.maxY < view.minY || c.minY > view.maxY) continue;
      visible.push(c);
    }

    // Terrain
    for (const c of visible) {
      if (!c.fills) c.fills = this.buildFills(c);
      for (const [color, p] of c.fills) { ctx.fillStyle = color; ctx.fill(p); }
    }

    // Terrain glyphs
    if (glyphs > 0.01) {
      ctx.globalAlpha = glyphs * 0.55;
      for (const c of visible) for (const h of c.hexes) {
        if (h.cx < view.minX - HEX_SIZE || h.cx > view.maxX + HEX_SIZE || h.cy < view.minY - HEX_SIZE || h.cy > view.maxY + HEX_SIZE) continue;
        drawGlyph(ctx, this.terrainGlyph.get(h.terrain) ?? 'none', h.cx, h.cy, HEX_SIZE, h.q * 7 + h.r * 13);
      }
      ctx.globalAlpha = 1;
    }

    // Faction territory tint: strong when zoomed out (political map), light when in.
    const tint = 0.18 + (1 - detail) * 0.32;
    for (const [fid, p] of this.claimFill) {
      ctx.globalAlpha = tint;
      ctx.fillStyle = this.factionColor.get(fid) ?? '#888';
      ctx.fill(p);
    }
    ctx.globalAlpha = 1;

    // Contested hexes: diagonal stripes in the contesting factions' colors.
    for (const [hexId, fids] of this.contested) {
      const h = this.byId.get(hexId);
      if (!h || !fids.length) continue;
      ctx.save();
      ctx.translate(h.cx, h.cy);
      ctx.clip(this.hexPath);
      ctx.lineWidth = HEX_SIZE * 0.14;
      ctx.globalAlpha = 0.55;
      for (let i = -6; i <= 6; i++) {
        ctx.strokeStyle = this.factionColor.get(fids[(i + 6) % fids.length]) ?? '#888';
        ctx.beginPath();
        ctx.moveTo(i * HEX_SIZE * 0.3 - HEX_SIZE, -HEX_SIZE);
        ctx.lineTo(i * HEX_SIZE * 0.3 + HEX_SIZE, HEX_SIZE);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Grid lines fade in with detail.
    if (detail > 0.01) {
      ctx.globalAlpha = detail * 0.5;
      ctx.strokeStyle = '#0d0f13';
      ctx.lineWidth = 1.2 / z;
      for (const c of visible) {
        for (const h of c.hexes) { ctx.save(); ctx.translate(h.cx, h.cy); ctx.stroke(this.hexPath); ctx.restore(); }
      }
      ctx.globalAlpha = 1;
    }

    // Fog of war (GM sees through it, darkened and hatched).
    if (this.fog && this.fogPath && this.showFog) {
      ctx.fillStyle = 'rgba(8, 10, 14, 0.5)';
      ctx.fill(this.fogPath);
      if (detail > 0.2) {
        ctx.save();
        ctx.clip(this.fogPath);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 2 / z;
        const step = 14 / z;
        ctx.beginPath();
        for (let x = view.minX - (view.maxY - view.minY); x < view.maxX; x += step) {
          ctx.moveTo(x, view.minY); ctx.lineTo(x + (view.maxY - view.minY), view.maxY);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // Borders: a soft wide glow plus a crisp line, constant on-screen width.
    for (const [fid, p] of this.borders) {
      const color = this.factionColor.get(fid) ?? '#888';
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = (5 + (1 - detail) * 3) / z;
      ctx.stroke(p);
      ctx.globalAlpha = 1;
      ctx.lineWidth = (1.8 + (1 - detail) * 1.2) / z;
      ctx.stroke(p);
    }

    // Hex state pips (only states with a color) and names.
    if (detail > 0.3) {
      for (const c of visible) for (const h of c.hexes) {
        const sc = this.stateColor.get(h.state);
        if (sc) {
          ctx.globalAlpha = detail;
          const top = this.o === 'flat' ? { x: 0, y: -HEX_SIZE * 0.66 } : { x: 0, y: -HEX_SIZE * 0.62 };
          ctx.fillStyle = sc;
          ctx.beginPath();
          const s = clamp(7 / z, 2, 4.5);
          ctx.moveTo(h.cx + top.x, h.cy + top.y - s); ctx.lineTo(h.cx + top.x + s, h.cy + top.y);
          ctx.lineTo(h.cx + top.x, h.cy + top.y + s); ctx.lineTo(h.cx + top.x - s, h.cy + top.y); ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
        }
        if (h.name && fine > 0.01) {
          ctx.globalAlpha = fine;
          ctx.font = `600 ${12 / z}px 'Inter Variable', sans-serif`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 3 / z;
          ctx.strokeStyle = 'rgba(8,10,14,0.7)';
          ctx.strokeText(h.name, h.cx, h.cy + HEX_SIZE * 0.78);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fillText(h.name, h.cx, h.cy + HEX_SIZE * 0.78);
        }
        if (fine > 0.01) {
          ctx.globalAlpha = fine * 0.45;
          ctx.font = `500 ${Math.min(7, 10 / z)}px 'Inter Variable', sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#fff';
          ctx.fillText(hexLabel(h.q, h.r, this.o), h.cx, h.cy - HEX_SIZE * 0.42);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Paint brush footprint
    if (this.brushIds.size) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      for (const id of this.brushIds) { const h = this.byId.get(id); if (h) { ctx.save(); ctx.translate(h.cx, h.cy); ctx.stroke(this.hexPath); ctx.restore(); } }
      ctx.setLineDash([]);
    }

    // Change flashes
    for (const [id, t0] of this.flashes) {
      const t = (now - t0) / 450;
      if (t >= 1) { this.flashes.delete(id); continue; }
      const h = this.byId.get(id);
      if (!h) continue;
      ctx.save();
      ctx.translate(h.cx, h.cy);
      const s = 1 + 0.12 * Math.sin(t * Math.PI);
      ctx.scale(s, s);
      ctx.globalAlpha = (1 - t) * 0.55;
      ctx.fillStyle = '#fff';
      ctx.fill(this.hexPath);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Hover + selection
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d4a64a';
    if (this.hoverId && this.hoverId !== this.selectedId) {
      const h = this.byId.get(this.hoverId);
      if (h) { ctx.save(); ctx.translate(h.cx, h.cy); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2 / z; ctx.stroke(this.hexPath); ctx.restore(); }
    }
    if (this.selectedId) {
      const h = this.byId.get(this.selectedId);
      if (h) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 320);
        ctx.save(); ctx.translate(h.cx, h.cy);
        ctx.strokeStyle = accent; ctx.lineWidth = (3 + pulse * 2) / z; ctx.globalAlpha = 0.35 + pulse * 0.25; ctx.stroke(this.hexPath);
        ctx.globalAlpha = 1; ctx.lineWidth = 2 / z; ctx.stroke(this.hexPath);
        ctx.restore();
      }
    }

    // Faction names over their territory when zoomed out.
    const labelAlpha = 1 - smoothstep(10, 26, R);
    if (labelAlpha > 0.01) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const l of this.factionLabels) {
        // Fit the name inside its territory's on-screen width (spaced capitals are ~0.95em each).
        const px = clamp((l.width * z) / (l.name.length * 0.95), 9, 30) / z;
        ctx.font = `600 ${px}px 'Fraunces Variable', serif`;
        ctx.globalAlpha = labelAlpha;
        ctx.lineWidth = 4 / z;
        ctx.strokeStyle = 'rgba(8,10,14,0.85)';
        const text = l.name.toUpperCase().split('').join(' ');
        ctx.strokeText(text, l.x, l.y);
        ctx.fillStyle = '#f3ecdc';
        ctx.fillText(text, l.x, l.y);
      }
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
    }

    this.drawTokens(now, z, accent);
  }

  private buildFills(c: Chunk): Map<string, Path2D> {
    const m = new Map<string, Path2D>();
    for (const h of c.hexes) {
      const color = this.terrainColor.get(h.terrain) ?? '#2a2f38';
      let p = m.get(color);
      if (!p) { p = new Path2D(); m.set(color, p); }
      p.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
    }
    return m;
  }

  // ---------------------------------------------------------------- tokens
  private tokenRadius(t: Token) {
    return t.kind === 'city' ? 15 : t.kind === 'outpost' ? 11 : t.kind === 'party' ? 12 : t.kind === 'unit' ? 11 : 8;
  }

  /** Tokens sharing a hex fan out around the center: settlements stay central, movers orbit. */
  tokenPos(t: Token): { x: number; y: number } | null {
    if (this.dragToken?.token.id === t.id) return { x: this.dragToken.x, y: this.dragToken.y };
    if (!t.hexId) return null;
    const h = this.byId.get(t.hexId);
    if (!h) return null;
    const here = this.tokens.filter((x) => x.hexId === t.hexId && x.id !== this.dragToken?.token.id);
    const fixed = here.filter((x) => x.kind === 'city' || x.kind === 'outpost');
    const movers = here.filter((x) => !(x.kind === 'city' || x.kind === 'outpost'));
    if (fixed.includes(t)) {
      const i = fixed.indexOf(t);
      return { x: h.cx + (fixed.length > 1 ? (i - (fixed.length - 1) / 2) * 18 : 0) - (movers.length ? 6 : 0), y: h.cy - (movers.length ? 6 : 0) };
    }
    const i = movers.indexOf(t);
    const n = movers.length;
    if (!fixed.length && n === 1) return { x: h.cx, y: h.cy };
    // Movers sit on an arc in the lower-right of the hex, clear of the settlement plate.
    const base = fixed.length ? Math.PI * 0.3 : -Math.PI / 2;
    const ang = base + (n > 1 ? (i - (n - 1) / 2) * (Math.PI / 3.2) : 0);
    const rad = HEX_SIZE * (fixed.length ? 0.6 : 0.42);
    return { x: h.cx + Math.cos(ang) * rad, y: h.cy + Math.sin(ang) * rad };
  }

  private drawTokens(now: number, z: number, accent: string) {
    const ctx = this.ctx;
    // Keep tokens readable when zoomed far out: never smaller than ~7px, never huge.
    const scale = Math.max(1, 7 / (12 * z));
    const ordered = [...this.tokens].sort((a, b) => order(a) - order(b));
    for (const t of ordered) {
      const p = this.tokenPos(t);
      if (!p) continue;
      const r = this.tokenRadius(t) * scale;
      const color = t.color ?? (t.factionId ? this.factionColor.get(t.factionId) : undefined) ?? '#bbb';
      ctx.save();
      ctx.translate(p.x, p.y);
      if (this.dragToken?.token.id === t.id) { ctx.globalAlpha = 0.85; ctx.scale(1.15, 1.15); }
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 6 * z;
      ctx.shadowOffsetY = 2 * z;
      if (t.kind === 'city' || t.kind === 'outpost') drawSettlement(ctx, r, color, t.kind === 'city');
      else if (t.kind === 'party') {
        ctx.shadowBlur = 0;
        const pulse = 0.5 + 0.5 * Math.sin(now / 500);
        ctx.fillStyle = color; ctx.globalAlpha = 0.18 + pulse * 0.12;
        ctx.beginPath(); ctx.arc(0, 0, r * (1.5 + pulse * 0.35), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 6 * z;
        drawParty(ctx, r, color);
      } else if (t.kind === 'unit') drawUnit(ctx, r, color);
      else { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = r * 0.18; ctx.stroke(); }
      ctx.restore();
      // Name plate
      const showName = t.kind === 'city' ? z > 0.22 : t.kind === 'party' ? z > 0.3 : z > 0.7;
      if (showName) {
        ctx.save();
        ctx.font = `600 ${t.kind === 'city' ? 11 : 9.5}px 'Inter Variable', sans-serif`;
        ctx.textAlign = 'center';
        // Constant on-screen size. Under the token, or beside it when it shares a hex with a settlement.
        const beside = t.kind !== 'city' && t.kind !== 'outpost'
          && this.tokens.some((x) => x.hexId === t.hexId && (x.kind === 'city' || x.kind === 'outpost'));
        if (beside) ctx.textAlign = 'left';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,10,14,0.9)';
        ctx.fillStyle = t.kind === 'party' ? accent : '#f3ecdc';
        if (beside) ctx.translate(p.x + r + 4 / z, p.y + 4 / z);
        else ctx.translate(p.x, p.y + r + 12 / z);
        ctx.scale(1 / z, 1 / z);
        ctx.strokeText(t.name, 0, 0);
        ctx.fillText(t.name, 0, 0);
        ctx.restore();
      }
    }
  }
}

const order = (t: Token) => (t.kind === 'city' ? 0 : t.kind === 'outpost' ? 1 : t.kind === 'party' ? 3 : 2);

function drawSettlement(ctx: CanvasRenderingContext2D, r: number, color: string, city: boolean) {
  // Shield-like plate with a tower silhouette.
  ctx.fillStyle = '#15171c';
  roundRect(ctx, -r, -r, r * 2, r * 2, r * 0.35);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  const s = r * 0.62;
  ctx.beginPath();
  if (city) {
    // three towers
    ctx.moveTo(-s, s); ctx.lineTo(-s, -s * 0.2); ctx.lineTo(-s * 0.75, -s * 0.2); ctx.lineTo(-s * 0.75, -s * 0.45); ctx.lineTo(-s * 0.45, -s * 0.45);
    ctx.lineTo(-s * 0.45, -s * 0.2); ctx.lineTo(-s * 0.3, -s * 0.2); ctx.lineTo(-s * 0.3, -s * 0.85); ctx.lineTo(0, -s * 1.1); ctx.lineTo(s * 0.3, -s * 0.85);
    ctx.lineTo(s * 0.3, -s * 0.2); ctx.lineTo(s * 0.45, -s * 0.2); ctx.lineTo(s * 0.45, -s * 0.45); ctx.lineTo(s * 0.75, -s * 0.45); ctx.lineTo(s * 0.75, -s * 0.2);
    ctx.lineTo(s, -s * 0.2); ctx.lineTo(s, s); ctx.closePath();
  } else {
    ctx.moveTo(-s * 0.55, s); ctx.lineTo(-s * 0.55, -s * 0.4); ctx.lineTo(-s * 0.3, -s * 0.4); ctx.lineTo(-s * 0.3, -s * 0.7); ctx.lineTo(0, -s * 0.7); ctx.lineTo(0, -s * 0.4);
    ctx.lineTo(s * 0.3, -s * 0.4); ctx.lineTo(s * 0.3, -s * 0.7); ctx.lineTo(s * 0.55, -s * 0.7); ctx.lineTo(s * 0.55, s); ctx.closePath();
  }
  ctx.fill();
}

function drawParty(ctx: CanvasRenderingContext2D, r: number, color: string) {
  ctx.fillStyle = '#15171c';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = r * 0.2; ctx.strokeStyle = color; ctx.stroke();
  // pennant
  ctx.fillStyle = color;
  ctx.fillRect(-r * 0.35, -r * 0.55, r * 0.14, r * 1.1);
  ctx.beginPath(); ctx.moveTo(-r * 0.21, -r * 0.55); ctx.lineTo(r * 0.5, -r * 0.32); ctx.lineTo(-r * 0.21, -r * 0.08); ctx.closePath(); ctx.fill();
}

function drawUnit(ctx: CanvasRenderingContext2D, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r, -r * 0.8); ctx.lineTo(r, -r * 0.8); ctx.lineTo(r, r * 0.1); ctx.quadraticCurveTo(r * 0.8, r * 0.8, 0, r); ctx.quadraticCurveTo(-r * 0.8, r * 0.8, -r, r * 0.1);
  ctx.closePath(); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#111'; ctx.lineWidth = r * 0.15; ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Small procedural terrain marks drawn in world space. */
function drawGlyph(ctx: CanvasRenderingContext2D, glyph: string, x: number, y: number, s: number, seed: number) {
  if (glyph === 'none') return;
  const j = (n: number) => (((seed * 9301 + n * 49297) % 233280) / 233280 - 0.5) * s * 0.18;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = s * 0.045;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (glyph) {
    case 'trees':
      for (const [dx, dy] of [[-0.3, 0.05], [0.05, -0.2], [0.32, 0.12], [-0.02, 0.32]]) {
        const cx = x + dx * s + j(dx * 10), cy = y + dy * s + j(dy * 10), h = s * 0.22;
        ctx.moveTo(cx, cy - h); ctx.lineTo(cx + h * 0.6, cy + h * 0.5); ctx.lineTo(cx - h * 0.6, cy + h * 0.5); ctx.closePath();
      }
      ctx.fill(); ctx.stroke(); break;
    case 'peaks':
      ctx.moveTo(x - s * 0.5, y + s * 0.25); ctx.lineTo(x - s * 0.15, y - s * 0.3); ctx.lineTo(x + s * 0.1, y + s * 0.05);
      ctx.lineTo(x + s * 0.25, y - s * 0.15); ctx.lineTo(x + s * 0.5, y + s * 0.25);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - s * 0.15, y - s * 0.3); ctx.lineTo(x - s * 0.05, y - s * 0.05); ctx.stroke(); break;
    case 'hills':
      ctx.arc(x - s * 0.18 + j(1), y + s * 0.12, s * 0.2, Math.PI * 1.1, Math.PI * 1.9);
      ctx.moveTo(x + s * 0.38 + j(2), y - s * 0.02);
      ctx.arc(x + s * 0.2 + j(2), y - s * 0.02, s * 0.18, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke(); break;
    case 'waves':
      for (const dy of [-0.15, 0.12]) {
        const yy = y + dy * s;
        ctx.moveTo(x - s * 0.35, yy);
        ctx.quadraticCurveTo(x - s * 0.2, yy - s * 0.1, x - s * 0.05, yy);
        ctx.quadraticCurveTo(x + s * 0.1, yy + s * 0.1, x + s * 0.25, yy);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke(); break;
    case 'grass':
      for (const [dx, dy] of [[-0.25, 0.1], [0.15, -0.15], [0.22, 0.25]]) {
        const cx = x + dx * s + j(dx * 7), cy = y + dy * s;
        ctx.moveTo(cx - s * 0.06, cy); ctx.lineTo(cx - s * 0.1, cy - s * 0.1);
        ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - s * 0.13);
        ctx.moveTo(cx + s * 0.06, cy); ctx.lineTo(cx + s * 0.1, cy - s * 0.1);
      }
      ctx.stroke(); break;
    case 'reeds':
      for (const dx of [-0.25, -0.05, 0.15, 0.3]) {
        const cx = x + dx * s, cy = y + s * 0.18 + j(dx * 5);
        ctx.moveTo(cx, cy); ctx.lineTo(cx + s * 0.03, cy - s * 0.3);
      }
      ctx.moveTo(x - s * 0.35, y + s * 0.2); ctx.lineTo(x + s * 0.4, y + s * 0.2);
      ctx.stroke(); break;
    case 'dunes':
      ctx.moveTo(x - s * 0.4, y + s * 0.1); ctx.quadraticCurveTo(x - s * 0.1, y - s * 0.2, x + s * 0.2, y + s * 0.1);
      ctx.moveTo(x - s * 0.05, y + s * 0.3); ctx.quadraticCurveTo(x + s * 0.2, y + s * 0.05, x + s * 0.42, y + s * 0.28);
      ctx.stroke(); break;
  }
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smoothstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
