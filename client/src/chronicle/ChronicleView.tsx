import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Send } from 'lucide-react';
import { api, qk } from '../api';
import type { WorldEvent } from '../types';
import { useWorld } from '../world';
import { toastError } from '../components/toast';

const FILTERS = [
  { id: '', label: 'Everything' }, { id: 'note', label: 'GM notes' }, { id: 'meter', label: 'Meters' }, { id: 'claim', label: 'Claims' },
  { id: 'hex', label: 'Hexes' }, { id: 'token', label: 'Tokens' }, { id: 'roll', label: 'Rolls' }, { id: 'fog', label: 'Fog' }, { id: 'weather', label: 'Weather' },
];

export function ChronicleView() {
  const world = useWorld();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const q = useInfiniteQuery({
    queryKey: [...qk.events(world.id), kind],
    queryFn: ({ pageParam }) => api<WorldEvent[]>(`/api/worlds/${world.id}/events?limit=150${pageParam ? `&before=${pageParam}` : ''}${kind ? `&kind=${kind}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length === 150 ? last[last.length - 1].id : undefined),
  });
  const byDay = useMemo(() => {
    const m = new Map<number, WorldEvent[]>();
    for (const e of q.data?.pages.flat() ?? []) { if (!m.has(e.gameDay)) m.set(e.gameDay, []); m.get(e.gameDay)!.push(e); }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [q.data]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api(`/api/worlds/${world.id}/events`, { body: { summary: note.trim() } });
      setNote('');
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
    } catch (err) { toastError(err); }
  };

  return (
    <div className="pagewrap scroll">
      <div className="pagebody" style={{ maxWidth: 900 }}>
        <div className="pagehead"><h1>Chronicle</h1><span className="muted" style={{ marginBottom: 6 }}>Append-only history of {world.name}</span></div>
        <form className="row" onSubmit={add} style={{ marginBottom: 18 }}>
          <input className="input" placeholder={`Record something that happened on day ${world.currentDay}…`} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" disabled={!note.trim()}><Send size={14} /> Record</button>
        </form>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginBottom: 18 }}>
          {FILTERS.map((f) => <button key={f.id} className={`brush ${kind === f.id ? 'on' : ''}`} onClick={() => setKind(f.id)}>{f.label}</button>)}
        </div>
        {byDay.map(([day, evs]) => (
          <motion.div key={day} className="chron-day" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <div className="d">Day {day}</div>
            <div>
              {evs.map((e) => (
                <div key={e.id} className="chron-entry">
                  <span className="k">{e.kind.replace('.', ' ')}</span>
                  <span className="grow">{e.summary}{e.kind.startsWith('roll.') && typeof e.payload.text === 'string' && <span className="muted"> {e.payload.text}</span>}</span>
                  <span className="faint" style={{ fontSize: 11 }} title={new Date(e.createdAt).toLocaleString()}>{[e.actor !== 'gm' && e.actor, e.payload.rolled === true && 'rolled'].filter(Boolean).join(' · ')}</span>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
        {q.data && !byDay.length && <div className="empty">Nothing recorded yet.</div>}
        {q.hasNextPage && <button className="btn" style={{ marginTop: 14 }} onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load older</button>}
      </div>
    </div>
  );
}
