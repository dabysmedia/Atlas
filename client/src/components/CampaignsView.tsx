import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, qk } from '../api';
import type { Campaign } from '../types';
import { useWorld } from '../world';
import { toastError } from './toast';

export function CampaignsView() {
  const world = useWorld();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: qk.campaigns(world.id), queryFn: () => api<Campaign[]>(`/api/worlds/${world.id}/campaigns`) });
  const [name, setName] = useState('');
  const [system, setSystem] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: qk.campaigns(world.id) }); qc.invalidateQueries({ queryKey: qk.map(world.id) }); };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api(`/api/worlds/${world.id}/campaigns`, { body: { name: name.trim(), system } }); setName(''); refresh(); } catch (err) { toastError(err); }
  };
  const patch = async (c: Campaign, p: Partial<Campaign>) => {
    qc.setQueryData<Campaign[]>(qk.campaigns(world.id), (xs) => xs?.map((x) => (x.id === c.id ? { ...x, ...p } : x)));
    try { await api(`/api/worlds/${world.id}/campaigns/${c.id}`, { method: 'PATCH', body: p }); if (p.name) refresh(); } catch (err) { toastError(err); }
  };
  const del = async (c: Campaign) => {
    if (!window.confirm(`Delete the campaign "${c.name}"? Its party fog goes with it; its chronicle entries stay.`)) return;
    try { await api(`/api/worlds/${world.id}/campaigns/${c.id}`, { method: 'DELETE' }); refresh(); } catch (err) { toastError(err); }
  };
  return (
    <div className="pagewrap scroll">
      <div className="pagebody" style={{ maxWidth: 900 }}>
        <div className="pagehead"><h1>Campaigns</h1><span className="muted" style={{ marginBottom: 6 }}>Campaigns share {world.name}&rsquo;s lore; each has its own party fog.</span></div>
        <table className="table">
          <thead><tr><th>Name</th><th style={{ width: 180 }}>System</th><th style={{ width: 130 }}>Status</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {(list.data ?? []).map((c) => (
              <tr key={c.id}>
                <td><input className="input bare" defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && patch(c, { name: e.target.value.trim() })} /></td>
                <td><input className="input bare" defaultValue={c.system} placeholder="System" onBlur={(e) => e.target.value !== c.system && patch(c, { system: e.target.value })} /></td>
                <td>
                  <select className="select" value={c.status} onChange={(e) => patch(c, { status: e.target.value })}>
                    <option value="active">Active</option><option value="paused">Paused</option><option value="finished">Finished</option>
                  </select>
                </td>
                <td><button className="btn ghost sm icon danger" onClick={() => del(c)} aria-label="Delete campaign"><Trash2 size={13} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="row" style={{ marginTop: 16 }} onSubmit={add}>
          <input className="input" placeholder="New campaign name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" style={{ maxWidth: 220 }} placeholder="System (e.g. Call of Cthulhu)" value={system} onChange={(e) => setSystem(e.target.value)} />
          <button className="btn primary" disabled={!name.trim()}><Plus size={14} /> Add</button>
        </form>
      </div>
    </div>
  );
}
