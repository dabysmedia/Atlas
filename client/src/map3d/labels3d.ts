/**
 * Faction names floating over their territory in the 3D view: crisp DOM text (Cinzel capitals over
 * a glowing rule in the faction's color) placed every frame at a point raised above the land, with
 * a tether to the ground drawn by the renderer. Sized by distance like the land under them, kept
 * from overlapping (the larger territory wins), and the only part of the map that takes the
 * pointer where they stand: hovering one lifts it toward the camera and asks for its info card.
 */

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box, mx = 0, my = 0) => a.x < b.x + b.w + mx && b.x < a.x + a.w + mx && a.y < b.y + b.h + my && b.y < a.y + a.h + my;

export type LabelSpot = { id: string; name: string; color: string; n: number; width: number };
/** Where a label goes this frame, in CSS pixels; `ppw` = screen pixels per world unit at its anchor. */
export type LabelPlace = { x: number; y: number; ppw: number; alpha: number };

type Item = {
  spot: LabelSpot; el: HTMLDivElement; text: HTMLSpanElement; rule: HTMLElement;
  w100: number; hot: number; fade: number; alpha: number; px: number; shown: boolean; live: boolean;
  tf: string; op: string; rect: { x: number; y: number; w: number; h: number } | null;
};

const DISPLAY_FONT = "600 100px 'Cinzel Variable', 'Cinzel', Georgia, serif";

export class FactionLabels {
  readonly root: HTMLDivElement;
  protected items = new Map<string, Item>();
  protected measure = document.createElement('canvas').getContext('2d')!;
  hovered: string | null = null;
  onHover?: (id: string | null) => void;
  onClick?: (id: string) => void;
  /** The map canvas: wheel turns over a label still zoom the map. */
  wheelTarget: HTMLElement | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'flabels';
    document.fonts?.ready.then(() => { for (const it of this.items.values()) it.w100 = this.textWidth(it.spot.name); });
  }

  attach(parent: HTMLElement | null) { if (parent && this.root.parentElement !== parent) parent.appendChild(this.root); }
  destroy() { this.root.remove(); this.items.clear(); }

  protected textWidth(name: string) {
    const m = this.measure;
    m.font = DISPLAY_FONT;
    if ('letterSpacing' in m) (m as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '18px';
    return m.measureText(name.toUpperCase()).width;
  }

  /** The territories to label (only those with a few hexes). */
  sync(spots: LabelSpot[]) {
    const keep = new Set<string>();
    for (const s of spots) {
      keep.add(s.id);
      let it = this.items.get(s.id);
      if (!it) {
        const el = document.createElement('div');
        el.className = 'flabel';
        const text = document.createElement('span');
        const rule = document.createElement('i');
        el.append(text, rule);
        el.addEventListener('pointerenter', () => { this.hovered = s.id; this.onHover?.(s.id); });
        el.addEventListener('pointerleave', () => { if (this.hovered === s.id) { this.hovered = null; this.onHover?.(null); } });
        el.addEventListener('click', (e) => { e.stopPropagation(); this.onClick?.(s.id); });
        el.addEventListener('contextmenu', (e) => e.preventDefault());
        el.addEventListener('wheel', (e) => {
          e.preventDefault();
          this.wheelTarget?.dispatchEvent(new WheelEvent('wheel', { clientX: e.clientX, clientY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, altKey: e.altKey, bubbles: true, cancelable: true }));
        }, { passive: false });
        this.root.appendChild(el);
        it = { spot: s, el, text, rule, w100: 0, hot: 0, fade: 0, alpha: 0, px: 0, shown: false, live: false, tf: '', op: '', rect: null };
        this.items.set(s.id, it);
      }
      if (it.spot.name !== s.name || !it.w100) { it.text.textContent = s.name.toUpperCase(); it.w100 = this.textWidth(s.name); }
      if (it.spot.color !== s.color || !it.el.style.getPropertyValue('--fc')) it.el.style.setProperty('--fc', s.color);
      it.spot = s;
    }
    this.order.length = 0;
    for (const [id, it] of this.items) if (!keep.has(id)) {
      it.el.remove(); this.items.delete(id);
      if (this.hovered === id) { this.hovered = null; this.onHover?.(null); }
    }
  }

  ids() { return this.items.keys(); }
  spot(id: string) { return this.items.get(id)?.spot; }
  /** How far a label has popped out (0..1), eased per frame. */
  hotness(id: string) { return this.items.get(id)?.hot ?? 0; }
  /** How far a label has faded in (0..1). */
  fadeOf(id: string) { return this.items.get(id)?.fade ?? 0; }
  /** The label's box on screen this frame (CSS pixels), if shown. */
  rect(id: string) { const it = this.items.get(id); return it?.shown ? it.rect : null; }

  /** Ease the hover pop: call once a frame before placing. */
  step(dt: number) {
    const k = 1 - Math.exp(-dt * 11);
    for (const [id, it] of this.items) it.hot += ((this.hovered === id ? 1 : 0) - it.hot) * k;
    this.fadeK = 1 - Math.exp(-dt * 8);
  }

  /**
   * Place every label for this frame. `place` returns its screen point (the bottom centre of the
   * label) or null when off screen; a label rises clear of the `blocked` boxes (markers and their
   * name plates), and never takes the pointer over one. Labels that would overlap a bigger
   * territory's label are hidden.
   */
  layout(place: (s: LabelSpot, hot: number) => LabelPlace | null, w: number, h: number, blocked: Box[], nBlocked = blocked.length) {
    // Reused from frame to frame: the hovered label first, then the larger territories.
    const order = this.order;
    if (order.length !== this.items.size) { order.length = 0; for (const it of this.items.values()) order.push(it); }
    order.sort(this.rank);
    let nt = 0;
    const hit = (r: Box) => { for (let i = 0; i < nBlocked; i++) if (overlaps(blocked[i], r)) return blocked[i]; return null; };
    for (const it of order) {
      const p = place(it.spot, it.hot);
      let show = false, live = false;
      if (p && p.alpha > 0.02) {
        // Lettering sized to the land under it, as the flat map does, within readable bounds.
        const len = it.spot.name.length;
        let px = Math.min(22, Math.max(11, (it.spot.width * p.ppw) / (len * 1.05)));
        px = Math.round(px * 2) / 2;
        if (px !== it.px) { it.px = px; it.el.style.fontSize = `${px}px`; }
        const s = 1 + 0.2 * it.hot;
        const tw = ((it.w100 * px) / 100 + px * 1.6) * s, th = px * 2.1 * s;
        const r = (it.rect ??= { x: 0, y: 0, w: 0, h: 0 });
        r.x = p.x - tw / 2; r.y = p.y - th; r.w = tw; r.h = th;
        // Float clear of a marker standing under the name (a capital often sits at the territory's heart).
        for (let k = 0; k < 3; k++) {
          const b = hit(r);
          if (!b) break;
          r.y = b.y - th - 4;
        }
        p.y = r.y + th;
        let clear = r.x + r.w > 0 && r.x < w && r.y + r.h > 0 && r.y < h;
        for (let i = 0; clear && i < nt; i++) if (overlaps(this.taken[i], r, 6, 2)) clear = false;
        if (clear) {
          show = true;
          this.taken[nt++] = r;
          live = p.alpha > 0.6 && (it.spot.id === this.hovered || !hit(r));
          const tf = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
          if (tf !== it.tf) { it.tf = tf; it.el.style.transform = tf; }
        }
      }
      // Fade in and out here rather than with a CSS transition, which stalls while frames are slow.
      if (show) it.alpha = p!.alpha;
      it.fade += ((show ? 1 : 0) - it.fade) * this.fadeK;
      const a = it.alpha * it.fade;
      const op = a < 0.01 ? '0' : a.toFixed(2);
      if (op !== it.op) { it.op = op; it.el.style.opacity = op; }
      if (live !== it.live) { it.live = live; it.el.classList.toggle('live', live); }
      const hot = it.hot > 0.5;
      if (hot !== it.el.classList.contains('hot')) it.el.classList.toggle('hot', hot);
      it.shown = show;
      if (!show && this.hovered === it.spot.id) { this.hovered = null; this.onHover?.(null); }
    }
  }
  protected order: Item[] = [];
  protected fadeK = 1;
  protected taken: Box[] = [];
  protected rank = (a: Item, b: Item) => (b.spot.id === this.hovered ? 1 : 0) - (a.spot.id === this.hovered ? 1 : 0) || b.spot.n - a.spot.n;
}
