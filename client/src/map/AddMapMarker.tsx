import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, qk } from '../api';
import type { MapData, Token, TokenKind } from '../types';
import { useWorld } from '../world';
import { TOKEN_KINDS, isNotableKind } from '../../../shared/markers';
import { isSettlementKind } from '../../../shared/settlements';
import { Dialog } from '../components/Dialog';
import { toastError } from '../components/toast';
import { MarkerIcon } from './PanelPrimitives';

export function AddMapMarker({ hexId, data, onPlaced }: { hexId: string; data: MapData; onPlaced: (t: Token) => void }) {
  const world = useWorld(), qc = useQueryClient();
  const touch = () => qc.invalidateQueries({ queryKey: qk.events(world.id) });
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TokenKind>('temple');
  const [name, setName] = useState('');
  const [factionId, setFactionId] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const t = await api<Token>(`/api/worlds/${world.id}/tokens`, {
        body: { kind, name: name.trim(), hexId, factionId: factionId || null, campaignId: kind === 'party' ? data.campaigns[0]?.id ?? null : null },
      });
      qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? { ...d, tokens: [...d.tokens, t] } : d));
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
          <div className="kind-grid" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
            {TOKEN_KINDS.filter(k=>!isSettlementKind(k.kind)).map((k) => (
              <button type="button" key={k.kind} className={`kind-opt ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(k.kind)}>
                <MarkerIcon kind={k.kind} color={data.factions.find((f) => f.id === factionId)?.color ?? '#b9b2a3'} size={22} />{k.label}
              </button>
            ))}
          </div>
          {isNotableKind(kind) && <div className="faint">Visible during exploration.</div>}
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
