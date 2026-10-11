import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Upload, ArrowLeft, ArrowRight } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { api } from '../api';
import { toastError } from '../components/toast';
import { InteriorBoard } from './InteriorBoard';
import { alignMapImage, gridDimensions, uploadInteriorMap, type ImageGrid } from './mapImport';
import type { Interior } from '../../../shared/interiors';

export function LocalMapWizard({ worldId, hexId, onClose, onSaved }: { worldId: string; hexId: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const [step, setStep] = useState<'import' | 'align' | 'name'>('import');
  const [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(''), [previewUrl, setPreviewUrl] = useState('');
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [grid, setGrid] = useState<ImageGrid>({ size: 50, x: 0, y: 0 });
  const [value, setValue] = useState<Interior>({ id: 'draft', worldId, hexId, name: '', mode: '2d', cols: 24, rows: 18, entryX: 0, entryY: 0, visibleToPlayers: false, asset: null });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [calibrating, setCalibrating] = useState(false), [corner, setCorner] = useState<{ x: number; y: number } | null>(null);
  const savedId = useRef<string | null>(null);
  const uploaded = useRef(false);
  const drag = useRef<{ x: number; y: number; grid: ImageGrid; moved: boolean } | null>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  const dimensions = image ? gridDimensions(image.naturalWidth, image.naturalHeight, grid) : { cols: value.cols, rows: value.rows };
  const validGrid = dimensions.cols <= 200 && dimensions.rows <= 200;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { const message = e instanceof Error ? e.message : 'The map could not be saved.'; setError(message); toastError(e); } finally { setBusy(false); } };
  const discardPartial = async () => {
    if (savedId.current && !uploaded.current) {
      await api(`/api/worlds/${worldId}/interiors/${savedId.current}?confirm=delete`, { method: 'DELETE' });
      savedId.current = null; await onSaved();
    }
  };
  const close = () => { if (!busy) void run(async () => { await discardPartial(); onClose(); }); };
  const importFile = (next: File) => run(async () => {
    if (next.size > 40 * 1024 * 1024) throw Error('Local maps must be under 40 MB.');
    const nextUrl = URL.createObjectURL(next), modeled = /\.glb$/i.test(next.name);
    let img: HTMLImageElement | null = null;
    try {
      if (!modeled) {
        if (!/\.(png|jpe?g|webp|gif)$/i.test(next.name)) throw Error('Choose a PNG, JPEG, WebP, GIF or self-contained GLB.');
        img = new Image(); img.src = nextUrl; await img.decode();
        if (img.naturalWidth * img.naturalHeight > 40_000_000) throw Error('Map art must be under 40 megapixels.');
      }
    } catch (e) { URL.revokeObjectURL(nextUrl); throw e; }
    try { await discardPartial(); } catch (e) { URL.revokeObjectURL(nextUrl); throw e; }
    setFile(next); setUrl(nextUrl); setImage(img); setPreviewUrl(''); savedId.current = null; uploaded.current = false;
    setGrid({ size: img ? Math.max(1, Math.round(Math.max(img.naturalWidth, img.naturalHeight) / 24)) : 50, x: 0, y: 0 });
    setValue(v => ({ ...v, mode: modeled ? '3d' : '2d', entryX: 0, entryY: 0 })); setStep('align');
  });
  const next = () => run(async () => {
    if (!file || !validGrid) return;
    const aligned = image ? await alignMapImage(file, image, grid) : file;
    setPreviewUrl(URL.createObjectURL(aligned));
    setValue(v => ({ ...v, ...dimensions, entryX: Math.min(v.entryX, dimensions.cols - 1), entryY: Math.min(v.entryY, dimensions.rows - 1) }));
    setStep('name');
  });
  const create = () => run(async () => {
    if (!file || !value.name.trim()) return;
    const art = image ? await alignMapImage(file, image, grid) : file;
    const path = `/api/worlds/${worldId}/interiors`, { name, mode, cols, rows, entryX, entryY, visibleToPlayers } = value;
    // Keep a successful create on upload failure so retry cannot duplicate the map.
    const saved = await api<Interior>(savedId.current ? `${path}/${savedId.current}` : path, { method: savedId.current ? 'PATCH' : 'POST', body: { name, mode, cols, rows, entryX, entryY, visibleToPlayers, ...(!savedId.current ? { hexId } : {}) } });
    savedId.current = saved.id;
    await uploadInteriorMap(`${path}/${saved.id}/asset`, art);
    uploaded.current = true;
    await onSaved(); onClose();
  });
  const point = (e: PointerEvent<SVGSVGElement>) => { const b = e.currentTarget.getBoundingClientRect(); return { x: (e.clientX - b.left) * image!.naturalWidth / b.width, y: (e.clientY - b.top) * image!.naturalHeight / b.height }; };
  const wrap = (n: number, size: number) => ((n % size) + size) % size;
  return <Dialog open onClose={close} title="Add a local map"><div className="interior-editor local-map-wizard">
    <ol className="local-map-steps" aria-label="Map import progress">{(['import', 'align', 'name'] as const).map((s, i) => <li key={s} aria-current={step === s ? 'step' : undefined}>{i + 1}. {s === 'import' ? 'Import art' : s === 'align' ? 'Align grid' : 'Name map'}</li>)}</ol>
    {error && <p className="local-map-error" role="alert">{error}</p>}
    {step === 'import' && <>
      <p>Choose the art for this local area. You’ll align its 5-foot grid next.</p>
      <label className="local-map-import btn"><Upload size={24}/><b>Import map art</b><span>PNG, JPEG, WebP, GIF or GLB · up to 40 MB</span><input type="file" aria-label="Interior map file" hidden disabled={busy} accept=".png,.jpg,.jpeg,.webp,.gif,.glb" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }}/></label>
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={close}>Cancel</button></div>
    </>}
    {step === 'align' && <>
      <p>{image ? 'Match the overlay to the art’s grid. Adjust square size, drag to position the grid, and click a square to mark the entry.' : 'Adjust the grid to the model’s footprint, then click the party’s entry square. One square is 5 feet.'}</p>
      {image ? <>
        <div className="local-map-alignment"><svg role="img" aria-label="Map grid alignment" viewBox={`0 0 ${image.naturalWidth} ${image.naturalHeight}`} style={{ aspectRatio: `${image.naturalWidth}/${image.naturalHeight}`, width: `min(100%, ${380 * image.naturalWidth / image.naturalHeight}px)`, margin: '0 auto' }}
          onPointerDown={e => { if (busy) return; if (calibrating) { const p = point(e); if (!corner) setCorner(p); else { const size = Number(Math.max(Math.abs(p.x - corner.x), Math.abs(p.y - corner.y)).toFixed(2)); if (size >= 1) { setGrid({ size, x: wrap(-Math.min(p.x, corner.x), size), y: wrap(-Math.min(p.y, corner.y), size) }); setValue(v => ({ ...v, entryX: 0, entryY: 0 })); setCalibrating(false); setCorner(null); } } return; } e.currentTarget.setPointerCapture(e.pointerId); drag.current = { ...point(e), grid, moved: false }; }}
          onPointerMove={e => { const d = drag.current; if (!d) return; const p = point(e); if (Math.hypot(p.x - d.x, p.y - d.y) > 3) d.moved = true; if (d.moved) setGrid({ ...d.grid, x: wrap(d.grid.x - (p.x - d.x), d.grid.size), y: wrap(d.grid.y - (p.y - d.y), d.grid.size) }); }}
          onPointerUp={e => { const d = drag.current; if (d && !d.moved) { const p = point(e); setValue(v => ({ ...v, entryX: Math.floor((p.x + grid.x) / grid.size), entryY: Math.floor((p.y + grid.y) / grid.size) })); } drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <image href={url} width={image.naturalWidth} height={image.naturalHeight}/>
          {corner && <circle cx={corner.x} cy={corner.y} r={Math.max(3, image.naturalWidth / 150)} fill="#8fe8e2"/>}
          <rect x={value.entryX * grid.size - grid.x} y={value.entryY * grid.size - grid.y} width={grid.size} height={grid.size} fill="rgba(143,232,226,.3)"/>
          <g stroke="rgba(0,0,0,.65)" strokeWidth={3} vectorEffect="non-scaling-stroke">{Array.from({ length: Math.min(201, dimensions.cols + 1) }, (_, i) => <path key={`x${i}`} d={`M${i * grid.size - grid.x} 0V${image.naturalHeight}`}/>)}{Array.from({ length: Math.min(201, dimensions.rows + 1) }, (_, i) => <path key={`y${i}`} d={`M0 ${i * grid.size - grid.y}H${image.naturalWidth}`}/>)}</g>
          <g stroke="#e9d8a6" strokeWidth={1} vectorEffect="non-scaling-stroke">{Array.from({ length: Math.min(201, dimensions.cols + 1) }, (_, i) => <path key={`x${i}`} d={`M${i * grid.size - grid.x} 0V${image.naturalHeight}`}/>)}{Array.from({ length: Math.min(201, dimensions.rows + 1) }, (_, i) => <path key={`y${i}`} d={`M0 ${i * grid.size - grid.y}H${image.naturalWidth}`}/>)}</g>
        </svg></div>
        <div className="row"><button className="btn sm" disabled={busy} onClick={() => { setCalibrating(c => !c); setCorner(null); }}>{calibrating ? 'Cancel square matching' : 'Match an existing square'}</button><span className="faint grow">{calibrating ? corner ? 'Click the opposite corner of that square.' : 'Click a corner of one square in the art.' : 'Or adjust the overlay below.'}</span></div>
        <label className="field">Square size · {grid.size.toFixed(1)} px<input aria-label="Grid square size" type="range" min={Math.max(1, Math.max(image.naturalWidth, image.naturalHeight) / 199)} max={Math.max(image.naturalWidth, image.naturalHeight)} step={0.1} value={grid.size} disabled={busy} onChange={e => { const size = Number(e.target.value); setGrid(g => ({ size, x: wrap(g.x, size), y: wrap(g.y, size) })); }}/></label>
        <div className="row"><label className="field grow">Horizontal alignment<input aria-label="Horizontal grid alignment" type="range" min={0} max={grid.size} step={0.1} value={grid.x} disabled={busy} onChange={e => setGrid(g => ({ ...g, x: Number(e.target.value) }))}/></label><label className="field grow">Vertical alignment<input aria-label="Vertical grid alignment" type="range" min={0} max={grid.size} step={0.1} value={grid.y} disabled={busy} onChange={e => setGrid(g => ({ ...g, y: Number(e.target.value) }))}/></label></div>
      </> : <>
        <div className="interior-entry-preview"><InteriorBoard interior={value} assetUrl={url} tokens={[]} positions={[]} showEntry onCell={(x, y) => setValue(v => ({ ...v, entryX: x, entryY: y }))}/></div>
        <label className="field">Grid width · {value.cols} squares<input aria-label="Model grid width" type="range" min={1} max={200} value={value.cols} disabled={busy} onChange={e => setValue(v => ({ ...v, cols: Number(e.target.value), entryX: 0 }))}/></label>
        <label className="field">Grid depth · {value.rows} squares<input aria-label="Model grid depth" type="range" min={1} max={200} value={value.rows} disabled={busy} onChange={e => setValue(v => ({ ...v, rows: Number(e.target.value), entryY: 0 }))}/></label>
      </>}
      <p className="faint">{dimensions.cols} × {dimensions.rows} squares · 5 feet each · Entry: column {Math.min(value.entryX + 1, dimensions.cols)}, row {Math.min(value.entryY + 1, dimensions.rows)}</p>
      {!validGrid && <p role="alert">Increase square size to keep each side within 200 squares.</p>}
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={() => setStep('import')}><ArrowLeft size={14}/>Back</button><button className="btn primary" disabled={busy || !validGrid} onClick={() => void next()}>Use this grid<ArrowRight size={14}/></button></div>
    </>}
    {step === 'name' && <>
      <label className="field">Map name<input className="input" aria-label="Interior name" autoFocus maxLength={120} value={value.name} disabled={busy} onChange={e => setValue(v => ({ ...v, name: e.target.value }))} placeholder="e.g. The ruined watchtower"/></label>
      <div className="interior-entry-preview"><InteriorBoard interior={value} assetUrl={previewUrl} tokens={[]} positions={[]} showEntry onCell={(x, y) => { if (!busy) setValue(v => ({ ...v, entryX: x, entryY: y })); }}/></div>
      <div className="row"><span className="faint grow">Entry: column {value.entryX + 1}, row {value.entryY + 1}</span><label className="toggle"><input type="checkbox" checked={value.visibleToPlayers} disabled={busy} onChange={e => setValue(v => ({ ...v, visibleToPlayers: e.target.checked }))}/>Visible to players</label></div>
      <div className="actions"><button className="btn ghost" disabled={busy} onClick={() => setStep('align')}><ArrowLeft size={14}/>Back</button><button className="btn primary" disabled={busy || !value.name.trim()} onClick={() => void create()}>{busy ? 'Saving map…' : 'Create local map'}</button></div>
    </>}
  </div></Dialog>;
}
