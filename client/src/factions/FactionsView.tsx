import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, Check, ChevronDown, Dices, History, Plus, Trash2, X } from 'lucide-react';
import { api, qk } from '../api';
import type { Faction, FactionMeter, MeterBand, MeterChange, MeterDef, RollEntry, RollTable } from '../types';
import { useWorld } from '../world';
import { isLowTone } from '../../../shared/meters';
import { usePageIndex } from '../wiki/usePages';
import { Dialog } from '../components/Dialog';
import { toast, toastError } from '../components/toast';
import { Diamond } from '../map/panels';

const PALETTE = ['#c0392b', '#3b6fd4', '#2e9e6a', '#8e44ad', '#d68910', '#16a3b8', '#b8466e', '#7f8c8d', '#c2a83e', '#5d6dbe'];

export function FactionsView() {
  const [tab, setTab] = useState<'factions' | 'meters' | 'tables'>('factions');
  return (
    <div className="pagewrap scroll">
      <div className="pagebody">
        <div className="pagehead"><h1>Factions</h1></div>
        <div className="tabs">
          <button className={tab === 'factions' ? 'on' : ''} onClick={() => setTab('factions')}>Factions</button>
          <button className={tab === 'meters' ? 'on' : ''} onClick={() => setTab('meters')}>Meter definitions</button>
          <button className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>Roll tables</button>
        </div>
        {tab === 'factions' && <FactionList />}
        {tab === 'meters' && <MeterDefs />}
        {tab === 'tables' && <RollTables />}
      </div>
    </div>
  );
}

export function useFactionData() {
  const world = useWorld();
  const factions = useQuery({ queryKey: qk.factions(world.id), queryFn: () => api<Faction[]>(`/api/worlds/${world.id}/factions`) });
  const meters = useQuery({ queryKey: qk.meters(world.id), queryFn: () => api<MeterDef[]>(`/api/worlds/${world.id}/meters`) });
  const tables = useQuery({ queryKey: qk.rollTables(world.id), queryFn: () => api<RollTable[]>(`/api/worlds/${world.id}/roll-tables`) });
  return { factions: factions.data, meters: meters.data, tables: tables.data, loading: factions.isLoading || meters.isLoading };
}

// ---------------------------------------------------------------- factions
function FactionList() {
  const world = useWorld();
  const qc = useQueryClient();
  const { factions, meters, tables, loading } = useFactionData();
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const openId = params.get('f');
  const setOpen = (id: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('f', id); else n.delete('f'); return n; }, { replace: true });
  // Arriving from the map with ?f= scrolls the opened faction into view.
  useEffect(() => {
    if (!openId || loading) return;
    const t = setTimeout(() => document.getElementById(`faction-${openId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [openId, loading]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading) return null;
  return (
    <>
      <div className="faction-list">
        <AnimatePresence>
          {(factions ?? []).map((f, i) => (
            <motion.div key={f.id} layout="position" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }} exit={{ opacity: 0, scale: 0.98 }}>
              <FactionRow faction={f} meters={meters ?? []} tables={tables ?? []} open={openId === f.id} onToggle={() => setOpen(openId === f.id ? null : f.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
        <button className="btn ghost" style={{ alignSelf: 'flex-start', marginTop: 4 }} onClick={() => setCreating(true)}>
          <Plus size={16} /> New faction
        </button>
      </div>
      <NewFactionDialog open={creating} onClose={() => setCreating(false)} meters={meters ?? []} onCreated={() => {
        qc.invalidateQueries({ queryKey: qk.factions(world.id) });
        qc.invalidateQueries({ queryKey: qk.map(world.id) });
      }} />
    </>
  );
}

function NewFactionDialog({ open, onClose, meters, onCreated }: { open: boolean; onClose: () => void; meters: MeterDef[]; onCreated: () => void }) {
  const world = useWorld();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[2]);
  const [sig, setSig] = useState('');
  const create = useMutation({
    mutationFn: () => api(`/api/worlds/${world.id}/factions`, { body: { name, color, signatureMeterId: sig || null } }),
    onSuccess: () => { onCreated(); onClose(); setName(''); toast('Faction founded'); },
    onError: toastError,
  });
  const sigs = meters.filter((m) => m.kind === 'signature');
  return (
    <Dialog open={open} onClose={onClose} title="New faction">
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <div className="field"><label className="label">Name</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label className="label">Color</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {PALETTE.map((c) => (
              <button type="button" key={c} onClick={() => setColor(c)} aria-label={c}
                style={{ width: 24, height: 24, borderRadius: 6, background: c, border: color === c ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer' }} />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 30, height: 26, background: 'none', border: 0 }} />
          </div>
        </div>
        <div className="field">
          <label className="label">Signature meter</label>
          <select className="select" value={sig} onChange={(e) => setSig(e.target.value)}>
            <option value="">None yet</option>
            {sigs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {!sigs.length && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Add signature meters (Zeal, Grandeur…) under Meter definitions.</div>}
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || create.isPending}>Create</button>
        </div>
      </form>
    </Dialog>
  );
}

function FactionRow({ faction, meters, tables, open, onToggle }: { faction: Faction; meters: MeterDef[]; tables: RollTable[]; open: boolean; onToggle: () => void }) {
  const world = useWorld();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pages = usePageIndex(world.id);
  const [name, setName] = useState(faction.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = async (p: Partial<Faction>) => {
    qc.setQueryData<Faction[]>(qk.factions(world.id), (xs) => xs?.map((f) => (f.id === faction.id ? { ...f, ...p } : f)));
    try {
      await api(`/api/worlds/${world.id}/factions/${faction.id}`, { method: 'PATCH', body: p });
      if ('signatureMeterId' in p) qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      if ('color' in p || 'name' in p) qc.invalidateQueries({ queryKey: qk.map(world.id) });
    } catch (e) { toastError(e); qc.invalidateQueries({ queryKey: qk.factions(world.id) }); }
  };
  const del = async () => {
    try {
      await api(`/api/worlds/${world.id}/factions/${faction.id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      qc.invalidateQueries({ queryKey: qk.map(world.id) });
    } catch (e) { toastError(e); }
  };
  const sigs = meters.filter((m) => m.kind === 'signature');
  // Collapsed rows show the signature meter first, then the next bounded meters.
  const summary = faction.meters
    .map((fm) => ({ fm, def: meters.find((m) => m.id === fm.meterId) }))
    .filter((x): x is { fm: FactionMeter; def: MeterDef } => !!x.def && x.def.min != null && x.def.max != null)
    .sort((a, b) => Number(b.def.id === faction.signatureMeterId) - Number(a.def.id === faction.signatureMeterId))
    .slice(0, 3);
  return (
    <div className={`faction-row ${open ? 'open' : ''}`} id={`faction-${faction.id}`}>
      <button className="fr-head" onClick={onToggle} aria-expanded={open}>
        <span className="fr-crest"><Diamond color={faction.color} size={18} /></span>
        <div className="grow">
          <div className="fr-name">{faction.name}</div>
          <div className="fr-sub">{faction.claims.control ?? 0} hexes held{faction.claims.contested ? ` · ${faction.claims.contested} contested` : ''}</div>
        </div>
        <div className="fr-meters">
          {summary.map(({ fm, def }) => (
            <div key={def.id} className="fr-meter" title={fm.band?.label}>
              <span>{def.name} <b className={`tone-${fm.band?.tone ?? 'neutral'}`}>{fm.value}</b></span>
              <div className="mini-bar"><span className={`bg-${fm.band?.tone ?? 'neutral'}`} style={{ width: `${Math.max(2, ((fm.value - def.min!) / (def.max! - def.min!)) * 100)}%` }} /></div>
            </div>
          ))}
        </div>
        <ChevronDown size={18} className="fr-chev" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} style={{ overflow: 'hidden' }}>
            <div className="card" style={{ border: 0, borderRadius: 0, background: 'transparent', boxShadow: 'none', borderTop: '1px solid var(--line-soft)' }}>
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 14 }}>
              <label className="row" style={{ gap: 8 }}>
                <span className="label" style={{ margin: 0 }}>Name</span>
                <input className="input" style={{ width: 220, padding: '4px 8px' }} value={name} aria-label="Faction name"
                  onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== faction.name && patch({ name: name.trim() })}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              </label>
              <label className="row" style={{ gap: 8, position: 'relative', cursor: 'pointer' }} title="Faction color">
                <span className="label" style={{ margin: 0 }}>Color</span>
                <span className="swatch" style={{ background: faction.color, width: 22, height: 22, borderRadius: 5 }} />
                <input type="color" value={faction.color} onChange={(e) => patch({ color: e.target.value })} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
              </label>
              <label className="row" style={{ gap: 8 }}>
                <span className="label" style={{ margin: 0 }}>Signature</span>
                <select className="select" style={{ width: 'auto', padding: '3px 8px', fontSize: 12.5 }} value={faction.signatureMeterId ?? ''}
                  onChange={(e) => patch({ signatureMeterId: e.target.value || null })}>
                  <option value="">None</option>
                  {sigs.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <div className="spacer" />
              {faction.wikiPageId
                ? <button className="btn ghost sm" title="Open wiki page" onClick={() => navigate(`/w/${world.id}/wiki/${faction.wikiPageId}`)}><BookOpen size={14} /> Wiki</button>
                : (
                  <select className="select" style={{ width: 'auto', padding: '3px 8px', fontSize: 12.5 }} title="Link a wiki page" value="" onChange={(e) => e.target.value && patch({ wikiPageId: e.target.value })}>
                    <option value="">Link wiki page…</option>
                    {(pages.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                )}
              <button className="btn ghost icon danger" title="Delete faction" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /></button>
            </div>
            <div className="card-body">
              {faction.meters.map((fm) => {
                const def = meters.find((m) => m.id === fm.meterId);
                if (!def) return null;
                const table = fm.band ? tables.find((t) => t.factionId === faction.id && t.meterId === def.id && t.band === fm.band!.label) : undefined;
                return <MeterRow key={fm.meterId} faction={faction} def={def} fm={fm} table={table} />;
              })}
            </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete faction">
        <p className="muted" style={{ marginTop: 0 }}>Delete {faction.name}? Its claims, meter values and history are removed; borders redraw without it.</p>
        <div className="actions">
          <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn danger" onClick={() => { setConfirmDelete(false); del(); }}><Trash2 size={14} /> Delete</button>
        </div>
      </Dialog>
    </div>
  );
}

function MeterRow({ faction, def, fm, table }: { faction: Faction; def: MeterDef; fm: FactionMeter; table?: RollTable }) {
  const world = useWorld();
  const qc = useQueryClient();
  const [cause, setCause] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const history = useQuery({
    queryKey: qk.meterHistory(world.id, faction.id, def.id), enabled: showHistory,
    queryFn: () => api<MeterChange[]>(`/api/worlds/${world.id}/factions/${faction.id}/meters/${def.id}/history`),
  });
  const set = useMutation({
    mutationFn: (b: { value?: number; delta?: number }) =>
      api<{ value: number; band: MeterBand | null }>(`/api/worlds/${world.id}/factions/${faction.id}/meters/${def.id}`, { body: { ...b, cause } }),
    onSuccess: (r) => {
      qc.setQueryData<Faction[]>(qk.factions(world.id), (xs) => xs?.map((f) => (f.id !== faction.id ? f : {
        ...f, meters: f.meters.map((m) => (m.meterId === def.id ? { ...m, value: r.value, band: r.band, isSet: true } : m)),
      })));
      qc.invalidateQueries({ queryKey: qk.meterHistory(world.id, faction.id, def.id) });
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
      setCause('');
    },
    onError: toastError,
  });
  const roll = useMutation({
    mutationFn: () => api<{ entry: RollEntry }>(`/api/worlds/${world.id}/roll-tables/${table!.id}/roll`, { method: 'POST', body: {} }),
    onSuccess: (r) => { toast(`${r.entry.kind === 'calamity' ? '⚠ ' : ''}${r.entry.title}: ${r.entry.text}`); qc.invalidateQueries({ queryKey: qk.events(world.id) }); },
    onError: toastError,
  });

  const bounded = def.min != null && def.max != null;
  const pct = bounded ? ((fm.value - def.min!) / (def.max! - def.min!)) * 100 : 0;
  const tone = fm.band?.tone ?? 'neutral';
  const step = bounded ? [-5, -1, 1, 5] : [-100, -10, 10, 100];
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

  return (
    <div className="meter">
      <div className="top">
        <span className="name">{def.name}</span>
        {def.kind === 'signature' && <span className="chip" style={{ fontSize: 10, padding: '0 6px' }}>signature</span>}
        {fm.band && <span className={`tone-${tone}`} style={{ fontSize: 12, fontWeight: 600 }}>{fm.band.label}</span>}
        <div className="spacer" />
        {table && isLowTone(fm.band?.tone) && (
          <button className="btn sm" onClick={() => roll.mutate()} title={`Roll on ${table.name}`}><Dices size={13} /> Roll</button>
        )}
        <button className={`btn ghost sm icon ${showHistory ? 'on' : ''}`} onClick={() => setShowHistory(!showHistory)} title="Trace changes"><History size={13} /></button>
        {editing !== null ? (
          <input className="input val" autoFocus style={{ width: 80, padding: '2px 6px', textAlign: 'right' }} value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => { const v = Number(editing); if (editing.trim() !== '' && !Number.isNaN(v) && v !== fm.value) set.mutate({ value: v }); setEditing(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
        ) : (
          <button className={`val tone-${bounded ? tone : 'neutral'}`} style={{ background: 'none', border: 0, cursor: 'text' }} title="Click to set exactly"
            onClick={() => setEditing(String(fm.value))}>
            <motion.span key={fm.value} initial={{ opacity: 0.3, y: -4 }} animate={{ opacity: 1, y: 0 }}>{fmt(fm.value)}</motion.span>
          </button>
        )}
      </div>
      {bounded && (
        <div className="bar">
          <motion.div className={`fill bg-${tone}`} initial={false} animate={{ width: `${Math.max(0, Math.min(100, pct))}%` }} transition={{ type: 'spring', stiffness: 200, damping: 26 }} />
          {def.bands.map((b) => <span key={b.label} className="tick" style={{ left: `${((b.min - def.min!) / (def.max! - def.min!)) * 100}%` }} title={b.label} />)}
        </div>
      )}
      <div className="adj">
        <input className="input" style={{ padding: '3px 8px', fontSize: 12 }} placeholder={`Cause (logged on day ${world.currentDay})`} value={cause}
          onChange={(e) => setCause(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
        {step.map((d) => (
          <button key={d} className="btn sm" style={{ minWidth: 38, justifyContent: 'center' }} disabled={set.isPending} onClick={() => set.mutate({ delta: d })}>
            {d > 0 ? `+${d}` : d}
          </button>
        ))}
      </div>
      <AnimatePresence>
        {showHistory && (
          <motion.div className="history scroll" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <table>
              <tbody>
                {(history.data ?? []).map((h) => (
                  <tr key={h.id}>
                    <td className="num faint">Day {h.gameDay}</td>
                    <td className="num">{h.oldValue == null ? '' : `${fmt(h.oldValue)} → `}<b>{fmt(h.newValue)}</b></td>
                    <td>{h.cause}{h.source !== 'gm' && <span className="faint"> ({h.source})</span>}</td>
                  </tr>
                ))}
                {history.data && !history.data.length && <tr><td className="faint">No changes yet.</td></tr>}
              </tbody>
            </table>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- meter definitions
function MeterDefs() {
  const world = useWorld();
  const qc = useQueryClient();
  const { meters } = useFactionData();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<MeterDef['kind']>('signature');
  const refresh = () => { qc.invalidateQueries({ queryKey: qk.meters(world.id) }); qc.invalidateQueries({ queryKey: qk.factions(world.id) }); };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const bounded = kind !== 'resource';
    try {
      await api(`/api/worlds/${world.id}/meters`, {
        body: {
          name: name.trim(), kind, min: bounded ? 0 : null, max: bounded ? 100 : null, defaultValue: bounded ? 60 : 0,
          bands: bounded ? [
            { label: 'High', min: 75, tone: 'good' }, { label: 'Steady', min: 50, tone: 'neutral' },
            { label: 'Eroding', min: 25, tone: 'warn' }, { label: 'Broken', min: 0, tone: 'dire' },
          ] : [],
        },
      });
      setName(''); refresh();
    } catch (err) { toastError(err); }
  };
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        <b>Core</b> meters apply to every faction. <b>Resource</b> meters are tallies like Treasury. Each faction picks exactly one <b>signature</b> meter.
        Bands start at their minimum value and run up to the next band; the warn, bad and dire bands are the ones that offer roll tables.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        {(meters ?? []).map((m) => <MeterDefCard key={m.id} def={m} onChange={refresh} />)}
      </div>
      <form className="row" style={{ marginTop: 16 }} onSubmit={add}>
        <input className="input" style={{ maxWidth: 260 }} placeholder="New meter name (e.g. Attunement)" value={name} onChange={(e) => setName(e.target.value)} />
        <select className="select" style={{ width: 140 }} value={kind} onChange={(e) => setKind(e.target.value as MeterDef['kind'])}>
          <option value="signature">Signature</option><option value="core">Core</option><option value="resource">Resource</option>
        </select>
        <button className="btn primary" disabled={!name.trim()}><Plus size={14} /> Add meter</button>
      </form>
    </>
  );
}

function MeterDefCard({ def, onChange }: { def: MeterDef; onChange: () => void }) {
  const world = useWorld();
  const [d, setD] = useState(def);
  const dirty = JSON.stringify(d) !== JSON.stringify(def);
  const save = async () => {
    try {
      await api(`/api/worlds/${world.id}/meters/${def.id}`, {
        method: 'PATCH',
        body: { name: d.name, min: d.min, max: d.max, defaultValue: d.defaultValue, bands: d.bands, description: d.description },
      });
      onChange(); toast(`${d.name} saved`);
    } catch (e) { toastError(e); }
  };
  const del = async () => {
    if (!window.confirm(`Delete the ${def.name} meter from this world? Every faction's ${def.name} value and history goes with it.`)) return;
    try { await api(`/api/worlds/${world.id}/meters/${def.id}`, { method: 'DELETE' }); onChange(); } catch (e) { toastError(e); }
  };
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return (
    <div className="card">
      <div className="card-head">
        <input className="input bare display grow" style={{ fontSize: 17, fontWeight: 600 }} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        <span className="chip">{def.kind}</span>
        <button className="btn ghost icon danger" onClick={del} title="Delete meter"><Trash2 size={14} /></button>
      </div>
      <div className="card-body">
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div><label className="label">Min</label><input className="input" style={{ width: 90 }} value={d.min ?? ''} onChange={(e) => setD({ ...d, min: num(e.target.value) })} /></div>
          <div><label className="label">Max</label><input className="input" style={{ width: 90 }} value={d.max ?? ''} onChange={(e) => setD({ ...d, max: num(e.target.value) })} /></div>
          <div><label className="label">Starts at</label><input className="input" style={{ width: 90 }} value={d.defaultValue} onChange={(e) => setD({ ...d, defaultValue: Number(e.target.value) || 0 })} /></div>
          <div className="grow"><label className="label">Description</label><input className="input" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
        </div>
        <label className="label" style={{ marginTop: 14 }}>Bands</label>
        {d.bands.map((b, i) => (
          <div key={i} className="row" style={{ marginBottom: 4 }}>
            <input className="input" style={{ maxWidth: 200 }} value={b.label} onChange={(e) => setD({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <span className="faint">from</span>
            <input className="input" style={{ width: 80 }} value={b.min} onChange={(e) => setD({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) || 0 } : x)) })} />
            <select className={`select tone-${b.tone}`} style={{ width: 110 }} value={b.tone} onChange={(e) => setD({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, tone: e.target.value as MeterBand['tone'] } : x)) })}>
              {['good', 'neutral', 'warn', 'bad', 'dire'].map((t) => <option key={t}>{t}</option>)}
            </select>
            <button className="btn ghost sm icon" onClick={() => setD({ ...d, bands: d.bands.filter((_, j) => j !== i) })}><X size={13} /></button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn ghost sm" onClick={() => setD({ ...d, bands: [...d.bands, { label: 'New band', min: 0, tone: 'neutral' }] })}><Plus size={13} /> Band</button>
          <div className="spacer" />
          {dirty && <button className="btn ghost sm" onClick={() => setD(def)}>Revert</button>}
          <button className="btn primary sm" disabled={!dirty} onClick={save}><Check size={13} /> Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- roll tables
function RollTables() {
  const world = useWorld();
  const qc = useQueryClient();
  const { factions, meters, tables } = useFactionData();
  const [name, setName] = useState('');
  const [factionId, setFactionId] = useState('');
  const [meterId, setMeterId] = useState('');
  const [band, setBand] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: qk.rollTables(world.id) });
  const meter = meters?.find((m) => m.id === meterId);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/worlds/${world.id}/roll-tables`, { body: { name: name.trim(), factionId: factionId || null, meterId: meterId || null, band: band || null } });
      setName(''); refresh();
    } catch (err) { toastError(err); }
  };
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Weighted tables tied to a faction&rsquo;s meter band. Entries you write are canon. Entries marked AI stay unapproved, and are never rolled, until you approve them.
      </p>
      <div style={{ display: 'grid', gap: 16 }}>
        {(tables ?? []).map((t) => <RollTableCard key={t.id} table={t} factionName={factions?.find((f) => f.id === t.factionId)?.name}
          meterName={meters?.find((m) => m.id === t.meterId)?.name} onChange={refresh} />)}
        {tables && !tables.length && <div className="empty">No roll tables yet.</div>}
      </div>
      <form className="card" style={{ marginTop: 18 }} onSubmit={create}>
        <div className="card-head"><b>New roll table</b></div>
        <div className="card-body row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="grow" style={{ minWidth: 200 }}><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Valcourt: Pride Wounded" /></div>
          <div><label className="label">Faction</label>
            <select className="select" value={factionId} onChange={(e) => setFactionId(e.target.value)}><option value="">Any</option>{factions?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
          <div><label className="label">Meter</label>
            <select className="select" value={meterId} onChange={(e) => { setMeterId(e.target.value); setBand(''); }}><option value="">None</option>{meters?.filter((m) => m.bands.length).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
          <div><label className="label">Band</label>
            <select className="select" value={band} onChange={(e) => setBand(e.target.value)} disabled={!meter}><option value="">Any</option>{meter?.bands.map((b) => <option key={b.label}>{b.label}</option>)}</select></div>
          <button className="btn primary" disabled={!name.trim()}><Plus size={14} /> Create</button>
        </div>
      </form>
    </>
  );
}

function RollTableCard({ table, factionName, meterName, onChange }: { table: RollTable; factionName?: string; meterName?: string; onChange: () => void }) {
  const world = useWorld();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<RollEntry['kind']>('event');
  const [weight, setWeight] = useState(1);
  const [last, setLast] = useState<string | null>(null);
  const totalApproved = table.entries.filter((e) => e.approved).reduce((s, e) => s + e.weight, 0);
  const patchEntry = async (id: string, p: Partial<RollEntry>) => {
    try { await api(`/api/worlds/${world.id}/roll-entries/${id}`, { method: 'PATCH', body: p }); onChange(); qc.invalidateQueries({ queryKey: qk.events(world.id) }); } catch (e) { toastError(e); }
  };
  const delEntry = async (id: string) => { try { await api(`/api/worlds/${world.id}/roll-entries/${id}`, { method: 'DELETE' }); onChange(); } catch (e) { toastError(e); } };
  const add = async (source: 'gm' | 'ai' = 'gm') => {
    if (!title.trim()) return;
    try {
      await api(`/api/worlds/${world.id}/roll-tables/${table.id}/entries`, { body: { title: title.trim(), text, kind, weight, source } });
      setTitle(''); setText(''); setWeight(1); onChange();
    } catch (e) { toastError(e); }
  };
  const roll = async () => {
    try {
      const r = await api<{ entry: RollEntry }>(`/api/worlds/${world.id}/roll-tables/${table.id}/roll`, { method: 'POST', body: {} });
      setLast(r.entry.id); qc.invalidateQueries({ queryKey: qk.events(world.id) });
      toast(`Rolled: ${r.entry.title}`);
    } catch (e) { toastError(e); }
  };
  const delTable = async () => {
    if (!window.confirm(`Delete the table "${table.name}" and its ${table.entries.length} entries?`)) return;
    try { await api(`/api/worlds/${world.id}/roll-tables/${table.id}`, { method: 'DELETE' }); onChange(); } catch (e) { toastError(e); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <div className="grow">
          <b className="display" style={{ fontSize: 17 }}>{table.name}</b>
          <div className="faint" style={{ fontSize: 12 }}>{[factionName, meterName, table.band].filter(Boolean).join(' · ') || 'General'}</div>
        </div>
        <button className="btn" onClick={roll} disabled={!totalApproved}><Dices size={14} /> Roll</button>
        <button className="btn ghost icon danger" onClick={delTable} title="Delete table"><Trash2 size={14} /></button>
      </div>
      <table className="table">
        <thead><tr><th style={{ width: 70 }}>Weight</th><th style={{ width: 90 }}>Kind</th><th>Entry</th><th style={{ width: 110 }}>Approved</th><th style={{ width: 40 }} /></tr></thead>
        <tbody>
          {table.entries.map((e) => (
            <tr key={e.id} className={e.approved ? '' : 'unapproved'} style={last === e.id ? { background: 'var(--gold-soft)' } : undefined}>
              <td>{e.weight}{e.approved && totalApproved ? <span className="faint" style={{ fontSize: 11 }}> ({Math.round((e.weight / totalApproved) * 100)}%)</span> : null}</td>
              <td className={`kind-${e.kind}`}>{e.kind}</td>
              <td><b>{e.title}</b> {e.source === 'ai' && <span className="pill-ai">AI draft</span>}<div className="muted" style={{ fontSize: 13 }}>{e.text}</div></td>
              <td>
                <button className={`btn sm ${e.approved ? '' : 'primary'}`} onClick={() => patchEntry(e.id, { approved: !e.approved })}>
                  {e.approved ? <><Check size={12} /> Canon</> : 'Approve'}
                </button>
              </td>
              <td><button className="btn ghost sm icon" onClick={() => delEntry(e.id)} aria-label="Delete entry"><X size={13} /></button></td>
            </tr>
          ))}
          <tr>
            <td><input className="input" type="number" min={1} value={weight} onChange={(e) => setWeight(Math.max(1, Number(e.target.value) || 1))} style={{ padding: '4px 6px' }} /></td>
            <td><select className="select" style={{ padding: '4px 6px' }} value={kind} onChange={(e) => setKind(e.target.value as RollEntry['kind'])}><option>event</option><option>status</option><option>calamity</option></select></td>
            <td>
              <input className="input" placeholder="New entry title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ padding: '4px 8px', marginBottom: 4 }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add('gm'); } }} />
              <input className="input" placeholder="What happens (optional)" value={text} onChange={(e) => setText(e.target.value)} style={{ padding: '4px 8px' }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add('gm'); } }} />
            </td>
            <td colSpan={2}>
              <button className="btn primary sm" disabled={!title.trim()} onClick={() => add('gm')} title="Add as canon">Add</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
