import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Castle, FilePlus2, FileText, MapPin, Shield } from 'lucide-react';
import { api, qk } from '../api';
import type { MapData } from '../types';
import { useWorld } from '../world';
import { Snippet, useCombinedSearch, useCreatePage } from '../wiki/usePages';
import { toastError } from './toast';

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const world = useWorld();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const results = useCombinedSearch(world.id, q);
  const create = useCreatePage(world.id);
  // Places come from the same map bundle the map view caches, so this is usually free.
  const mapQ = useQuery({ queryKey: qk.map(world.id), queryFn: () => api<MapData>(`/api/worlds/${world.id}/map`), enabled: open });
  const places = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const d = mapQ.data;
    if (!needle || !d) return [];
    const out: { kind: 'place'; id: string; title: string; category: string; snippet: string; focus: string; icon: 'faction' | 'settlement' | 'place' }[] = [];
    for (const f of d.factions) if (f.name.toLowerCase().includes(needle)) out.push({ kind: 'place', id: `f-${f.id}`, title: f.name, category: 'Faction', snippet: '', focus: `faction:${f.id}`, icon: 'faction' });
    for (const t of d.tokens) if (t.name.toLowerCase().includes(needle)) out.push({ kind: 'place', id: `t-${t.id}`, title: t.name, category: t.kind === 'city' || t.kind === 'outpost' ? 'Settlement' : 'On the map', snippet: '', focus: `token:${t.id}`, icon: t.kind === 'city' || t.kind === 'outpost' ? 'settlement' : 'place' });
    for (const h of d.hexes) if (h.name && h.name.toLowerCase().includes(needle) && !d.tokens.some((t) => t.hexId === h.id && t.name === h.name)) out.push({ kind: 'place', id: `h-${h.id}`, title: h.name, category: 'Hex', snippet: '', focus: `hex:${h.id}`, icon: 'place' });
    return out.slice(0, 6);
  }, [q, mapQ.data]);
  const exact = results.some((r) => r.title.toLowerCase() === q.trim().toLowerCase());
  const items = [
    ...places,
    ...results.map((r) => ({ kind: 'page' as const, ...r })),
    ...(q.trim() && !exact ? [{ kind: 'create' as const, id: '__create', title: q.trim(), category: '', snippet: '' }] : []),
  ];
  useEffect(() => { setQ(''); setSel(0); }, [open]);
  useEffect(() => setSel(0), [q]);

  const go = async (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    if (it.kind === 'place') { navigate(`/w/${world.id}/map?focus=${it.focus}`); return; }
    if (it.kind === 'create') {
      try {
        const page = await create.mutateAsync({ title: it.title });
        navigate(`/w/${world.id}/wiki/${page.id}`);
      } catch (e) { toastError(e); }
    } else navigate(`/w/${world.id}/wiki/${it.id}`);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="palette-backdrop" onMouseDown={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} />
          <motion.div className="palette" initial={{ opacity: 0, y: -10, x: '-50%', scale: 0.98 }} animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
            exit={{ opacity: 0, y: -6, x: '-50%' }} transition={{ type: 'spring', stiffness: 500, damping: 34 }}>
            <input autoFocus placeholder="Find a place, faction or page…" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
                else if (e.key === 'Escape') onClose();
              }} />
            <ul>
              {items.map((it, i) => (
                <li key={it.id} className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); go(i); }}>
                  {it.kind === 'create' ? <FilePlus2 size={15} className="faint" />
                    : it.kind === 'place' ? (it.icon === 'faction' ? <Shield size={15} className="faint" /> : it.icon === 'settlement' ? <Castle size={15} className="faint" /> : <MapPin size={15} className="faint" />)
                    : <FileText size={15} className="faint" />}
                  <div className="grow">
                    <div>{it.kind === 'create' ? <>Create page <b>&ldquo;{it.title}&rdquo;</b></> : it.title}</div>
                    {it.snippet && <div className="snip"><Snippet text={it.snippet} /></div>}
                  </div>
                  {it.kind !== 'create' && it.category && <span className="cat">{it.category}</span>}
                </li>
              ))}
              {!items.length && <li className="faint">Nothing yet. Type a title to create a page.</li>}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
