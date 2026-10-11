import type { Token } from '../types';
import { drawPlaceGlyph } from '../map/markers';

type Plate = { x: number; y: number; width: number; height: number };
function typography(ctx: CanvasRenderingContext2D, modeled: boolean) {
  ctx.font = `600 ${modeled ? 12 : 10}px 'Cinzel Variable', 'Cinzel', Georgia, serif`;
  ctx.letterSpacing = modeled ? '1px' : '0.7px';
}
const title = (token: Token) => `${token.visibleToPlayers ? '' : '◌ '}${token.name.toUpperCase()}`;
export function tokenNameplateSize(ctx: CanvasRenderingContext2D, token: Token, modeled: boolean) {
  ctx.save(); typography(ctx, modeled);
  const width = Math.min(modeled ? 256 : 208, Math.max(modeled ? 120 : 100, Math.ceil(ctx.measureText(title(token)).width) + (modeled ? 56 : 46)));
  ctx.restore(); return { width, height: modeled ? 38 : 30 };
}

/** The same heraldic lettering and luminous faction rule as the territory labels. */
export function drawTokenNameplate(ctx: CanvasRenderingContext2D, token: Token, plate: Plate, modeled: boolean, color: string, hot: boolean) {
  ctx.save();
  const { x, y, width, height } = plate, cy = y + height / 2 - 3;
  // A feathered scrim lets the lettering read over terrain without boxing it into a UI pill.
  const scrim = ctx.createLinearGradient(x, y, x + width, y);
  scrim.addColorStop(0, 'rgba(6,12,17,0)'); scrim.addColorStop(0.18, 'rgba(6,12,17,0.64)'); scrim.addColorStop(0.82, 'rgba(6,12,17,0.64)'); scrim.addColorStop(1, 'rgba(6,12,17,0)');
  ctx.fillStyle = scrim; ctx.fillRect(x, y + 2, width, height - 6);
  const iconX = x + (modeled ? 19 : 16), diamond = modeled ? 13 : 10;
  ctx.beginPath(); ctx.moveTo(iconX, cy-diamond); ctx.lineTo(iconX+diamond,cy); ctx.lineTo(iconX,cy+diamond); ctx.lineTo(iconX-diamond,cy); ctx.closePath();
  ctx.fillStyle = 'rgba(10,20,26,0.85)'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.shadowColor = color; ctx.shadowBlur = hot ? 8 : 3; ctx.stroke(); ctx.shadowBlur = 0;
  drawPlaceGlyph(ctx, token.kind, false, iconX, cy, modeled ? 19 : 15, color);
  typography(ctx, modeled); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const textX = x + (modeled ? 41 : 34), available = width - (textX-x) - 9;
  let text = title(token);
  while (ctx.measureText(text).width > available && text.length > 2) text = text.slice(0,-2) + '…';
  ctx.strokeStyle = 'rgba(3,8,12,0.85)'; ctx.lineWidth = 3; ctx.strokeText(text, textX, cy);
  ctx.shadowColor = hot ? color : 'rgba(0,0,0,0.95)'; ctx.shadowBlur = hot ? 7 : 4;
  ctx.fillStyle = hot ? '#fff8e6' : '#f4ead4'; ctx.fillText(text, textX, cy); ctx.shadowBlur = 0;
  ctx.letterSpacing = '0px';
  const ruleY = y + height - 4, start = x + 9, end = x + width - 8;
  const rule = ctx.createLinearGradient(start, ruleY, end, ruleY);
  rule.addColorStop(0, 'transparent'); rule.addColorStop(0.2, color); rule.addColorStop(0.5, '#fff8e6'); rule.addColorStop(0.8, color); rule.addColorStop(1, 'transparent');
  ctx.strokeStyle = rule; ctx.lineWidth = hot ? 1.8 : 1.2; ctx.shadowColor = color; ctx.shadowBlur = hot ? 9 : 5;
  ctx.beginPath(); ctx.moveTo(start, ruleY); ctx.lineTo(end, ruleY); ctx.stroke();
  ctx.restore();
}
