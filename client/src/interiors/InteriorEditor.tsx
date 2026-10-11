import { useState } from 'react';
import { Map, Box, Upload, Trash2 } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { api, clientHeaders, pendingWrites } from '../api';
import { toastError } from '../components/toast';
import { InteriorBoard } from './InteriorBoard';
import type { Interior } from '../../../shared/interiors';
import { interiorCell } from '../../../shared/interiors';
export function InteriorEditor({worldId,hexId,initial,onClose,onSaved}: {worldId:string;hexId:string;initial:Interior|null;onClose:()=>void;onSaved:()=>Promise<unknown>}) {
  const [value,setValue]=useState<Interior>(initial??{id:'draft',worldId,hexId,name:'',mode:'2d',cols:24,rows:18,entryX:0,entryY:0,visibleToPlayers:false,asset:null});
  const [busy,setBusy]=useState(false),[confirm,setConfirm]=useState<'map'|'interior'|null>(null);
  const path=`/api/worlds/${worldId}/interiors`;
  const save=async()=>{
    if(!interiorCell(value.entryX,value.entryY,value.cols,value.rows))throw Error('Click an entry square within the map’s grid.');
    const {name,mode,cols,rows,entryX,entryY,visibleToPlayers}=value;
    const result=await api<Interior>(value.id==='draft'?path:`${path}/${value.id}`,{method:value.id==='draft'?'POST':'PATCH',body:{name,mode,cols,rows,entryX,entryY,visibleToPlayers,...(value.id==='draft'?{hexId}: {})}});
    const next={...value,...result,asset:value.asset};setValue(next);await onSaved();return next;
  };
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();}catch(e){toastError(e);}finally{setBusy(false);}};
  return <Dialog open onClose={()=>{if(!busy)onClose();}} title={initial?'Interior settings':'Link an interior'}><div className="interior-editor">
    <label className="field">Name<input className="input" aria-label="Interior name" maxLength={120} value={value.name} onChange={e=>setValue(v=>({...v,name:e.target.value}))} disabled={busy}/></label>
    <div className="row"><button className={`btn ${value.mode==='2d'?'on':'ghost'}`} disabled={busy||!!value.asset&&value.mode!=='2d'} onClick={()=>setValue(v=>({...v,mode:'2d'}))}><Map size={16}/>2D image</button><button className={`btn ${value.mode==='3d'?'on':'ghost'}`} disabled={busy||!!value.asset&&value.mode!=='3d'} onClick={()=>setValue(v=>({...v,mode:'3d'}))}><Box size={16}/>3D model</button></div>
    <div className="row"><label className="field grow">Columns<input className="input" aria-label="Interior columns" type="number" min={1} max={200} value={value.cols} disabled={busy} onChange={e=>setValue(v=>({...v,cols:Math.max(1,Math.min(200,Number(e.target.value)||1))}))}/></label><label className="field grow">Rows<input className="input" aria-label="Interior rows" type="number" min={1} max={200} value={value.rows} disabled={busy} onChange={e=>setValue(v=>({...v,rows:Math.max(1,Math.min(200,Number(e.target.value)||1))}))}/></label></div>
    <p className="faint">One square = 5 feet. Match the dimensions to your image’s grid; a 3D model fits within this footprint. Click the map to set the party’s entry square.</p>
    <div className="interior-entry-preview"><InteriorBoard interior={value} tokens={[]} positions={[]} showEntry onCell={(x,y)=>{if(!busy)setValue(v=>({...v,entryX:x,entryY:y}));}}/></div>
    <div className="row"><span className="faint grow">Entry: column {value.entryX+1}, row {value.entryY+1}</span><label className="toggle"><input type="checkbox" checked={value.visibleToPlayers} disabled={busy} onChange={e=>setValue(v=>({...v,visibleToPlayers:e.target.checked}))}/>Visible to players</label></div>
    <label className={`btn ${busy||!value.name.trim()?'disabled':''}`}><Upload size={14}/>{busy?'Saving…':value.asset?'Replace map':'Upload map'}<input type="file" aria-label="Interior map file" hidden disabled={busy||!value.name.trim()} accept={value.mode==='3d'?'.glb':'.png,.jpg,.jpeg,.webp,.gif'} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>{if(file.size>40*1024*1024)throw Error('Interior maps must be under 40 MB.');const saved=await save();const response=await pendingWrites.track(fetch(`${path}/${saved.id}/asset`,{method:'PUT',headers:{...clientHeaders,'content-type':value.mode==='3d'?'model/gltf-binary':file.type,'x-file-name':file.name},body:file}));const asset=await response.json();if(!response.ok)throw Error(asset.error);setValue(v=>({...v,asset}));await onSaved();});}}/></label>
    {value.asset&&<div className="row"><span className="faint grow">{value.asset.name}</span><button className="btn ghost sm" disabled={busy} onClick={()=>setConfirm('map')}>Remove map</button></div>}
    {confirm&&<div className="interior-confirm" role="alert"><p>{confirm==='map'?'Permanently remove this uploaded map? The interior and party positions remain.':'Delete this interior and its uploaded map? Parties must leave first.'}</p><div className="row"><button className="btn ghost sm" disabled={busy} onClick={()=>setConfirm(null)}>Keep it</button><button className="btn danger-solid sm" disabled={busy} onClick={()=>void run(async()=>{await api(`${path}/${value.id}${confirm==='map'?'/asset':''}?confirm=delete`,{method:'DELETE'});await onSaved();if(confirm==='interior')onClose();else{setValue(v=>({...v,asset:null}));setConfirm(null);}})}>Confirm deletion</button></div></div>}
    <div className="actions">{value.id!=='draft'&&<button className="btn danger ghost" disabled={busy} onClick={()=>setConfirm('interior')}><Trash2 size={14}/>Delete interior</button>}<button className="btn ghost" disabled={busy} onClick={onClose}>Close</button><button className="btn" disabled={busy||!value.name.trim()} onClick={()=>void run(save)}>{value.id==='draft'?'Create interior':'Save changes'}</button></div>
  </div></Dialog>;
}
