import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Download, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { api, qk } from '../api';
import { useWorld } from '../world';
import { TokenPreview } from '../map/TokenPreview';
import { Dialog } from './Dialog';
import { toastError } from './toast';
export type UploadedFile = { id: string; name: string; size: number; kind: string; mime: string; date: string; uses: string[]; blocked: string | null };
const kinds: Record<string, string> = { miniature: 'Miniatures', 'wiki-image': 'Wiki images', 'map-art': 'Map art', terrain: 'Terrain', 'terrain-archive': 'Archived terrain' };
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
export function FileManager() {
  const world = useWorld(), qc = useQueryClient(), location = useLocation(), section = useRef<HTMLElement>(null);
  const me = useQuery({ queryKey: qk.me, queryFn: () => api<{ role: string }>('/api/auth/me'), staleTime: Infinity });
  const key = ['w', world.id, 'files'];
  const files = useQuery({ queryKey: key, enabled: me.data?.role === 'gm', queryFn: () => api<UploadedFile[]>(`/api/worlds/${world.id}/files`) });
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [order, setOrder] = useState('newest');
  const [rename, setRename] = useState<UploadedFile | null>(null), [name, setName] = useState('');
  const [remove, setRemove] = useState<UploadedFile | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { setRename(null); setRemove(null); }, [world.id]);
  useEffect(() => { if (location.hash === '#files' && me.data?.role === 'gm') section.current?.scrollIntoView({ block: 'start' }); }, [location.hash, me.data?.role, files.isPending]);
  const path = (f: UploadedFile) => `/api/worlds/${world.id}/files/${f.kind}/${f.id}`;
  const save = async (f: UploadedFile, deleting: boolean) => {
    setBusy(true);
    try {
      await api(path(f) + (deleting ? '?confirm=delete' : ''), { method: deleting ? 'DELETE' : 'PATCH', ...(!deleting && { body: { name } }) });
      setRename(null); setRemove(null);
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: qk.map(world.id) }), qc.invalidateQueries({ queryKey: ['w', world.id, 'tokenModels'] }), qc.invalidateQueries({ queryKey: ['modelArchive', world.id] })]);
    } catch (error) { toastError(error); } finally { setBusy(false); }
  };
  if (me.data?.role !== 'gm') return null;
  const visible = (files.data ?? []).filter(f => (filter === 'all' || f.kind === filter) && f.name.toLowerCase().includes(search.toLowerCase())).sort((a,b) => order === 'name' ? a.name.localeCompare(b.name) : order === 'size' ? b.size-a.size : Date.parse(b.date)-Date.parse(a.date));
  return <section id="files" ref={section} className="file-manager" aria-label="Uploaded files">
    <h3 className="display"><FolderOpen size={18} /> Uploaded files</h3>
    <p className="muted">Files saved for this world. Rename, download, or remove accidental uploads.</p>
    <div className="card"><div className="card-body">
      <div className="file-toolbar">
        <input className="input grow" aria-label="Search uploaded files" placeholder="Search files…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select" aria-label="File type" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All files</option>{Object.entries(kinds).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="select" aria-label="Sort files" value={order} onChange={e => setOrder(e.target.value)}><option value="newest">Newest first</option><option value="name">Name</option><option value="size">Largest first</option></select>
      </div>
      {files.isPending && <p role="status">Loading files…</p>}
      {files.error && <p role="alert">{files.error.message} <button className="btn sm" onClick={() => void files.refetch()}>Retry</button></p>}
      {!files.isPending && !files.error && <p className="faint">{visible.length} files · {sizeLabel((files.data ?? []).reduce((n,f) => n+f.size,0))} stored</p>}
      <div className="file-list">{visible.map(f => <article className="file-row" key={`${f.kind}/${f.id}`} aria-label={f.name}>
        {f.mime.startsWith('image/') ? <img className="file-thumb" src={f.kind === 'wiki-image' ? `/api/worlds/${world.id}/wiki-images/${f.id}` : `/api/worlds/${world.id}/map/art?v=${Date.parse(f.date)}`} alt={f.name} /> : <TokenPreview token={{ worldId: world.id, modelId: f.kind === 'miniature' ? f.id : null, name: f.name, kind: 'unit' }} color={world.accent} />}
        <div className="file-info"><b>{f.name}</b><small>{kinds[f.kind]} · {sizeLabel(f.size)} · {new Date(f.date).toLocaleDateString()}</small>
          <details><summary>{f.uses.length ? `Used by ${f.uses.length} ${f.kind === 'wiki-image' ? 'pages' : f.kind === 'miniature' ? 'pieces' : 'map'}` : 'Unused'}</summary>{f.uses.map((use,i) => <div key={i}>{use}</div>)}</details>
          {f.blocked && <small>{f.blocked}</small>}
        </div>
        <div className="file-actions">
          <a className="btn ghost sm icon" href={`${path(f)}/content`} aria-label={`Download ${f.name}`}><Download size={14} /></a>
          <button className="btn ghost sm icon" aria-label={`Rename ${f.name}`} onClick={() => { setRename(f); setName(f.name); }}><Pencil size={14} /></button>
          <button className="btn ghost sm icon danger" aria-label={`Delete ${f.name}`} disabled={!!f.blocked} title={f.blocked ?? 'Delete file'} onClick={() => setRemove(f)}><Trash2 size={14} /></button>
        </div>
      </article>)}</div>
      {!files.isPending && !files.error && !visible.length && <p className="faint">{search || filter !== 'all' ? 'No matching files.' : 'No uploaded files yet.'}</p>}
    </div></div>
    <Dialog open={!!rename} onClose={() => { if (!busy) setRename(null); }} title="Rename file">
      <form onSubmit={e => { e.preventDefault(); if (rename && name.trim() && !busy) void save(rename,false); }}>
        <input className="input" autoFocus aria-label="File name" maxLength={120} value={name} onChange={e => setName(e.target.value)} />
        <div className="actions"><button type="button" className="btn ghost" disabled={busy} onClick={() => setRename(null)}>Cancel</button><button className="btn primary" disabled={busy || !name.trim()}>Save name</button></div>
      </form>
    </Dialog>
    <Dialog open={!!remove} onClose={() => { if (!busy) setRemove(null); }} title="Delete uploaded file?">
      <p>Delete <b>{remove?.name}</b> permanently? This cannot be undone.</p>
      {remove?.kind === 'miniature' && !!remove.uses.length && <p>{remove.uses.length} assigned pieces will use their 2D indicators. Their positions, sheets, and movement history stay saved.</p>}
      {remove?.kind === 'map-art' && <p>This removes the map’s background image. Hex data stays saved.</p>}
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={() => setRemove(null)}>Keep file</button><button className="btn danger-solid" disabled={busy} onClick={() => { if (remove) void save(remove,true); }}>Delete file permanently</button></div>
    </Dialog>
  </section>;
}
