import { corner, type Orientation } from '../../../shared/hex';
import type { TokenKind } from '../types';

const tiles = new Map<string, HTMLCanvasElement>();
/** Top-down settlement art is a terrain tile, clipped to the full hex and draped by the 3D renderer. */
export function settlementGround(kind: TokenKind, color: string, orientation: Orientation) {
  const key = `${kind}/${color}/${orientation}`;
  const cached = tiles.get(key); if (cached) return cached;
  if (tiles.size > 100) tiles.clear();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.translate(128, 128); g.scale(3.2, 3.2);
  g.beginPath(); for (let i=0;i<6;i++) { const c=corner(i,40,orientation); i ? g.lineTo(c.x,c.y) : g.moveTo(c.x,c.y); } g.closePath(); g.clip();
  const military = kind === 'military_base' || kind === 'outpost';
  const rural = kind === 'village' || kind === 'hamlet';
  g.fillStyle = military ? '#655c48' : rural ? '#666746' : '#777365'; g.fillRect(-40,-40,80,80);
  // Fields and gardens establish rural hexes; denser settlements have paved districts.
  if (rural) {
    for (const [x,y] of [[-30,-24],[12,16],[-26,16]]) {
      g.fillStyle='#4b5838';g.fillRect(x,y,17,12);g.strokeStyle='#8d9361';g.lineWidth=.65;
      for(let n=2;n<17;n+=3){g.beginPath();g.moveTo(x+n,y);g.lineTo(x+n,y+12);g.stroke();}
    }
  }
  // Roads cross the hex edge so adjoining settlement hexes read as one built area.
  g.lineCap='round'; g.strokeStyle='#403e35'; g.lineWidth=7;
  g.beginPath();g.moveTo(-42,0);g.lineTo(42,0);g.moveTo(0,-42);g.lineTo(0,42);g.stroke();
  g.strokeStyle='#bbb29a';g.lineWidth=4;g.stroke();
  if (!rural) {g.strokeStyle='#aaa48b';g.lineWidth=2;for(const n of [-22,22]){g.beginPath();g.moveTo(-40,n);g.lineTo(40,n);g.moveTo(n,-40);g.lineTo(n,40);g.stroke();}}
  const roof=(x:number,y:number,w:number,h:number,shade:string)=>{
    g.fillStyle='rgba(21,22,19,.5)';g.fillRect(x+1,y+1,w,h);g.fillStyle='#d2c0a0';g.fillRect(x-.5,y-.5,w+1,h+1);
    g.fillStyle=shade;g.fillRect(x,y,w,h);g.strokeStyle='#e1c5a1';g.lineWidth=.5;g.beginPath();g.moveTo(x+w/2,y);g.lineTo(x+w/2,y+h);g.stroke();
  };
  if (military) {
    g.strokeStyle='#c5bda3';g.lineWidth=2.8;g.strokeRect(-28,-28,56,56);
    for (const x of [-28,22]) for(const y of [-28,22]) roof(x,y,6,6,'#565e68');
    for (const y of [-19,9]) for(const x of [-19,6]) roof(x,y,12,9,'#65727c');
    g.fillStyle=color;g.fillRect(-2,-17,4,10);g.fillStyle='#d8d0b6';g.fillRect(-7,7,14,10);
  } else {
    const points=rural ? [[-17,-16,10,9],[9,-15,9,8],[-17,8,8,9],[8,8,12,10]] :
      [[-32,-16,8,10],[-18,-17,10,10],[8,-17,10,10],[24,-16,8,10],[-32,7,8,11],[-18,8,10,10],[8,8,10,10],[24,7,8,11],[-17,-32,9,8],[8,-32,9,8],[-17,25,9,8],[8,25,9,8]];
    points.forEach(([x,y,w,h],i)=>roof(x,y,w,h,i%3===0?'#955a43':i%3===1?'#ac7751':'#7c6656'));
    if (!rural) {g.fillStyle='#c2b895';g.beginPath();g.arc(0,0,7,0,Math.PI*2);g.fill();g.fillStyle='#608c98';g.beginPath();g.arc(0,0,3.5,0,Math.PI*2);g.fill();}
  }
  // Faction-colored outer paving makes the whole hex's designation legible even without the grid.
  g.strokeStyle=color;g.lineWidth=1.3;g.beginPath();for(let i=0;i<6;i++){const c=corner(i,38.5,orientation);i?g.lineTo(c.x,c.y):g.moveTo(c.x,c.y);}g.closePath();g.stroke();
  tiles.set(key,canvas);return canvas;
}
