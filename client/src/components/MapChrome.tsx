/**
 * The map's floating controls: a tool dock that keeps one tool in hand and fans out the rest, a view stack whose
 * compass tracks north and tiles out the camera moves, and the shortcut sheet. Everything reachable from here is
 * also on a key; every control names its key in its tip.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Grid3x3, Keyboard, Maximize, RotateCcw, RotateCw, X, type LucideIcon } from 'lucide-react';
import type { HexMapRenderer } from '../map/renderer';
import { is3d } from '../map3d/support';
import { glassPref } from '../prefs';

const SPRING = { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.8 };

/** Opens on mouse hover (with a forgiving close), keyboard focus or a tap; closes on leaving, blur or Escape. */
function useFan() {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const pointer = useRef('mouse');
  const set = (o: boolean, delay = 0) => {
    window.clearTimeout(timer.current);
    if (delay) timer.current = window.setTimeout(() => setOpen(o), delay); else setOpen(o);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const props = {
    onPointerEnter: (e: React.PointerEvent) => { pointer.current = e.pointerType; if (e.pointerType === 'mouse') set(true, 70); },
    onPointerLeave: (e: React.PointerEvent) => { if (e.pointerType === 'mouse') set(false, 340); },
    onPointerDown: (e: React.PointerEvent) => { pointer.current = e.pointerType; },
    onFocus: (e: React.FocusEvent) => { if ((e.target as HTMLElement).matches(':focus-visible')) set(true); },
    onBlur: (e: React.FocusEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set(false); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && open) { e.stopPropagation(); set(false); (e.currentTarget.querySelector('[aria-expanded], .on') as HTMLElement | null)?.focus(); }
    },
  };
  return { open, set, pointer, props };
}

/**
 * Frosted glass costs a blur of whatever is behind it every frame, and behind the map's chrome is a scene that
 * redraws every frame. While the map is open, watch the browser's pace: a crawl (a few frames in a row slower
 * than a quarter second: no GPU) or frames slower than ~25 a second for a couple of seconds trade the blur for
 * thicker tint. A start-up stall on a good machine shows up as a pace that recovers, which brings the glass back
 * (once, so a machine on the edge doesn't flicker between the two). A choice in World settings overrides it.
 */
export const glassLite = {
  get: () => document.documentElement.classList.contains('glass-lite'),
  set: (on: boolean) => { document.documentElement.classList.toggle('glass-lite', on); },
};
if (typeof document !== 'undefined' && glassPref.get() === 'lite') glassLite.set(true);
let autoLite = false, restored = false;
export function useGlassBudget() {
  useEffect(() => {
    if (glassPref.get() || (glassLite.get() && (!autoLite || restored))) return;
    let raf = 0, last = 0, pace = 16, crawl = 0, slow = 0, quick = 0;
    const tick = (now: number) => {
      const dt = last ? now - last : 0;
      last = now;
      if (dt > 0 && dt < 8000 && !document.hidden) {
        pace = pace * 0.9 + dt * 0.1;
        if (!autoLite) {
          crawl = dt > 250 ? crawl + 1 : 0;
          slow = pace > 40 ? slow + 1 : 0;
          if (crawl >= 3 || slow > 90) { autoLite = true; quick = 0; glassLite.set(true); }
        } else {
          quick = pace < 20 ? quick + 1 : 0;
          if (quick > 240 && !restored) { autoLite = false; restored = true; glassLite.set(false); return; }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

export type ToolDef<T extends string> = { id: T; label: string; short: string; icon: LucideIcon; keyHint: string };

/** The active tool, labelled; the others fan out beside it on hover or focus. */
export function ToolDock<T extends string>({ tools, tool, onTool }: { tools: ToolDef<T>[]; tool: T; onTool: (t: T) => void }) {
  const { open, set, pointer, props } = useFan();
  return (
    <div className={`panel dock ${open ? 'open' : ''}`} role="toolbar" aria-label="Map tools" data-tip-side="top" {...props}>
      <AnimatePresence initial={false}>
        {tools.map((x) => {
          const on = x.id === tool;
          if (!on && !open) return null;
          return (
            <motion.button key={x.id} className={on ? 'on' : ''} aria-pressed={on} aria-label={x.label} aria-keyshortcuts={x.keyHint}
              data-tip={open ? x.label : undefined} data-key={x.keyHint}
              initial={{ width: 0, opacity: 0, scale: 0.7 }} animate={{ width: 'auto', opacity: 1, scale: 1 }} exit={{ width: 0, opacity: 0, scale: 0.7 }}
              transition={SPRING}
              onClick={() => {
                // A tap on the folded dock unfolds it; a choice made by touch folds it again.
                if (!open) { set(true); return; }
                onTool(x.id);
                if (pointer.current !== 'mouse') set(false);
              }}>
              <x.icon size={17} strokeWidth={1.7} />
              <AnimatePresence initial={false}>
                {on && !open && (
                  <motion.span className="dock-label" initial={{ width: 0, opacity: 0 }} animate={{ width: 'auto', opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={SPRING}>
                    <span>{x.short}</span><kbd className="kbd">{x.keyHint}</kbd>
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** A round glass button in the right-hand stack. */
export function StackButton({ label, tip, keys, on, onClick, children, className = '', expanded }: {
  label: string; tip?: string; keys?: string; on?: boolean; onClick: () => void; children: ReactNode; className?: string; expanded?: boolean;
}) {
  return (
    <button className={`stack-btn ${on || expanded ? 'on' : ''} ${className}`} onClick={onClick} aria-label={label} data-tip={tip ?? label} data-key={keys}
      aria-keyshortcuts={keys} aria-pressed={expanded === undefined ? on : undefined} aria-expanded={expanded}>
      {children}
    </button>
  );
}

/** North on screen, from the renderer each frame (cheap: two projections, and a style write only when it turns). */
function useNorth(getRenderer: () => HexMapRenderer | null, needle: React.RefObject<SVGGElement | null>, onOverhead: (o: boolean) => void) {
  useEffect(() => {
    let raf = 0, last = NaN, over: boolean | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = getRenderer();
      if (!r || !r.viewport.w) return;
      // Two points a step north of the view's centre, at a fixed height so ridges don't bend the needle.
      const c = r.cam, three = is3d(r) ? r : null;
      const at = (x: number, y: number) => (three ? three.projectPoint(x, y, 0) : r.worldToScreen(x, y));
      const a = at(c.x, c.y), b = at(c.x, c.y - 200);
      const deg = (Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI;
      if (Number.isFinite(deg) && !(Math.abs(deg - last) < 0.2)) { last = deg; needle.current?.setAttribute('transform', `rotate(${deg.toFixed(1)} 12 12)`); }
      const o = is3d(r) ? r.overhead : false;
      if (o !== over) { over = o; onOverhead(o); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getRenderer]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The compass: it shows where north lies, and opens the row of camera moves. */
export function ViewControls({ getRenderer, mode, onFit, keysOpen, onKeys }: {
  getRenderer: () => HexMapRenderer | null; mode: '3d' | '2d'; onFit: () => void; keysOpen: boolean; onKeys: () => void;
}) {
  const { open, set, props } = useFan();
  const needle = useRef<SVGGElement>(null);
  const [overhead, setOverhead] = useState(false);
  useNorth(getRenderer, needle, setOverhead);
  const r3 = () => { const r = getRenderer(); return r && is3d(r) ? r : null; };
  const items: { label: string; keys: string; icon: ReactNode; run: () => void; on?: boolean }[] = [
    { label: 'Fit map', keys: 'F', icon: <Maximize size={15} />, run: onFit },
    ...(mode === '3d' ? [
      { label: 'Turn left', keys: 'Q', icon: <RotateCcw size={15} />, run: () => r3()?.rotate(Math.PI / 8) },
      { label: 'Face north', keys: 'N', icon: <CompassGlyph size={17} />, run: () => r3()?.faceNorth() },
      { label: 'Turn right', keys: 'E', icon: <RotateCw size={15} />, run: () => r3()?.rotate(-Math.PI / 8) },
      { label: 'Overhead view', keys: 'T', icon: <Grid3x3 size={15} />, run: () => { const x = r3(); if (x) x.setOverhead(!x.overhead); }, on: overhead },
    ] : []),
    { label: 'Keyboard shortcuts', keys: '?', icon: <Keyboard size={15} />, run: onKeys, on: keysOpen },
  ];
  return (
    <div className="view-stack" {...props}>
      <AnimatePresence>
        {open && (
          <motion.div className="panel view-row" role="group" aria-label="View" data-tip-side="top"
            initial={{ opacity: 0, x: 14, scale: 0.94 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 10, scale: 0.96, transition: { duration: 0.12 } }}
            transition={SPRING}>
            {items.map((it, i) => (
              <motion.button key={it.label} className={it.on ? 'on' : ''} onClick={it.run} aria-label={it.label} aria-keyshortcuts={it.keys}
                aria-pressed={it.on === undefined ? undefined : it.on} data-tip={it.label} data-key={it.keys}
                initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SPRING, delay: (items.length - 1 - i) * 0.025 }}>
                {it.icon}
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <StackButton label="View controls" expanded={open} onClick={() => set(!open)} className="compass-btn">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="10" className="compass-ring" />
          <g ref={needle}>
            <path d="M12 3.6 L14.6 12 L9.4 12 Z" className="needle-n" />
            <path d="M12 20.4 L14.6 12 L9.4 12 Z" className="needle-s" />
            <circle cx="12" cy="12" r="1.3" className="needle-pin" />
          </g>
        </svg>
      </StackButton>
    </div>
  );
}

function CompassGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
      <path d="M12 4.5 L14.2 12 L9.8 12 Z" fill="var(--gold-hi)" />
      <path d="M12 19.5 L14.2 12 L9.8 12 Z" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

const SHORTCUTS: { keys: string[]; label: string; only3d?: boolean }[] = [
  { keys: ['1', '–', '5'], label: 'Inspect, terrain, state, control, fog' },
  { keys: ['[', ']'], label: 'Brush size' },
  { keys: ['L'], label: 'Layers' },
  { keys: ['F'], label: 'Fit the whole map' },
  { keys: ['+', '−'], label: 'Zoom (or scroll, or pinch)' },
  { keys: ['Q', 'E'], label: 'Turn left, right (or right-drag)', only3d: true },
  { keys: ['N'], label: 'Face north', only3d: true },
  { keys: ['T'], label: 'Look straight down', only3d: true },
  { keys: ['Space'], label: 'Hold and drag to pan' },
  { keys: ['Esc'], label: 'Close the panel' },
  { keys: ['Ctrl', 'K'], label: 'Search the atlas' },
  { keys: ['?'], label: 'This list' },
];

export function ShortcutsCard({ mode, onClose }: { mode: '3d' | '2d'; onClose: () => void }) {
  return (
    <>
      <header><h4>Keyboard</h4><button className="iconbtn sm" onClick={onClose} aria-label="Close keyboard shortcuts"><X size={14} /></button></header>
      <dl className="keys-list">
        {SHORTCUTS.filter((s) => !s.only3d || mode === '3d').map((s) => (
          <div key={s.label}>
            <dt>{s.keys.map((k) => (k === '–' ? <span key={k} className="faint">–</span> : <kbd key={k} className="kbd">{k}</kbd>))}</dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
