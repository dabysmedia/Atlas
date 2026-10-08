import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Brush, Eye, EyeOff, Flag, Layers, Maximize, Minus, MousePointer2, Plus, Shield } from 'lucide-react';
import { api, qk } from '../api';
import type { Claim, Hex, MapData, Token } from '../types';
import { useWorld } from '../world';
import { cameraPref, fogCampaign } from '../prefs';
import { HEX_SIZE, HexMapRenderer, type Camera } from './renderer';
import { HexInspector } from './HexInspector';
import { toastError } from '../components/toast';
import { DIRS, key } from '../../../shared/hex';

type Tool = 'select' | 'terrain' | 'state' | 'claim' | 'fog';
const TOOLS: { id: Tool; label: string; icon: typeof Brush; keyHint: string }[] = [
  { id: 'select', label: 'Inspect and move', icon: MousePointer2, keyHint: '1' },
  { id: 'terrain', label: 'Paint terrain', icon: Brush, keyHint: '2' },
  { id: 'state', label: 'Paint hex state', icon: Layers, keyHint: '3' },
  { id: 'claim', label: 'Paint faction control', icon: Shield, keyHint: '4' },
  { id: 'fog', label: 'Reveal or hide (party fog)', icon: Eye, keyHint: '5' },
];

/** Cameras survive tab switches within the session; localStorage carries them across visits. */
const sessionCameras = new Map<string, Camera>();

export function MapView() {
  const world = useWorld();
  const qc = useQueryClient();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HexMapRenderer | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [brush, setBrush] = useState<Record<Tool, string>>({ select: '', terrain: 'plains', state: 'settled', claim: '', fog: 'reveal' });
  const [radius, setRadius] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; hexId: string } | null>(null);
  const [zoomLabel, setZoomLabel] = useState('');
  const [campaignId, setCampaignId] = useState<string | null | undefined>(() => fogCampaign(world.id).get());
  const [showFog, setShowFog] = useState(true);

  const mapQ = useQuery({ queryKey: qk.map(world.id), queryFn: () => api<MapData>(`/api/worlds/${world.id}/map`) });
  const data = mapQ.data;
  // Default the fog campaign to the first campaign the first time.
  const fogCamp = campaignId === undefined ? data?.campaigns[0]?.id ?? null : campaignId;
  const fogQ = useQuery({
    queryKey: qk.fog(world.id, fogCamp ?? ''), enabled: !!fogCamp,
    queryFn: () => api<string[]>(`/api/worlds/${world.id}/campaigns/${fogCamp}/fog`),
  });

  useEffect(() => {
    if (!brush.claim && data?.factions[0]) setBrush((b) => ({ ...b, claim: data.factions[0].id }));
  }, [data, brush.claim]);

  // ---- renderer lifecycle
  useEffect(() => {
    const r = new HexMapRenderer(canvasRef.current!);
    rendererRef.current = r;
    const ro = new ResizeObserver(([e]) => r.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrapRef.current!);
    let saveT = 0;
    r.onCameraChange = (c) => {
      sessionCameras.set(world.id, { ...c });
      window.clearTimeout(saveT);
      saveT = window.setTimeout(() => cameraPref(world.id).set({ ...c }), 300);
    };
    let lastLabel = '';
    r.onAfterFrame = () => {
      const R = HEX_SIZE * r.cam.zoom;
      const l = R < 12 ? 'Continental' : 'Hexcrawl';
      if (l !== lastLabel) { lastLabel = l; setZoomLabel(l); }
    };
    return () => { ro.disconnect(); r.destroy(); rendererRef.current = null; };
  }, [world.id]);

  const placedCamera = useRef(false);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !data) return;
    r.setData({
      orientation: data.map.layout.orientation, hexes: data.hexes, claims: data.claims, tokens: data.tokens,
      factions: data.factions, terrain: world.terrainTypes, states: world.hexStates,
      fog: fogCamp && fogQ.data ? new Set(fogQ.data) : null,
    });
  }, [data, fogQ.data, fogCamp, world.terrainTypes, world.hexStates, world.id]);

  // Place the camera once both data and a measured viewport exist: back to the exact
  // spot the GM left, or (first visit) a gentle pull-in onto the whole map.
  useEffect(() => {
    if (!data) return;
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r || placedCamera.current) { window.clearInterval(id); return; }
      if (!r.viewport.w) return;
      placedCamera.current = true;
      window.clearInterval(id);
      const saved = sessionCameras.get(world.id) ?? cameraPref(world.id).get();
      if (saved) { r.setCamera(saved); return; }
      const fit = r.fitCamera();
      r.setCamera({ ...fit, zoom: fit.zoom * 0.7 });
      r.flyTo(fit.x, fit.y, fit.zoom);
    }, 16);
    return () => window.clearInterval(id);
  }, [data, world.id]);

  useEffect(() => { if (rendererRef.current) { rendererRef.current.selectedId = selected; rendererRef.current.invalidate(); } }, [selected]);
  useEffect(() => { if (rendererRef.current) { rendererRef.current.showFog = showFog; rendererRef.current.invalidate(); } }, [showFog]);
  useEffect(() => { fogCampaign(world.id).set(fogCamp); }, [fogCamp, world.id]);

  // ---- cache helpers (optimistic edits flow through the query cache)
  const patchCache = (fn: (d: MapData) => MapData) => qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? fn(d) : d));

  const brushArea = (center: Hex): string[] => {
    if (radius === 0) return [center.id];
    const out: string[] = [];
    const dirs = DIRS[data!.map.layout.orientation];
    const seen = new Set([key(center.q, center.r)]);
    let ring = [center];
    out.push(center.id);
    for (let i = 0; i < radius; i++) {
      const next: Hex[] = [];
      for (const h of ring) for (const d of dirs) {
        const k = key(h.q + d.q, h.r + d.r);
        if (seen.has(k)) continue;
        seen.add(k);
        const n = data!.hexes.find((x) => x.q === h.q + d.q && x.r === h.r + d.r);
        if (n) { next.push(n); out.push(n.id); }
      }
      ring = next;
    }
    return out;
  };

  const commitStroke = async (ids: string[]) => {
    if (!ids.length || !data) return;
    try {
      if (tool === 'terrain' || tool === 'state') {
        const field = tool;
        const value = brush[tool];
        const changed = ids.filter((id) => data.hexes.find((h) => h.id === id)?.[field] !== value);
        if (!changed.length) return;
        await api(`/api/worlds/${world.id}/hexes/paint`, { body: { hexIds: changed, [field]: value } });
        patchCache((d) => ({ ...d, hexes: d.hexes.map((h) => (changed.includes(h.id) ? { ...h, [field]: value } : h)) }));
      } else if (tool === 'claim') {
        const factionId = brush.claim === 'none' ? null : brush.claim;
        const claims = await api<Claim[]>(`/api/worlds/${world.id}/claims/control`, { body: { hexIds: ids, factionId } });
        patchCache((d) => ({ ...d, claims: [...d.claims.filter((c) => !ids.includes(c.hexId)), ...claims] }));
        qc.invalidateQueries({ queryKey: qk.factions(world.id) });
      } else if (tool === 'fog' && fogCamp) {
        const explored = brush.fog === 'reveal';
        await api(`/api/worlds/${world.id}/campaigns/${fogCamp}/fog`, { body: { hexIds: ids, explored } });
        qc.setQueryData<string[]>(qk.fog(world.id, fogCamp), (xs) => {
          const s = new Set(xs ?? []);
          ids.forEach((id) => (explored ? s.add(id) : s.delete(id)));
          return [...s];
        });
      }
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
    } catch (e) {
      toastError(e);
      mapQ.refetch(); fogQ.refetch();
    }
  };

  const moveToken = async (t: Token, hexId: string) => {
    patchCache((d) => ({ ...d, tokens: d.tokens.map((x) => (x.id === t.id ? { ...x, hexId } : x)) }));
    try {
      await api(`/api/worlds/${world.id}/tokens/${t.id}`, { method: 'PATCH', body: { hexId } });
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
    } catch (e) { toastError(e); mapQ.refetch(); }
  };

  // ---- input
  const toolRef = useRef({ tool, brush, radius, fogCamp });
  toolRef.current = { tool, brush, radius, fogCamp };
  const handlers = useRef({ commitStroke, moveToken, brushArea });
  handlers.current = { commitStroke, moveToken, brushArea };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pan' | 'maybe-click' | 'stroke' | 'token' | 'pinch' = 'none';
    let start = { x: 0, y: 0 };
    let lastMove = { x: 0, y: 0, t: 0 };
    let vel = { x: 0, y: 0 };
    let stroke = new Set<string>();
    let dragTok: Token | null = null;
    let pinchDist = 0;
    let space = false;

    const pos = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const r = () => rendererRef.current!;

    const strokeAt = (p: { x: number; y: number }) => {
      const h = r().hexAt(p.x, p.y);
      if (!h) return;
      const { tool: t, brush: b, fogCamp: fc } = toolRef.current;
      const ids = handlers.current.brushArea(h).filter((id) => !stroke.has(id));
      if (!ids.length) return;
      ids.forEach((id) => stroke.add(id));
      if (t === 'terrain') r().patchHexes(ids, { terrain: b.terrain });
      else if (t === 'state') r().patchHexes(ids, { state: b.state });
      else if (t === 'claim') r().previewControl(ids, b.claim === 'none' ? null : b.claim);
      else if (t === 'fog' && fc) r().previewFog(ids, b.fog === 'reveal');
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      pointers.set(e.pointerId, p);
      r().fling(0, 0);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        mode = 'pinch';
        return;
      }
      start = p; lastMove = { ...p, t: performance.now() }; vel = { x: 0, y: 0 };
      if (e.button === 1 || e.button === 2 || space) { mode = 'pan'; return; }
      const t = toolRef.current.tool;
      if (t === 'select') {
        const tok = r().tokenAt(p.x, p.y);
        if (tok) { dragTok = tok; mode = 'token'; return; }
        mode = 'maybe-click';
      } else {
        if (t === 'fog' && !toolRef.current.fogCamp) { mode = 'maybe-click'; return; }
        mode = 'stroke'; stroke = new Set(); strokeAt(p);
      }
    };

    const onMove = (e: PointerEvent) => {
      const p = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      const h = r().hexAt(p.x, p.y);
      const hid = h?.id ?? null;
      if (r().hoverId !== hid) { r().hoverId = hid; r().invalidate(); }
      setHover(h && mode === 'none' ? { x: p.x, y: p.y, hexId: h.id } : null);
      // brush footprint preview
      const t = toolRef.current.tool;
      if (t !== 'select' && h) { r().brushIds = new Set(handlers.current.brushArea(h)); r().invalidate(); }
      else if (r().brushIds.size) { r().brushIds = new Set(); r().invalidate(); }

      if (mode === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist) r().zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
        pinchDist = d;
        return;
      }
      const now = performance.now();
      const dx = p.x - lastMove.x, dy = p.y - lastMove.y, dt = Math.max(1, now - lastMove.t);
      if (mode === 'maybe-click' && Math.hypot(p.x - start.x, p.y - start.y) > 4) mode = 'pan';
      if (mode === 'pan') {
        r().panBy(dx, dy);
        vel = { x: (dx / dt) * 1000 * 0.6 + vel.x * 0.4, y: (dy / dt) * 1000 * 0.6 + vel.y * 0.4 };
        canvas.style.cursor = 'grabbing';
      } else if (mode === 'stroke') strokeAt(p);
      else if (mode === 'token' && dragTok) {
        if (!r().dragToken && Math.hypot(p.x - start.x, p.y - start.y) < 4) { lastMove = { ...p, t: now }; return; }
        const w = r().screenToWorld(p.x, p.y);
        r().dragToken = { token: dragTok, x: w.x, y: w.y };
        r().invalidate();
        canvas.style.cursor = 'grabbing';
      } else {
        canvas.style.cursor = toolRef.current.tool === 'select' ? (r().tokenAt(p.x, p.y) ? 'grab' : 'default') : 'crosshair';
      }
      lastMove = { ...p, t: now };
    };

    const onUp = (e: PointerEvent) => {
      const p = pos(e);
      pointers.delete(e.pointerId);
      if (mode === 'pinch') { if (pointers.size === 0) mode = 'none'; return; }
      if (mode === 'pan') {
        if (performance.now() - lastMove.t < 80 && Math.hypot(vel.x, vel.y) > 120) r().fling(vel.x, vel.y);
      } else if (mode === 'maybe-click') {
        const h = r().hexAt(p.x, p.y);
        setSelected(h ? h.id : null);
      } else if (mode === 'stroke') {
        handlers.current.commitStroke([...stroke]);
        stroke = new Set();
      } else if (mode === 'token' && dragTok) {
        const dragging = r().dragToken;
        r().dragToken = null;
        const h = r().hexAt(p.x, p.y);
        if (dragging && h && h.id !== dragTok.hexId) handlers.current.moveToken(dragTok, h.id);
        else if (!dragging) {
          // A click on a token selects its hex.
          setSelected(dragTok.hexId);
        }
        r().invalidate();
        dragTok = null;
      }
      mode = 'none';
      canvas.style.cursor = '';
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = pos(e);
      // Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels give ~100 per notch.
      const scale = e.ctrlKey ? 0.012 : e.deltaMode === 1 ? 0.05 : 0.0018;
      r().zoomAt(p.x, p.y, Math.exp(-e.deltaY * scale));
    };
    const onDbl = (e: MouseEvent) => {
      if (toolRef.current.tool !== 'select') return;
      const p = pos(e);
      const h = r().hexAt(p.x, p.y);
      if (h) r().flyTo(h.cx, h.cy, Math.max(r().target.zoom * 2, 1.4));
    };
    const onLeave = () => { setHover(null); if (r()) { r().hoverId = null; r().brushIds = new Set(); r().invalidate(); } };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.code === 'Space') { space = e.type === 'keydown'; canvas.style.cursor = space ? 'grab' : ''; if (space) e.preventDefault(); return; }
      if (e.type !== 'keydown' || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = ['1', '2', '3', '4', '5'].indexOf(e.key);
      if (idx >= 0) setTool(TOOLS[idx].id);
      else if (e.key === 'Escape') setSelected(null);
      else if (e.key === '+' || e.key === '=') r().zoomAt(r().viewport.w / 2, r().viewport.h / 2, 1.5);
      else if (e.key === '-') r().zoomAt(r().viewport.w / 2, r().viewport.h / 2, 1 / 1.5);
      else if (e.key === 'f') { const c = r().fitCamera(); r().flyTo(c.x, c.y, c.zoom); }
      else if (e.key === '[') setRadius((x) => Math.max(0, x - 1));
      else if (e.key === ']') setRadius((x) => Math.min(3, x + 1));
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  const hoverHex = hover && data ? data.hexes.find((h) => h.id === hover.hexId) : undefined;
  const hoverInfo = useMemo(() => {
    if (!hoverHex || !data) return null;
    const ctrl = data.claims.find((c) => c.hexId === hoverHex.id && c.kind === 'control');
    const f = ctrl ? data.factions.find((x) => x.id === ctrl.factionId) : undefined;
    const t = world.terrainTypes.find((x) => x.key === hoverHex.terrain);
    const toks = data.tokens.filter((x) => x.hexId === hoverHex.id);
    return { hex: hoverHex, faction: f, terrain: t, tokens: toks };
  }, [hoverHex, data, world.terrainTypes]);

  const selectedHex = selected && data ? data.hexes.find((h) => h.id === selected) : undefined;
  const r = rendererRef.current;

  return (
    <div className="mapview" ref={wrapRef}>
      <canvas ref={canvasRef} className="map" aria-label="Hex map" />
      {!data && <div className="empty" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>Unrolling the map…</div>}

      <div className="map-tools">
        <div className="toolgroup">
          {TOOLS.map((t) => (
            <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.keyHint})`} aria-label={t.label}>
              <t.icon size={18} />
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {tool !== 'select' && data && (
          <motion.div className="brushbar" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.15 }}>
            {tool === 'terrain' && world.terrainTypes.map((t) => (
              <button key={t.key} className={`brush ${brush.terrain === t.key ? 'on' : ''}`} onClick={() => setBrush({ ...brush, terrain: t.key })}>
                <span className="swatch" style={{ background: t.color }} />{t.name}
              </button>
            ))}
            {tool === 'state' && world.hexStates.map((s) => (
              <button key={s.key} className={`brush ${brush.state === s.key ? 'on' : ''}`} onClick={() => setBrush({ ...brush, state: s.key })}>
                <span className="swatch" style={{ background: s.color ?? 'transparent' }} />{s.name}
              </button>
            ))}
            {tool === 'claim' && (
              <>
                {data.factions.map((f) => (
                  <button key={f.id} className={`brush ${brush.claim === f.id ? 'on' : ''}`} onClick={() => setBrush({ ...brush, claim: f.id })}>
                    <span className="swatch" style={{ background: f.color }} />{f.name}
                  </button>
                ))}
                <button className={`brush ${brush.claim === 'none' ? 'on' : ''}`} onClick={() => setBrush({ ...brush, claim: 'none' })}>Clear control</button>
                {!data.factions.length && <span className="faint" style={{ padding: 4 }}>Create a faction first.</span>}
              </>
            )}
            {tool === 'fog' && (
              fogCamp ? (
                <>
                  <button className={`brush ${brush.fog === 'reveal' ? 'on' : ''}`} onClick={() => setBrush({ ...brush, fog: 'reveal' })}><Eye size={13} /> Reveal</button>
                  <button className={`brush ${brush.fog === 'hide' ? 'on' : ''}`} onClick={() => setBrush({ ...brush, fog: 'hide' })}><EyeOff size={13} /> Hide</button>
                  <span className="faint" style={{ padding: '4px 6px', fontSize: 12 }}>for {data.campaigns.find((c) => c.id === fogCamp)?.name}</span>
                </>
              ) : <span className="faint" style={{ padding: 4, fontSize: 12 }}>Pick a campaign below to edit its party fog.</span>
            )}
            <span style={{ width: 1, background: 'var(--line)', margin: '2px 4px' }} />
            <div className="seg" title="Brush size ([ and ])">
              {[0, 1, 2].map((n) => <button key={n} className={radius === n ? 'on' : ''} onClick={() => setRadius(n)}>{n === 0 ? '1 hex' : `r${n}`}</button>)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {data && (
        <div className="map-hud">
          <div className="hud-pill">
            <Flag size={13} />
            <select className="select" style={{ background: 'transparent', border: 0, padding: 0, width: 'auto', fontSize: 12 }}
              value={fogCamp ?? ''} onChange={(e) => setCampaignId(e.target.value || null)} aria-label="Party fog campaign">
              <option value="">No party fog</option>
              {data.campaigns.map((c) => <option key={c.id} value={c.id}>Fog: {c.name}</option>)}
            </select>
            {fogCamp && (
              <button className="btn ghost sm icon" onClick={() => setShowFog((s) => !s)} title={showFog ? 'Hide fog overlay' : 'Show fog overlay'}>
                {showFog ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            )}
          </div>
          <div className="hud-pill">{zoomLabel} view</div>
          <div className="hud-pill faint">Scroll to zoom · drag to pan · double-click to dive in</div>
        </div>
      )}

      {data && !!data.factions.length && (
        <div className="legend">
          {data.factions.map((f) => {
            const n = data.claims.filter((c) => c.factionId === f.id && c.kind === 'control').length;
            return <div key={f.id} className="row"><span className="swatch" style={{ background: f.color }} /> <span className="grow">{f.name}</span> <span className="faint">{n}</span></div>;
          })}
        </div>
      )}

      <div className="zoombar">
        <div className="toolgroup">
          <button onClick={() => r?.zoomAt(r.viewport.w / 2, r.viewport.h / 2, 1 / 1.6)} title="Zoom out (-)" aria-label="Zoom out"><Minus size={16} /></button>
          <button onClick={() => { if (r) { const c = r.fitCamera(); r.flyTo(c.x, c.y, c.zoom); } }} title="Whole map (F)" aria-label="Fit map"><Maximize size={16} /></button>
          <button onClick={() => r?.zoomAt(r.viewport.w / 2, r.viewport.h / 2, 1.6)} title="Zoom in (+)" aria-label="Zoom in"><Plus size={16} /></button>
        </div>
      </div>

      {hover && hoverInfo && !selected && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="swatch" style={{ background: hoverInfo.terrain?.color }} />
            <b>{hoverInfo.hex.name || hoverInfo.terrain?.name || hoverInfo.hex.terrain}</b>
            <span className="faint">{r?.label(hoverInfo.hex)}</span>
          </div>
          {hoverInfo.faction && <div className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: hoverInfo.faction.color }} />{hoverInfo.faction.name}</div>}
          {hoverInfo.tokens.map((t) => <div key={t.id} className="muted">{t.name}</div>)}
        </div>
      )}

      <AnimatePresence>
        {selectedHex && data && (
          <HexInspector key="inspector" hex={selectedHex} data={data} fogCampaignId={fogCamp} explored={fogQ.data?.includes(selectedHex.id) ?? false}
            label={r?.label(selectedHex) ?? ''} onClose={() => setSelected(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
