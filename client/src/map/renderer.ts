/**
 * Canvas 2D hex map renderer.
 *
 * Layers, bottom to top: the map art (or, without art, painted terrain tiles),
 * an optional terrain-color overlay, faction territory (a soft wash and inner glow
 * inside smoothed, inked borders), contested hatching, the grid, party fog, labels,
 * crafted markers, then interaction feedback (hover, selection, brush, flashes).
 *
 * Hexes stay the source of truth: everything above the art is derived from them.
 * The camera eases toward a target every frame; zoom stays anchored to the cursor.
 */
import { axialToOffset, corner, DIRS, HEX_SIZE, hexLabel, hexToPixel, key, pixelToHex, type Orientation } from '../../../shared/hex';
import type { ArtPlacement, Claim, FactionLite, Hex, HexStateType, TerrainType, Token, TokenKind } from '../types';
import { TerrainPainter, type PaintHex } from './painter';
import { MARKER_RADIUS, markerSprite } from './markers';

export { HEX_SIZE };
const CHUNK = 12; // hexes per chunk side, in offset coordinates
export const MIN_ZOOM = 0.04;
export const MAX_ZOOM = 4;
const SELECT = '#8fe8e2';
const DISPLAY_FONT = "'Cinzel Variable', 'Cinzel', Georgia, serif";
const UI_FONT = "'Inter Variable', system-ui, sans-serif";

export type Camera = { x: number; y: number; zoom: number };

type HexR = Hex & { cx: number; cy: number; col: number; row: number; chunk: string };
type Chunk = { minX: number; minY: number; maxX: number; maxY: number; hexes: HexR[]; fills: Map<string, Path2D> | null };
type Territory = {
  id: string; color: string; name: string;
  fill: Path2D; // exact hexes, for hit-free washes when zoomed far in
  loops: { x: number; y: number }[][]; // smoothed border loops
  smooth: Path2D; // smoothed territory shape (evenodd)
  line: Map<number, Path2D>; // inset ink line per zoom bucket
  label: { x: number; y: number; width: number; n: number };
};

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

export type Layers = {
  /** Terrain colors over the art (0 = art only). Without art the painted terrain always shows. */
  terrainOverlay: number;
  grid: boolean;
  territory: boolean;
};

export class HexMapRenderer {
  canvas: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D;
  protected dpr = 1;
  protected w = 0;
  protected h = 0;

  cam: Camera = { x: 0, y: 0, zoom: 1 };
  target: Camera = { x: 0, y: 0, zoom: 1 };
  protected drawnCam: Camera = { x: 0, y: 0, zoom: 0 };
  protected baseCache: { canvas: HTMLCanvasElement; sig: string; minX: number; maxX: number; minY: number; maxY: number } | null = null;
  protected baseRev = 0;
  protected lastBaseSig = '';
  protected buildingBase = false;
  protected fastArt = false;
  protected artWasFast = false;
  protected anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
  protected velocity = { x: 0, y: 0 };

  protected o: Orientation = 'flat';
  protected hexes: HexR[] = [];
  protected byKey = new Map<string, HexR>();
  protected byId = new Map<string, HexR>();
  protected chunks = new Map<string, Chunk>();
  protected hexPath!: Path2D; // unit hex at origin
  protected terrainColor = new Map<string, string>();
  protected terrainGlyph = new Map<string, string>();
  protected stateColor = new Map<string, string>();
  protected factionColor = new Map<string, string>();
  protected factions: FactionLite[] = [];
  protected control = new Map<string, string>(); // hexId -> factionId
  protected contested = new Map<string, string[]>(); // hexId -> factionIds
  protected influence = new Map<string, string[]>();
  protected territories = new Map<string, Territory>();
  protected tokens: Token[] = [];
  protected fog: Set<string> | null = null;
  protected fogPath: Path2D | null = null;
  protected painter = new TerrainPainter();
  protected art: { img: CanvasImageSource; width: number; height: number; mips: { img: ImageBitmap; width: number }[] } | null = null;
  artPlacement: ArtPlacement | null = null;
  layers: Layers = { terrainOverlay: 0, grid: true, territory: true };
  /** True while a terrain or state brush is active: terrain colors surface over the art so edits are visible. */
  painting = false;
  showFog = false;

  hoverId: string | null = null;
  selectedId: string | null = null;
  selectedTokenId: string | null = null;
  focusFactionId: string | null = null;
  brushIds: Set<string> = new Set();
  dragToken: { token: Token; x: number; y: number } | null = null;
  protected flashes = new Map<string, number>();
  protected raf = 0;
  protected last = performance.now();
  protected dirty = true;
  protected settledFrames = 0;
  protected painting_pending = false;
  onCameraChange?: (c: Camera) => void;
  onAfterFrame?: () => void;
  /**
   * Set by the 3D view, which drapes this renderer's output over terrain: the ground (art, painted
   * terrain) comes from the 3D scene, the background stays transparent, markers are drawn upright
   * by the 3D view, and level of detail follows the 3D camera's zoom rather than the overlay's.
   */
  protected overlayMode = false;
  protected lodZoom: number | null = null;

  constructor(canvas: HTMLCanvasElement, opts: { alpha?: boolean } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: !!opts.alpha })!;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    // Labels use web fonts; redraw once they arrive.
    document.fonts?.ready.then(() => this.invalidate());
  }

  destroy() { cancelAnimationFrame(this.raf); this.painter.clear(); }

  resize(w: number, h: number) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.dirty = true;
  }

  get viewport() { return { w: this.w, h: this.h }; }
  get hasArt() { return !!this.art; }

  // ---------------------------------------------------------------- data
  setData(d: RenderInput) {
    const orientationChanged = d.orientation !== this.o;
    this.o = d.orientation;
    this.hexPath = new Path2D();
    for (let i = 0; i < 6; i++) { const c = corner(i, HEX_SIZE, this.o); i ? this.hexPath.lineTo(c.x, c.y) : this.hexPath.moveTo(c.x, c.y); }
    this.hexPath.closePath();
    const paletteBefore = JSON.stringify([...this.terrainColor, ...this.terrainGlyph]);
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
    const sameShape = !orientationChanged && prevIds.size === this.byId.size && this.hexes.every((h) => prevIds.has(h.id));
    const terrainChanged: HexR[] = [];
    if (sameShape) {
      for (const h of this.hexes) { const was = prevIds.get(h.id)!; if (was.terrain !== h.terrain) { terrainChanged.push(h); this.flash(h.id); } }
    }
    this.chunks = new Map();
    this.baseRev++;
    for (const h of this.hexes) {
      let c = this.chunks.get(h.chunk);
      if (!c) { c = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hexes: [], fills: null }; this.chunks.set(h.chunk, c); }
      c.hexes.push(h);
      c.minX = Math.min(c.minX, h.cx - HEX_SIZE); c.maxX = Math.max(c.maxX, h.cx + HEX_SIZE);
      c.minY = Math.min(c.minY, h.cy - HEX_SIZE); c.maxY = Math.max(c.maxY, h.cy + HEX_SIZE);
    }
    // Painted terrain: keep finished tiles unless the grid or palette changed.
    if (!sameShape || paletteBefore !== JSON.stringify([...this.terrainColor, ...this.terrainGlyph])) {
      this.painter.setSource({
        orientation: this.o, size: HEX_SIZE,
        hexesIn: (a, b, c, e) => this.hexesIn(a, b, c, e),
        neighbor: (h, dir) => { const dd = DIRS[this.o][dir]; return this.byKey.get(key(h.q + dd.q, h.r + dd.r)); },
        color: (t) => this.terrainColor.get(t) ?? '#2a2f38',
        glyph: (t) => this.terrainGlyph.get(t) ?? 'none',
      });
    } else if (terrainChanged.length) this.painter.invalidate(terrainChanged);
    this.tokens = d.tokens;
    this.setClaims(d.claims, false);
    this.setFog(d.fog);
    this.dirty = true;
  }

  protected hexesIn(minX: number, minY: number, maxX: number, maxY: number): PaintHex[] {
    const out: PaintHex[] = [];
    for (const c of this.chunks.values()) {
      if (c.maxX < minX || c.minX > maxX || c.maxY < minY || c.minY > maxY) continue;
      for (const h of c.hexes) if (h.cx >= minX - HEX_SIZE && h.cx <= maxX + HEX_SIZE && h.cy >= minY - HEX_SIZE && h.cy <= maxY + HEX_SIZE) out.push(h);
    }
    return out;
  }

  /** Art under the grid. Mipmaps are built in the background for crisp zoomed-out views. */
  setArt(img: HTMLImageElement | null, placement: ArtPlacement | null) {
    this.artPlacement = placement ? { ...placement } : null;
    this.baseRev++;
    if (!img) { this.art = null; this.dirty = true; return; }
    const art = { img: img as CanvasImageSource, width: img.naturalWidth, height: img.naturalHeight, mips: [] as { img: ImageBitmap; width: number }[] };
    this.art = art;
    (async () => {
      // Decode once, then halve each level from the one before: cheap, and the small levels
      // that zoomed-out views need arrive within a few frames instead of after the big ones.
      let prev: CanvasImageSource = img;
      try {
        const full = await createImageBitmap(img);
        if (this.art !== art) { full.close(); return; }
        art.img = prev = full;
        this.baseRev++;
      } catch { /* keep drawing the element */ }
      let prevW = art.width, prevH = art.height;
      for (let wdt = Math.floor(art.width / 2); wdt >= 256; wdt = Math.floor(wdt / 2)) {
        try {
          const hgt = Math.round((art.height * wdt) / art.width);
          const bmp: ImageBitmap = await createImageBitmap(prev as ImageBitmapSource, 0, 0, prevW, prevH, { resizeWidth: wdt, resizeHeight: hgt, resizeQuality: 'high' });
          if (this.art !== art) { bmp.close(); return; }
          art.mips.push({ img: bmp, width: wdt });
          prev = bmp; prevW = wdt; prevH = hgt;
          this.dirty = true;
        } catch { return; }
      }
    })();
    this.dirty = true;
  }

  setClaims(claims: Claim[], flashChanges = true) {
    const before = this.control;
    this.control = new Map();
    this.contested = new Map();
    this.influence = new Map();
    for (const c of claims) {
      if (c.kind === 'control') this.control.set(c.hexId, c.factionId);
      else if (c.kind === 'contested') this.contested.set(c.hexId, [...(this.contested.get(c.hexId) ?? []), c.factionId]);
      else this.influence.set(c.hexId, [...(this.influence.get(c.hexId) ?? []), c.factionId]);
    }
    if (flashChanges) {
      for (const h of this.hexes) if ((before.get(h.id) ?? null) !== (this.control.get(h.id) ?? null)) this.flash(h.id);
    }
    this.rebuildTerritories();
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
    const changed: HexR[] = [];
    for (const id of ids) {
      const h = this.byId.get(id);
      if (!h) continue;
      if (patch.terrain && h.terrain !== patch.terrain) { h.terrain = patch.terrain; this.chunks.get(h.chunk)!.fills = null; changed.push(h); this.flash(id); }
      if (patch.state && h.state !== patch.state) { h.state = patch.state; this.flash(id); }
    }
    if (changed.length) { this.painter.invalidate(changed); this.baseRev++; }
    this.dirty = true;
  }

  previewControl(ids: Iterable<string>, factionId: string | null) {
    for (const id of ids) {
      if ((this.control.get(id) ?? null) === factionId) continue;
      if (factionId) this.control.set(id, factionId); else this.control.delete(id);
      this.flash(id);
    }
    this.rebuildTerritories();
    this.dirty = true;
  }

  previewFog(ids: Iterable<string>, explored: boolean) {
    if (!this.fog) return;
    for (const id of ids) { if (explored) this.fog.add(id); else this.fog.delete(id); }
    this.setFog(this.fog);
  }

  protected flash(id: string) { this.flashes.set(id, performance.now()); this.dirty = true; }

  /**
   * Territories: exact hex fills, plus border loops chained from boundary edges and
   * smoothed (Chaikin) so borders read as inked lines rather than hex staircases.
   */
  protected rebuildTerritories() {
    this.baseRev++;
    this.territories = new Map();
    const dirs = DIRS[this.o];
    const groups = new Map<string, HexR[]>();
    for (const [hexId, fid] of this.control) {
      const h = this.byId.get(hexId);
      if (h) groups.set(fid, [...(groups.get(fid) ?? []), h]);
    }
    const P = (x: number, y: number) => `${Math.round(x * 4)},${Math.round(y * 4)}`;
    for (const [fid, hs] of groups) {
      const fill = new Path2D();
      const next = new Map<string, { x: number; y: number; to: string }>();
      for (const h of hs) {
        fill.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
        for (let d = 0; d < 6; d++) {
          const n = this.byKey.get(key(h.q + dirs[d].q, h.r + dirs[d].r));
          if (n && this.control.get(n.id) === fid) continue;
          const a = corner(d, HEX_SIZE, this.o), b = corner((d + 1) % 6, HEX_SIZE, this.o);
          const ka = P(h.cx + a.x, h.cy + a.y), kb = P(h.cx + b.x, h.cy + b.y);
          next.set(ka, { x: h.cx + a.x, y: h.cy + a.y, to: kb });
        }
      }
      // Chain edges into closed loops.
      const loops: { x: number; y: number }[][] = [];
      const seen = new Set<string>();
      for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop: { x: number; y: number }[] = [];
        let k: string | undefined = start;
        while (k && !seen.has(k)) {
          seen.add(k);
          const e = next.get(k);
          if (!e) break;
          loop.push({ x: e.x, y: e.y });
          k = e.to;
        }
        // Smooth from edge midpoints: they sit on a much gentler line than the hex corners.
        if (loop.length >= 3) {
          const mids = loop.map((p, i) => { const q = loop[(i + 1) % loop.length]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; });
          loops.push(chaikin(chaikin(chaikin(mids))));
        }
      }
      const smooth = new Path2D();
      for (const l of loops) { l.forEach((p, i) => (i ? smooth.lineTo(p.x, p.y) : smooth.moveTo(p.x, p.y))); smooth.closePath(); }
      // Label anchor: the territory hex deepest inside it (farthest from its border).
      const depth = new Map<string, number>();
      let frontier = hs.filter((h) => dirs.some((d) => this.control.get(this.byKey.get(key(h.q + d.q, h.r + d.r))?.id ?? '') !== fid));
      frontier.forEach((h) => depth.set(h.id, 0));
      for (let level = 1; frontier.length; level++) {
        const nx: HexR[] = [];
        for (const h of frontier) for (const d of dirs) {
          const n = this.byKey.get(key(h.q + d.q, h.r + d.r));
          if (n && this.control.get(n.id) === fid && !depth.has(n.id)) { depth.set(n.id, level); nx.push(n); }
        }
        frontier = nx;
      }
      const f = this.factions.find((x) => x.id === fid);
      // The engraved name spans most of its row, so test the label's whole footprint against markers.
      const rowSpan = (h: HexR) => {
        // The contiguous run of territory hexes through h on its row (both half-rows of a flat-top grid).
        const row = hs.filter((o) => Math.abs(o.cy - h.cy) < HEX_SIZE * 1.2).map((o) => o.cx).sort((a, b) => a - b);
        let lo = h.cx, hi = h.cx;
        const step = HEX_SIZE * 1.6;
        for (let i = row.indexOf(h.cx); i > 0 && row[i] - row[i - 1] <= step; i--) lo = row[i - 1];
        for (let i = row.indexOf(h.cx); i >= 0 && i < row.length - 1 && row[i + 1] - row[i] <= step; i++) hi = row[i + 1];
        return { lo, hi, span: hi - lo };
      };
      const textHalf = (span: number) => Math.min(span * 0.85, (f?.name.length ?? 8) * HEX_SIZE * 0.75) / 2;
      const tokenPts = this.tokens.map((t) => (t.hexId ? this.byId.get(t.hexId) : undefined)).filter((h): h is HexR => !!h);
      // Name plates hang below their marker, so the keep-out box reaches further down than up.
      const hits = (x: number, y: number, half: number) => tokenPts.filter((th) => y - th.cy > -HEX_SIZE * 1.15 && y - th.cy < HEX_SIZE * 1.9 && Math.abs(th.cx - x) < half + HEX_SIZE * 2.6).length;
      const mx = hs.reduce((s, h) => s + h.cx, 0) / hs.length, my = hs.reduce((s, h) => s + h.cy, 0) / hs.length;
      let best = { x: hs[0].cx, y: hs[0].cy, span: HEX_SIZE * 2 }, bestScore = -Infinity;
      for (const h of hs) {
        const r = rowSpan(h);
        const x = (r.lo + r.hi) / 2;
        const cxHex = hs.reduce((b, o) => (Math.abs(o.cy - h.cy) < HEX_SIZE * 1.2 && Math.abs(o.cx - x) < Math.abs(b.cx - x) ? o : b), h);
        const score = Math.min(depth.get(cxHex.id) ?? 0, 3) * 1000 + Math.min(depth.get(h.id) ?? 0, 2) * 300
          - hits(x, h.cy, textHalf(r.span)) * 2600 + Math.min(r.span, HEX_SIZE * 14) * 3 - Math.hypot(x - mx, h.cy - my);
        if (score > bestScore) { bestScore = score; best = { x, y: h.cy, span: r.span }; }
      }
      this.territories.set(fid, {
        id: fid, color: this.factionColor.get(fid) ?? '#888', name: f?.name ?? '', fill, loops, smooth, line: new Map(),
        label: { x: best.x, y: best.y, width: best.span * 0.85, n: hs.length },
      });
    }
  }

  /** The border line, inset toward the territory so neighbors' borders sit side by side. */
  protected insetLine(t: Territory, z: number): Path2D {
    const bucket = Math.round(Math.log2(z) * 3);
    let p = t.line.get(bucket);
    if (p) return p;
    const off = Math.min(HEX_SIZE * 0.12, 3.2 / 2 ** (bucket / 3));
    p = new Path2D();
    for (const loop of t.loops) {
      // Which side is inside? Probe the first segment's left normal.
      const n = loop.length;
      const a = loop[0], b = loop[1];
      const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot(tx, ty) || 1;
      const probe = this.hexAtWorld((a.x + b.x) / 2 - (ty / tl) * HEX_SIZE * 0.3, (a.y + b.y) / 2 + (tx / tl) * HEX_SIZE * 0.3);
      const sign = probe && this.control.get(probe.id) === t.id ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const prev = loop[(i - 1 + n) % n], cur = loop[i], nxt = loop[(i + 1) % n];
        const dx = nxt.x - prev.x, dy = nxt.y - prev.y, dl = Math.hypot(dx, dy) || 1;
        const x = cur.x - (dy / dl) * off * sign, y = cur.y + (dx / dl) * off * sign;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath();
    }
    t.line.set(bucket, p);
    return p;
  }

  // ---------------------------------------------------------------- camera
  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.w / 2) / this.cam.zoom + this.cam.x, y: (sy - this.h / 2) / this.cam.zoom + this.cam.y };
  }
  worldToScreen(x: number, y: number) {
    return { x: (x - this.cam.x) * this.cam.zoom + this.w / 2, y: (y - this.cam.y) * this.cam.zoom + this.h / 2 };
  }
  protected hexAtWorld(x: number, y: number) {
    const a = pixelToHex(x, y, HEX_SIZE, this.o);
    return this.byKey.get(key(a.q, a.r));
  }
  hexAt(sx: number, sy: number): HexR | undefined {
    const p = this.screenToWorld(sx, sy);
    return this.hexAtWorld(p.x, p.y);
  }
  hexById(id: string) { return this.byId.get(id); }
  label(h: { q: number; r: number }) { return hexLabel(h.q, h.r, this.o); }

  tokenAt(sx: number, sy: number): Token | undefined {
    for (const t of [...this.tokens].sort((a, b) => order(b) - order(a))) {
      const pos = this.tokenPos(t);
      if (!pos) continue;
      const s = this.worldToScreen(pos.x, pos.y);
      const r = Math.max(10, this.markerRadius(t.kind));
      s.y -= this.tokenLift(t.kind, this.markerRadius(t.kind));
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

  /** Camera that fits the whole map in view, leaving room for overlaid chrome. */
  fitCamera(padding = 70): Camera {
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
  protected loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const moving = this.step(dt);
    // Art resamples cheaply while the camera moves; one sharp frame follows when it settles.
    const camChanged = this.cam.x !== this.drawnCam.x || this.cam.y !== this.drawnCam.y || this.cam.zoom !== this.drawnCam.zoom;
    this.fastArt = moving || camChanged;
    if (!this.fastArt && this.artWasFast) this.dirty = true;
    const animating = moving || this.flashes.size > 0 || this.selectedId !== null || this.dragToken !== null
      || this.painting_pending || this.tokens.some((t) => t.kind === 'party');
    if (!this.dirty && !animating) return;
    // Throttle idle ambient animation (selection pulse, party glow) to ~30fps.
    if (!this.dirty && !moving && this.flashes.size === 0 && !this.painting_pending && (this.settledFrames++ & 1)) return;
    this.dirty = false;
    this.draw(now);
    this.drawnCam = { ...this.cam };
    this.onAfterFrame?.();
  }

  /** Ease the camera toward its target. Returns true while still moving. */
  protected step(dt: number): boolean {
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

  /**
   * Render a still of the map around a point into a new canvas (panel headers).
   * Uses the same drawing path as the live view, minus interaction feedback.
   */
  snapshot(x: number, y: number, zoom: number, w: number, h: number): HTMLCanvasElement {
    const saved = { canvas: this.canvas, ctx: this.ctx, w: this.w, h: this.h, cam: this.cam, hover: this.hoverId, sel: this.selectedId, brush: this.brushIds, selTok: this.selectedTokenId };
    const c = document.createElement('canvas');
    const dpr = this.dpr;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    this.canvas = c; this.ctx = c.getContext('2d', { alpha: false })!;
    this.w = w; this.h = h; this.cam = { x, y, zoom };
    this.hoverId = null; this.selectedId = null; this.brushIds = new Set(); this.selectedTokenId = null;
    try { this.draw(performance.now(), { still: true }); } finally {
      this.canvas = saved.canvas; this.ctx = saved.ctx; this.w = saved.w; this.h = saved.h; this.cam = saved.cam;
      this.hoverId = saved.hover; this.selectedId = saved.sel; this.brushIds = saved.brush; this.selectedTokenId = saved.selTok;
    }
    this.dirty = true;
    return c;
  }

  protected draw(now: number, opts: { still?: boolean } = {}) {
    const { ctx, cam } = this;
    const z = cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.overlayMode) ctx.clearRect(0, 0, this.w, this.h);
    else {
      // Open sea beyond the map.
      const bg = ctx.createRadialGradient(this.w / 2, this.h / 2, 0, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
      bg.addColorStop(0, '#0f2230'); bg.addColorStop(1, '#070e14');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    // Level-of-detail weights: 0 = continental, 1 = hexcrawl detail.
    const RL = HEX_SIZE * (this.lodZoom ?? z);
    const detail = smoothstep(7, 22, RL);
    const fine = smoothstep(46, 70, RL);

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
    const inView = (h: HexR, m = HEX_SIZE) => !(h.cx < view.minX - m || h.cx > view.maxX + m || h.cy < view.minY - m || h.cy > view.maxY + m);

    // 1–2. Ground and territory washes. Static between edits, so while the zoom holds still they are
    // rendered once into an offscreen layer and blitted; panning then costs one image copy.
    const sig = this.baseSignature(z);
    const stable = !this.overlayMode && !opts.still && z === this.drawnCam.zoom && sig === this.lastBaseSig && !this.painting_pending;
    this.lastBaseSig = sig;
    if (!stable || !this.drawBaseCached(view, z, detail, sig)) this.drawBase(view, z, visible, detail, !!opts.still);

    if (this.layers.territory) {
      ctx.globalAlpha = 1;
      for (const [hexId, fids] of this.contested) {
        const h = this.byId.get(hexId);
        if (!h || !fids.length || !inView(h)) continue;
        this.drawContested(h, fids, z, now, opts.still);
      }
    }

    // 3. Grid lines fade in with detail.
    if (this.layers.grid && detail > 0.01) {
      const path = new Path2D();
      // Over art, open ocean stays clean; the grid starts at the shallows.
      for (const c of visible) for (const h of c.hexes) if (inView(h) && !((this.art || this.overlayMode) && h.terrain === 'deep')) path.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
      ctx.lineWidth = 1 / z;
      ctx.lineJoin = 'round';
      if (this.art || this.overlayMode) {
        ctx.globalAlpha = detail * 0.35; ctx.strokeStyle = 'rgba(6,12,16,0.9)'; ctx.lineWidth = 2 / z; ctx.stroke(path);
        ctx.globalAlpha = detail * 0.3; ctx.strokeStyle = '#e9f2ee'; ctx.lineWidth = 0.9 / z; ctx.stroke(path);
      } else {
        ctx.globalAlpha = detail * 0.32; ctx.strokeStyle = '#0d120f'; ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
    }

    // 4. Fog of war (the GM sees through it, darkened and hatched).
    if (this.fog && this.fogPath && this.showFog) {
      ctx.fillStyle = 'rgba(5, 9, 13, 0.55)';
      ctx.fill(this.fogPath);
      if (detail > 0.2) {
        ctx.save();
        ctx.clip(this.fogPath);
        ctx.strokeStyle = 'rgba(200,220,230,0.06)';
        ctx.lineWidth = 2 / z;
        const step = 12 / z;
        ctx.beginPath();
        for (let x = view.minX - (view.maxY - view.minY); x < view.maxX; x += step) {
          ctx.moveTo(x, view.minY); ctx.lineTo(x + (view.maxY - view.minY), view.maxY);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // 5. Inked borders: dark ink under a faction-colored line, constant on-screen weight.
    if (this.layers.territory) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const t of this.territories.values()) {
        const line = this.insetLine(t, z);
        const focus = this.focusFactionId === t.id ? 1.4 : 1;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = 'rgba(8, 10, 12, 0.85)';
        ctx.lineWidth = (4.2 * focus + (1 - detail) * 0.8) / z;
        ctx.stroke(line);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = lighten(t.color, 0.12);
        ctx.lineWidth = (2 * focus + (1 - detail) * 0.6) / z;
        ctx.stroke(line);
      }
      // Influence: a dotted ring in the faction's color (hexcrawl only).
      if (detail > 0.3 && this.influence.size) {
        ctx.setLineDash([1.5 / z, 5 / z]);
        ctx.lineWidth = 2.4 / z;
        ctx.globalAlpha = detail * 0.9;
        for (const [hexId, fids] of this.influence) {
          const h = this.byId.get(hexId);
          if (!h || !inView(h)) continue;
          fids.forEach((fid, i) => {
            ctx.strokeStyle = this.factionColor.get(fid) ?? '#aaa';
            ctx.save(); ctx.translate(h.cx, h.cy); ctx.scale(0.8 - i * 0.1, 0.8 - i * 0.1); ctx.stroke(this.hexPath); ctx.restore();
          });
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }

    // 6. Hex state pips, names and coordinates (constant on-screen size).
    if (detail > 0.3) {
      for (const c of visible) for (const h of c.hexes) {
        if (!inView(h)) continue;
        const sc = this.stateColor.get(h.state);
        if (sc && h.state !== 'contested') {
          ctx.globalAlpha = detail;
          const top = { x: 0, y: -HEX_SIZE * (this.o === 'flat' ? 0.66 : 0.62) };
          ctx.fillStyle = sc;
          ctx.beginPath();
          const s = clamp(6 / z, 2, 4.2);
          ctx.moveTo(h.cx + top.x, h.cy + top.y - s); ctx.lineTo(h.cx + top.x + s, h.cy + top.y);
          ctx.lineTo(h.cx + top.x, h.cy + top.y + s); ctx.lineTo(h.cx + top.x - s, h.cy + top.y); ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1 / z; ctx.stroke();
        }
        if (fine > 0.01) {
          ctx.globalAlpha = fine * 0.55;
          ctx.font = `600 ${9.5 / z}px ${UI_FONT}`;
          ctx.textAlign = 'center';
          ctx.fillStyle = this.art ? '#f2f6f2' : '#fff';
          ctx.fillText(hexLabel(h.q, h.r, this.o), h.cx, h.cy - HEX_SIZE * 0.44);
        }
      }
      // Hex names: a small engraved caption, only when there's room.
      if (detail > 0.55) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const c of visible) for (const h of c.hexes) {
          if (!h.name || !inView(h) || this.tokens.some((t) => t.hexId === h.id && (t.kind === 'city' || t.kind === 'outpost'))) continue;
          ctx.globalAlpha = smoothstep(0.55, 0.9, detail);
          drawCaption(ctx, h.name, h.cx, h.cy + HEX_SIZE * 0.62, z, 10.5, '#f4ecd8');
        }
        ctx.textBaseline = 'alphabetic';
      }
      ctx.globalAlpha = 1;
    }

    // 7. Interaction feedback.
    if (this.brushIds.size) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      for (const id of this.brushIds) { const h = this.byId.get(id); if (h) { ctx.save(); ctx.translate(h.cx, h.cy); ctx.stroke(this.hexPath); ctx.restore(); } }
      ctx.setLineDash([]);
    }
    for (const [id, t0] of this.flashes) {
      const t = (now - t0) / 450;
      if (t >= 1) { this.flashes.delete(id); continue; }
      const h = this.byId.get(id);
      if (!h) continue;
      ctx.save();
      ctx.translate(h.cx, h.cy);
      const s = 1 + 0.12 * Math.sin(t * Math.PI);
      ctx.scale(s, s);
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.fillStyle = '#fff';
      ctx.fill(this.hexPath);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    if (this.hoverId && this.hoverId !== this.selectedId) {
      const h = this.byId.get(this.hoverId);
      if (h) {
        ctx.save(); ctx.translate(h.cx, h.cy);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill(this.hexPath);
        ctx.strokeStyle = 'rgba(240,250,248,0.6)'; ctx.lineWidth = 1.6 / z; ctx.stroke(this.hexPath);
        ctx.restore();
      }
    }
    if (this.selectedId) {
      const h = this.byId.get(this.selectedId);
      if (h) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 420);
        ctx.save(); ctx.translate(h.cx, h.cy);
        ctx.fillStyle = `rgba(143, 232, 226, ${0.08 + pulse * 0.06})`; ctx.fill(this.hexPath);
        ctx.shadowColor = SELECT; ctx.shadowBlur = 14 * this.dpr;
        ctx.strokeStyle = SELECT; ctx.lineWidth = 2.4 / z; ctx.globalAlpha = 0.75 + pulse * 0.25; ctx.stroke(this.hexPath);
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        ctx.strokeStyle = '#effffd'; ctx.lineWidth = 1 / z; ctx.stroke(this.hexPath);
        ctx.restore();
      }
    }

    // 8. Faction names over their territory when zoomed out: engraved capitals.
    const labelAlpha = 1 - smoothstep(16, 34, RL);
    if (labelAlpha > 0.01 && this.layers.territory) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const t of this.territories.values()) {
        if (t.label.n < 3) continue;
        const text = t.name.toUpperCase();
        const px = clamp((t.label.width * z) / (text.length * 1.08), 10, 26);
        ctx.save();
        ctx.translate(t.label.x, t.label.y);
        ctx.scale(1 / z, 1 / z);
        ctx.font = `600 ${px}px ${DISPLAY_FONT}`;
        setSpacing(ctx, `${(px * 0.18).toFixed(1)}px`);
        ctx.globalAlpha = labelAlpha;
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, px * 0.28);
        ctx.strokeStyle = 'rgba(6, 9, 12, 0.78)';
        ctx.strokeText(text, 0, 0);
        ctx.fillStyle = '#f5ead0';
        ctx.fillText(text, 0, 0);
        // A rule beneath the name in the faction color.
        const wdt = Math.min(ctx.measureText(text).width, t.label.width * z) * 0.5;
        ctx.globalAlpha = labelAlpha * 0.9;
        ctx.strokeStyle = t.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(-wdt * 0.6, px * 0.78); ctx.lineTo(wdt * 0.6, px * 0.78); ctx.stroke();
        setSpacing(ctx, '0px');
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
    }

    if (!this.overlayMode) this.drawTokens(now, z, opts.still);
  }

  protected flatFills(visible: Chunk[]) {
    const ctx = this.ctx;
    for (const c of visible) {
      if (!c.fills) c.fills = this.buildFills(c);
      for (const [color, p] of c.fills) { ctx.fillStyle = color; ctx.fill(p); }
    }
  }

  protected buildFills(c: Chunk): Map<string, Path2D> {
    const m = new Map<string, Path2D>();
    for (const h of c.hexes) {
      const color = this.terrainColor.get(h.terrain) ?? '#2a2f38';
      let p = m.get(color);
      if (!p) { p = new Path2D(); m.set(color, p); }
      p.addPath(this.hexPath, new DOMMatrix([1, 0, 0, 1, h.cx, h.cy]));
    }
    return m;
  }

  /** Contested: bold hatching in the rivals' colors, ringed by an alternating dashed border. */
  /** Ground (art or painted terrain) and territory washes, in world space on this.ctx. */
  protected drawBase(view: { minX: number; maxX: number; minY: number; maxY: number }, z: number, visible: Chunk[], detail: number, still: boolean) {
    const ctx = this.ctx;
    if (this.overlayMode) {
      // The 3D scene is the ground; show terrain colors only when asked for or while painting terrain.
      this.painting_pending = false;
      const overlay = Math.max(this.layers.terrainOverlay * 0.7, this.painting ? 0.5 : 0);
      if (overlay > 0.01) { ctx.globalAlpha = overlay; this.flatFills(visible); ctx.globalAlpha = 1; }
    } else if (this.art && this.artPlacement) {
      this.painting_pending = false;
      const p = this.artPlacement;
      // Pick the smallest mip that still has at least one texel per device pixel.
      const devPxPerWorld = z * this.dpr;
      let src: CanvasImageSource = this.art.img;
      for (const m of this.art.mips) if (m.width / p.w >= devPxPerWorld) src = m.img;
      ctx.globalAlpha = p.opacity;
      const fast = this.fastArt && !still && !this.buildingBase;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = fast ? 'low' : 'high';
      ctx.drawImage(src, p.x, p.y, p.w, p.h);
      if (!still && !this.buildingBase) this.artWasFast = fast;
      ctx.globalAlpha = 1;
      const overlay = Math.max(this.layers.terrainOverlay, this.painting ? 0.55 : 0);
      if (overlay > 0.01) {
        ctx.globalAlpha = overlay;
        this.flatFills(visible);
        ctx.globalAlpha = 1;
      }
    } else {
      this.painting_pending = this.painter.draw(ctx, view, z, this.dpr, (rect, ids) => {
        if (ids) {
          for (const id of ids) {
            const h = this.byId.get(id);
            if (!h) continue;
            ctx.fillStyle = this.terrainColor.get(h.terrain) ?? '#2a2f38';
            ctx.save(); ctx.translate(h.cx, h.cy); ctx.fill(this.hexPath); ctx.restore();
          }
          return;
        }
        if (!rect) return;
        ctx.save();
        ctx.beginPath(); ctx.rect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY); ctx.clip();
        this.flatFills(visible);
        ctx.restore();
      });
      if (this.layers.terrainOverlay > 0.01) { ctx.globalAlpha = this.layers.terrainOverlay * 0.6; this.flatFills(visible); ctx.globalAlpha = 1; }
    }

    // Territory: soft wash and an inner glow along the border.
    if (this.layers.territory) {
      const wash = (this.art ? 0.1 : 0.12) + (1 - detail) * 0.2;
      for (const t of this.territories.values()) {
        const focus = this.focusFactionId ? (this.focusFactionId === t.id ? 1.5 : 0.45) : 1;
        ctx.fillStyle = t.color;
        ctx.globalAlpha = Math.min(0.6, wash * focus);
        ctx.fill(t.smooth, 'evenodd');
        // Glow just inside the border: a wide stroke clipped to the territory.
        ctx.save();
        ctx.clip(t.smooth, 'evenodd');
        ctx.strokeStyle = t.color;
        ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.22 * Math.min(1.4, focus);
        ctx.lineWidth = 22 / z;
        ctx.stroke(t.smooth);
        ctx.globalAlpha = 0.25 * Math.min(1.4, focus);
        ctx.lineWidth = 9 / z;
        ctx.stroke(t.smooth);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  /** Signature of everything the base layer depends on; any change rebuilds the cache. */
  protected baseSignature(z: number): string {
    const p = this.artPlacement, l = this.layers;
    return [z, this.dpr, this.w, this.h, this.baseRev, this.art ? this.art.mips.length : -1,
      p ? `${p.x},${p.y},${p.w},${p.h},${p.opacity}` : '', l.terrainOverlay, l.territory, this.painting, this.focusFactionId].join('|');
  }

  protected drawBaseCached(view: { minX: number; maxX: number; minY: number; maxY: number }, z: number, detail: number, sig: string): boolean {
    const M = 160; // css px of slack around the viewport
    let c = this.baseCache;
    if (!c || c.sig !== sig || view.minX < c.minX || view.maxX > c.maxX || view.minY < c.minY || view.maxY > c.maxY) {
      const cw = Math.ceil((this.w + 2 * M) * this.dpr), ch = Math.ceil((this.h + 2 * M) * this.dpr);
      if (cw * ch > 40e6) return false; // too large to be worth caching
      const canvas = c && c.canvas.width === cw && c.canvas.height === ch ? c.canvas : document.createElement('canvas');
      canvas.width = cw; canvas.height = ch; // also clears
      const bctx = canvas.getContext('2d')!;
      const minX = view.minX - M / z, minY = view.minY - M / z;
      const bview = { minX, minY, maxX: minX + (this.w + 2 * M) / z, maxY: minY + (this.h + 2 * M) / z };
      const bvisible: Chunk[] = [];
      for (const ch2 of this.chunks.values()) {
        if (ch2.maxX < bview.minX || ch2.minX > bview.maxX || ch2.maxY < bview.minY || ch2.minY > bview.maxY) continue;
        bvisible.push(ch2);
      }
      bctx.setTransform(this.dpr * z, 0, 0, this.dpr * z, -minX * this.dpr * z, -minY * this.dpr * z);
      const saved = this.ctx;
      this.ctx = bctx; this.buildingBase = true;
      try { this.drawBase(bview, z, bvisible, detail, false); } finally { this.ctx = saved; this.buildingBase = false; }
      // Painted terrain still filling in: use this frame, rebuild on the next.
      c = this.baseCache = { canvas, sig: this.painting_pending ? '' : sig, ...bview };
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(c.canvas, Math.round(((c.minX - this.cam.x) * z + this.w / 2) * this.dpr), Math.round(((c.minY - this.cam.y) * z + this.h / 2) * this.dpr));
    ctx.restore();
    return true;
  }

  protected drawContested(h: HexR, fids: string[], z: number, now: number, still?: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(h.cx, h.cy);
    ctx.save();
    ctx.clip(this.hexPath);
    ctx.fillStyle = 'rgba(10, 6, 4, 0.25)';
    ctx.fill(this.hexPath);
    ctx.lineWidth = HEX_SIZE * 0.11;
    ctx.globalAlpha = 0.7;
    for (let i = -8; i <= 8; i++) {
      ctx.strokeStyle = this.factionColor.get(fids[(i + 8) % fids.length]) ?? '#888';
      ctx.beginPath();
      ctx.moveTo(i * HEX_SIZE * 0.24 - HEX_SIZE, -HEX_SIZE);
      ctx.lineTo(i * HEX_SIZE * 0.24 + HEX_SIZE, HEX_SIZE);
      ctx.stroke();
    }
    ctx.restore();
    const dash = 7 / z;
    const phase = still ? 0 : (now / 60) % (dash * 2 * fids.length);
    ctx.lineWidth = 2.6 / z;
    fids.forEach((fid, i) => {
      ctx.strokeStyle = this.factionColor.get(fid) ?? '#888';
      ctx.setLineDash([dash, dash * (fids.length * 2 - 1)]);
      ctx.lineDashOffset = -phase - i * dash * 2;
      ctx.stroke(this.hexPath);
    });
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.restore();
  }

  // ---------------------------------------------------------------- tokens
  /** Marker radius in CSS px: readable when zoomed out, a touch larger up close. */
  protected markerRadius(kind: TokenKind) {
    return MARKER_RADIUS[kind] * clamp(0.62 + this.cam.zoom * 0.3, 0.62, 1.3);
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
      return { x: h.cx + (fixed.length > 1 ? (i - (fixed.length - 1) / 2) * 20 : 0), y: h.cy - (movers.length ? 4 : 0) };
    }
    const i = movers.indexOf(t);
    const n = movers.length;
    if (!fixed.length && n === 1) return { x: h.cx, y: h.cy };
    // Movers sit on an arc in the lower-right of the hex, clear of the settlement shield.
    const base = fixed.length ? Math.PI * 0.22 : -Math.PI / 2;
    const ang = base + (n > 1 ? (i - (n - 1) / 2) * (Math.PI / 3.2) : 0);
    const rad = HEX_SIZE * (fixed.length ? 0.62 : 0.42);
    return { x: h.cx + Math.cos(ang) * rad, y: h.cy + Math.sin(ang) * rad };
  }

  /** How far a marker stands above its ground point, in CSS px (the 3D view stands markers up). */
  protected tokenLift(_kind: TokenKind, _r: number) { return 0; }
  /** Opacity for a marker at a world point (the 3D view dims markers hidden behind terrain). */
  protected tokenAlpha(_x: number, _y: number) { return 1; }

  protected drawTokens(now: number, z: number, still?: boolean) {
    const ctx = this.ctx;
    const ordered = [...this.tokens].sort((a, b) => order(a) - order(b));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const plates: { text: string; x: number; y: number; kind: TokenKind; color: string; side: boolean; alpha: number }[] = [];
    for (const t of ordered) {
      const p = this.tokenPos(t);
      if (!p) continue;
      const s = this.worldToScreen(p.x, p.y);
      const r = this.markerRadius(t.kind);
      if (s.x < -60 || s.y < -60 || s.x > this.w + 60 || s.y > this.h + 60) continue;
      const color = t.color ?? (t.factionId ? this.factionColor.get(t.factionId) : undefined) ?? '#b9b2a3';
      const dragging = this.dragToken?.token.id === t.id;
      const lift = this.tokenLift(t.kind, r);
      const fade = this.tokenAlpha(p.x, p.y);
      ctx.globalAlpha = fade;
      if (lift > 0) {
        // Standing on the ground: a contact shadow at the foot and a short post up to the marker.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
        ctx.beginPath(); ctx.ellipse(s.x, s.y, r * 0.75, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(12, 14, 16, 0.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - lift + r * 0.6); ctx.stroke();
        s.y -= lift;
      }
      if (t.kind === 'party') {
        const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(now / 520);
        const g = ctx.createRadialGradient(s.x, s.y, r * 0.6, s.x, s.y, r * (2.1 + pulse * 0.5));
        g.addColorStop(0, 'rgba(242, 210, 122, 0.45)'); g.addColorStop(1, 'rgba(242, 210, 122, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(s.x, s.y, r * (2.1 + pulse * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      if (this.selectedTokenId === t.id) {
        ctx.strokeStyle = SELECT; ctx.lineWidth = 2; ctx.shadowColor = SELECT; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.35, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
      }
      const sprite = markerSprite(t.kind, color, r * (dragging ? 1.15 : 1), this.dpr);
      const size = sprite.canvas.width / this.dpr;
      ctx.globalAlpha = (dragging ? 0.85 : 1) * fade;
      ctx.drawImage(sprite.canvas, s.x - size / 2, s.y - size / 2, size, size);
      ctx.globalAlpha = 1;
      const showName = t.kind === 'city' ? z > 0.18 : t.kind === 'outpost' ? z > 0.45 : t.kind === 'party' ? z > 0.3 : z > 0.8;
      if (showName && !dragging) {
        const beside = t.kind !== 'city' && t.kind !== 'outpost'
          && this.tokens.some((x) => x.hexId === t.hexId && (x.kind === 'city' || x.kind === 'outpost'));
        plates.push({ text: t.name, x: beside ? s.x + r + 6 : s.x, y: beside ? s.y : s.y + r + 11 + (lift ? lift * 0.55 : 0), kind: t.kind, color, side: beside, alpha: fade });
      }
    }
    // Name plates on top of every marker.
    ctx.textBaseline = 'middle';
    for (const pl of plates) {
      const settlement = pl.kind === 'city' || pl.kind === 'outpost';
      const px = pl.kind === 'city' ? 11 : 10;
      ctx.font = settlement ? `600 ${px}px ${DISPLAY_FONT}` : `600 ${px}px ${UI_FONT}`;
      setSpacing(ctx, settlement ? '0.8px' : '0px');
      const text = settlement ? pl.text.toUpperCase() : pl.text;
      const w = ctx.measureText(text).width;
      const padX = 7, hgt = px + 8;
      const x0 = pl.side ? pl.x : pl.x - w / 2 - padX;
      ctx.globalAlpha = pl.alpha;
      ctx.fillStyle = 'rgba(9, 13, 17, 0.82)';
      ctx.beginPath(); ctx.roundRect(x0, pl.y - hgt / 2, w + padX * 2, hgt, hgt / 2); ctx.fill();
      ctx.strokeStyle = settlement ? 'rgba(214, 178, 104, 0.55)' : 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = pl.kind === 'party' ? '#f2d27a' : '#f1e8d4';
      ctx.fillText(text, x0 + padX, pl.y + 0.5);
      setSpacing(ctx, '0px');
    }
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }
}

const order = (t: Token) => (t.kind === 'city' ? 0 : t.kind === 'outpost' ? 1 : t.kind === 'party' ? 3 : 2);

function chaikin(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
  }
  return out;
}

function drawCaption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, z: number, px: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 / z, 1 / z);
  ctx.font = `italic 600 ${px + 2}px 'EB Garamond Variable', Georgia, serif`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(6, 9, 12, 0.8)';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function setSpacing(ctx: CanvasRenderingContext2D, v: string) {
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = v;
}

function lighten(hex: string, amt: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c: number) => Math.round(c + (255 - c) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smoothstep = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
