import { motion, useIsPresent } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, Plus, X, Eye, EyeOff, Footprints, Box } from 'lucide-react';
import { api, qk, clientHeaders, pendingWrites } from '../api';
import type { MapData, Token } from '../types';
import { useWorld } from '../world';
import { toastError } from '../components/toast';
import { MarkerIcon } from './panels';
import { TokenPreview } from './TokenPreview';
import { usePageIndex } from '../wiki/usePages';
import { AddToken } from './AddToken';
import { useMiniatureStatus, retryMiniature } from '../map3d/modelStatus';
export const usePlayer = () => useQuery({ queryKey: qk.me, queryFn: () => api<{ username: string; role: 'gm' | 'player' }>('/api/auth/me'), staleTime: Infinity }).data?.role === 'player';
export function PieceDrawer({ data, onClose, onSelect, onPlace, onDeployCopy, startHexId, showTrails, onShowTrails }: { startHexId?: string | null; showTrails: boolean; onShowTrails: (v: boolean) => void; data: MapData; onClose: () => void; onSelect: (id: string) => void; onPlace: (t: Token) => void; onDeployCopy: (t: Token) => void }) {
  const present = useIsPresent();
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const drawer = drawerRef.current, map = drawer?.closest<HTMLElement>('.mapview'); if (!drawer || !map) return;
    const measure = () => map.style.setProperty('--piece-drawer-height', `${drawer.offsetHeight}px`);
    const observer = new ResizeObserver(measure); observer.observe(drawer); measure();
    return () => { observer.disconnect(); map.style.removeProperty('--piece-drawer-height'); };
  }, []);
  const world = useWorld(), qc = useQueryClient(), player = usePlayer();
  const [factionId, setFaction] = useState(data.playerFactionId ?? data.factions[0]?.id ?? '');
  const faction = data.factions.find(f => f.id === factionId);
  const isCopyOf = (t: Token, source: Token) => t.id !== source.id && (t.data.drawerSourceId === source.id || !t.data.drawerSourceId && t.data.drawerName === source.name && t.factionId === source.factionId && t.kind === source.kind);
  const entries = data.tokens.filter(t => t.factionId === factionId && ['party', 'unit', 'character', 'marker'].includes(t.kind) && !t.data.drawerSourceId && !t.data.drawerName);
  const [adding, setAdding] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [campaign, setCampaign] = useState(data.campaigns[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: qk.map(world.id) }); await qc.invalidateQueries({ queryKey: ['w', world.id, 'players'] }); };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  return <motion.aside ref={drawerRef} initial={{ opacity: 0, x: 18, scale: 0.97 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 12, scale: 0.98, transition: { duration: 0.14 } }} transition={{ type: "spring", stiffness: 400, damping: 34 }} style={{ pointerEvents: present ? "auto" : "none" }} className="panel piece-drawer" aria-label="Faction token drawer">
    <header><Flag size={16} /><h4>Token drawer</h4>{faction && <button className="btn sm token-add" onClick={()=>setAdding(true)}><Plus size={14}/>Add token</button>}<label className="toggle"><input type="checkbox" aria-label="Show token trails" checked={showTrails} onChange={e => onShowTrails(e.target.checked)} /><Footprints size={14} /> Trails</label><button className="iconbtn" aria-label="Close token drawer" onClick={onClose}><X size={14} /></button></header>
    <div className="piece-factions" role="tablist" aria-label="Token drawer factions">
      {data.factions.filter(f => !player || f.id === data.playerFactionId).map(f => <button key={f.id} role="tab" aria-selected={f.id === factionId} className={`btn sm ${f.id === factionId ? 'on' : 'ghost'}`} onClick={() => { setFaction(f.id); setAdding(false); }}><span className="piece-faction-dot" style={{ background: f.color }} />{f.name}{f.isParty ? ' · Party' : ''}</button>)}
    </div>
    {!faction && <p className="muted">Create a faction in the Factions module first, then open its drawer.</p>}
    {faction && <>
      <div className="piece-palette scroll">
        {entries.map(t => <div className="piece-row" key={t.id}>
          <button className="poi grow piece-card" aria-label={`Select ${t.name}`} onClick={() => { if(t.hexId) { onSelect(t.id); onClose(); } else onPlace(t); }}><TokenPreview token={t} color={t.color ?? faction.color} /><span className="grow">{t.name}<small>{t.mainParty ? 'Main party' : String(t.data.role ?? t.kind)} · {t.hexId ? 'On map · Select to move' : 'In drawer · Select to place'}{!t.visibleToPlayers ? ' · Hidden' : ''}</small></span></button>
          {!player && <button className="btn ghost sm" aria-label={`Edit ${t.name}`} onClick={()=>onSelect(t.id)}>Edit token</button>}
          {data.tokens.some(c => isCopyOf(c, t)) && <details className="piece-instances piece-tool"><summary>Copies · {data.tokens.filter(c => isCopyOf(c, t)).length}</summary><div className="panel piece-tool-content piece-instance-list">{data.tokens.filter(c => isCopyOf(c, t)).map(c => <button key={c.id} className="poi" aria-label={`Select ${c.name}`} onClick={() => onSelect(c.id)}>{c.name} · {c.hexId ? 'Deployed' : 'In reserve'}</button>)}</div></details>}
        </div>)}
      </div>
      {!player && <>
        <div className="piece-tools"><details className="piece-tool" onToggle={e => { if (e.currentTarget.open) e.currentTarget.parentElement?.querySelectorAll<HTMLDetailsElement>("details").forEach(d => { if (d !== e.currentTarget) d.open = false; }); }}><summary>Party setup</summary><div className="panel piece-tool-content"><div className="label">Player party</div>
        {!data.tokens.some(t => t.factionId === factionId && t.mainParty) && <button className="btn" disabled={busy || !startHexId} title={startHexId ? "Start on the selected hex" : "Select a starting hex first"} onClick={() => run(async () => {
          await api(`/api/worlds/${world.id}/factions/${factionId}`, { method: 'PATCH', body: { isParty: true } });
          await api(`/api/worlds/${world.id}/tokens`, { body: { kind: 'party', name: faction.name, factionId, mainParty: true, hexId: startHexId, campaignId: campaign || null } });
        })}><Footprints size={14} /> Designate as player party</button>}
        {!startHexId && <p className="faint">Select the party’s starting hex before designating it.</p>}</div></details><details className="piece-tool" onToggle={e => { if (e.currentTarget.open) e.currentTarget.parentElement?.querySelectorAll<HTMLDetailsElement>("details").forEach(d => { if (d !== e.currentTarget) d.open = false; }); }}><summary>Player access</summary><div className="panel piece-tool-content">
          <p className="faint">Players can move this faction’s visible deployed pieces. If a campaign is selected, unexplored hexes conceal other factions’ tokens.</p>
          <select className="select" aria-label="Player campaign" value={campaign} onChange={e => setCampaign(e.target.value)}><option value="">No fog campaign</option>{data.campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input className="input" aria-label="Player username" placeholder="Player username" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" />
          <input className="input" aria-label="Player password" type="password" placeholder="Password (10+ characters)" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
          <button className="btn" disabled={busy || !username.trim() || password.length < 10} onClick={() => run(async () => { await api(`/api/worlds/${world.id}/players`, { body: { username, password, factionId, campaignId: campaign || null } }); setUsername(''); setPassword(''); })}>Create player account</button>
          <PlayerList />
        </div></details><Link className="btn ghost sm" to={`/w/${world.id}/settings#files`} onClick={onClose}>Manage files</Link></div>
    </>}
        {adding && <AddToken worldId={world.id} factionId={faction.id} color={faction.color} entries={entries} player={player} onClose={()=>setAdding(false)} onPlace={onPlace} onCopy={onDeployCopy} onSelect={onSelect}/> }
    </>}
  </motion.aside>;
}
function PlayerList() {
  const world = useWorld(), qc = useQueryClient();
  const key = ['w', world.id, 'players'];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ id: string; username: string }[]>(`/api/worlds/${world.id}/players`) });
  return <>{list.data?.map(u => <div className="row" key={u.id}><span className="grow">{u.username}</span><button className="btn ghost sm" onClick={async () => { try { await api(`/api/worlds/${world.id}/players/${u.id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: key }); } catch (e) { toastError(e); } }}>Revoke access</button></div>)}</>;
}
export function PieceControls({ token, data, onMove }: { token: Token; data: MapData; onMove: () => void }) {
  const world = useWorld(), qc = useQueryClient(), player = usePlayer(), [busy, setBusy] = useState(false);
  const pages = usePageIndex(world.id, !player);
  const miniatureStatus = useMiniatureStatus(token.worldId, token.modelId);
  const [visibility, setVisibility] = useState<boolean | null>(null);
  const models = useQuery({ queryKey: ['w', world.id, 'tokenModels'], enabled: !player, queryFn: () => api<{ id: string; name: string }[]>(`/api/worlds/${world.id}/token-models`) });
  const patch = async (body: Partial<Token>) => {
    await qc.cancelQueries({ queryKey: qk.map(world.id), exact: true });
    qc.setQueryData<MapData>(qk.map(world.id), data => data ? { ...data, tokens: data.tokens.map(t => t.id === token.id ? { ...t, ...body } : t) } : data);
    try { await api(`/api/worlds/${world.id}/tokens/${token.id}`, { method: 'PATCH', body }); } catch (e) { toastError(e); }
    finally { await qc.invalidateQueries({ queryKey: qk.map(world.id) }); }
  };
  const canMove = !player || token.factionId === data.playerFactionId && ['party', 'unit', 'character', 'marker'].includes(token.kind);
  return <div className="piece-controls">
    {canMove && !token.hexId && <button className="btn" onClick={onMove}><Footprints size={14} />{token.hexId ? 'Move to next hex' : 'Deploy on a hex'}</button>}
    {canMove && token.hexId && <p className="faint">Select the token, then click a highlighted hex or drag it there.</p>}
    {!player && <>
      <label className="toggle"><input type="checkbox" aria-label="Visible to players" disabled={token.mainParty || visibility !== null} checked={visibility ?? token.visibleToPlayers} onChange={e => { const visible = e.target.checked; setVisibility(visible); void patch({ visibleToPlayers: visible }).finally(() => setVisibility(null)); }} />{(visibility ?? token.visibleToPlayers) ? <Eye size={14} /> : <EyeOff size={14} />} Visible to players</label>
      <div className="field">Appearance<div className="token-appearance-grid"><button className={`token-preset ${!token.modelId?'on':''}`} aria-label="Use 2D indicator" aria-pressed={!token.modelId} onClick={()=>void patch({modelId:null})}><MarkerIcon kind={token.kind} color={data.factions.find(f=>f.id===token.factionId)?.color??'#d6b06a'} size={30}/><span>2D indicator</span></button>{models.data?.map(m=><button key={m.id} className={`token-preset ${token.modelId===m.id?'on':''}`} aria-label={`Use miniature ${m.name}`} aria-pressed={token.modelId===m.id} onClick={()=>void patch({modelId:m.id})}><TokenPreview token={{...token,modelId:m.id,name:m.name}} color={data.factions.find(f=>f.id===token.factionId)?.color??'#d6b06a'}/><span>{m.name.replace(/\.glb$/i,'')}</span></button>)}</div></div>
      {token.modelId && <div className={miniatureStatus?.state === 'error' ? 'miniature-error' : 'faint'} role="status">{!token.hexId ? 'Miniature will load when deployed.' : miniatureStatus?.state === 'ready' ? '3D miniature ready' : miniatureStatus?.state === 'error' ? <>{miniatureStatus.message}<button className="btn ghost sm" onClick={() => retryMiniature(token.worldId, token.modelId!)}>Retry miniature</button></> : 'Loading 3D miniature…'}</div>}
      <label className="field">Token sheet<select className="select" aria-label="Token sheet" value={String(token.data.sheetPageId ?? '')} onChange={e => patch({ data: { ...token.data, sheetPageId: e.target.value || null } })}><option value="">No sheet assigned</option>{pages.data?.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
      {pages.data?.some(p => p.id === token.data.sheetPageId) && <Link className="btn ghost sm" to={`/w/${world.id}/wiki/${token.data.sheetPageId}`}>Open token sheet</Link>}
      <span className="faint">Link a wiki page for this token’s sheet. New copies use the same sheet.</span>
      <label className="btn"><Box size={14} />{busy ? 'Uploading…' : 'Upload GLB miniature'}<input type="file" accept=".glb" hidden disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true);
        try { if (file.size > 10 * 1024 * 1024) throw new Error('Miniatures must be under 10 MB.'); const response = await pendingWrites.track(fetch(`/api/worlds/${world.id}/token-models?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'model/gltf-binary' }, body: file })); const model = await response.json(); if (!response.ok) throw new Error(model.error); await patch({ modelId: model.id }); qc.invalidateQueries({ queryKey: ['w', world.id, 'tokenModels'] }); } catch (e) { toastError(e); } finally { setBusy(false); }
      }} /></label>
      {token.hexId && !token.mainParty && <button className="btn ghost sm" onClick={() => patch({ hexId: null })}>Return to drawer</button>}
    </>}
    {!!token.trail?.length && <details open={token.mainParty}><summary>Movement log · {token.trail.filter(v => v.hexId).length} visits</summary><ol className="piece-history">{token.trail.map((v, i) => {
      const h = data.hexes.find(h => h.id === v.hexId); return <li key={i}>{h ? h.name || `Hex ${h.q}, ${h.r}` : 'Trail break / off-map'} <span className="faint">· Day {v.day}</span></li>;
    })}</ol></details>}
  </div>;
}
