import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Camera, Check, ChevronRight, Compass, Droplets, Eye, EyeOff, Flag, Gem, Leaf, MapPin, Mountain, Package, PawPrint, Pencil, Plus, Sparkles, Trees, Trash2, X } from 'lucide-react';
import { api, ApiError, clientHeaders, pendingWrites, qk } from '../api';
import { useWorld } from '../world';
import type { Claim, Hex, MapData, PageIndex, Token } from '../types';
import { toastError } from '../components/toast';
import { Dialog } from '../components/Dialog';
import { isNotableKind, TOKEN_KINDS } from '../../../shared/markers';
import { emptyHexPresentation, RESOURCE_KINDS, type HexPresentation, type HexResource } from '../../../shared/hexPresentation';
import { Diamond, MarkerIcon, Prop } from './PanelPrimitives';
import { AddMapMarker } from './AddMapMarker';
import { usePlayer } from './PieceDrawer';
import { placeDiamond } from './markers';

type HexFields = Pick<Hex, 'name' | 'terrain' | 'state' | 'notes' | 'wikiPageId'>;
type Draft = HexPresentation & { hex: HexFields };
export type HexDossierProps = {
  hex: Hex; data: MapData; fogCampaignId: string | null; explored: boolean; label: string;
  onClose: () => void; onFocus: (f: { kind: 'hex' | 'token' | 'faction'; id: string }) => void;
  snap: () => string | null; interiorFooter?: ReactNode;
};
const hexFields = (hex: Hex): HexFields => ({ name: hex.name, terrain: hex.terrain, state: hex.state, notes: hex.notes, wikiPageId: hex.wikiPageId });
const RESOURCE_ICONS = { mineral: Gem, plant: Leaf, wildlife: PawPrint, water: Droplets, arcane: Sparkles, other: Package };
const RESOURCE_LABELS = { mineral: 'Mineral', plant: 'Plant', wildlife: 'Wildlife', water: 'Water', arcane: 'Arcane', other: 'Other' };
const TYPE_LABELS = Object.fromEntries(TOKEN_KINDS.map(k => [k.kind, k.label]));
function terrainIcon(key: string) {
  return /forest|wood|jungle/.test(key) ? Trees : /water|ocean|lake|swamp|marsh/.test(key) ? Droplets : /plain|grass|farm/.test(key) ? Leaf : Mountain;
}
function DossierSection({ title, icon, children, action }: { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <section className="hex-section"><header><span>{icon}{title}</span>{action}</header>{children}</section>;
}
function PlaceEmblem({ token, color }: { token: Token; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const sprite = placeDiamond(token.kind, color, Math.min(2, window.devicePixelRatio || 1), token.kind === 'city' && token.data.majorCity === true);
    canvas.current.width = sprite.width; canvas.current.height = sprite.height;
    canvas.current.getContext('2d')!.drawImage(sprite, 0, 0);
  }, [token.kind, color, token.data.majorCity]);
  return <canvas ref={canvas} aria-hidden="true" style={{ width: 48, height: 48 }} />;
}

export function HexDossier({ hex, data, fogCampaignId, explored, label, onClose, onFocus, snap, interiorFooter }: HexDossierProps) {
  const world = useWorld(), qc = useQueryClient(), player = usePlayer(), navigate = useNavigate();
  const key = ['w', world.id, 'hexPresentation', hex.id];
  const details = useQuery({ queryKey: key, queryFn: () => api<HexPresentation>(`/api/worlds/${world.id}/hexes/${hex.id}/presentation`) });
  const pages = useQuery({ queryKey: qk.pages(world.id), enabled: !player, queryFn: () => api<PageIndex[]>(`/api/worlds/${world.id}/pages`) });
  const presentation = details.data ?? emptyHexPresentation(hex.id);
  const [edit, setEdit] = useState(false), [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState(false), [discard, setDiscard] = useState(false), [brokenArt, setBrokenArt] = useState<string | null>(null);
  const base = useRef<Draft | null>(null), snapRef = useRef(snap), [mapStill, setMapStill] = useState<string | null>(null);
  snapRef.current = snap;
  useEffect(() => {
    let frame = 0, timer = 0, active = true;
    const capture = () => { if (!active) return; const src = snapRef.current(); if (src) setMapStill(src); else timer = window.setTimeout(() => { frame = requestAnimationFrame(capture); }, 150); };
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(capture); });
    return () => { active = false; cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [hex.id, hex.terrain]);
  useEffect(() => {
    if (!edit || !base.current) return;
    if (presentation.revision !== base.current.revision || JSON.stringify(hexFields(hex)) !== JSON.stringify(base.current.hex)) setConflict(true);
  }, [presentation.revision, hex, edit]);
  const begin = () => {
    const next = { ...structuredClone(presentation), hex: hexFields(hex) };
    base.current = next; setDraft(structuredClone(next)); setConflict(false); setEdit(true);
  };
  const cancel = () => { setEdit(false); setDraft(null); setConflict(false); };
  const dirty = edit && JSON.stringify(draft) !== JSON.stringify(base.current);
  const close = () => { if (busy || uploading) return; if (dirty) setDiscard(true); else onClose(); };
  const view = edit && draft ? draft : presentation, props = edit && draft ? draft.hex : hex;
  const terrain = world.terrainTypes.find(t => t.key === props.terrain), state = world.hexStates.find(s => s.key === props.state);
  const TerrainIcon = terrainIcon(props.terrain), accent = terrain?.color ?? world.accent;
  const claims = data.claims.filter(c => c.hexId === hex.id), control = claims.find(c => c.kind === 'control'), others = claims.filter(c => c.kind !== 'control');
  const controlling = data.factions.find(f => f.id === control?.factionId), campaign = data.campaigns.find(c => c.id === fogCampaignId);
  const present = data.tokens.filter(t => t.hexId === hex.id), places = present.filter(t => isNotableKind(t.kind)), pieces = present.filter(t => !isNotableKind(t.kind));
  const patchDraft = (patch: Partial<HexPresentation>) => setDraft(d => d ? { ...d, ...patch } : d);
  const patchHex = (patch: Partial<HexFields>) => setDraft(d => d ? { ...d, hex: { ...d.hex, ...patch } } : d);
  const patchResource = (id: string, patch: Partial<HexResource>) => setDraft(d => d ? { ...d, resources: d.resources.map(r => r.id === id ? { ...r, ...patch } : r) } : d);
  const save = async () => {
    if (!draft || !base.current) return;
    setBusy(true);
    try {
      const changedHex = Object.fromEntries(Object.entries(draft.hex).filter(([k, v]) => v !== base.current!.hex[k as keyof HexFields]));
      const expectedHex = Object.fromEntries(Object.keys(changedHex).map(k => [k, base.current!.hex[k as keyof HexFields]]));
      const saved = await api<HexPresentation>(`/api/worlds/${world.id}/hexes/${hex.id}/presentation`, { method: 'PATCH', body: {
        revision: draft.revision, heroId: draft.heroId, heroFocus: draft.heroFocus, lore: draft.lore,
        resources: draft.resources, hex: changedHex, expectedHex,
      } });
      qc.setQueryData(key, saved);
      if (Object.keys(changedHex).length) qc.setQueryData<MapData>(qk.map(world.id), d => d ? { ...d, hexes: d.hexes.map(h => h.id === hex.id ? { ...h, ...changedHex } : h) } : d);
      cancel();
      await qc.invalidateQueries({ queryKey: ['w', world.id, 'files'] });
      await qc.invalidateQueries({ queryKey: qk.events(world.id) });
    } catch (e) {
      toastError(e);
      if (e instanceof ApiError && e.status === 409) { setConflict(true); await qc.invalidateQueries({ queryKey: key }); await qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
    } finally { setBusy(false); }
  };
  const upload = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) { toastError(Error('Artwork must be under 8 MB.')); return; }
    setUploading(true);
    try {
      const response = await pendingWrites.track(fetch(`/api/worlds/${world.id}/hex-artwork?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { ...clientHeaders, 'content-type': file.type }, body: file }));
      const art = await response.json(); if (!response.ok) throw Error(art.error);
      patchDraft({ heroId: art.id }); await qc.invalidateQueries({ queryKey: ['w', world.id, 'files'] });
    } catch (e) { toastError(e); } finally { setUploading(false); }
  };
  const controlTo = async (factionId: string | null) => {
    try {
      const result = await api<Claim[]>(`/api/worlds/${world.id}/claims/control`, { body: { hexIds: [hex.id], factionId } });
      qc.setQueryData<MapData>(qk.map(world.id), d => d ? { ...d, claims: [...d.claims.filter(c => c.hexId !== hex.id), ...result] } : d);
      await qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      await qc.invalidateQueries({ queryKey: qk.events(world.id) });
    } catch (e) { toastError(e); }
  };
  const addClaim = async (factionId: string, kind: 'contested' | 'influence') => {
    try { await api(`/api/worlds/${world.id}/claims`, { body: { hexId: hex.id, factionId, kind } }); await qc.invalidateQueries({ queryKey: qk.map(world.id) }); await qc.invalidateQueries({ queryKey: qk.events(world.id) }); } catch (e) { toastError(e); }
  };
  const removeClaim = async (claim: Claim) => {
    try { await api(`/api/worlds/${world.id}/claims/${claim.id}`, { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: qk.map(world.id) }); await qc.invalidateQueries({ queryKey: qk.events(world.id) }); } catch (e) { toastError(e); }
  };
  const setExplored = async () => {
    if (!fogCampaignId) return;
    try { await api(`/api/worlds/${world.id}/campaigns/${fogCampaignId}/fog`, { body: { hexIds: [hex.id], explored: !explored } }); await qc.invalidateQueries({ queryKey: qk.fog(world.id, fogCampaignId) }); await qc.invalidateQueries({ queryKey: qk.events(world.id) }); } catch (e) { toastError(e); }
  };
  const card = (token: Token) => {
    const faction = data.factions.find(f => f.id === token.factionId), settlement = data.settlements.find(s => s.id === token.settlementId);
    return <button className="hex-place" key={token.id} disabled={edit && dirty} title={edit && dirty ? 'Save or cancel your details before opening another place.' : undefined} onClick={() => onFocus({ kind: 'token', id: token.id })} style={{ '--place-accent': token.color ?? faction?.color ?? '#d6b06a' } as CSSProperties}>
      <span className="hex-place-emblem">{isNotableKind(token.kind) ? <PlaceEmblem token={token} color={token.color ?? faction?.color ?? '#d6b06a'} /> : <MarkerIcon kind={token.kind} color={token.color ?? faction?.color ?? '#d6b06a'} size={34} />}</span>
      <span className="hex-place-copy"><small>{TYPE_LABELS[token.kind]}</small><strong>{token.name}</strong><span>{faction?.name ?? 'Unaligned'}{settlement?.population != null ? ` · ${settlement.population.toLocaleString()} residents` : ''}</span></span><ChevronRight size={14} />
    </button>;
  };
  const artwork = view.heroId && brokenArt !== view.heroId ? `/api/worlds/${world.id}/hex-artwork/${view.heroId}` : mapStill;
  const ready = !details.isPending && !details.isError;

  return <motion.aside className="panel inspector hex-dossier" aria-label={`Hex ${label} details`} style={{ '--hex-accent': accent } as CSSProperties}
    initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 28 }} transition={{ type: 'spring', stiffness: 420, damping: 36 }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
    <div className="hex-hero">
      {artwork && <img className="hex-hero-image" src={artwork} alt={view.heroId ? `${props.name || 'Hex ' + label} artwork` : ''} style={{ objectPosition: `50% ${view.heroFocus}%` }} onError={() => { if (view.heroId) setBrokenArt(view.heroId); }} />}
      <div className="hex-hero-shade" /><span className="hex-coordinate"><MapPin size={11} />HEX {label}</span>
      <div className="hex-hero-tools">
        {!player && !edit && <button className="iconbtn" disabled={!ready} aria-label="Edit hex details" title="Edit hex details" onClick={begin}><Pencil size={15} /></button>}
        {edit && <label className="iconbtn" title="Upload hex artwork"><Camera size={16} /><input hidden type="file" aria-label="Upload hex artwork" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy || uploading} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} /></label>}
        <button className="iconbtn" aria-label="Close hex details" onClick={close} disabled={busy || uploading}><X size={16} /></button>
      </div>
      <div className="hex-hero-title"><span className="hex-eyebrow">{terrain?.name ?? props.terrain}</span><h2>{props.name || `Hex ${label}`}</h2><div className="hex-hero-status"><i style={{ background: state?.color ?? accent }} />{state?.name ?? props.state}{campaign && <><span className="dot" />{explored ? 'Explored' : 'Unexplored'}</>}</div></div>
    </div>
    <div className={`hex-dossier-body scroll ${edit ? 'editing' : ''}`}>
      {details.isPending && <p className="faint" role="status">Opening the atlas…</p>}
      {details.isError && <div className="hex-empty">{details.error instanceof ApiError && details.error.status === 404 ? 'These details have not been discovered.' : <><p>Details could not be loaded.</p><button className="btn ghost sm" onClick={() => details.refetch()}>Retry</button></>}</div>}
      {conflict && <p className="sheet-conflict" role="alert">This hex changed on another screen. Cancel to load the latest details before editing again.</p>}
      {edit && draft && <div className="hex-edit-basics"><label className="field">Hex name<input className="input" aria-label="Hex name" value={draft.hex.name} maxLength={200} disabled={busy} onChange={e => patchHex({ name: e.target.value })} /></label>{view.heroId && <><label className="field">Artwork framing<input aria-label="Artwork vertical position" type="range" min={0} max={100} value={draft.heroFocus} disabled={busy} onChange={e => patchDraft({ heroFocus: Number(e.target.value) })} /></label><button className="btn ghost sm" disabled={busy || uploading} onClick={() => patchDraft({ heroId: null, heroFocus: 50 })}>Use map illustration</button></>}{uploading && <small role="status">Uploading artwork…</small>}</div>}
      <DossierSection title="Lore" icon={<BookOpen size={13} />}>
        {edit && draft ? <textarea className="textarea hex-lore-editor" aria-label="Hex lore" rows={7} value={draft.lore} maxLength={100000} disabled={busy} placeholder="Write this place’s story…" onChange={e => patchDraft({ lore: e.target.value })} /> : view.lore ? <div className="hex-lore">{view.lore.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph}</p>)}</div> : <p className="hex-empty">No lore recorded.</p>}
      </DossierSection>
      <div className="hex-landscape">
        <div><TerrainIcon size={22} /><span className="hex-eyebrow">Terrain</span>{edit && draft ? <select className="select" aria-label="Hex terrain" value={draft.hex.terrain} disabled={busy} onChange={e => patchHex({ terrain: e.target.value })}><option hidden value={draft.hex.terrain}>{terrain?.name ?? draft.hex.terrain}</option>{world.terrainTypes.map(t => <option key={t.key} value={t.key}>{t.name}</option>)}</select> : <strong>{terrain?.name ?? props.terrain}</strong>}</div>
        <div><Compass size={22} /><span className="hex-eyebrow">State</span>{edit && draft ? <select className="select" aria-label="Hex state" value={draft.hex.state} disabled={busy} onChange={e => patchHex({ state: e.target.value })}><option hidden value={draft.hex.state}>{state?.name ?? draft.hex.state}</option>{world.hexStates.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}</select> : <strong>{state?.name ?? props.state}</strong>}</div>
      </div>
      <DossierSection title="Notable places" icon={<MapPin size={13} />} action={edit && <AddMapMarker hexId={hex.id} data={data} onPlaced={() => void qc.invalidateQueries({ queryKey: qk.map(world.id) })} />}>
        <div className="hex-place-list">{places.map(card)}</div>{!places.length && <p className="hex-empty">No points of interest designated.</p>}
      </DossierSection>
      <DossierSection title="Resources" icon={<Gem size={13} />} action={edit && <button className="iconbtn sm" aria-label="Add hex resource" disabled={busy || view.resources.length >= 50} onClick={() => patchDraft({ resources: [...view.resources, { id: crypto.randomUUID(), name: '', kind: 'other', availability: '', notes: '' }] })}><Plus size={14} /></button>}>
        {view.resources.map(resource => {
          const ResourceIcon = RESOURCE_ICONS[resource.kind];
          return edit ? <fieldset className="hex-resource-editor" key={resource.id} disabled={busy}><legend>{resource.name || 'New resource'}</legend><div className="row"><label className="field grow">Resource name<input className="input" aria-label="Resource name" value={resource.name} maxLength={120} onChange={e => patchResource(resource.id, { name: e.target.value })} /></label><button className="iconbtn danger" type="button" aria-label={`Remove resource ${resource.name || 'entry'}`} onClick={() => patchDraft({ resources: view.resources.filter(r => r.id !== resource.id) })}><Trash2 size={14} /></button></div><label className="field">Kind<select className="select" aria-label="Resource kind" value={resource.kind} onChange={e => patchResource(resource.id, { kind: e.target.value as HexResource['kind'] })}>{RESOURCE_KINDS.map(k => <option key={k} value={k}>{RESOURCE_LABELS[k]}</option>)}</select></label><label className="field">Availability<input className="input" aria-label="Resource availability" maxLength={120} value={resource.availability} placeholder="Optional" onChange={e => patchResource(resource.id, { availability: e.target.value })} /></label><label className="field">Notes<textarea className="textarea" aria-label="Resource notes" rows={3} maxLength={2000} value={resource.notes} onChange={e => patchResource(resource.id, { notes: e.target.value })} /></label></fieldset> : <article className="hex-resource" key={resource.id}><span className="hex-resource-icon"><ResourceIcon size={21} /></span><div><small>{RESOURCE_LABELS[resource.kind]}</small><h4>{resource.name}</h4>{resource.availability && <span className="hex-resource-availability">{resource.availability}</span>}{resource.notes && <p>{resource.notes}</p>}</div></article>;
        })}
        {!view.resources.length && <p className="hex-empty">No resources recorded.</p>}
      </DossierSection>
      {!!pieces.length && <DossierSection title="Present here" icon={<Flag size={13} />}><div className="hex-place-list compact">{pieces.map(card)}</div></DossierSection>}
      <DossierSection title="Territory" icon={<Flag size={13} />}>
        {controlling ? <button className="hex-allegiance" disabled={player} onClick={() => onFocus({ kind: 'faction', id: controlling.id })}><Diamond color={controlling.color} /><span><strong>{controlling.name}</strong><small>{control?.sinceDay != null ? `Control since day ${control.sinceDay}` : 'Controlling faction'}</small></span>{!player && <ChevronRight size={14} />}</button> : <p className="hex-empty">Unclaimed</p>}
        {others.map(c => <div key={c.id} className="claim-chip"><Diamond color={data.factions.find(f => f.id === c.factionId)?.color ?? '#888'} size={8} /><span className="grow">{data.factions.find(f => f.id === c.factionId)?.name}</span><span className={`claim-kind ${c.kind}`}>{c.kind}</span>{edit && <button className="iconbtn sm" aria-label="Remove claim" onClick={() => void removeClaim(c)}><X size={12} /></button>}</div>)}
      </DossierSection>
      {!player && <>
        {edit && draft && <DossierSection title="GM notes" icon={<EyeOff size={13} />}><textarea className="textarea" aria-label="Hex GM notes" rows={5} maxLength={100000} value={draft.hex.notes} disabled={busy} placeholder="Encounters, secrets, table reminders…" onChange={e => patchHex({ notes: e.target.value })} /><small className="faint">Private to the GM.</small></DossierSection>}
        {!edit && hex.notes && <details className="hex-private-notes"><summary><EyeOff size={13} />GM notes</summary><p>{hex.notes}</p></details>}
        {edit && draft && <DossierSection title="Lore reference" icon={<BookOpen size={13} />}><label className="field">Wiki page<select className="select" aria-label="Hex wiki page" disabled={busy} value={draft.hex.wikiPageId ?? ''} onChange={e => patchHex({ wikiPageId: e.target.value || null })}><option value="">No linked page</option>{pages.data?.slice().sort((a, b) => a.title.localeCompare(b.title)).map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label></DossierSection>}
        {!edit && hex.wikiPageId && <button className="hex-reference" onClick={() => navigate(`/w/${world.id}/wiki/${hex.wikiPageId}`)}><BookOpen size={16} /><span><small>FROM THE WIKI</small><strong>{pages.data?.find(p => p.id === hex.wikiPageId)?.title ?? 'Open linked lore'}</strong></span><ChevronRight size={14} /></button>}
        {edit && <details className="hex-map-actions"><summary>Territory & exploration controls</summary><p className="faint">These map actions take effect immediately.</p><Prop label="Control" value={controlling?.name ?? 'Unclaimed'}>{closeMenu => <>{data.factions.map(f => <button className="pick" key={f.id} onClick={() => { void controlTo(f.id); closeMenu(); }}><Diamond color={f.color} size={8} />{f.name}</button>)}<button className="pick" onClick={() => { void controlTo(null); closeMenu(); }}>No controlling faction</button></>}</Prop>{!!data.factions.length && <Prop label="Add claim" value="Contested or influence">{closeMenu => data.factions.flatMap(f => (['contested', 'influence'] as const).map(kind => <button className="pick" key={f.id + kind} onClick={() => { void addClaim(f.id, kind); closeMenu(); }}><Diamond color={f.color} size={8} />{f.name}<small>{kind}</small></button>))}</Prop>}{campaign && <button className="btn ghost sm" onClick={() => void setExplored()}>{explored ? <EyeOff size={13} /> : <Eye size={13} />}{explored ? 'Mark unexplored' : 'Mark explored'} · {campaign.name}</button>}</details>}
      </>}
      {interiorFooter}
    </div>
    <footer className="hex-dossier-footer">{edit ? <><span className="hex-edit-status">{dirty ? 'Unsaved details' : 'Editing details'}</span><button className="btn ghost sm" disabled={busy || uploading} onClick={cancel}>Cancel</button><button className="btn sm" disabled={busy || uploading || conflict || view.resources.some(r => !r.name.trim())} onClick={() => void save()}><Check size={13} />{busy ? 'Saving…' : 'Save details'}</button></> : <><span><MapPin size={12} />{label}</span><small>{player ? 'Field atlas' : ready && presentation.revision ? 'Saved' : 'Field atlas'}</small>{!player && <button className="btn ghost sm" disabled={!ready} onClick={begin}><Pencil size={13} />Edit</button>}</>}</footer>
    <Dialog open={discard} onClose={() => setDiscard(false)} title="Keep your edits?"><p>Save your hex details before leaving, or discard this draft. Uploaded artwork remains in Uploaded files.</p><div className="actions"><button className="btn ghost" onClick={() => setDiscard(false)}>Keep editing</button><button className="btn" onClick={() => { setDiscard(false); cancel(); onClose(); }}>Discard draft</button></div></Dialog>
  </motion.aside>;
}
