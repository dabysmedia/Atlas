/**
 * Focused side panels for the map: one thing at a time (a hex, a marker, or a
 * faction), read-first with an art header, editing on demand.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { BookOpen, Check, ChevronDown, Crosshair, Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import { api, qk } from '../api';
import type { Claim, Faction, Hex, MapData, MeterDef, Settlement, Token, TokenKind } from '../types';
import { useWorld } from '../world';
import { usePageIndex } from '../wiki/usePages';
import { toastError } from '../components/toast';
import { Dialog } from '../components/Dialog';
import { bandFor } from '../../../shared/meters';
import { markerSprite } from './markers';

export const TOKEN_KINDS: { kind: TokenKind; label: string }[] = [
  { kind: 'city', label: 'City' }, { kind: 'outpost', label: 'Outpost' }, { kind: 'party', label: 'Party' },
  { kind: 'unit', label: 'Unit' }, { kind: 'character', label: 'Character' }, { kind: 'marker', label: 'Marker' },
];
const KIND_LABEL = Object.fromEntries(TOKEN_KINDS.map((k) => [k.kind, k.label])) as Record<TokenKind, string>;

export type Focus = { kind: 'hex' | 'token' | 'faction'; id: string };

// ---------------------------------------------------------------- shared pieces
function Panel({ children, onClose, className = '' }: { children: ReactNode; onClose: () => void; className?: string }) {
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
function PanelArt({ snap, deps, children, onClose, tint }: { snap: () => string | null; deps: unknown[]; children?: ReactNode; onClose: () => void; tint?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setSrc(snap())); });
    return () => cancelAnimationFrame(raf);
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

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="psec">
      <header><h4>{title}</h4>{action}</header>
      {children}
    </section>
  );
}

/** A labeled value that turns into a picker on click. */
function Prop({ label, children, value }: { label: string; value: ReactNode; children?: (close: () => void) => ReactNode }) {
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

function MarkerIcon({ kind, color, size = 26 }: { kind: TokenKind; color: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = markerSprite(kind, color, size * 0.42, dpr);
    c.width = s.canvas.width; c.height = s.canvas.height;
    c.getContext('2d')!.drawImage(s.canvas, 0, 0);
  }, [kind, color, size]);
  return <canvas ref={ref} className="marker-icon" style={{ width: size * 1.25, height: size * 1.25 }} />;
}

/** Notes that read as text and become an editor on click; autosave while typing. */
function Notes({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const t = useRef<number | undefined>(undefined);
  const latest = useRef(value);
  useEffect(() => { if (!editing) setText(value); }, [value, editing]);
  const flush = () => { window.clearTimeout(t.current); if (latest.current !== value) onSave(latest.current); };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editing) {
    return (
      <button className={`notes-read ${text ? '' : 'empty'}`} onClick={() => setEditing(true)}>
        {text || placeholder}
      </button>
    );
  }
  return (
    <textarea className="textarea" rows={6} autoFocus value={text} placeholder={placeholder}
      onChange={(e) => { setText(e.target.value); latest.current = e.target.value; window.clearTimeout(t.current); t.current = window.setTimeout(() => onSave(latest.current), 600); }}
      onBlur={() => { flush(); setEditing(false); }} />
  );
}

function useMapCache() {
  const world = useWorld();
  const qc = useQueryClient();
  const patch = (fn: (d: MapData) => MapData) => qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? fn(d) : d));
  const touch = () => qc.invalidateQueries({ queryKey: qk.events(world.id) });
  return { world, qc, patch, touch };
}

// ---------------------------------------------------------------- hex
export function HexPanel({ hex, data, fogCampaignId, explored, label, onClose, onFocus, snap }: {
  hex: Hex; data: MapData; fogCampaignId: string | null; explored: boolean; label: string;
  onClose: () => void; onFocus: (f: Focus) => void; snap: () => string | null;
}) {
  const { world, qc, patch, touch } = useMapCache();
  const navigate = useNavigate();
  const pages = usePageIndex(world.id);
  const [name, setName] = useState(hex.name);
  const nameT = useRef<number | undefined>(undefined);
  useEffect(() => setName(hex.name), [hex.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchHex = async (p: Partial<Hex>) => {
    patch((d) => ({ ...d, hexes: d.hexes.map((h) => (h.id === hex.id ? { ...h, ...p } : h)) }));
    try {
      await api(`/api/worlds/${world.id}/hexes/${hex.id}`, { method: 'PATCH', body: p });
      if ('terrain' in p || 'state' in p || 'name' in p) touch();
    } catch (e) { toastError(e); qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
  };

  const claims = data.claims.filter((c) => c.hexId === hex.id);
  const control = claims.find((c) => c.kind === 'control');
  const others = claims.filter((c) => c.kind !== 'control');
  const tokens = data.tokens.filter((t) => t.hexId === hex.id);
  const factionById = (id: string | null) => data.factions.find((f) => f.id === id);
  const camp = data.campaigns.find((c) => c.id === fogCampaignId);
  const terrain = world.terrainTypes.find((t) => t.key === hex.terrain);
  const state = world.hexStates.find((s) => s.key === hex.state);
  const ctrl = factionById(control?.factionId ?? null);
  const page = pages.data?.find((p) => p.id === hex.wikiPageId);

  const setControl = async (factionId: string | null) => {
    try {
      const res = await api<Claim[]>(`/api/worlds/${world.id}/claims/control`, { body: { hexIds: [hex.id], factionId } });
      patch((d) => ({ ...d, claims: [...d.claims.filter((c) => !(c.hexId === hex.id && c.kind === 'control')), ...res] }));
      qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      touch();
    } catch (e) { toastError(e); }
  };
  const addClaim = async (factionId: string, kind: 'contested' | 'influence') => {
    try {
      const c = await api<Claim | null>(`/api/worlds/${world.id}/claims`, { body: { hexId: hex.id, factionId, kind } });
      if (c) patch((d) => ({ ...d, claims: [...d.claims, c] }));
      touch();
    } catch (e) { toastError(e); }
  };
  const removeClaim = async (c: Claim) => {
    patch((d) => ({ ...d, claims: d.claims.filter((x) => x.id !== c.id) }));
    try { await api(`/api/worlds/${world.id}/claims/${c.id}`, { method: 'DELETE' }); touch(); } catch (e) { toastError(e); }
  };
  const setExplored = async (v: boolean) => {
    if (!fogCampaignId) return;
    qc.setQueryData<string[]>(qk.fog(world.id, fogCampaignId), (xs) => (v ? [...(xs ?? []), hex.id] : (xs ?? []).filter((x) => x !== hex.id)));
    try { await api(`/api/worlds/${world.id}/campaigns/${fogCampaignId}/fog`, { body: { hexIds: [hex.id], explored: v } }); touch(); }
    catch (e) { toastError(e); }
  };

  return (
    <Panel onClose={onClose}>
      <PanelArt snap={snap} deps={[hex.id, hex.terrain, control?.factionId, tokens.length]} onClose={onClose}>
        <span className="art-chip">Hex {label}</span>
      </PanelArt>
      <div className="panel-head">
        <input className="panel-title" value={name} placeholder={terrain?.name ?? 'Unnamed hex'} aria-label="Hex name"
          onChange={(e) => { const v = e.target.value; setName(v); window.clearTimeout(nameT.current); nameT.current = window.setTimeout(() => patchHex({ name: v }), 600); }}
          onBlur={() => { window.clearTimeout(nameT.current); if (name !== hex.name) patchHex({ name }); }} />
        <div className="panel-sub">
          <span className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: terrain?.color }} />{terrain?.name ?? hex.terrain}</span>
          {state && state.key !== 'wild' && <><span className="dot" /><span>{state.name}</span></>}
        </div>
      </div>
      <div className="panel-body scroll">
        <Section title="Control">
          {ctrl ? (
            <button className="faction-line" onClick={() => onFocus({ kind: 'faction', id: ctrl.id })}>
              <Diamond color={ctrl.color} /> <span className="grow">{ctrl.name}</span>
              {control?.sinceDay != null && <span className="faint">since day {control.sinceDay}</span>}
            </button>
          ) : <div className="faint" style={{ padding: '4px 0' }}>Unclaimed</div>}
          {others.map((c) => (
            <div key={c.id} className="claim-chip">
              <Diamond color={factionById(c.factionId)?.color ?? '#888'} size={8} />
              <span className="grow">{factionById(c.factionId)?.name}</span>
              <span className={`claim-kind ${c.kind}`}>{c.kind}</span>
              <button className="iconbtn sm" onClick={() => removeClaim(c)} aria-label="Remove claim"><X size={12} /></button>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <Prop label="Set control" value={<span className="faint">{ctrl ? 'Change hands' : 'Choose a faction'}</span>}>
              {(close) => (
                <>
                  {data.factions.map((f) => (
                    <button key={f.id} className={`pick ${ctrl?.id === f.id ? 'on' : ''}`} onClick={() => { setControl(f.id); close(); }}><Diamond color={f.color} size={9} />{f.name}</button>
                  ))}
                  <button className="pick" onClick={() => { setControl(null); close(); }}><X size={12} /> No one</button>
                </>
              )}
            </Prop>
            {!!data.factions.length && (
              <Prop label="Add claim" value={<span className="faint">Contested or influence</span>}>
                {(close) => data.factions.flatMap((f) => (['contested', 'influence'] as const).map((k) => (
                  <button key={f.id + k} className="pick" onClick={() => { addClaim(f.id, k); close(); }}><Diamond color={f.color} size={9} />{f.name} <span className="faint">{k}</span></button>
                )))}
              </Prop>
            )}
          </div>
        </Section>

        <Section title="Details">
          <Prop label="Terrain" value={<span className="row" style={{ gap: 7 }}><span className="swatch" style={{ background: terrain?.color }} />{terrain?.name ?? hex.terrain}</span>}>
            {(close) => (
              <div className="terrain-grid">
                {world.terrainTypes.map((t) => (
                  <button key={t.key} className={`terrain-opt ${hex.terrain === t.key ? 'on' : ''}`} onClick={() => { patchHex({ terrain: t.key }); close(); }} title={t.name}>
                    <span className="swatch" style={{ background: t.color }} />{t.name}
                  </button>
                ))}
              </div>
            )}
          </Prop>
          <Prop label="State" value={<span className="row" style={{ gap: 7 }}>{state?.color && <Diamond color={state.color} size={8} />}{state?.name ?? hex.state}</span>}>
            {(close) => world.hexStates.map((s) => (
              <button key={s.key} className={`pick ${hex.state === s.key ? 'on' : ''}`} onClick={() => { patchHex({ state: s.key }); close(); }}>
                {s.color ? <Diamond color={s.color} size={8} /> : <span style={{ width: 8 }} />}{s.name}
              </button>
            ))}
          </Prop>
          {camp && (
            <div className="prop">
              <span className="prop-label">Party</span>
              <button className="prop-value" onClick={() => setExplored(!explored)} title={`Party fog for ${camp.name}`}>
                <span className="row" style={{ gap: 7 }}>{explored ? <><Eye size={13} /> Explored</> : <><EyeOff size={13} className="faint" /> Unexplored</>}</span>
              </button>
            </div>
          )}
          <Prop label="Wiki" value={page ? <span className="link-like">{page.title}</span> : <span className="faint">None</span>}>
            {(close) => (
              <div className="pick-scroll">
                {page && <button className="pick" onClick={() => { navigate(`/w/${world.id}/wiki/${page.id}`); close(); }}><BookOpen size={12} /> Open “{page.title}”</button>}
                <button className="pick" onClick={() => { patchHex({ wikiPageId: null }); close(); }}><X size={12} /> No page</button>
                {(pages.data ?? []).slice().sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
                  <button key={p.id} className={`pick ${p.id === hex.wikiPageId ? 'on' : ''}`} onClick={() => { patchHex({ wikiPageId: p.id }); close(); }}>{p.title}</button>
                ))}
              </div>
            )}
          </Prop>
        </Section>

        <Section title="On this hex" action={<AddToken hexId={hex.id} data={data} onPlaced={(t) => onFocus({ kind: 'token', id: t.id })} />}>
          {tokens.map((t) => {
            const f = factionById(t.factionId);
            const s = data.settlements.find((x) => x.id === t.settlementId);
            return (
              <button key={t.id} className="poi" onClick={() => onFocus({ kind: 'token', id: t.id })}>
                <MarkerIcon kind={t.kind} color={t.color ?? f?.color ?? '#b9b2a3'} size={20} />
                <span className="grow">{t.name}</span>
                <span className="faint">{KIND_LABEL[t.kind]}{s?.population ? ` · ${s.population.toLocaleString()}` : ''}</span>
              </button>
            );
          })}
          {!tokens.length && <div className="faint" style={{ padding: '2px 0' }}>Nothing placed here.</div>}
        </Section>

        <Section title="GM notes">
          <Notes value={hex.notes} placeholder="What's here? Encounters, secrets, weather…" onSave={(v) => patchHex({ notes: v })} />
        </Section>
      </div>
    </Panel>
  );
}

function AddToken({ hexId, data, onPlaced }: { hexId: string; data: MapData; onPlaced: (t: Token) => void }) {
  const { world, qc, touch } = useMapCache();
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
      if (t.settlementId) await qc.invalidateQueries({ queryKey: qk.map(world.id) });
      else qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? { ...d, tokens: [...d.tokens, t] } : d));
      touch();
      setName(''); setOpen(false);
      onPlaced(t);
    } catch (err) { toastError(err); }
  };
  return (
    <>
      <button className="iconbtn sm" onClick={() => setOpen(true)} title="Place a marker" aria-label="Place a marker"><Plus size={14} /></button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Place a marker">
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <div className="kind-grid">
            {TOKEN_KINDS.map((k) => (
              <button type="button" key={k.kind} className={`kind-opt ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(k.kind)}>
                <MarkerIcon kind={k.kind} color={data.factions.find((f) => f.id === factionId)?.color ?? '#b9b2a3'} size={22} />{k.label}
              </button>
            ))}
          </div>
          <input className="input" autoFocus placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="select" value={factionId} onChange={(e) => setFactionId(e.target.value)}>
            <option value="">No faction</option>
            {data.factions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <div className="actions"><button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary">Place</button></div>
        </form>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- token
export function TokenPanel({ token, data, onClose, onFocus, onLocate, snap }: {
  token: Token; data: MapData; onClose: () => void; onFocus: (f: Focus) => void; onLocate: () => void; snap: () => string | null;
}) {
  const { world, qc, patch, touch } = useMapCache();
  const navigate = useNavigate();
  const pages = usePageIndex(world.id);
  const [confirm, setConfirm] = useState(false);
  const settlement = data.settlements.find((s) => s.id === token.settlementId);
  const faction = data.factions.find((f) => f.id === token.factionId);
  const color = token.color ?? faction?.color ?? '#b9b2a3';
  const hex = data.hexes.find((h) => h.id === token.hexId);
  const [name, setName] = useState(token.name);
  useEffect(() => setName(token.name), [token.id, token.name]);

  const patchToken = async (p: Partial<Token>) => {
    patch((d) => ({ ...d, tokens: d.tokens.map((t) => (t.id === token.id ? { ...t, ...p } : t)) }));
    try { await api(`/api/worlds/${world.id}/tokens/${token.id}`, { method: 'PATCH', body: p }); } catch (e) { toastError(e); }
  };
  const patchSettlement = async (p: Partial<Settlement>) => {
    if (!settlement) return;
    patch((d) => ({
      ...d,
      settlements: d.settlements.map((s) => (s.id === settlement.id ? { ...s, ...p } : s)),
      tokens: d.tokens.map((t) => (t.settlementId === settlement.id ? { ...t, ...(p.name ? { name: p.name } : {}), ...('factionId' in p ? { factionId: p.factionId ?? null } : {}) } : t)),
    }));
    try { await api(`/api/worlds/${world.id}/settlements/${settlement.id}`, { method: 'PATCH', body: p }); } catch (e) { toastError(e); }
  };
  const rename = (v: string) => { if (v.trim() && v !== token.name) void (settlement ? patchSettlement({ name: v.trim() }) : patchToken({ name: v.trim() })); };
  const setFaction = (id: string | null) => (settlement ? patchSettlement({ factionId: id }) : patchToken({ factionId: id }));
  const remove = async () => {
    onClose();
    patch((d) => ({ ...d, tokens: d.tokens.filter((t) => t.id !== token.id), settlements: d.settlements.filter((s) => s.id !== token.settlementId) }));
    try { await api(`/api/worlds/${world.id}/tokens/${token.id}`, { method: 'DELETE' }); touch(); }
    catch (e) { toastError(e); qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
  };
  const page = pages.data?.find((p) => p.id === settlement?.wikiPageId);

  return (
    <Panel onClose={onClose} className="token-panel">
      <PanelArt snap={snap} deps={[token.id, token.hexId, color]} onClose={onClose} tint={color}>
        <div className="art-medallion"><MarkerIcon kind={token.kind} color={color} size={44} /></div>
      </PanelArt>
      <div className="panel-head">
        <input className="panel-title" value={name} aria-label="Marker name" onChange={(e) => setName(e.target.value)}
          onBlur={() => rename(name)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <div className="panel-sub">
          <span>{settlement ? cap(settlement.size) : KIND_LABEL[token.kind]}</span>
          {hex && <><span className="dot" /><button className="link-like" onClick={() => onFocus({ kind: 'hex', id: hex.id })}>{hex.name || 'Hex'}</button></>}
        </div>
      </div>
      <div className="panel-body scroll">
        <Section title="Allegiance">
          <Prop label="Faction" value={faction ? <span className="row" style={{ gap: 7 }}><Diamond color={faction.color} size={9} />{faction.name}</span> : <span className="faint">None</span>}>
            {(close) => (
              <>
                {data.factions.map((f) => <button key={f.id} className={`pick ${f.id === token.factionId ? 'on' : ''}`} onClick={() => { setFaction(f.id); close(); }}><Diamond color={f.color} size={9} />{f.name}</button>)}
                <button className="pick" onClick={() => { setFaction(null); close(); }}><X size={12} /> No faction</button>
              </>
            )}
          </Prop>
          {token.kind === 'party' && (
            <Prop label="Campaign" value={data.campaigns.find((c) => c.id === token.campaignId)?.name ?? <span className="faint">None</span>}>
              {(close) => (
                <>
                  {data.campaigns.map((c) => <button key={c.id} className={`pick ${c.id === token.campaignId ? 'on' : ''}`} onClick={() => { patchToken({ campaignId: c.id }); close(); }}>{c.name}</button>)}
                  <button className="pick" onClick={() => { patchToken({ campaignId: null }); close(); }}><X size={12} /> No campaign</button>
                </>
              )}
            </Prop>
          )}
        </Section>
        {settlement && (
          <Section title="Settlement">
            <Prop label="Size" value={cap(settlement.size)}>
              {(close) => ['outpost', 'hamlet', 'village', 'town', 'city', 'metropolis'].map((s) => (
                <button key={s} className={`pick ${settlement.size === s ? 'on' : ''}`} onClick={() => { patchSettlement({ size: s }); close(); }}>{cap(s)}</button>
              ))}
            </Prop>
            <div className="prop">
              <span className="prop-label">Population</span>
              <input className="prop-input" type="number" value={settlement.population ?? ''} placeholder="Unknown"
                onChange={(e) => patchSettlement({ population: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <Prop label="Wiki" value={page ? <span className="link-like">{page.title}</span> : <span className="faint">None</span>}>
              {(close) => (
                <div className="pick-scroll">
                  {page && <button className="pick" onClick={() => { navigate(`/w/${world.id}/wiki/${page.id}`); close(); }}><BookOpen size={12} /> Open “{page.title}”</button>}
                  {(pages.data ?? []).slice().sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
                    <button key={p.id} className={`pick ${p.id === settlement.wikiPageId ? 'on' : ''}`} onClick={() => { patchSettlement({ wikiPageId: p.id }); close(); }}>{p.title}</button>
                  ))}
                </div>
              )}
            </Prop>
          </Section>
        )}
        {settlement && (
          <Section title="Notes">
            <Notes value={settlement.notes} placeholder="Who rules here, what they trade, what they fear…" onSave={(v) => patchSettlement({ notes: v })} />
          </Section>
        )}
        <div className="panel-actions">
          <button className="btn" onClick={onLocate}><Crosshair size={14} /> Center on map</button>
          <button className="btn ghost danger" onClick={() => setConfirm(true)}><Trash2 size={14} /> Remove</button>
        </div>
        <div className="faint hint-line">Drag the marker on the map to move it.</div>
      </div>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={`Remove ${token.name}?`}>
        <p className="muted" style={{ marginTop: 0 }}>{settlement ? 'The settlement record goes with it.' : 'This removes the marker from the map.'} The removal is recorded in the chronicle.</p>
        <div className="actions"><button className="btn ghost" onClick={() => setConfirm(false)}>Keep</button><button className="btn danger-solid" onClick={() => { setConfirm(false); remove(); }}>Remove</button></div>
      </Dialog>
    </Panel>
  );
}

// ---------------------------------------------------------------- faction
export function FactionPanel({ factionId, data, onClose, onFocus, snap }: {
  factionId: string; data: MapData; onClose: () => void; onFocus: (f: Focus) => void; snap: () => string | null;
}) {
  const world = useWorld();
  const navigate = useNavigate();
  const factions = useQuery({ queryKey: qk.factions(world.id), queryFn: () => api<Faction[]>(`/api/worlds/${world.id}/factions`) });
  const meters = useQuery({ queryKey: qk.meters(world.id), queryFn: () => api<MeterDef[]>(`/api/worlds/${world.id}/meters`) });
  const lite = data.factions.find((f) => f.id === factionId);
  const f = factions.data?.find((x) => x.id === factionId);
  if (!lite) return null;
  const held = data.claims.filter((c) => c.factionId === factionId && c.kind === 'control').length;
  const contested = new Set(data.claims.filter((c) => c.factionId === factionId && c.kind === 'contested').map((c) => c.hexId)).size;
  const places = data.tokens.filter((t) => t.factionId === factionId);
  const defs = meters.data ?? [];
  const shown = f ? f.meters.map((m) => ({ m, def: defs.find((d) => d.id === m.meterId) })).filter((x) => x.def && (x.def.kind !== 'signature' || x.def.id === f.signatureMeterId)) : [];
  shown.sort((a, b) => (a.def!.id === f?.signatureMeterId ? -1 : b.def!.id === f?.signatureMeterId ? 1 : a.def!.sortOrder - b.def!.sortOrder));
  return (
    <Panel onClose={onClose} className="faction-panel">
      <PanelArt snap={snap} deps={[factionId, held]} onClose={onClose} tint={lite.color}>
        <span className="art-chip"><Diamond color={lite.color} size={8} /> Territory</span>
      </PanelArt>
      <div className="panel-head">
        <div className="panel-title static">{lite.name}</div>
        <div className="panel-sub"><span>{held} hexes held</span>{contested > 0 && <><span className="dot" /><span>{contested} contested</span></>}</div>
      </div>
      <div className="panel-body scroll">
        {f?.description && <p className="faction-desc">{f.description}</p>}
        <Section title="Standing">
          {shown.map(({ m, def }) => {
            const band = def!.bands.length ? bandFor(def!.bands, m.value) : null;
            const pct = def!.max != null && def!.min != null ? (m.value - def!.min) / (def!.max - def!.min) : null;
            return (
              <div key={m.meterId} className="mini-meter">
                <div className="row">
                  <span className="grow">{def!.name}{def!.id === f?.signatureMeterId && <span className="sig-tag">signature</span>}</span>
                  {band && <span className={`tone-${band.tone}`} style={{ fontSize: 12 }}>{band.label}</span>}
                  <b className="num">{m.value.toLocaleString()}</b>
                </div>
                {pct != null && <div className="mini-bar"><span className={`bg-${band?.tone ?? 'neutral'}`} style={{ width: `${Math.max(2, pct * 100)}%` }} /></div>}
              </div>
            );
          })}
          {!f && <div className="faint">Loading…</div>}
        </Section>
        {!!places.length && (
          <Section title="Holdings">
            {places.map((t) => (
              <button key={t.id} className="poi" onClick={() => onFocus({ kind: 'token', id: t.id })}>
                <MarkerIcon kind={t.kind} color={lite.color} size={20} />
                <span className="grow">{t.name}</span><span className="faint">{KIND_LABEL[t.kind]}</span>
              </button>
            ))}
          </Section>
        )}
        <div className="panel-actions">
          <button className="btn" onClick={() => navigate(`/w/${world.id}/factions?f=${factionId}`)}><Check size={14} /> Open faction sheet</button>
          {f?.wikiPageId && <button className="btn ghost" onClick={() => navigate(`/w/${world.id}/wiki/${f.wikiPageId}`)}><BookOpen size={14} /> Wiki</button>}
        </div>
      </div>
    </Panel>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
