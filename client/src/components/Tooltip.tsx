import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Tip = { label: string; keys: string[]; x: number; y: number; side: Side; id: number };

const GAP = 10;
const OFFSET: Record<Side, { x?: number; y?: number }> = { top: { y: 5 }, bottom: { y: -5 }, left: { x: 5 }, right: { x: -5 } };

/**
 * One floating tip for every control marked `data-tip`: its label and, from `data-key`, its shortcut keys
 * (space-separated). The side comes from `data-tip-side` on the control or the nearest ancestor that sets it.
 * Mouse hover shows it after a beat; keyboard focus shows it at once; touch never does (the label is the aria-label).
 */
export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer = 0;
    let cur: HTMLElement | null = null;
    let seq = 0;
    let tipShown = false;
    const place = (el: HTMLElement) => {
      const label = el.dataset.tip;
      if (!label || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      let side = ((el.closest('[data-tip-side]') as HTMLElement | null)?.dataset.tipSide ?? 'top') as Side;
      // Flip when the preferred side has no room.
      if (side === 'top' && r.top < 44) side = 'bottom';
      else if (side === 'bottom' && r.bottom > window.innerHeight - 44) side = 'top';
      else if (side === 'right' && r.right > window.innerWidth - 160) side = 'left';
      else if (side === 'left' && r.left < 160) side = 'right';
      const x = side === 'left' ? r.left - GAP : side === 'right' ? r.right + GAP : r.left + r.width / 2;
      const y = side === 'top' ? r.top - GAP : side === 'bottom' ? r.bottom + GAP : r.top + r.height / 2;
      tipShown = true;
      setTip({ label, keys: (el.dataset.key ?? '').split(' ').filter(Boolean), x, y, side, id: ++seq });
    };
    const show = (el: HTMLElement, delay: number) => {
      window.clearTimeout(timer);
      cur = el;
      // Moving between neighbouring controls swaps the tip at once instead of waiting again.
      timer = window.setTimeout(() => place(el), tipShown ? 0 : delay);
    };
    const hide = () => { window.clearTimeout(timer); cur = null; tipShown = false; setTip(null); };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === cur) return;
      if (!el) { if (cur) { window.clearTimeout(timer); timer = window.setTimeout(hide, 80); cur = null; } return; }
      show(el, 380);
    };
    const focusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el && el.matches(':focus-visible')) { cur = el; window.clearTimeout(timer); place(el); }
    };
    const focusOut = (e: FocusEvent) => { if (cur && e.target === cur) hide(); };
    const down = () => hide();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('pointerover', over);
    window.addEventListener('focusin', focusIn);
    window.addEventListener('focusout', focusOut);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerover', over);
      window.removeEventListener('focusin', focusIn);
      window.removeEventListener('focusout', focusOut);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  return createPortal(
    <AnimatePresence>
      {tip && (
        // The anchor holds the position (its stylesheet transform pins the side); the inner card does the motion.
        <motion.div key={tip.id} className={`tip-anchor tip-${tip.side}`} style={{ left: tip.x, top: tip.y }} aria-hidden
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.12 }}>
          <motion.div className="tip" initial={{ scale: 0.94, ...OFFSET[tip.side] }} animate={{ scale: 1, x: 0, y: 0 }} transition={{ type: 'spring', stiffness: 620, damping: 34 }}>
            <span>{tip.label}</span>
            {tip.keys.map((k) => <kbd key={k} className="kbd">{k}</kbd>)}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
