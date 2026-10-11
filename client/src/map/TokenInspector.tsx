import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Check, Crosshair, Dice5, Pencil, Shield, Trash2, Users, X } from 'lucide-react';
import { api, qk, clientHeaders, pendingWrites, ApiError } from '../api';
import { useWorld } from '../world';
import { toastError } from '../components/toast';
import { Dialog } from '../components/Dialog';
import type { MapData, Token } from '../types';
import { PieceControls, usePlayer } from './PieceDrawer';
import { TokenPreview } from './TokenPreview';
import { fieldsFor, sheetNumbers, travelBudget, kingdomStats, type SheetBundle, type SheetValues, type StatSheet, type RuleField } from '../../../shared/rulesets';

export function TokenInspector({token,data,onClose,onLocate,onMove}:{token:Token;data:MapData;onClose:()=>void;onLocate:()=>void;onMove:()=>void}) {
  const world=useWorld(),qc=useQueryClient(),player=usePlayer();
  const [tab,setTab]=useState('stats'),[remove,setRemove]=useState(false),[uploading,setUploading]=useState(false);
  const color=token.color??data.factions.find(f=>f.id===token.factionId)?.color??'#d6b06a',faction=data.factions.find(f=>f.id===token.factionId);
  const portrait=typeof token.data.portraitId==='string'?token.data.portraitId:null;
  const [brokenArt,setBrokenArt]=useState<string|null>(null);
  const patch=async(body:Partial<Token>)=>{try{await api(`/api/worlds/${world.id}/tokens/${token.id}`,{method:'PATCH',body});await qc.invalidateQueries({queryKey:qk.map(world.id)});}catch(e){toastError(e);}};
  const upload=async(file:File)=>{
    setUploading(true);try{if(file.size>8*1024*1024)throw Error('Portrait art must be under 8 MB.');const response=await pendingWrites.track(fetch(`/api/worlds/${world.id}/token-portraits?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{...clientHeaders,'content-type':file.type},body:file}));const art=await response.json();if(!response.ok)throw Error(art.error);await patch({data:{...token.data,portraitId:art.id}});await qc.invalidateQueries({queryKey:['w',world.id,'portraits']});}catch(e){toastError(e);}finally{setUploading(false);}
  };
  const portraits=useQuery({queryKey:['w',world.id,'portraits'],enabled:!player&&tab==='appearance',queryFn:()=>api<{id:string;name:string}[]>(`/api/worlds/${world.id}/token-portraits`)});
  const canEdit=!player||token.factionId===data.playerFactionId;
  return <motion.aside className="panel inspector token-panel token-dossier" style={{'--token-accent':color} as CSSProperties} initial={{opacity:0,x:28}} animate={{opacity:1,x:0}} exit={{opacity:0,x:28}} transition={{type:'spring',stiffness:420,damping:36}} aria-label={`${token.name} token sheet`} onKeyDown={e=>{if(e.key==='Escape')onClose();e.stopPropagation();}}>
    <div className={`token-hero ${portrait&&brokenArt!==portrait?'has-art':''}`}>
      {portrait&&brokenArt!==portrait?<img className="token-hero-art" src={`/api/worlds/${world.id}/token-portraits/${portrait}`} alt={`${token.name} portrait`} onError={()=>setBrokenArt(portrait)}/>:<div className="token-hero-emblem"><TokenPreview token={token} color={color}/></div>}
      <div className="token-hero-shade"/>
      <div className="token-hero-tools">{!player&&<label className="iconbtn" title="Upload portrait art"><Camera size={16}/><input type="file" aria-label="Upload portrait art" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={uploading} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void upload(f);}}/></label>}<button className="iconbtn" aria-label="Close token sheet" onClick={onClose}><X size={16}/></button></div>
      <div className="token-hero-title"><span className="token-eyebrow">{token.mainParty?'The company':token.kind==='party'?'Adventuring party':String(token.data.role??token.kind)}</span><h2>{token.name}</h2><span className="token-allegiance"><i style={{background:color}}/>{faction?.name??'Unaligned'}{!token.visibleToPlayers?' · GM only':''}</span></div>
    </div>
    <nav className="token-tabs" aria-label="Token sections">{['stats','appearance','journey'].map(t=><button key={t} className={tab===t?'on':''} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='stats'?'Sheet':t==='appearance'?'Appearance':'Journey'}</button>)}</nav>
    <div className="token-dossier-body scroll">
      {tab==='stats'&&<TokenSheet token={token} data={data}/>}
      {tab==='appearance'&&<>
        <div className="dossier-section-head"><h3>Portrait gallery</h3>{uploading&&<span className="faint">Uploading…</span>}</div>
        {!player&&<div className="portrait-grid"><button className={!portrait?'on':''} aria-label="Use emblem portrait" onClick={()=>void patch({data:{...token.data,portraitId:null}})}><Shield/><span>Emblem</span></button>{portraits.data?.map(p=><button key={p.id} className={portrait===p.id?'on':''} aria-label={`Use art ${p.name}`} onClick={()=>void patch({data:{...token.data,portraitId:p.id}})}><img src={`/api/worlds/${world.id}/token-portraits/${p.id}`} alt=""/><span>{p.name}</span></button>)}</div>}
        {!player&&<label className="btn ghost sm"><Camera size={14}/>{uploading?'Uploading…':'Upload portrait art'}<input hidden type="file" aria-label="Upload gallery art" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void upload(f);}}/></label>}
        <h3 className="dossier-section-head">Map appearance</h3><PieceControls token={token} data={data} onMove={onMove} mode="appearance"/>
        {!player&&<details className="sheet-section"><summary>Identity & allegiance</summary><label className="field">Token name<input className="input" aria-label="Marker name" defaultValue={token.name} maxLength={120} onBlur={e=>{if(e.target.value.trim()&&e.target.value.trim()!==token.name)void patch({name:e.target.value.trim()});}}/></label><label className="field">Faction<select className="select" disabled={token.mainParty} value={token.factionId??''} onChange={e=>void patch({factionId:e.target.value||null})}><option value="">Unaligned</option>{data.factions.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{token.kind==='party'&&<label className="field">Campaign<select className="select" value={token.campaignId??''} onChange={e=>void patch({campaignId:e.target.value||null})}><option value="">No campaign</option>{data.campaigns.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}</details>}
      </>}
      {tab==='journey'&&<><h3 className="dossier-section-head">Footsteps in the world</h3><p className="faint">{token.hexId?`On the map · ${data.hexes.find(h=>h.id===token.hexId)?.name||'Hex '+(data.hexes.find(h=>h.id===token.hexId)?.q??'')+', '+(data.hexes.find(h=>h.id===token.hexId)?.r??'')}`:'In the faction drawer'}</p><PieceControls token={token} data={data} onMove={onMove} mode="journey"/></>}
    </div>
    <footer className="token-dossier-footer"><button className="btn ghost sm" disabled={!token.hexId} onClick={onLocate}><Crosshair size={14}/>Locate</button>{canEdit&&!token.hexId&&<button className="btn sm" onClick={onMove}>Deploy on map</button>}{!player&&!token.mainParty&&<button className="iconbtn danger" aria-label="Delete token" onClick={()=>setRemove(true)}><Trash2 size={15}/></button>}</footer>
    <Dialog open={remove} onClose={()=>setRemove(false)} title={`Delete ${token.name}?`}><p>This removes the token and its stat sheets. Wiki pages are kept.</p><div className="actions"><button className="btn ghost" onClick={()=>setRemove(false)}>Keep token</button><button className="btn danger-solid" onClick={async()=>{try{await api(`/api/worlds/${world.id}/tokens/${token.id}`,{method:'DELETE'});await qc.invalidateQueries({queryKey:qk.map(world.id)});onClose();}catch(e){toastError(e);}}}>Delete token</button></div></Dialog>
  </motion.aside>;
}

function TokenSheet({token,data}:{token:Token;data:MapData}) {
  const world=useWorld();
  const bundle=useQuery({queryKey:['w',world.id,'sheets',token.id],queryFn:()=>api<SheetBundle>(`/api/worlds/${world.id}/tokens/${token.id}/sheet`)});
  if(bundle.isPending)return <p className="faint" role="status">Opening stat sheet…</p>;
  if(bundle.isError)return <div className="sheet-empty"><Shield/><p>{bundle.error instanceof ApiError&&bundle.error.status===403?'This faction’s statistics are private.':'The sheet could not be opened.'}</p><button className="btn ghost sm" onClick={()=>bundle.refetch()}>Retry</button></div>;
  return <SheetEditor key={`${bundle.data.sheet.rulesetId}:${bundle.data.sheet.kind}`} bundle={bundle.data} token={token} data={data}/>;
}
function SheetEditor({bundle,token,data}:{bundle:SheetBundle;token:Token;data:MapData}) {
  const world=useWorld(),qc=useQueryClient(),player=usePlayer(),{sheet,ruleset}=bundle,rules=ruleset.definition;
  const [edit,setEdit]=useState(false),[draft,setDraft]=useState<SheetValues>(sheet.values),[busy,setBusy]=useState(false),[dc,setDC]=useState(''),[roll,setRoll]=useState<{total:number;die:number;modifier:number;degree:string|null}|null>(null);
  const revision=useRef(sheet.revision),rulesRevision=useRef(ruleset.revision),[conflict,setConflict]=useState(false);
  useEffect(()=>{if(!edit){setDraft(sheet.values);revision.current=sheet.revision;rulesRevision.current=ruleset.revision;setConflict(false);}else if(sheet.revision!==revision.current||ruleset.revision!==rulesRevision.current)setConflict(true);},[sheet.revision,ruleset.revision,edit]);
  const values=edit?draft:sheet.values,stats=sheetNumbers(rules,sheet.kind,values),template=rules.templates.find(t=>t.kind===sheet.kind)!;
  const change=(key:string,value:SheetValues[string])=>setDraft(d=>({...d,[key]:value}));
  const save=async()=>{setBusy(true);try{const allowed=new Set(fieldsFor(rules,sheet.kind).filter(f=>f.formula===undefined).map(f=>f.key));const saved=await api<StatSheet>(`/api/worlds/${world.id}/tokens/${token.id}/sheet`,{method:'PATCH',body:{rulesetId:ruleset.id,revision:revision.current,rulesRevision:rulesRevision.current,values:Object.fromEntries(Object.entries(draft).filter(([key])=>allowed.has(key)))}});qc.setQueryData<SheetBundle>(['w',world.id,'sheets',token.id],b=>b?{...b,sheet:saved}:b);setEdit(false);await qc.invalidateQueries({queryKey:['w',world.id,'sheets']});}catch(e){toastError(e);if(e instanceof ApiError&&e.status===409){setConflict(true);await qc.invalidateQueries({queryKey:['w',world.id,'sheets',token.id]});}}finally{setBusy(false);}};
  const rollStat=async(field:RuleField)=>{setBusy(true);try{const result=await api<typeof roll>(`/api/worlds/${world.id}/tokens/${token.id}/sheet/roll`,{body:{rulesetId:ruleset.id,field:field.key,dc:dc.trim()===''?null:Number(dc)}});setRoll(result);}catch(e){toastError(e);}finally{setBusy(false);}};
  const memberIds=Array.isArray(values.members)?values.members:[];
  const roster=bundle.members.filter(m=>memberIds.includes(m.id));
  const speeds=roster.map(m=>m.speed).filter((s):s is number=>s!==null),speed=speeds.length?Math.min(...speeds):stats[rules.exploration?.speedKey??'speed']??0;
  const hex=data.hexes.find(h=>h.id===token.hexId),travel=sheet.kind==='party'?travelBudget(rules,speed,hex?.terrain??'',stats.activitiesSpent??0):null;
  const kingdom=sheet.kind==='kingdom'?kingdomStats(rules,stats.level,stats.size):null;
  const fieldView=(f:RuleField)=>{
    const value=values[f.key]??f.default,calculated=f.formula!==undefined;
    if(f.type==='roster')return <div className="roster-field" key={f.key}><label className="label"><Users size={14}/>{f.label}</label>{bundle.members.length?bundle.members.map(m=><label className="roster-member" key={m.id}><input type="checkbox" disabled={!edit||busy} checked={Array.isArray(value)&&value.includes(m.id)} onChange={e=>change(f.key,e.target.checked?[...(Array.isArray(value)?value:[]),m.id]:(Array.isArray(value)?value:[]).filter(id=>id!==m.id))}/><span>{m.name}</span><small>{m.speed===null?'Speed unset':`${m.speed} ft`}</small></label>):<p className="faint">Add character or unit tokens to this faction to build its roster.</p>}</div>;
    return <label className={`sheet-field ${f.type==='textarea'?'wide':''} ${calculated?'calculated':''}`} key={f.key}><span>{f.label}{calculated&&<small>calculated</small>}</span>{edit&&!calculated?(f.type==='choice'?<select className="select" aria-label={f.label} disabled={busy} value={String(value)} onChange={e=>change(f.key,e.target.value)}>{f.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:f.type==='textarea'?<textarea className="textarea" aria-label={f.label} disabled={busy} value={String(value)} onChange={e=>change(f.key,e.target.value)}/>:<input className="input" aria-label={f.label} disabled={busy} type={f.type==='number'?'number':'text'} min={f.min} max={f.max} step={f.type==='number'?(f.integer?'1':'any'):undefined} value={String(value)} onChange={e=>change(f.key,f.type==='number'?Number(e.target.value):e.target.value)}/>):<div className="sheet-value">{calculated?stats[f.key]:f.type==='choice'?f.options?.find(o=>o.value===value)?.label:String(value)||'—'}{f.roll&&!edit&&<button className="iconbtn" aria-label={`Roll ${f.label}`} disabled={busy} onClick={()=>void rollStat(f)}><Dice5 size={14}/></button>}</div>}{f.help&&<small className="faint">{f.help}</small>}</label>;
  };
  return <>
    <div className="sheet-toolbar"><span><span className="token-eyebrow">{template.label} sheet</span><small>{ruleset.name}</small></span>{bundle.canEdit&&(edit?<><button className="btn ghost sm" disabled={busy} onClick={()=>setEdit(false)}>Cancel</button><button className="btn sm" disabled={busy||conflict} onClick={()=>void save()}><Check size={13}/>{busy?'Saving…':'Save'}</button></>:<button className="iconbtn" aria-label="Edit stat sheet" onClick={()=>setEdit(true)}><Pencil size={15}/></button>)}</div>
    {conflict&&<p className="sheet-conflict" role="alert">This sheet or its rules changed on another screen. Cancel to load the latest values before editing again.</p>}
    {sheet.kind!=='party'&&['hp','ac','speed'].some(k=>Object.hasOwn(stats,k))&&<div className="sheet-vitals">{[['hp','Hit points'],['ac','Armor class'],['speed','Speed']].filter(([k])=>Object.hasOwn(stats,k)).map(([k,label])=><div key={k}><strong>{stats[k]}{k==='hp'&&<small>/{stats.hpMax??0}</small>}</strong><span>{label}</span></div>)}</div>}
    {travel&&<section className="party-journey"><span className="token-eyebrow">Hexploration</span><div className="party-budget"><strong>{travel.remaining}<small>/{travel.activities}</small></strong><span>activities remaining<br/><small>Slowest member · {speed} ft</small></span></div><p>Current terrain: {travel.cost} activities per hex · {travel.hexMiles}-mile hexes</p><small>Travel planner; the GM records activities used. Roads, modes of travel and forced marches can alter the cost.</small>{roster.some(m=>m.speed===null)&&<p className="faint">Some member speeds are unset; confirm the party’s travel speed.</p>}</section>}
    {kingdom&&<section className="party-journey"><span className="token-eyebrow">{kingdom.tier}</span><div className="sheet-vitals"><div><strong>{kingdom.dc}</strong><span>Control DC</span></div><div><strong>d{kingdom.die}</strong><span>Resource die</span></div><div><strong>{kingdom.storage}</strong><span>Commodity cap</span></div></div></section>}
    {!edit&&fieldsFor(rules,sheet.kind).some(f=>f.roll)&&<div className="sheet-roll-row"><label>Target DC<input className="input" type="number" min={-1000} max={1000} value={dc} aria-label="Roll target DC" placeholder="Optional" onChange={e=>setDC(e.target.value)}/></label>{roll&&<output aria-live="polite"><strong>{roll.total}</strong><span>d{rules.check.die}: {roll.die} {roll.modifier>=0?'+':''}{roll.modifier}<br/>{roll.degree??'Check recorded'}</span></output>}</div>}
    {template.sections.map((section,index)=><details className="sheet-section" key={section.key} open={index<2||edit}><summary>{section.label}</summary><div className="sheet-fields">{section.fields.map(fieldView)}</div></details>)}
    {!player&&!edit&&<details className="sheet-section"><summary>Sheet type & rules references</summary><label className="field">Sheet type<select className="select" aria-label="Sheet type" value={sheet.kind} onChange={async e=>{try{await api(`/api/worlds/${world.id}/tokens/${token.id}/sheet`,{method:'PATCH',body:{rulesetId:ruleset.id,revision:sheet.revision,rulesRevision:ruleset.revision,kind:e.target.value,values:{}}});await qc.invalidateQueries({queryKey:['w',world.id,'sheets']});}catch(err){toastError(err);}}}>{rules.templates.map(t=><option key={t.kind} value={t.kind}>{t.label}</option>)}</select></label><p className="faint">Changing type preserves stored values. Each world can edit or switch rulesets in World settings.</p>{rules.sources.map(s=><a className="sheet-reference" key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title} ↗</a>)}</details>}
  </>;
}
