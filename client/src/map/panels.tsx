/**
 * Focused side panels for the map: one thing at a time (a hex, a marker, or a
 * faction), read-first with an art header, editing on demand.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, Crosshair, Trash2, X } from 'lucide-react';
import { api, qk } from '../api';
import type { Faction, MapData, MeterDef, Settlement, Token, TokenKind } from '../types';
import { useWorld } from '../world';
import { usePageIndex } from '../wiki/usePages';
import { toastError } from '../components/toast';
import { Dialog } from '../components/Dialog';
import { bandFor } from '../../../shared/meters';
import { useDraft } from '../live';
import { TOKEN_KINDS, isNotableKind, isMajorCity } from '../../../shared/markers';
import { PieceControls } from './PieceDrawer';
import { profileFor, settlementStats } from '../../../shared/settlements';
import { SettlementPanel } from './SettlementPanel';
import { TokenInspector } from './TokenInspector';
import { Panel, PanelArt, Section, Prop, Diamond, MarkerIcon } from './PanelPrimitives';
export { Diamond, MarkerIcon } from './PanelPrimitives';
export { TOKEN_KINDS } from '../../../shared/markers';

const KIND_LABEL = Object.fromEntries(TOKEN_KINDS.map((k) => [k.kind, k.label])) as Record<TokenKind, string>;

export type Focus = { kind: 'hex' | 'token' | 'faction'; id: string };

/** Notes that read as text and become an editor on click; autosave while typing. */
function Notes({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const t = useRef<number | undefined>(undefined);
  const latest = useRef(value);
  // Another screen's save shows here too, and becomes what this one compares its own edits against.
  useEffect(() => { if (!editing) { setText(value); latest.current = value; } }, [value, editing]);
  /** Whether this screen typed since it last saved; opening the editor and leaving it saves nothing. */
  const typed = useRef(false);
  const save = () => { typed.current = false; onSave(latest.current); };
  const flush = () => { window.clearTimeout(t.current); if (typed.current && latest.current !== value) save(); };
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
      onChange={(e) => { setText(e.target.value); latest.current = e.target.value; typed.current = true; window.clearTimeout(t.current); t.current = window.setTimeout(save, 600); }}
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

export { HexDossier as HexPanel } from './HexDossier';

// ---------------------------------------------------------------- token
export function TokenPanel(props: Parameters<typeof MarkerPanel>[0]) {
  if (props.token.settlementId && props.data.settlements.some(s=>s.id===props.token.settlementId)) return <SettlementPanel {...props}/>;
  return isNotableKind(props.token.kind) ? <MarkerPanel {...props}/> : <TokenInspector {...props}/>;
}
function MarkerPanel({ token, data, onClose, onFocus, onLocate, snap, onMove }: {
  token: Token; data: MapData; onClose: () => void; onFocus: (f: Focus) => void; onLocate: () => void; snap: () => string | null;
  onMove: () => void; onFootprint: (s: Settlement) => void; onInfluence: (ids: string[]) => void;
}) {
  const { world, qc, patch, touch } = useMapCache();
  const navigate = useNavigate();
  const pages = usePageIndex(world.id);
  const [confirm, setConfirm] = useState(false);
  const settlement = data.settlements.find((s) => s.id === token.settlementId);
  const faction = data.factions.find((f) => f.id === token.factionId);
  const color = token.color ?? faction?.color ?? '#b9b2a3';
  const hex = data.hexes.find((h) => h.id === token.hexId);
  const [name, setName] = useDraft(token.name, token.id);

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
        <div className="art-medallion"><MarkerIcon kind={token.kind} color={color} size={44} major={isMajorCity(token)} /></div>
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
        <PieceControls token={token} data={data} onMove={onMove} />
        {token.kind === 'city' && <Section title="Map visibility"><label className="toggle"><input type="checkbox" checked={isMajorCity(token)} onChange={e => patchToken({ data: { ...token.data, majorCity: e.target.checked } })} /> Major city — visible in world overview</label></Section>}
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
          {!token.mainParty && <button className="btn ghost danger" onClick={() => setConfirm(true)}><Trash2 size={14} /> Remove</button>}
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
  const holdings=data.settlements.filter(s=>s.factionId===factionId);
  const development=holdings.map(s=>settlementStats(s.size,profileFor(s)));
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
        {!!holdings.length && <Section title="Settlements"><div className="settlement-stat-grid"><div><small>Settlements</small><strong>{holdings.length}</strong></div><div><small>Recorded population</small><strong>{holdings.reduce((n,s)=>n+(s.population??0),0).toLocaleString()}</strong></div><div><small>Settlement consumption</small><strong>{development.reduce((n,s)=>n+s.consumption,0)}</strong></div><div><small>Unrest per turn (housing)</small><strong>{development.reduce((n,s)=>n+s.unrest,0)}</strong></div></div><p className="faint">Settlement contributions only. Apply these during your kingdom turn.</p></Section>}

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
