/**
 * Faction names floating over their territory in the 3D view: crisp DOM text (Cinzel capitals over
 * a glowing rule in the faction's color) placed every frame at a point raised above the land, with
 * a tether to the ground drawn by the renderer. Sized by distance like the land under them, kept
 * from overlapping (the larger territory wins), and the only part of the map that takes the
 * pointer where they stand: hovering one lifts it toward the camera and asks for its info card.
 */

export type LabelSpot = { id: string; name: string; color: string; n: number; width: number };
/** Where a label goes this frame, in CSS pixels; `ppw` = screen pixels per world unit at its anchor. */
export type LabelPlace = { x: number; y: number; ppw: number; alpha: number };

type Item = {
  spot: LabelSpot; el: HTMLDivElement; text: HTMLSpanElement; rule: HTMLElement;
  w100: number; hot: number; px: number; shown: boolean; live: boolean;
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
        it = { spot: s, el, text, rule, w100: 0, hot: 0, px: 0, shown: false, live: false, tf: '', op: '', rect: null };
        this.items.set(s.id, it);
      }
      if (it.spot.name !== s.name || !it.w100) { it.text.textContent = s.name.toUpperCase(); it.w100 = this.textWidth(s.name); }
      if (it.spot.color !== s.color || !it.el.style.getPropertyValue('--fc')) it.el.style.setProperty('--fc', s.color);
      it.spot = s;
    }
    for (const [id, it] of this.items) if (!keep.has(id)) {
      it.el.remove(); this.items.delete(id);
      if (this.hovered === id) { this.hovered = null; this.onHover?.(null); }
    }
  }

  ids() { return this.items.keys(); }
  spot(id: string) { return this.items.get(id)?.spot; }
  /** How far a label has popped out (0..1), eased per frame. */
  hotness(id: string) { return this.items.get(id)?.hot ?? 0; }
  /** The label's box on screen this frame (CSS pixels), if shown. */
  rect(id: string) { const it = this.items.get(id); return it?.shown ? it.rect : null; }

  /** Ease the hover pop: call once a frame before placing. */
  step(dt: number) {
    const k = 1 - Math.exp(-dt * 11);
    for (const [id, it] of this.items) it.hot += ((this.hovered === id ? 1 : 0) - it.hot) * k;
  }

  /**
   * Place every label for this frame. `place` returns its screen point (the bottom centre of the
   * label) or null when off screen; `blocked` boxes (markers) keep labels from taking the pointer
   * there. Labels that would overlap a bigger territory's label are hidden.
   */
  layout(place: (s: LabelSpot, hot: number) => LabelPlace | null, w: number, h: number, blocked: { x: number; y: number; r: number }[]) {
    const order = [...this.items.values()].sort((a, b) => (b.spot.id === this.hovered ? 1 : 0) - (a.spot.id === this.hovered ? 1 : 0) || b.spot.n - a.spot.n);
    const taken: { x: number; y: number; w: number; h: number }[] = [];
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
        const r = { x: p.x - tw / 2, y: p.y - th, w: tw, h: th };
        const clear = r.x + r.w > 0 && r.x < w && r.y + r.h > 0 && r.y < h
          && !taken.some((o) => r.x < o.x + o.w + 6 && o.x < r.x + r.w + 6 && r.y < o.y + o.h + 2 && o.y < r.y + r.h + 2);
        if (clear) {
          show = true;
          taken.push(r);
          it.rect = r;
          live = p.alpha > 0.4 && (it.spot.id === this.hovered || !blocked.some((b) => b.x + b.r > r.x && b.x - b.r < r.x + r.w && b.y + b.r > r.y && b.y - b.r < r.y + r.h));
          const tf = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${s.toFixed(3)})`;
          if (tf !== it.tf) { it.tf = tf; it.el.style.transform = tf; }
        }
      }
      const op = show ? (p!.alpha).toFixed(2) : '0';
      if (op !== it.op) { it.op = op; it.el.style.opacity = op; }
      if (live !== it.live) { it.live = live; it.el.classList.toggle('live', live); }
      const hot = it.hot > 0.5;
      if (hot !== it.el.classList.contains('hot')) it.el.classList.toggle('hot', hot);
      it.shown = show;
      if (!show && this.hovered === it.spot.id) { this.hovered = null; this.onHover?.(null); }
    }
  }
}
