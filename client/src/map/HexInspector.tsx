import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { BookOpen, Castle, Eye, EyeOff, Plus, Trash2, Users, X } from 'lucide-react';
import { api, qk } from '../api';
import type { Claim, Hex, MapData, Settlement, Token, TokenKind } from '../types';
import { useWorld } from '../world';
import { usePageIndex } from '../wiki/usePages';
import { toastError } from '../components/toast';

const TOKEN_KINDS: { kind: TokenKind; label: string }[] = [
  { kind: 'city', label: 'City' }, { kind: 'outpost', label: 'Outpost' }, { kind: 'party', label: 'Party' },
  { kind: 'unit', label: 'Unit' }, { kind: 'character', label: 'Character' }, { kind: 'marker', label: 'Marker' },
];

export function HexInspector({ hex, data, fogCampaignId, explored, label, onClose }: {
  hex: Hex; data: MapData; fogCampaignId: string | null; explored: boolean; label: string; onClose: () => void;
}) {
  const world = useWorld();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pages = usePageIndex(world.id);
  const [name, setName] = useState(hex.name);
  const [notes, setNotes] = useState(hex.notes);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingText = useRef<{ name?: string; notes?: string }>({});

  useEffect(() => { setName(hex.name); setNotes(hex.notes); pendingText.current = {}; }, [hex.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchCache = (fn: (d: MapData) => MapData) => qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? fn(d) : d));
  const touchEvents = () => qc.invalidateQueries({ queryKey: qk.events(world.id) });

  const patchHex = async (patch: Partial<Hex>) => {
    patchCache((d) => ({ ...d, hexes: d.hexes.map((h) => (h.id === hex.id ? { ...h, ...patch } : h)) }));
    try {
      await api(`/api/worlds/${world.id}/hexes/${hex.id}`, { method: 'PATCH', body: patch });
      if ('terrain' in patch || 'state' in patch || 'name' in patch) touchEvents();
    } catch (e) { toastError(e); qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
  };
  // Text fields autosave after a short pause, and on close/switch.
  const flushText = () => {
    window.clearTimeout(saveTimer.current);
    const p = pendingText.current;
    pendingText.current = {};
    if (Object.keys(p).length) void patchHex(p);
  };
  const queueText = (p: { name?: string; notes?: string }) => {
    pendingText.current = { ...pendingText.current, ...p };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushText, 600);
  };
  useEffect(() => () => flushText(), [hex.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const claims = data.claims.filter((c) => c.hexId === hex.id);
  const control = claims.find((c) => c.kind === 'control');
  const others = claims.filter((c) => c.kind !== 'control');
  const tokens = data.tokens.filter((t) => t.hexId === hex.id);
  const factionById = (id: string | null) => data.factions.find((f) => f.id === id);
  const camp = data.campaigns.find((c) => c.id === fogCampaignId);

  const setControl = async (factionId: string | null) => {
    try {
      const res = await api<Claim[]>(`/api/worlds/${world.id}/claims/control`, { body: { hexIds: [hex.id], factionId } });
      patchCache((d) => ({ ...d, claims: [...d.claims.filter((c) => c.hexId !== hex.id), ...res] }));
      qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      touchEvents();
    } catch (e) { toastError(e); }
  };
  const addClaim = async (factionId: string, kind: 'contested' | 'influence') => {
    try {
      const c = await api<Claim | null>(`/api/worlds/${world.id}/claims`, { body: { hexId: hex.id, factionId, kind } });
      if (c) patchCache((d) => ({ ...d, claims: [...d.claims, c] }));
      touchEvents();
    } catch (e) { toastError(e); }
  };
  const removeClaim = async (c: Claim) => {
    patchCache((d) => ({ ...d, claims: d.claims.filter((x) => x.id !== c.id) }));
    try { await api(`/api/worlds/${world.id}/claims/${c.id}`, { method: 'DELETE' }); touchEvents(); } catch (e) { toastError(e); }
  };
  const setExplored = async (v: boolean) => {
    if (!fogCampaignId) return;
    qc.setQueryData<string[]>(qk.fog(world.id, fogCampaignId), (xs) => (v ? [...(xs ?? []), hex.id] : (xs ?? []).filter((x) => x !== hex.id)));
    try { await api(`/api/worlds/${world.id}/campaigns/${fogCampaignId}/fog`, { body: { hexIds: [hex.id], explored: v } }); touchEvents(); }
    catch (e) { toastError(e); }
  };

  const terrain = world.terrainTypes.find((t) => t.key === hex.terrain);
  const ctrlFaction = factionById(control?.factionId ?? null);

  return (
    <motion.aside className="inspector" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      onKeyDown={(e) => {
        // Escape closes; blur so map shortcuts work immediately even while the panel animates out.
        if (e.key === 'Escape') { (document.activeElement as HTMLElement | null)?.blur(); flushText(); onClose(); } else e.stopPropagation();
      }}>
      <header>
        <div className="row">
          <span className="swatch" style={{ background: terrain?.color, width: 16, height: 16, borderRadius: 4 }} />
          <input className="input bare display grow" style={{ fontSize: 20, fontWeight: 600, padding: 0 }} value={name} placeholder={terrain?.name ?? 'Hex'}
            onChange={(e) => { setName(e.target.value); queueText({ name: e.target.value }); }} aria-label="Hex name" />
          <button className="btn ghost icon" onClick={() => { flushText(); onClose(); }} aria-label="Close inspector"><X size={16} /></button>
        </div>
        <div className="row coords" style={{ marginTop: 4 }}>
          <span>Hex {label}</span>
          <span>·</span>
          {ctrlFaction ? <span className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: ctrlFaction.color }} />{ctrlFaction.name}</span> : <span>Unclaimed</span>}
          {camp && <><span>·</span><span>{explored ? 'Explored' : 'Unexplored'}</span></>}
        </div>
      </header>
      <div className="content scroll">
        <div className="field">
          <label className="label">Terrain</label>
          <div className="terrain-grid">
            {world.terrainTypes.map((t) => (
              <button key={t.key} className={`terrain-opt ${hex.terrain === t.key ? 'on' : ''}`} onClick={() => patchHex({ terrain: t.key })} title={t.name}>
                <span className="swatch" style={{ background: t.color }} />{t.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="label">State</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {world.hexStates.map((s) => (
              <button key={s.key} className={`terrain-opt ${hex.state === s.key ? 'on' : ''}`} onClick={() => patchHex({ state: s.key })}>
                {s.color && <span className="swatch" style={{ background: s.color, transform: 'rotate(45deg) scale(0.8)' }} />}{s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="label">Controlling faction</label>
          <select className="select" value={control?.factionId ?? ''} onChange={(e) => setControl(e.target.value || null)}>
            <option value="">None</option>
            {data.factions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {control?.sinceDay != null && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Held since day {control.sinceDay}</div>}
          {others.map((c) => (
            <div key={c.id} className="token-row" style={{ marginTop: 6 }}>
              <span className="swatch" style={{ background: factionById(c.factionId)?.color }} />
              <span className="grow">{factionById(c.factionId)?.name} <span className="faint">({c.kind})</span></span>
              <button className="btn ghost sm icon" onClick={() => removeClaim(c)} aria-label="Remove claim"><X size={13} /></button>
            </div>
          ))}
          {!!data.factions.length && <AddClaim factions={data.factions} onAdd={addClaim} />}
        </div>

        {camp && (
          <div className="field">
            <label className="label">Party fog: {camp.name}</label>
            <button className="btn" onClick={() => setExplored(!explored)}>
              {explored ? <><EyeOff size={14} /> Hide from party</> : <><Eye size={14} /> Mark explored</>}
            </button>
          </div>
        )}

        <div className="field">
          <label className="label">On this hex</label>
          {tokens.map((t) => <TokenRow key={t.id} token={t} data={data} />)}
          <AddToken hexId={hex.id} data={data} />
        </div>

        <div className="field">
          <label className="label">Wiki page</label>
          <div className="row">
            <select className="select grow" value={hex.wikiPageId ?? ''} onChange={(e) => patchHex({ wikiPageId: e.target.value || null })}>
              <option value="">None</option>
              {(pages.data ?? []).slice().sort((a, b) => a.title.localeCompare(b.title)).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            {hex.wikiPageId && (
              <button className="btn icon" title="Open page" onClick={() => navigate(`/w/${world.id}/wiki/${hex.wikiPageId}`)}><BookOpen size={15} /></button>
            )}
          </div>
        </div>

        <div className="field">
          <label className="label">GM notes</label>
          <textarea className="textarea" rows={6} value={notes} placeholder="What's here? Encounters, secrets, weather…"
            onChange={(e) => { setNotes(e.target.value); queueText({ notes: e.target.value }); }} />
        </div>
      </div>
    </motion.aside>
  );
}

function AddClaim({ factions, onAdd }: { factions: { id: string; name: string }[]; onAdd: (f: string, k: 'contested' | 'influence') => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(factions[0]?.id ?? '');
  const [k, setK] = useState<'contested' | 'influence'>('contested');
  if (!open) return <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setOpen(true)}><Plus size={13} /> Add contested or influence claim</button>;
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <select className="select" value={f} onChange={(e) => setF(e.target.value)}>{factions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <select className="select" style={{ width: 120 }} value={k} onChange={(e) => setK(e.target.value as 'contested' | 'influence')}>
        <option value="contested">contested</option><option value="influence">influence</option>
      </select>
      <button className="btn sm" onClick={() => { onAdd(f, k); setOpen(false); }}>Add</button>
    </div>
  );
}

function TokenRow({ token, data }: { token: Token; data: MapData }) {
  const world = useWorld();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const settlement = data.settlements.find((s) => s.id === token.settlementId);
  const faction = data.factions.find((f) => f.id === token.factionId);
  const patchCache = (fn: (d: MapData) => MapData) => qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? fn(d) : d));

  const remove = async () => {
    patchCache((d) => ({ ...d, tokens: d.tokens.filter((t) => t.id !== token.id), settlements: d.settlements.filter((s) => s.id !== token.settlementId) }));
    try { await api(`/api/worlds/${world.id}/tokens/${token.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: qk.events(world.id) }); }
    catch (e) { toastError(e); qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
  };
  const patchToken = async (p: Partial<Token>) => {
    patchCache((d) => ({ ...d, tokens: d.tokens.map((t) => (t.id === token.id ? { ...t, ...p } : t)) }));
    try { await api(`/api/worlds/${world.id}/tokens/${token.id}`, { method: 'PATCH', body: p }); } catch (e) { toastError(e); }
  };
  const patchSettlement = async (p: Partial<Settlement>) => {
    if (!settlement) return;
    patchCache((d) => ({
      ...d,
      settlements: d.settlements.map((s) => (s.id === settlement.id ? { ...s, ...p } : s)),
      tokens: d.tokens.map((t) => (t.settlementId === settlement.id ? { ...t, ...(p.name ? { name: p.name } : {}), ...('factionId' in p ? { factionId: p.factionId ?? null } : {}) } : t)),
    }));
    try { await api(`/api/worlds/${world.id}/settlements/${settlement.id}`, { method: 'PATCH', body: p }); } catch (e) { toastError(e); }
  };

  const Icon = token.kind === 'city' || token.kind === 'outpost' ? Castle : Users;
  return (
    <div className="token-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row">
        <Icon size={15} style={{ color: token.color ?? faction?.color ?? 'var(--text-dim)' }} />
        <button className="grow" style={{ textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', padding: 0 }} onClick={() => setOpen(!open)}>
          <b>{token.name}</b> <span className="faint">{token.kind}{settlement?.population ? ` · pop ${settlement.population.toLocaleString()}` : ''}</span>
        </button>
        <button className="btn ghost sm icon danger" onClick={remove} aria-label={`Remove ${token.name}`}><Trash2 size={13} /></button>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          <input className="input" value={token.name} onChange={(e) => (settlement ? patchSettlement({ name: e.target.value }) : patchToken({ name: e.target.value }))} />
          <select className="select" value={token.factionId ?? ''} onChange={(e) => (settlement ? patchSettlement({ factionId: e.target.value || null }) : patchToken({ factionId: e.target.value || null }))}>
            <option value="">No faction</option>
            {data.factions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {token.kind === 'party' && (
            <select className="select" value={token.campaignId ?? ''} onChange={(e) => patchToken({ campaignId: e.target.value || null })}>
              <option value="">No campaign</option>
              {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {settlement && (
            <div className="row">
              <select className="select" value={settlement.size} onChange={(e) => patchSettlement({ size: e.target.value })}>
                {['outpost', 'hamlet', 'village', 'town', 'city', 'metropolis'].map((s) => <option key={s}>{s}</option>)}
              </select>
              <input className="input" type="number" placeholder="Population" value={settlement.population ?? ''}
                onChange={(e) => patchSettlement({ population: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
          )}
          <span className="faint" style={{ fontSize: 12 }}>Drag the token on the map to move it.</span>
        </div>
      )}
    </div>
  );
}

function AddToken({ hexId, data }: { hexId: string; data: MapData }) {
  const world = useWorld();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TokenKind>('outpost');
  const [name, setName] = useState('');
  const [factionId, setFactionId] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const t = await api<Token>(`/api/worlds/${world.id}/tokens`, {
        body: { kind, name: name.trim(), hexId, factionId: factionId || null, campaignId: kind === 'party' ? data.campaigns[0]?.id ?? null : null },
      });
      // Settlements are created server-side for cities and outposts; refetch to pick them up.
      if (t.settlementId) qc.invalidateQueries({ queryKey: qk.map(world.id) });
      else qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? { ...d, tokens: [...d.tokens, t] } : d));
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
      setName(''); setOpen(false);
    } catch (err) { toastError(err); }
  };
  if (!open) return <button className="btn ghost sm" onClick={() => setOpen(true)}><Plus size={13} /> Place a token</button>;
  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 6 }}>
      <div className="seg" style={{ flexWrap: 'wrap' }}>
        {TOKEN_KINDS.map((k) => <button type="button" key={k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => setKind(k.kind)}>{k.label}</button>)}
      </div>
      <input className="input" autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <select className="select" value={factionId} onChange={(e) => setFactionId(e.target.value)}>
        <option value="">No faction</option>
        {data.factions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <div className="row"><button className="btn primary sm">Place</button><button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}
