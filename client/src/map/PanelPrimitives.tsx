import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, X } from 'lucide-react';
import type { TokenKind } from '../types';
import { markerSprite } from './markers';

// ---------------------------------------------------------------- shared pieces
export function Panel({ children, onClose, className = '' }: { children: ReactNode; onClose: () => void; className?: string }) {
  return (
    <motion.aside className={`panel inspector ${className}`} initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 28 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      onKeyDown={(e) => {
        // Escape closes; blur so map shortcuts work immediately even while the panel animates out.
        if (e.key === 'Escape') { (document.activeElement as HTMLElement | null)?.blur(); onClose(); } else e.stopPropagation();
      }}>
      {children}
    </motion.aside>
  );
}

/** A rendered still of the map around the subject; reads as the panel's illustration. */
export function PanelArt({ snap, deps, children, onClose, tint }: { snap: () => string | null; deps: unknown[]; children?: ReactNode; onClose: () => void; tint?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let timer = 0, raf = 0;
    const capture = () => {
      const next = snap();
      if (next) setSrc(next);
      else timer = window.setTimeout(() => { raf = requestAnimationFrame(capture); }, 100);
    };
    setSrc(null);
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(capture); });
    return () => { cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="panel-art" style={tint ? { ['--tint' as string]: tint } : undefined}>
      {src ? <img src={src} alt="" /> : <div className="panel-art-blank" />}
      <div className="panel-art-shade" />
      <button className="iconbtn panel-close" onClick={onClose} aria-label="Close panel"><X size={15} /></button>
      {children}
    </div>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="psec">
      <header><h4>{title}</h4>{action}</header>
      {children}
    </section>
  );
}

/** A labeled value that turns into a picker on click. */
export function Prop({ label, children, value }: { label: string; value: ReactNode; children?: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);
  return (
    <div className={`prop ${open ? 'open' : ''}`} ref={ref}>
      <span className="prop-label">{label}</span>
      {children ? (
        <button className="prop-value" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Change ${label.toLowerCase()}`}>
          {value}<ChevronDown size={13} className="faint" />
        </button>
      ) : <span className="prop-value static">{value}</span>}
      {open && children && <div className="prop-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Diamond({ color, size = 10 }: { color: string; size?: number }) {
  return <span className="diamond" style={{ background: color, width: size, height: size }} />;
}

export function MarkerIcon({ kind, color, size = 26, major = false }: { kind: TokenKind; color: string; size?: number; major?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = markerSprite(kind, color, size * 0.42, dpr, major);
    c.width = s.canvas.width; c.height = s.canvas.height;
    c.getContext('2d')!.drawImage(s.canvas, 0, 0);
  }, [kind, color, size, major]);
  return <canvas ref={ref} className="marker-icon" style={{ width: size * 1.25, height: size * 1.25 }} />;
}
