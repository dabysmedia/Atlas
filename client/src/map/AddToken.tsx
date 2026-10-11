import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MapPin, Check } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { api, qk } from '../api';
import { toastError } from '../components/toast';
import type { Token, TokenKind } from '../types';
import { TokenPreview } from './TokenPreview';
const PRESETS: { name: string; kind: TokenKind; description: string }[] = [
  { name: 'Scouting party', kind: 'unit', description: 'Explore ahead' },
  { name: 'Soldiers', kind: 'unit', description: 'A fighting company' },
  { name: 'Envoy', kind: 'character', description: 'A diplomatic presence' },
  { name: 'Caravan', kind: 'unit', description: 'Supplies and trade' },
  { name: 'Fleet', kind: 'unit', description: 'A naval force' },
  { name: 'Character', kind: 'character', description: 'An individual' },
  { name: 'Party', kind: 'party', description: 'An adventuring group' },
];
type Choice = { key: string; name: string; kind: TokenKind; role: string; modelId: string | null; source?: Token; description: string };
export function AddToken({ worldId, factionId, color, entries, player, onClose, onPlace, onCopy, onSelect }: {
  worldId: string; factionId: string; color: string; entries: Token[]; player: boolean;
  onClose: () => void; onPlace: (t: Token) => void; onCopy: (t: Token) => void; onSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['w', worldId, 'tokenModels'], enabled: !player, queryFn: () => api<{ id: string; name: string }[]>(`/api/worlds/${worldId}/token-models`) });
  const saved: Choice[] = entries.filter(t => !t.mainParty && (!player || t.visibleToPlayers)).map(t => ({ key:t.id,name:t.name,kind:t.kind,role:String(t.data.role ?? t.kind),modelId:t.modelId,source:t,description:t.hexId ? 'Add another · model and sheet included' : 'Ready to place' }));
  const roles: Choice[] = player ? [] : PRESETS.map(p => ({ ...p,key:p.name,role:p.name,modelId:null }));
  const miniatures: Choice[] = player ? [] : (models.data ?? []).map(m => ({ key:m.id,name:m.name.replace(/\.glb$/i,'').replace(/[_-]+/g,' ').slice(0,120),kind:'unit',role:'Miniature',modelId:m.id,description:'3D miniature' }));
  const [choice, setChoice] = useState<Choice | null>(player ? saved[0] ?? null : roles[0]);
  const [name, setName] = useState(choice?.name ?? ''), [busy,setBusy] = useState(false);
  const choose = (next: Choice) => { setChoice(next); setName(next.name); };
  const create = async (place: boolean) => {
    if (!choice || busy) return;
    if (choice.source) { onClose(); choice.source.hexId ? onCopy(choice.source) : onPlace(choice.source); return; }
    setBusy(true);
    try {
      const token = await api<Token>(`/api/worlds/${worldId}/tokens`, { body:{name:name.trim(),kind:choice.kind,factionId,modelId:choice.modelId,data:{role:choice.role}} });
      await qc.invalidateQueries({queryKey:qk.map(worldId)});
      onClose(); if (place) onPlace(token); else onSelect(token.id);
    } catch(e) { toastError(e); } finally { setBusy(false); }
  };
  const section = (label: string, choices: Choice[]) => choices.length > 0 && <section className="token-preset-section"><div className="label">{label}</div><div className="token-preset-grid">{choices.map(p => <button key={p.key} className={`token-preset ${choice?.key===p.key?'on':''}`} aria-label={`Preset ${p.name}`} aria-pressed={choice?.key===p.key} disabled={busy} onClick={()=>choose(p)}>
    <TokenPreview token={{worldId,modelId:p.modelId,name:p.name,kind:p.kind}} color={color}/><span>{p.name}<small>{p.description}</small></span>{choice?.key===p.key&&<Check size={14} className="preset-check"/>}
  </button>)}</div></section>;
  return <Dialog open onClose={()=>{if(!busy)onClose();}} title="Add token">
    <div className="token-composer">
      <p className="faint">Choose a preset, then place it on the map.</p>
      <div className="token-preset-scroll">{section('Faction pieces',saved)}{section('Token presets',roles)}{section('Miniature presets',miniatures)}{player&&!saved.length&&<p className="muted">Your faction has no reserve pieces to add yet.</p>}{models.isError&&<button className="btn ghost sm" onClick={()=>models.refetch()}>Retry miniature presets</button>}</div>
      <label className="field">Token name<input className="input" aria-label="Token name" maxLength={120} value={name} readOnly={!!choice?.source} disabled={busy||!choice} onChange={e=>setName(e.target.value)}/></label>
      {choice?.source&&<p className="faint">Saved pieces keep their identity and sheet. Additional copies receive a numbered name.</p>}
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>{!player&&!choice?.source&&<button className="btn ghost" disabled={busy||!choice||!name.trim()} onClick={()=>void create(false)}><Plus size={14}/>Save to drawer</button>}<button className="btn" disabled={busy||!choice||!name.trim()} onClick={()=>void create(true)}><MapPin size={14}/>{busy?'Adding…':'Place token'}</button></div>
    </div>
  </Dialog>;
}
