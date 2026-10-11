import { useEffect, useRef, useState } from 'react';
import type { Interior, InteriorPosition } from '../../../shared/interiors';
import { interiorCell } from '../../../shared/interiors';
import type { Token } from '../types';
import { drawPlaceGlyph } from '../map/markers';
import type { InteriorScene } from './InteriorScene';
export function InteriorBoard({interior,positions,tokens,selectedTokenId,onCell,onReady,showEntry=false,assetUrl}: {
  interior:Interior;positions:InteriorPosition[];tokens:Token[];selectedTokenId?:string|null;onCell:(x:number,y:number)=>void;onReady?:()=>void;showEntry?:boolean;assetUrl?:string;
}) {
  const host=useRef<HTMLDivElement>(null),gl=useRef<HTMLCanvasElement>(null),hud=useRef<HTMLCanvasElement>(null),scene=useRef<InteriorScene|null>(null);
  const current=useRef({positions,tokens,selectedTokenId,onCell,onReady,showEntry,interior});current.current={positions,tokens,selectedTokenId,onCell,onReady,showEntry,interior};
  const [error,setError]=useState(''),[loaded,setLoaded]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const parent=host.current!,canvas=hud.current!,ctx=canvas.getContext('2d')!;let disposed=false,raf=0,image:HTMLImageElement|null=null,w=1,h=1,engine:InteriorScene|null=null;
    let zoom=1,panX=0,panY=0;const dpr=Math.min(devicePixelRatio,2);setError('');setLoaded(false);
    const scale=()=>Math.min((w-40)/(interior.cols*5),(h-40)/(interior.rows*5))*zoom;
    const project=(x:number,y:number)=>engine?engine.project(x,y):{x:w/2+panX+(x-interior.cols*2.5)*scale(),y:h/2+panY+(y-interior.rows*2.5)*scale()};
    const cell=(x:number,y:number)=>engine?engine.cell(x,y):{x:Math.floor(((x-w/2-panX)/scale()+interior.cols*2.5)/5),y:Math.floor(((y-h/2-panY)/scale()+interior.rows*2.5)/5)};
    const ready=()=>{if(!disposed){setLoaded(true);current.current.onReady?.();}};
    if(interior.mode==='3d')void import('./InteriorScene').then(async({InteriorScene})=>{if(disposed)return;engine=new InteriorScene(gl.current!,canvas,interior);scene.current=engine;engine.resize(w,h);try{await engine.load(assetUrl);}catch(e){if(!disposed)setError(e instanceof Error?e.message:'The 3D map could not load.');}ready();}).catch(e=>{if(!disposed){setError(String(e));ready();}});
    else if(interior.asset||assetUrl){image=new Image();image.onload=ready;image.onerror=()=>{setError('The map image could not load.');ready();};image.src=assetUrl??`/api/worlds/${interior.worldId}/interiors/${interior.id}/asset?v=${interior.asset!.version}`;}else ready();
    const resize=()=>{w=Math.max(1,parent.clientWidth);h=Math.max(1,parent.clientHeight);canvas.width=Math.ceil(w*dpr);canvas.height=Math.ceil(h*dpr);engine?.resize(w,h);};const observer=new ResizeObserver(resize);observer.observe(parent);resize();
    let down:{x:number;y:number;button:number;dragging:boolean}|null=null;
    const point=(event:PointerEvent|WheelEvent)=>{const b=canvas.getBoundingClientRect();return{x:event.clientX-b.left,y:event.clientY-b.top};};
    const onDown=(event:PointerEvent)=>{canvas.setPointerCapture(event.pointerId);down={...point(event),button:event.button,dragging:false};};
    const onMove=(event:PointerEvent)=>{if(!down)return;const p=point(event),dx=p.x-down.x,dy=p.y-down.y;if(Math.hypot(dx,dy)>4)down.dragging=true;if(down.button!==0&&!engine){panX+=dx;panY+=dy;down.x=p.x;down.y=p.y;}};
    const onUp=(event:PointerEvent)=>{if(!down)return;const p=point(event),position=cell(p.x,p.y);if(down.button===0&&position&&interiorCell(position.x,position.y,interior.cols,interior.rows))current.current.onCell(position.x,position.y);down=null;};
    const wheel=(event:WheelEvent)=>{if(engine)return;event.preventDefault();const old=scale(),p=point(event);zoom=Math.max(.4,Math.min(8,zoom*Math.exp(-event.deltaY*.001)));const ratio=scale()/old;panX=p.x-w/2-(p.x-w/2-panX)*ratio;panY=p.y-h/2-(p.y-h/2-panY)*ratio;};
    const cancel=()=>{down=null;};const menu=(e:Event)=>e.preventDefault();canvas.addEventListener('pointerdown',onDown);canvas.addEventListener('pointermove',onMove);canvas.addEventListener('pointerup',onUp);canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('contextmenu',menu);
    const frame=(now:number)=>{
      if(disposed)return;raf=requestAnimationFrame(frame);const value=current.current,parties=value.positions.flatMap(p=>{const token=value.tokens.find(t=>t.id===p.tokenId);return token?[{token,x:p.x,y:p.y}]:[];});
      engine?.frame(now,parties);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      if(!engine){ctx.fillStyle='#111c24';ctx.fillRect(0,0,w,h);const a=project(0,0),b=project(interior.cols*5,interior.rows*5);if(image?.complete&&image.naturalWidth)ctx.drawImage(image,a.x,a.y,b.x-a.x,b.y-a.y);ctx.strokeStyle='rgba(235,229,205,.35)';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<=interior.cols;x++){const p=project(x*5,0),q=project(x*5,interior.rows*5);ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);}for(let y=0;y<=interior.rows;y++){const p=project(0,y*5),q=project(interior.cols*5,y*5);ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);}ctx.stroke();}
      if(value.showEntry){const p=project(value.interior.entryX*5+2.5,value.interior.entryY*5+2.5);ctx.strokeStyle='#8fe8e2';ctx.lineWidth=2;ctx.beginPath();ctx.arc(p.x,p.y,14,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#8fe8e2';ctx.font='600 11px Inter';ctx.textAlign='center';ctx.fillText('ENTRY',p.x,p.y-20);}
      for(const p of parties){const point=project(p.x*5+2.5,p.y*5+2.5),modeled=engine?.miniatures.has(p.token.id);const color=p.token.color??'#d6b06a';if(!modeled){ctx.fillStyle='rgba(6,12,17,.94)';ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.arc(point.x,point.y,16,0,Math.PI*2);ctx.fill();ctx.stroke();drawPlaceGlyph(ctx,p.token.kind,false,point.x,point.y,21,color);}if(value.selectedTokenId===p.token.id){ctx.strokeStyle='#8fe8e2';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(point.x,point.y,20,modeled?9:20,0,0,Math.PI*2);ctx.stroke();}ctx.font='600 11px Inter';ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#081018';ctx.fillStyle='#f4ead4';ctx.strokeText(p.token.name,point.x,point.y+30);ctx.fillText(p.token.name,point.x,point.y+30);}
    };raf=requestAnimationFrame(frame);
    const debug={projectCell:(x:number,y:number)=>project(x*5+2.5,y*5+2.5),cell,scene:()=>engine,interior},debugWindow=window as unknown as {__atlasInterior?:unknown};if(!showEntry)debugWindow.__atlasInterior=debug;
    return()=>{disposed=true;if(debugWindow.__atlasInterior===debug)delete debugWindow.__atlasInterior;cancelAnimationFrame(raf);observer.disconnect();engine?.dispose();scene.current=null;if(image){image.onload=null;image.onerror=null;}canvas.removeEventListener('pointerdown',onDown);canvas.removeEventListener('pointermove',onMove);canvas.removeEventListener('pointerup',onUp);canvas.removeEventListener('pointercancel',cancel);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('contextmenu',menu);};
  },[interior.id,interior.mode,interior.cols,interior.rows,interior.asset?.version,assetUrl,retry]);
  return <div className="interior-board" ref={host}><canvas className="interior-gl" ref={gl} aria-hidden style={{display:interior.mode==='3d'?'block':'none'}}/><canvas ref={hud} className="interior-grid" aria-label="Interior tactical map"/>{!loaded&&<div className="interior-loading" role="status">Preparing the interior…</div>}{error&&<div className="interior-error" role="alert">{error}<button className="btn sm" onClick={()=>setRetry(n=>n+1)}>Retry map</button></div>}</div>;
}
