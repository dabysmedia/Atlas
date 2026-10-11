import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, Plus, Settings2 } from 'lucide-react';
import { api } from '../api';
import { toastError } from '../components/toast';
import { useWorld } from '../world';
import { usePlayer } from '../map/PieceDrawer';
import type { Focus } from '../map/panels';
import type { MapData } from '../types';
import type { HexMapRenderer3D } from '../map3d/renderer3d';
import type { Interior, InteriorState } from '../../../shared/interiors';
import { InteriorEditor } from './InteriorEditor';
import { InteriorBoard } from './InteriorBoard';
export function useInteriorLayer(data:MapData|undefined,setFocus:(focus:Focus)=>void,renderer:()=>HexMapRenderer3D|null) {
  const world=useWorld(),player=usePlayer(),qc=useQueryClient(),key=['w',world.id,'interiors'];
  const query=useQuery({queryKey:key,queryFn:()=>api<InteriorState>(`/api/worlds/${world.id}/interiors`)});
  const [active,setActive]=useState<{id:string;hexId:string;tokenId:string|null}|null>(null),[ready,setReady]=useState(false),[exiting,setExiting]=useState(false),[busy,setBusy]=useState(false);
  const [editor,setEditor]=useState<{hexId:string;initial:Interior|null}|null>(null),[pickedParty,setPickedParty]=useState<string|null>(null);
  const timer=useRef<number|undefined>(undefined),origin=useRef({x:0,y:0}),dismissed=useRef(new Set<string>());
  const state=query.data,interior=state?.interiors.find(i=>i.id===active?.id),position=state?.positions.find(p=>p.tokenId===active?.tokenId&&p.interiorId===active.id);
  const refresh=async()=>{await Promise.all([qc.invalidateQueries({queryKey:key}),qc.invalidateQueries({queryKey:['w',world.id,'files']}),qc.invalidateQueries({queryKey:['w',world.id,'events']})]);};
  const exitAnimation=(hexId:string)=>{if(timer.current)return;for(const p of state?.positions??[])dismissed.current.add(`${p.tokenId}/${p.interiorId}`);setExiting(true);const r=renderer();if(r){r.suspended=false;r.invalidate();}setFocus({kind:'hex',id:hexId});timer.current=window.setTimeout(()=>{timer.current=undefined;setActive(null);setReady(false);setExiting(false);},650);};
  useEffect(()=>()=>{clearTimeout(timer.current);const r=renderer();if(r)r.suspended=false;},[]);
  useEffect(()=>{
    if(!state||!data||exiting)return;
    for(const key of dismissed.current)if(!state.positions.some(p=>`${p.tokenId}/${p.interiorId}`===key))dismissed.current.delete(key);
    if(active&&!interior){exitAnimation(active.hexId);return;}
    if(active?.tokenId&&!data.tokens.some(t=>t.id===active.tokenId)){exitAnimation(active.hexId);return;}
    if(active?.tokenId&&!state.positions.some(p=>p.tokenId===active.tokenId&&p.interiorId===active.id)){if(interior)exitAnimation(interior.hexId);return;}
    if(!active){const p=[...state.positions].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).find(p=>!dismissed.current.has(`${p.tokenId}/${p.interiorId}`)&&data.tokens.some(t=>t.id===p.tokenId));const i=p&&state.interiors.find(i=>i.id===p.interiorId);if(p&&i){const r=renderer();origin.current=r?.hexScreen(i.hexId)??{x:innerWidth/2,y:innerHeight/2};setFocus({kind:'hex',id:i.hexId});setActive({id:i.id,hexId:i.hexId,tokenId:p.tokenId});setReady(false);}}
  },[state,data,active,exiting]);
  useEffect(()=>{const r=renderer();if(r)r.suspended=!!active&&ready&&!exiting;});
  const enter=async(i:Interior,tokenId:string|null)=>{
    if(busy)return;setBusy(true);
    try{
      if(tokenId){const existing=state?.positions.find(p=>p.tokenId===tokenId);if(existing&&existing.interiorId!==i.id)throw Error('The party must leave its current interior first.');if(!existing){const p=await api<InteriorState['positions'][number]>(`/api/worlds/${world.id}/interiors/${i.id}/enter`,{body:{tokenId}});qc.setQueryData<InteriorState>(key,old=>old?{...old,positions:[...old.positions,p]}:old);}}
      origin.current=renderer()?.hexScreen(i.hexId)??{x:innerWidth/2,y:innerHeight/2};setFocus({kind:'hex',id:i.hexId});setReady(false);setExiting(false);setActive({id:i.id,hexId:i.hexId,tokenId});await refresh();
    }catch(e){toastError(e);}finally{setBusy(false);}
  };
  const leave=async()=>{if(!interior||busy)return;setBusy(true);try{if(position){await api(`/api/worlds/${world.id}/interiors/${interior.id}/leave`,{body:{tokenId:position.tokenId,revision:position.revision}});qc.setQueryData<InteriorState>(key,old=>old?{...old,positions:old.positions.filter(p=>p.tokenId!==position.tokenId)}:old);}exitAnimation(interior.hexId);await refresh();}catch(e){toastError(e);await refresh();}finally{setBusy(false);}};
  const sidebar=(hexId:string)=>{
    const links=state?.interiors.filter(i=>i.hexId===hexId)??[],parties=data?.tokens.filter(t=>t.mainParty&&t.hexId===hexId&&(!player||t.factionId===data.playerFactionId))??[];
    const party=parties.find(t=>t.id===pickedParty)??parties[0];
    if(player&&!links.length)return null;
    return <section className="hex-interiors" aria-label="Hex interiors"><div className="row"><h4 className="grow">Interiors</h4>{!player&&<button className="btn ghost sm" aria-label="Link interior" onClick={()=>setEditor({hexId,initial:null})}><Plus size={14}/>Link</button>}</div>
      {query.isError&&<button className="btn ghost sm" onClick={()=>query.refetch()}>Retry interiors</button>}
      {parties.length>1&&<div className="row">{parties.map(t=><button key={t.id} className={`btn sm ${t.id===party?.id?'on':'ghost'}`} onClick={()=>setPickedParty(t.id)}>{t.name}</button>)}</div>}
      {links.map(i=><div key={i.id} className="row interior-link"><button className="btn grow" disabled={busy||player&&!party} onClick={()=>void enter(i,party?.id??null)}><ArrowDownToLine size={15}/><span className="grow">{i.name}</span><small>{party?'Enter':'Preview'} · {i.mode.toUpperCase()}</small></button>{!player&&<button className="iconbtn" aria-label={`Edit interior ${i.name}`} onClick={()=>setEditor({hexId,initial:i})}><Settings2 size={15}/></button>}</div>)}
      {!links.length&&!query.isPending&&!query.isError&&<p className="faint">Link a local map to this hex.</p>}{links.length>0&&!party&&<p className="faint">{player?'Bring your party to this hex to enter.':'Preview only: no party is on this hex.'}</p>}
    </section>;
  };
  const move=async(x:number,y:number)=>{if(!interior||!position||busy)return;setBusy(true);try{const p=await api<InteriorState['positions'][number]>(`/api/worlds/${world.id}/interiors/${interior.id}/move`,{body:{tokenId:position.tokenId,x,y,revision:position.revision}});qc.setQueryData<InteriorState>(key,old=>old?{...old,positions:old.positions.map(v=>v.tokenId===p.tokenId?p:v)}:old);await refresh();}catch(e){toastError(e);await refresh();}finally{setBusy(false);}};
  const parties=state?.positions.filter(p=>p.interiorId===interior?.id)??[];
  const layer=<>{editor&&<InteriorEditor worldId={world.id} hexId={editor.hexId} initial={editor.initial} onClose={()=>setEditor(null)} onSaved={refresh}/>} {active&&interior&&<section className={`interior-shell ${ready?'ready':''} ${exiting?'exiting':''}`} aria-label="Hex interior">
    <div className="interior-stage"><InteriorBoard interior={interior} positions={parties} tokens={(data?.tokens??[]).map(t=>({...t,color:data?.factions.find(f=>f.id===t.factionId)?.color??t.color}))} selectedTokenId={position?.tokenId} onCell={(x,y)=>void move(x,y)} onReady={()=>setReady(true)}/></div>
    <header className="interior-header panel"><button className="btn" disabled={busy||exiting} onClick={()=>void leave()}><ArrowUpFromLine size={16}/>Back to world</button><div className="grow"><b>{interior.name}</b><small>Interior · 5-foot grid · {interior.mode.toUpperCase()} · Day {world.currentDay}</small></div>{!player&&<button className="iconbtn" aria-label="Interior settings" onClick={()=>setEditor({hexId:interior.hexId,initial:interior})}><Settings2 size={16}/></button>}</header>
    {!ready&&<div className="interior-loading" role="status">Preparing the interior…</div>}
    <div className="interior-hint panel" role="status">{position?`${data?.tokens.find(t=>t.id===position.tokenId)?.name??'Party'} · column ${position.x+1}, row ${position.y+1} · click or drag to move`:'Preview · party position unchanged'}<small>{interior.mode==='3d'?'Right-drag to orbit · middle-drag to pan · wheel to zoom':'Right-drag to pan · wheel to zoom'}</small></div>
  </section>}</>;
  return {sidebar,layer,active:!!active,diving:!!active&&ready&&!exiting,origin:origin.current};
}
