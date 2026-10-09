import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, qk } from '../api';
import type { WorldSummary } from '../types';
import { Dialog } from './Dialog';
import { toast, toastError } from './toast';

const SIZES = { small: [24, 18], medium: [40, 30], large: [64, 48] } as const;

export function WorldSwitcher({ open, onClose, currentId, forced }: { open: boolean; onClose: () => void; currentId?: string; forced?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const worlds = useQuery({ queryKey: qk.worlds, queryFn: () => api<WorldSummary[]>('/api/worlds'), enabled: open });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<WorldSummary | null>(null);
  const [deleting, setDeleting] = useState<WorldSummary | null>(null);

  useEffect(() => {
    if (!open || forced) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creating && !renaming && !deleting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, forced, onClose, creating, renaming, deleting]);

  const choose = (w: WorldSummary) => {
    onClose();
    if (w.id !== currentId) navigate(`/w/${w.id}/map`);
  };

  const list = worlds.data ?? [];
  return (
    <>
      <AnimatePresence>
        {open && (
          <>
            <motion.div key="bd" className="switcher-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            <motion.div key="sw" className="switcher scroll" onMouseDown={(e) => { if (e.target === e.currentTarget && !forced) onClose(); }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
              <div className="switcher-inner">
                <motion.div className="row" initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 28 }}>
                  <div className="grow">
                    <h2 className="display">Your worlds</h2>
                    <span className="muted">Each world keeps its own map, lore, factions and campaigns.</span>
                  </div>
                  {!forced && <button className="btn ghost icon" onClick={onClose} aria-label="Close"><X size={18} /></button>}
                </motion.div>
                <motion.div className="world-grid" initial="hidden" animate="show"
                  variants={{ show: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } } }}>
                  <AnimatePresence mode="popLayout">
                    {list.map((w) => (
                      <motion.div key={w.id} layout variants={cardVariants} exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                        whileHover={{ y: -4 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }}>
                        <div role="button" tabIndex={0} className={`world-card ${w.id === currentId ? 'current' : ''}`}
                          onClick={() => choose(w)} onKeyDown={(e) => { if (e.key === 'Enter') choose(w); }} style={{ ['--accent' as string]: w.accent }}>
                          <div className="art">{w.artVersion != null
                            ? <img src={`/api/worlds/${w.id}/map/art?v=${w.artVersion}`} alt="" loading="lazy" />
                            : <WorldArt world={w} />}</div>
                          <div className="menu">
                            <button className="btn sm icon" title="Rename" onClick={(e) => { e.stopPropagation(); setRenaming(w); }}><Pencil size={13} /></button>
                            <button className="btn sm icon danger" title="Delete" onClick={(e) => { e.stopPropagation(); setDeleting(w); }}><Trash2 size={13} /></button>
                          </div>
                          <div className="body">
                            <div className="title">{w.name}</div>
                            <div className="muted" style={{ fontSize: 13, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              {w.description || <span className="faint">No description yet.</span>}
                            </div>
                            <div className="stats">
                              <span>Day {w.currentDay}</span><span>{w.pageCount} pages</span><span>{w.factionCount} factions</span><span>{w.hexCount} hexes</span>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                    <motion.div key="new" layout variants={cardVariants} whileHover={{ y: -4 }}>
                      <button className="world-card new" style={{ width: '100%' }} onClick={() => setCreating(true)}>
                        <Plus size={26} />
                        <span style={{ marginTop: 6 }}>New world</span>
                      </button>
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <CreateWorldDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => {
        setCreating(false); onClose(); navigate(`/w/${id}/map`);
      }} />
      <RenameDialog world={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog world={deleting} onClose={() => setDeleting(null)} onDeleted={(id) => {
        setDeleting(null);
        qc.removeQueries({ queryKey: ['w', id] });
        if (id === currentId) navigate('/');
      }} />
    </>
  );
}

const cardVariants = {
  hidden: { opacity: 0, y: 18, scale: 0.96 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
};

function CreateWorldDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'blank' | 'demo' | 'newworld'>('blank');
  const [size, setSize] = useState<keyof typeof SIZES>('medium');
  const [orientation, setOrientation] = useState<'flat' | 'pointy'>('flat');
  useEffect(() => { if (open) { setName(''); setTemplate('blank'); } }, [open]);
  const create = useMutation({
    mutationFn: () => api<{ id: string }>('/api/worlds', {
      body: { name: name.trim() || (template === 'demo' ? 'The Sundered Reach' : template === 'newworld' ? 'The New World' : 'New World'), template, cols: SIZES[size][0], rows: SIZES[size][1], orientation },
    }),
    onSuccess: (w) => { qc.invalidateQueries({ queryKey: qk.worlds }); toast('World created'); onCreated(w.id); },
    onError: toastError,
  });
  return (
    <Dialog open={open} onClose={onClose} title="New world">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="field">
          <label className="label">Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Drowned Kingdoms" />
        </div>
        <div className="field">
          <label className="label">Start from</label>
          <div className="seg">
            <button type="button" className={template === 'blank' ? 'on' : ''} onClick={() => setTemplate('blank')}>Blank canvas</button>
            <button type="button" className={template === 'demo' ? 'on' : ''} onClick={() => setTemplate('demo')}>Demo world</button>
            <button type="button" className={template === 'newworld' ? 'on' : ''} onClick={() => setTemplate('newworld')}>The New World lore</button>
          </div>
          {template === 'newworld' && <p className="faint" style={{ margin: '8px 0 0', fontSize: 12.5 }}>Imports the bundled setting document as wiki pages, seven factions and an unclaimed island. Each import is a separate world you can delete.</p>}
        </div>
        {template === 'blank' && (
          <div className="row" style={{ gap: 18 }}>
            <div className="field">
              <label className="label">Grid size</label>
              <div className="seg">
                {(Object.keys(SIZES) as (keyof typeof SIZES)[]).map((k) => (
                  <button type="button" key={k} className={size === k ? 'on' : ''} onClick={() => setSize(k)}>{SIZES[k][0]}×{SIZES[k][1]}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">Hexes</label>
              <div className="seg">
                <button type="button" className={orientation === 'flat' ? 'on' : ''} onClick={() => setOrientation('flat')}>Flat top</button>
                <button type="button" className={orientation === 'pointy' ? 'on' : ''} onClick={() => setOrientation('pointy')}>Pointy top</button>
              </div>
            </div>
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create world'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ world, onClose }: { world: WorldSummary | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => { if (world) { setName(world.name); setDescription(world.description); } }, [world]);
  const save = useMutation({
    mutationFn: () => api(`/api/worlds/${world!.id}`, { method: 'PATCH', body: { name, description } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.worlds });
      qc.invalidateQueries({ queryKey: qk.world(world!.id) });
      onClose();
    },
    onError: toastError,
  });
  return (
    <Dialog open={!!world} onClose={onClose} title="Rename world">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
        <div className="field"><label className="label">Name</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label className="label">Description</label><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || save.isPending}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ world, onClose, onDeleted }: { world: WorldSummary | null; onClose: () => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState('');
  useEffect(() => setConfirm(''), [world]);
  const del = useMutation({
    mutationFn: () => api(`/api/worlds/${world!.id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.worlds }); toast(`Deleted ${world!.name}`); onDeleted(world!.id); },
    onError: toastError,
  });
  return (
    <Dialog open={!!world} onClose={onClose} title="Delete world">
      <p className="muted" style={{ marginTop: 0 }}>
        This permanently deletes <b style={{ color: 'var(--text)' }}>{world?.name}</b> with its map, {world?.pageCount} wiki pages, factions,
        campaigns and history. It cannot be undone.
      </p>
      <label className="label">Type the world&rsquo;s name to confirm</label>
      <input className="input" autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={confirm.trim() !== world?.name.trim() || del.isPending} onClick={() => del.mutate()}>
          <Trash2 size={14} /> Delete forever
        </button>
      </div>
    </Dialog>
  );
}

/** Procedural thumbnail: a drifting field of hexes colored by the world's actual terrain mix. */
function WorldArt({ world }: { world: WorldSummary }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    let seed = [...world.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const colorOf = (k: string) => world.terrainTypes.find((t) => t.key === k)?.color ?? '#2a2f38';
    const mix = world.terrainMix.length ? world.terrainMix : [{ terrain: 'unknown', n: 1 }];
    const total = mix.reduce((s, m) => s + m.n, 0);
    const pick = () => { let r = rnd() * total; for (const m of mix) { if ((r -= m.n) < 0) return m.terrain; } return mix[0].terrain; };
    const s = 13, hw = s * 1.5, hh = s * Math.sqrt(3);
    // Blobby coherence: neighbors often reuse the previous color.
    let prev = pick();
    for (let col = -1; col < W / hw + 1; col++) {
      for (let row = -1; row < H / hh + 1; row++) {
        const terrain = rnd() < 0.55 ? prev : pick();
        prev = terrain;
        const x = col * hw, y = row * hh + (col & 1 ? hh / 2 : 0);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; ctx.lineTo(x + s * Math.cos(a), y + s * Math.sin(a)); }
        ctx.closePath();
        ctx.fillStyle = colorOf(terrain);
        ctx.globalAlpha = terrain === 'unknown' ? 0.6 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(25,28,35,0)');
    g.addColorStop(1, 'rgba(25,28,35,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }, [world]);
  return <canvas ref={ref} />;
}
