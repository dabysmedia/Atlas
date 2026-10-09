import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Plus, X } from 'lucide-react';
import { api, qk } from '../api';
import type { HexStateType, TerrainType, World } from '../types';
import { useWorld } from '../world';
import { toast, toastError } from './toast';
import { ambientPref } from '../prefs';
import { useAmbientPref } from './AmbientMap';

const GLYPHS = ['none', 'grass', 'trees', 'hills', 'peaks', 'reeds', 'dunes', 'waves'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `t${Date.now()}`;

export function SettingsView() {
  const world = useWorld();
  const qc = useQueryClient();
  const [name, setName] = useState(world.name);
  const [description, setDescription] = useState(world.description);
  const [accent, setAccent] = useState(world.accent);
  const [terrain, setTerrain] = useState<TerrainType[]>(world.terrainTypes);
  const [states, setStates] = useState<HexStateType[]>(world.hexStates);
  const ambient = useAmbientPref();
  const dirty = name !== world.name || description !== world.description || accent !== world.accent
    || JSON.stringify(terrain) !== JSON.stringify(world.terrainTypes) || JSON.stringify(states) !== JSON.stringify(world.hexStates);

  const save = async () => {
    try {
      const w = await api<World>(`/api/worlds/${world.id}`, { method: 'PATCH', body: { name, description, accent, terrainTypes: terrain, hexStates: states } });
      qc.setQueryData(qk.world(world.id), w);
      qc.invalidateQueries({ queryKey: qk.worlds });
      toast('World saved');
    } catch (e) { toastError(e); }
  };

  return (
    <div className="pagewrap scroll">
      <div className="pagebody" style={{ maxWidth: 860 }}>
        <div className="pagehead">
          <h1>World</h1>
          <div className="spacer" />
          <button className="btn primary" disabled={!dirty || !name.trim()} onClick={save}><Check size={14} /> Save changes</button>
        </div>
        <div className="card"><div className="card-body">
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <div className="grow">
              <div className="field"><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field"><label className="label">Description</label><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            </div>
            <div className="field"><label className="label">Accent</label><input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} style={{ width: 60, height: 40, border: 0, background: 'none' }} /></div>
          </div>
        </div></div>

        <h3 className="display" style={{ margin: '28px 0 6px' }}>Terrain types</h3>
        <p className="muted" style={{ marginTop: 0 }}>Hexes store the key; renaming or recoloring a type updates every hex that uses it.</p>
        <div className="card"><div className="card-body">
          {terrain.map((t, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input type="color" value={t.color} onChange={(e) => setTerrain(terrain.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} style={{ width: 34, height: 30, border: 0, background: 'none' }} />
              <input className="input" value={t.name} onChange={(e) => setTerrain(terrain.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <select className="select" style={{ width: 120 }} value={t.glyph ?? 'none'} onChange={(e) => setTerrain(terrain.map((x, j) => (j === i ? { ...x, glyph: e.target.value } : x)))} title="Map mark">
                {GLYPHS.map((g) => <option key={g}>{g}</option>)}
              </select>
              <span className="faint" style={{ width: 90, fontSize: 12 }}>{t.key}</span>
              <button className="btn ghost sm icon" disabled={t.key === 'unknown'} onClick={() => setTerrain(terrain.filter((_, j) => j !== i))} aria-label="Remove"><X size={13} /></button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => {
            const n = `Terrain ${terrain.length + 1}`;
            setTerrain([...terrain, { key: slug(n), name: n, color: '#888888', glyph: 'none' }]);
          }}><Plus size={13} /> Terrain type</button>
        </div></div>

        <h3 className="display" style={{ margin: '28px 0 6px' }}>Hex states</h3>
        <p className="muted" style={{ marginTop: 0 }}>States with a color show as a small marker on the map.</p>
        <div className="card"><div className="card-body">
          {states.map((s, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input type="color" value={s.color ?? '#000000'} onChange={(e) => setStates(states.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} style={{ width: 34, height: 30, border: 0, background: 'none', opacity: s.color ? 1 : 0.3 }} />
              <input className="input" value={s.name} onChange={(e) => setStates(states.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <button className="btn ghost sm" onClick={() => setStates(states.map((x, j) => (j === i ? { ...x, color: x.color ? undefined : '#cccccc' } : x)))}>{s.color ? 'No marker' : 'Marker'}</button>
              <span className="faint" style={{ width: 90, fontSize: 12 }}>{s.key}</span>
              <button className="btn ghost sm icon" disabled={states.length <= 1} onClick={() => setStates(states.filter((_, j) => j !== i))} aria-label="Remove"><X size={13} /></button>
            </div>
          ))}
          <button className="btn ghost sm" onClick={() => { const n = `State ${states.length + 1}`; setStates([...states, { key: slug(n), name: n }]); }}><Plus size={13} /> Hex state</button>
        </div></div>

        <h3 className="display" style={{ margin: '28px 0 6px' }}>Display</h3>
        <p className="muted" style={{ marginTop: 0 }}>Saved in this browser only.</p>
        <div className="card"><div className="card-body">
          <label className="toggle"><input type="checkbox" checked={ambient} onChange={(e) => ambientPref.set(e.target.checked)} /> Show the world map behind pages</label>
        </div></div>
      </div>
    </div>
  );
}
