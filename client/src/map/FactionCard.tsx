import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../api';
import type { Faction, MeterDef, TokenKind } from '../types';
import { useWorld } from '../world';
import { bandFor } from '../../../shared/meters';
import { Diamond, TOKEN_KINDS } from './panels';

/** A faction's territory as the 3D map sees it, for the card shown over its floating name. */
export type FactionArea = {
  id: string; name: string; color: string;
  held: number; contested: number; influence: number;
  terrain: { key: string; n: number }[];
  places: { id: string; name: string; kind: TokenKind }[];
};
/** The hovered label's box on screen (CSS pixels within the map). */
export type CardAnchor = { x: number; top: number; bottom: number; left: number; right: number };

/** Card width (matches .fcard), the gap to the label, and the room the map's floating chrome takes. */
const CARD_W = 264, GAP = 12, EDGE_TOP = 68, EDGE_BOTTOM = 84, EDGE_SIDE = 76;

const KIND = Object.fromEntries(TOKEN_KINDS.map((k) => [k.kind, k.label])) as Record<TokenKind, string>;

/** A glass card over a hovered faction name: what it holds, how it stands, what its land is. */
export function FactionCard({ area, at, mapW, mapH }: { area: FactionArea; at: CardAnchor; mapW: number; mapH: number }) {
  const world = useWorld();
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(340);
  useLayoutEffect(() => { const n = ref.current?.offsetHeight; if (n && Math.abs(n - h) > 1) setH(n); });
  const factions = useQuery({ queryKey: qk.factions(world.id), queryFn: () => api<Faction[]>(`/api/worlds/${world.id}/factions`) });
  const meters = useQuery({ queryKey: qk.meters(world.id), queryFn: () => api<MeterDef[]>(`/api/worlds/${world.id}/meters`) });
  const f = factions.data?.find((x) => x.id === area.id);
  const defs = meters.data ?? [];
  // The signature meter first, then the core ones: three at most.
  const shown = (f?.meters ?? []).map((m) => ({ m, def: defs.find((d) => d.id === m.meterId) }))
    .filter((x): x is { m: typeof x.m; def: MeterDef } => !!x.def && (x.def.kind !== 'signature' || x.def.id === f?.signatureMeterId))
    .sort((a, b) => (a.def.id === f?.signatureMeterId ? -1 : b.def.id === f?.signatureMeterId ? 1 : a.def.sortOrder - b.def.sortOrder))
    .slice(0, 3);
  const land = area.terrain.reduce((s, t) => s + t.n, 0) || 1;
  const terrain = area.terrain.slice(0, 5).map((t) => ({ ...t, type: world.terrainTypes.find((x) => x.key === t.key) }));
  // Above the label when it fits under the top bar, else below it, else beside it; never over the
  // name itself, and always clear of the floating chrome along the map's edges.
  const fitsAbove = at.top - GAP - h >= EDGE_TOP, fitsBelow = at.bottom + GAP + h <= mapH - EDGE_BOTTOM;
  const fitsRight = at.right + GAP + CARD_W <= mapW - EDGE_SIDE, fitsLeft = at.left - GAP - CARD_W >= EDGE_SIDE;
  const side = fitsAbove || fitsBelow || !(fitsRight || fitsLeft) ? null : fitsRight ? 'right' : 'left';
  const below = !fitsAbove && (fitsBelow || (!side && mapH - at.bottom > at.top));
  const clampY = (y: number) => Math.max(EDGE_TOP, Math.min(y, mapH - EDGE_BOTTOM - h));
  const clampX = (x: number) => (mapW > CARD_W + 2 * EDGE_SIDE ? Math.max(EDGE_SIDE + CARD_W / 2, Math.min(x, mapW - EDGE_SIDE - CARD_W / 2)) : x);
  const x = side === 'right' ? at.right + GAP + CARD_W / 2 : side === 'left' ? at.left - GAP - CARD_W / 2 : clampX(at.x);
  const y = clampY(side ? (at.top + at.bottom) / 2 - h / 2 : below ? at.bottom + GAP : at.top - GAP - h);
  return (
    <div ref={ref} className={`fcard ${side ?? (below ? 'below' : '')}`} style={{ left: x, top: y, ['--fc' as string]: area.color }}>
      <div className="fcard-head">
        <Diamond color={area.color} size={11} />
        <div className="grow">
          <div className="fcard-name">{area.name}</div>
          <div className="fcard-sub">Territory</div>
        </div>
      </div>
      <div className="fcard-stats">
        <div><b className="num">{area.held}</b><span>held</span></div>
        <div><b className="num">{area.contested}</b><span>contested</span></div>
        <div><b className="num">{area.influence}</b><span>influence</span></div>
      </div>
      {!!shown.length && (
        <div className="fcard-meters">
          {shown.map(({ m, def }) => {
            const band = def.bands.length ? bandFor(def.bands, m.value) : null;
            const pct = def.max != null && def.min != null ? (m.value - def.min) / (def.max - def.min) : null;
            return (
              <div key={m.meterId} className="fcard-meter">
                <div className="row"><span className="grow">{def.name}</span>{band && <span className={`tone-${band.tone}`}>{band.label}</span>}<b className="num">{m.value.toLocaleString()}</b></div>
                {pct != null && <div className="fcard-bar"><span className={`bg-${band?.tone ?? 'neutral'}`} style={{ width: `${Math.max(2, Math.min(1, pct) * 100)}%` }} /></div>}
              </div>
            );
          })}
        </div>
      )}
      {!!terrain.length && (
        <div className="fcard-terrain">
          <div className="fcard-mix">{terrain.map((t) => <span key={t.key} style={{ flexGrow: t.n, background: t.type?.color ?? '#555' }} />)}</div>
          <div className="fcard-legend">
            {terrain.slice(0, 3).map((t) => <span key={t.key}><i style={{ background: t.type?.color ?? '#555' }} />{t.type?.name ?? t.key} {Math.round((t.n / land) * 100)}%</span>)}
          </div>
        </div>
      )}
      {!!area.places.length && (
        <div className="fcard-places">
          {area.places.slice(0, 4).map((p) => <div key={p.id}><span className="grow">{p.name}</span><span className="faint">{KIND[p.kind]}</span></div>)}
          {area.places.length > 4 && <div className="faint">and {area.places.length - 4} more</div>}
        </div>
      )}
      <div className="fcard-hint">Click the name to open</div>
    </div>
  );
}
