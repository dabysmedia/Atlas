import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { FilePlus2, FileText } from 'lucide-react';
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
  const exact = results.some((r) => r.title.toLowerCase() === q.trim().toLowerCase());
  const items = [
    ...results.map((r) => ({ kind: 'page' as const, ...r })),
    ...(q.trim() && !exact ? [{ kind: 'create' as const, id: '__create', title: q.trim(), category: '', snippet: '' }] : []),
  ];
  useEffect(() => { if (open) { setQ(''); setSel(0); } }, [open]);
  useEffect(() => setSel(0), [q]);

  const go = async (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
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
          <motion.div className="switcher-backdrop" style={{ zIndex: 299 }} onMouseDown={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} />
          <motion.div className="palette" initial={{ opacity: 0, y: -10, x: '-50%', scale: 0.98 }} animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
            exit={{ opacity: 0, y: -6, x: '-50%' }} transition={{ type: 'spring', stiffness: 500, damping: 34 }}>
            <input autoFocus placeholder="Find or create a page…" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
                else if (e.key === 'Escape') onClose();
              }} />
            <ul>
              {items.map((it, i) => (
                <li key={it.id} className={i === sel ? 'on' : ''} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); go(i); }}>
                  {it.kind === 'create' ? <FilePlus2 size={15} className="faint" /> : <FileText size={15} className="faint" />}
                  <div className="grow">
                    <div>{it.kind === 'create' ? <>Create page <b>&ldquo;{it.title}&rdquo;</b></> : it.title}</div>
                    {it.snippet && <div className="snip"><Snippet text={it.snippet} /></div>}
                  </div>
                  {it.kind === 'page' && <span className="faint" style={{ fontSize: 12 }}>{it.category}</span>}
                </li>
              ))}
              {!items.length && <li className="faint">No pages yet. Type a title to create one.</li>}
            </ul>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
