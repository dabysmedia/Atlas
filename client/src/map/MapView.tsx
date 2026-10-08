import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  Brush, ChevronLeft, Eye, EyeOff, Flag, Grid3x3, Image as ImageIcon, Layers, Maximize, Minus, MousePointer2, Move, Plus,
  RotateCcw, Shield, Stamp, Trash2, Upload, X,
} from 'lucide-react';
import { api, ApiError, qk } from '../api';
import type { ArtPlacement, Claim, Hex, MapArt, MapData, Token } from '../types';
import { useWorld } from '../world';
import { cameraPref, fogCampaign, layerPrefs, panelPrefs } from '../prefs';
import { HEX_SIZE, HexMapRenderer, type Camera, type Layers as RLayers } from './renderer';
import { FactionPanel, HexPanel, TokenPanel, Diamond, type Focus } from './panels';
import { toast, toastError } from '../components/toast';
import { Dialog } from '../components/Dialog';
import { DIRS, key } from '../../../shared/hex';

type Tool = 'select' | 'terrain' | 'state' | 'claim' | 'fog';
const TOOLS: { id: Tool; label: string; icon: typeof Brush; keyHint: string }[] = [
  { id: 'select', label: 'Inspect and move', icon: MousePointer2, keyHint: '1' },
  { id: 'terrain', label: 'Paint terrain', icon: Brush, keyHint: '2' },
  { id: 'state', label: 'Paint hex state', icon: Stamp, keyHint: '3' },
  { id: 'claim', label: 'Paint faction control', icon: Shield, keyHint: '4' },
  { id: 'fog', label: 'Reveal or hide party fog', icon: Eye, keyHint: '5' },
];

/** Cameras survive tab switches within the session; localStorage carries them across visits. */
const sessionCameras = new Map<string, Camera>();
const DEFAULT_LAYERS: RLayers = { terrainOverlay: 0, grid: true, territory: true };

export function MapView() {
  const world = useWorld();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<HexMapRenderer | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [brush, setBrush] = useState<Record<Tool, string>>({ select: '', terrain: 'plains', state: 'settled', claim: '', fog: 'reveal' });
  const [radius, setRadius] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; hexId: string } | null>(null);
  const [campaignId, setCampaignId] = useState<string | null | undefined>(() => fogCampaign(world.id).get());
  const [showFog, setShowFog] = useState(false);
  const [layers, setLayers] = useState<RLayers>(() => ({ ...DEFAULT_LAYERS, ...layerPrefs(world.id).get() }));
  const [layersOpen, setLayersOpen] = useState(false);
  const [territoriesOpen, setTerritoriesOpen] = useState(() => panelPrefs.get()?.territories ?? true);
  const [align, setAlign] = useState<ArtPlacement | null>(null);
  const [artLoaded, setArtLoaded] = useState(0);
  const [dropping, setDropping] = useState(false);

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

  // Map art: load the versioned image once per version.
  const art = data?.map.art ?? null;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!art) { r.setArt(null, null); setArtLoaded(0); return; }
    const img = new Image();
    img.decoding = 'async';
    img.src = `/api/worlds/${world.id}/map/art?v=${art.version}`;
    let live = true;
    img.decode().then(() => { if (live) { rendererRef.current?.setArt(img, art.placement); setArtLoaded(art.version); } }).catch(() => {});
    return () => { live = false; };
  }, [art?.version, world.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const r = rendererRef.current;
    if (r && art && r.hasArt && !align) { r.artPlacement = { ...art.placement }; r.invalidate(); }
  }, [art?.placement, align]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Renderer state that follows React state.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.selectedId = focus?.kind === 'hex' ? focus.id : null;
    r.selectedTokenId = focus?.kind === 'token' ? focus.id : null;
    r.focusFactionId = focus?.kind === 'faction' ? focus.id : null;
    r.invalidate();
  }, [focus]);
  useEffect(() => { const r = rendererRef.current; if (r) { r.showFog = showFog; r.invalidate(); } }, [showFog]);
  useEffect(() => { fogCampaign(world.id).set(fogCamp); }, [fogCamp, world.id]);
  useEffect(() => {
    const r = rendererRef.current;
    if (r) { r.layers = align ? { ...layers, territory: false, grid: true, terrainOverlay: Math.max(layers.terrainOverlay, 0.35) } : layers; r.invalidate(); }
    layerPrefs(world.id).set(layers);
  }, [layers, align, world.id]);
  useEffect(() => { const r = rendererRef.current; if (r) { r.painting = tool === 'terrain' || tool === 'state'; r.invalidate(); } }, [tool]);
  useEffect(() => { panelPrefs.set({ ...panelPrefs.get(), territories: territoriesOpen }); }, [territoriesOpen]);

  /** Fly to a point, centered in the map area the focus panel leaves visible. */
  const centerOn = (x: number, y: number, zoom: number) => {
    const r = rendererRef.current;
    if (!r) return;
    const panel = r.viewport.w > 900 ? 185 : 0;
    r.flyTo(x + panel / zoom, y, zoom);
  };

  // Deep links from search: ?focus=hex:<id> | token:<id> | faction:<id>
  useEffect(() => {
    const f = params.get('focus');
    if (!f || !data) return;
    const [kind, id] = f.split(':') as [Focus['kind'], string];
    const r = rendererRef.current;
    if (kind === 'hex' || kind === 'token' || kind === 'faction') {
      setFocus({ kind, id });
      const hexId = kind === 'hex' ? id : kind === 'token' ? data.tokens.find((t) => t.id === id)?.hexId : null;
      const h = hexId && r?.hexById(hexId);
      // Wait for the initial camera placement, or it would override this flight.
      if (h && r) {
        const id = window.setInterval(() => { if (placedCamera.current) { window.clearInterval(id); centerOn(h.cx, h.cy, Math.max(r.target.zoom, 1.3)); } }, 16);
        window.setTimeout(() => window.clearInterval(id), 3000);
      }
    }
    params.delete('focus');
    setParams(params, { replace: true });
  }, [params, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- cache helpers (optimistic edits flow through the query cache)
  const patchCache = (fn: (d: MapData) => MapData) => qc.setQueryData<MapData>(qk.map(world.id), (d) => (d ? fn(d) : d));

  const brushArea = (center: Hex): string[] => {
    if (radius === 0) return [center.id];
    const out: string[] = [];
    const dirs = DIRS[data!.map.layout.orientation];
    const byKey = new Map(data!.hexes.map((h) => [key(h.q, h.r), h]));
    const seen = new Set([key(center.q, center.r)]);
    let ring = [center];
    out.push(center.id);
    for (let i = 0; i < radius; i++) {
      const next: Hex[] = [];
      for (const h of ring) for (const d of dirs) {
        const k = key(h.q + d.q, h.r + d.r);
        if (seen.has(k)) continue;
        seen.add(k);
        const n = byKey.get(k);
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
        patchCache((d) => ({ ...d, claims: [...d.claims.filter((c) => !(ids.includes(c.hexId) && c.kind === 'control')), ...claims] }));
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

  // ---- map art
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmArt, setConfirmArt] = useState<null | 'remove'>(null);
  const uploadArt = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast('That file is not an image.'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('Images up to 25 MB, please.'); return; }
    try {
      const res = await fetch(`/api/worlds/${world.id}/map/art`, { method: 'PUT', body: file, headers: { 'content-type': file.type }, credentials: 'same-origin' });
      const body = await res.json();
      if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText);
      const meta = body as MapArt;
      patchCache((d) => ({ ...d, map: { ...d.map, art: meta } }));
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
      qc.invalidateQueries({ queryKey: qk.worlds });
      setLayersOpen(false);
      setAlign({ ...meta.placement });
      toast('Map art added. Line it up with the grid, then save.');
    } catch (e) { toastError(e); }
  };
  const saveArt = async (placement: ArtPlacement | null, reset = false) => {
    try {
      const meta = await api<MapArt>(`/api/worlds/${world.id}/map/art`, { method: 'PATCH', body: reset ? { reset: true } : { placement } });
      patchCache((d) => ({ ...d, map: { ...d.map, art: meta } }));
      return meta;
    } catch (e) { toastError(e); return null; }
  };
  const removeArt = async () => {
    try {
      await api(`/api/worlds/${world.id}/map/art`, { method: 'DELETE' });
      patchCache((d) => ({ ...d, map: { ...d.map, art: null } }));
      qc.invalidateQueries({ queryKey: qk.events(world.id) });
      qc.invalidateQueries({ queryKey: qk.worlds });
    } catch (e) { toastError(e); }
  };
  // Live preview while aligning.
  useEffect(() => { const r = rendererRef.current; if (r && align) { r.artPlacement = { ...align }; r.invalidate(); } }, [align]);

  // ---- input
  const toolRef = useRef({ tool, brush, radius, fogCamp, align });
  toolRef.current = { tool, brush, radius, fogCamp, align };
  const handlers = useRef({ commitStroke, moveToken, brushArea, setAlign });
  handlers.current = { commitStroke, moveToken, brushArea, setAlign };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pan' | 'maybe-click' | 'stroke' | 'token' | 'pinch' | 'art' = 'none';
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
      if (toolRef.current.align) { mode = 'art'; return; }
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
      const hid = toolRef.current.align ? null : h?.id ?? null;
      if (r().hoverId !== hid) { r().hoverId = hid; r().invalidate(); }
      setHover(h && mode === 'none' && !toolRef.current.align ? { x: p.x, y: p.y, hexId: h.id } : null);
      const t = toolRef.current.tool;
      if (t !== 'select' && h && !toolRef.current.align) { r().brushIds = new Set(handlers.current.brushArea(h)); r().invalidate(); }
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
      } else if (mode === 'art') {
        const z = r().cam.zoom;
        handlers.current.setAlign((a) => (a ? { ...a, x: a.x + dx / z, y: a.y + dy / z } : a));
        canvas.style.cursor = 'move';
      } else if (mode === 'stroke') strokeAt(p);
      else if (mode === 'token' && dragTok) {
        if (!r().dragToken && Math.hypot(p.x - start.x, p.y - start.y) < 4) { lastMove = { ...p, t: now }; return; }
        const w = r().screenToWorld(p.x, p.y);
        r().dragToken = { token: dragTok, x: w.x, y: w.y };
        r().invalidate();
        canvas.style.cursor = 'grabbing';
      } else {
        canvas.style.cursor = toolRef.current.align ? 'move' : toolRef.current.tool === 'select' ? (r().tokenAt(p.x, p.y) ? 'pointer' : 'default') : 'crosshair';
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
        setFocus(h ? { kind: 'hex', id: h.id } : null);
      } else if (mode === 'stroke') {
        handlers.current.commitStroke([...stroke]);
        stroke = new Set();
      } else if (mode === 'token' && dragTok) {
        const dragging = r().dragToken;
        r().dragToken = null;
        const h = r().hexAt(p.x, p.y);
        if (dragging && h && h.id !== dragTok.hexId) handlers.current.moveToken(dragTok, h.id);
        else if (!dragging) setFocus({ kind: 'token', id: dragTok.id });
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
      const factor = Math.exp(-e.deltaY * scale);
      if (toolRef.current.align && e.altKey) {
        // Alt + wheel scales the art about the cursor.
        const w = r().screenToWorld(p.x, p.y);
        const f = Math.exp(-e.deltaY * 0.0012);
        handlers.current.setAlign((a) => (a ? { ...a, x: w.x - (w.x - a.x) * f, y: w.y - (w.y - a.y) * f, w: a.w * f, h: a.h * f } : a));
        return;
      }
      r().zoomAt(p.x, p.y, factor);
    };
    const onDbl = (e: MouseEvent) => {
      if (toolRef.current.tool !== 'select' || toolRef.current.align) return;
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
      else if (e.key === 'Escape') { setFocus(null); setLayersOpen(false); }
      else if (e.key === '+' || e.key === '=') r().zoomAt(r().viewport.w / 2, r().viewport.h / 2, 1.5);
      else if (e.key === '-') r().zoomAt(r().viewport.w / 2, r().viewport.h / 2, 1 / 1.5);
      else if (e.key === 'f') { const c = r().fitCamera(); r().flyTo(c.x, c.y, c.zoom); }
      else if (e.key === '[') setRadius((x) => Math.max(0, x - 1));
      else if (e.key === ']') setRadius((x) => Math.min(3, x + 1));
      else if (e.key === 'l') setLayersOpen((o) => !o);
    };
    // Drop an image anywhere on the map to use it as map art.
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDropping(true); } };
    const onDragLeave = () => setDropping(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); setDropping(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void uploadRef.current(f);
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDbl);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    const wrap = wrapRef.current!;
    wrap.addEventListener('dragover', onDragOver);
    wrap.addEventListener('dragleave', onDragLeave);
    wrap.addEventListener('drop', onDrop);
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
      wrap.removeEventListener('dragover', onDragOver);
      wrap.removeEventListener('dragleave', onDragLeave);
      wrap.removeEventListener('drop', onDrop);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);
  const uploadRef = useRef(uploadArt);
  uploadRef.current = uploadArt;

  const hoverHex = hover && data ? data.hexes.find((h) => h.id === hover.hexId) : undefined;
  const hoverInfo = useMemo(() => {
    if (!hoverHex || !data) return null;
    const ctrl = data.claims.find((c) => c.hexId === hoverHex.id && c.kind === 'control');
    const f = ctrl ? data.factions.find((x) => x.id === ctrl.factionId) : undefined;
    const t = world.terrainTypes.find((x) => x.key === hoverHex.terrain);
    const toks = data.tokens.filter((x) => x.hexId === hoverHex.id);
    const contested = data.claims.some((c) => c.hexId === hoverHex.id && c.kind === 'contested');
    return { hex: hoverHex, faction: f, terrain: t, tokens: toks, contested };
  }, [hoverHex, data, world.terrainTypes]);

  const r = rendererRef.current;
  const snapAt = (x: number, y: number, zoom = 1.6) => () => {
    const rr = rendererRef.current;
    if (!rr) return null;
    try { return rr.snapshot(x, y, zoom, 380, 168).toDataURL('image/jpeg', 0.86); } catch { return null; }
  };
  const focusHex = focus?.kind === 'hex' && data ? data.hexes.find((h) => h.id === focus.id) : undefined;
  const focusToken = focus?.kind === 'token' && data ? data.tokens.find((t) => t.id === focus.id) : undefined;
  const territoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    data?.claims.forEach((c) => { if (c.kind === 'control') m.set(c.factionId, (m.get(c.factionId) ?? 0) + 1); });
    return m;
  }, [data?.claims]); // eslint-disable-line react-hooks/exhaustive-deps

  const factionSnap = (id: string) => {
    const t = data?.claims.filter((c) => c.factionId === id && c.kind === 'control').map((c) => r?.hexById(c.hexId)).filter(Boolean) as { cx: number; cy: number }[] | undefined;
    if (!t?.length) return () => null;
    const xs = t.map((h) => h.cx), ys = t.map((h) => h.cy);
    const w = Math.max(...xs) - Math.min(...xs) + HEX_SIZE * 3, h = Math.max(...ys) - Math.min(...ys) + HEX_SIZE * 3;
    return snapAt((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, Math.min(380 / w, 168 / h));
  };

  return (
    <div className={`mapview ${align ? 'aligning' : ''}`} ref={wrapRef}>
      <canvas ref={canvasRef} className="map" aria-label="Hex map" />
      {!data && <div className="map-loading"><span>Unrolling the map…</span></div>}

      {/* Territories: compact, collapsible. */}
      {data && !align && (
        <AnimatePresence initial={false} mode="wait">
          {territoriesOpen ? (
            <motion.div key="open" className="panel territories" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.16 }}>
              <header>
                <h4>Territories</h4>
                <button className="iconbtn sm" onClick={() => setTerritoriesOpen(false)} aria-label="Collapse territories"><ChevronLeft size={14} /></button>
              </header>
              {data.factions.map((f) => (
                <button key={f.id} className={`terr-row ${focus?.kind === 'faction' && focus.id === f.id ? 'on' : ''}`}
                  onClick={() => setFocus(focus?.kind === 'faction' && focus.id === f.id ? null : { kind: 'faction', id: f.id })}>
                  <Diamond color={f.color} /> <span className="grow">{f.name}</span> <span className="num faint">{territoryCounts.get(f.id) ?? 0}</span>
                </button>
              ))}
              {!data.factions.length && <div className="faint" style={{ fontSize: 12, padding: '2px 4px 6px' }}>No factions yet.</div>}
              <div className="legend-rows">
                <span><i className="lg-contested" /> Contested</span>
                <span><i className="lg-influence" /> Influence</span>
                <span><i className="lg-border" /> Border</span>
              </div>
            </motion.div>
          ) : (
            <motion.button key="closed" className="panel territories-pill" onClick={() => setTerritoriesOpen(true)} title="Territories"
              initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.16 }}>
              <Flag size={14} />
              <span className="dots">{data.factions.slice(0, 6).map((f) => <Diamond key={f.id} color={f.color} size={7} />)}</span>
            </motion.button>
          )}
        </AnimatePresence>
      )}

      {/* Tool dock. */}
      {data && !align && (
        <div className="dock-wrap">
          <AnimatePresence>
            {tool !== 'select' && (
              <motion.div className="panel brushbar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.15 }}>
                <span className="brushbar-title">{TOOLS.find((t) => t.id === tool)?.label}</span>
                <div className="brush-list">
                  {tool === 'terrain' && world.terrainTypes.map((t) => (
                    <button key={t.key} className={`brush ${brush.terrain === t.key ? 'on' : ''}`} onClick={() => setBrush({ ...brush, terrain: t.key })}>
                      <span className="swatch" style={{ background: t.color }} />{t.name}
                    </button>
                  ))}
                  {tool === 'state' && world.hexStates.map((s) => (
                    <button key={s.key} className={`brush ${brush.state === s.key ? 'on' : ''}`} onClick={() => setBrush({ ...brush, state: s.key })}>
                      {s.color ? <Diamond color={s.color} size={8} /> : <span className="swatch" style={{ background: 'transparent' }} />}{s.name}
                    </button>
                  ))}
                  {tool === 'claim' && (
                    <>
                      {data.factions.map((f) => (
                        <button key={f.id} className={`brush ${brush.claim === f.id ? 'on' : ''}`} onClick={() => setBrush({ ...brush, claim: f.id })}>
                          <Diamond color={f.color} size={9} />{f.name}
                        </button>
                      ))}
                      <button className={`brush ${brush.claim === 'none' ? 'on' : ''}`} onClick={() => setBrush({ ...brush, claim: 'none' })}><X size={12} /> Clear control</button>
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
                    ) : <span className="faint" style={{ padding: 4, fontSize: 12 }}>Pick a campaign under Layers to edit its party fog.</span>
                  )}
                </div>
                <div className="seg" title="Brush size ([ and ])">
                  {[0, 1, 2].map((n) => <button key={n} className={radius === n ? 'on' : ''} onClick={() => setRadius(n)}>{n === 0 ? '1 hex' : `r${n}`}</button>)}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {layersOpen && (
              <motion.div className="panel layers" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.15 }}>
                <header><h4>Layers</h4><button className="iconbtn sm" onClick={() => setLayersOpen(false)} aria-label="Close layers"><X size={14} /></button></header>
                <div className="layer-group">
                  <div className="layer-title"><ImageIcon size={14} /> Map art</div>
                  {art ? (
                    <>
                      <div className="art-thumb"><img src={`/api/worlds/${world.id}/map/art?v=${art.version}`} alt="" /><span>{art.width}×{art.height}</span></div>
                      <label className="slider"><span>Art opacity</span>
                        <input type="range" min={0.2} max={1} step={0.05} value={art.placement.opacity}
                          onChange={(e) => { const o = Number(e.target.value); patchCache((d) => ({ ...d, map: { ...d.map, art: d.map.art && { ...d.map.art, placement: { ...d.map.art.placement, opacity: o } } } })); }}
                          onPointerUp={() => saveArt(data.map.art?.placement ?? null)} onKeyUp={() => saveArt(data.map.art?.placement ?? null)} />
                      </label>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn sm" onClick={() => { setLayersOpen(false); setFocus(null); setAlign({ ...art.placement }); }}><Move size={13} /> Align</button>
                        <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> Replace</button>
                        <button className="btn sm ghost danger" onClick={() => setConfirmArt('remove')}><Trash2 size={13} /> Remove</button>
                      </div>
                    </>
                  ) : (
                    <button className="dropzone" onClick={() => fileRef.current?.click()}>
                      <Upload size={18} />
                      <span><b>Add map art</b><br /><span className="faint">Choose an image, or drop one on the map. PNG, JPEG or WebP up to 25 MB.</span></span>
                    </button>
                  )}
                </div>
                <div className="layer-group">
                  {art && (
                    <label className="slider"><span>Terrain colors over art</span>
                      <input type="range" min={0} max={0.8} step={0.05} value={layers.terrainOverlay} onChange={(e) => setLayers({ ...layers, terrainOverlay: Number(e.target.value) })} />
                    </label>
                  )}
                  <label className="toggle"><input type="checkbox" checked={layers.grid} onChange={(e) => setLayers({ ...layers, grid: e.target.checked })} /><Grid3x3 size={14} /> Hex grid</label>
                  <label className="toggle"><input type="checkbox" checked={layers.territory} onChange={(e) => setLayers({ ...layers, territory: e.target.checked })} /><Shield size={14} /> Territories and borders</label>
                </div>
                <div className="layer-group">
                  <div className="layer-title"><Eye size={14} /> Party fog</div>
                  <select className="select" value={fogCamp ?? ''} onChange={(e) => setCampaignId(e.target.value || null)} aria-label="Party fog campaign">
                    <option value="">No campaign</option>
                    {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {fogCamp && <label className="toggle"><input type="checkbox" checked={showFog} onChange={(e) => setShowFog(e.target.checked)} /> Shade unexplored hexes</label>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="panel dock" role="toolbar" aria-label="Map tools">
            {TOOLS.map((t) => (
              <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} data-tip={`${t.label} · ${t.keyHint}`} aria-label={t.label}>
                <t.icon size={17} strokeWidth={1.7} />
              </button>
            ))}
            <span className="dock-sep" />
            <button className={layersOpen ? 'on' : ''} onClick={() => setLayersOpen((o) => !o)} data-tip="Layers and map art · L" aria-label="Layers"><Layers size={17} strokeWidth={1.7} /></button>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadArt(f); }} />

      {/* Art alignment. */}
      <AnimatePresence>
        {align && (
          <motion.div className="panel alignbar" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            <div className="align-head"><Move size={15} /> <b>Align map art</b><span className="faint">Drag the art to move it. Hold Alt and scroll to scale around the cursor.</span></div>
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <label className="slider inline"><span>Scale</span>
                <input type="range" min={-1.2} max={1.2} step={0.005} value={Math.log((align.w) / (art?.placement.w ?? align.w)) || 0}
                  onChange={(e) => {
                    const base = art?.placement ?? align;
                    const f = Math.exp(Number(e.target.value));
                    const cx = align.x + align.w / 2, cy = align.y + align.h / 2;
                    const w = base.w * f, h = base.h * f;
                    setAlign({ ...align, w, h, x: cx - w / 2, y: cy - h / 2 });
                  }} />
              </label>
              <label className="slider inline"><span>Opacity</span>
                <input type="range" min={0.2} max={1} step={0.05} value={align.opacity} onChange={(e) => setAlign({ ...align, opacity: Number(e.target.value) })} />
              </label>
              <div className="nudge">
                {([['←', -1, 0], ['→', 1, 0], ['↑', 0, -1], ['↓', 0, 1]] as const).map(([l, dx, dy]) => (
                  <button key={l} className="btn sm" onClick={() => setAlign({ ...align, x: align.x + dx * 4, y: align.y + dy * 4 })} aria-label={`Nudge ${l}`}>{l}</button>
                ))}
              </div>
              <button className="btn sm" onClick={async () => { const m = await saveArt(null, true); if (m) setAlign({ ...m.placement }); }}><RotateCcw size={13} /> Fit to grid</button>
              <span className="spacer" />
              <button className="btn sm ghost" onClick={() => setAlign(null)}>Cancel</button>
              <button className="btn sm primary" onClick={async () => { const m = await saveArt(align); if (m) { setAlign(null); toast('Art alignment saved'); } }}>Save alignment</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {align && <ArtHandles renderer={r} align={align} onChange={setAlign} />}

      <div className="zoombar panel">
        <button onClick={() => r?.zoomAt(r.viewport.w / 2, r.viewport.h / 2, 1.6)} title="Zoom in (+)" aria-label="Zoom in"><Plus size={15} /></button>
        <button onClick={() => { if (r) { const c = r.fitCamera(); r.flyTo(c.x, c.y, c.zoom); } }} title="Whole map (F)" aria-label="Fit map"><Maximize size={14} /></button>
        <button onClick={() => r?.zoomAt(r.viewport.w / 2, r.viewport.h / 2, 1 / 1.6)} title="Zoom out (-)" aria-label="Zoom out"><Minus size={15} /></button>
      </div>

      {hover && hoverInfo && !focus && !align && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
          <div className="tt-title">{hoverInfo.hex.name || hoverInfo.terrain?.name || hoverInfo.hex.terrain}<span className="faint">{r?.label(hoverInfo.hex)}</span></div>
          {hoverInfo.hex.name && <div className="row" style={{ gap: 6 }}><span className="swatch" style={{ background: hoverInfo.terrain?.color }} />{hoverInfo.terrain?.name}</div>}
          {hoverInfo.faction && <div className="row" style={{ gap: 6 }}><Diamond color={hoverInfo.faction.color} size={8} />{hoverInfo.faction.name}</div>}
          {hoverInfo.contested && <div className="tone-warn">Contested</div>}
          {hoverInfo.tokens.map((t) => <div key={t.id} className="muted">{t.name}</div>)}
        </div>
      )}

      <AnimatePresence>
        {dropping && (
          <motion.div className="drop-veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Upload size={28} /><div>Drop to use as map art</div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {data && focusHex && !align && (
          <HexPanel key={`hex-${focusHex.id}`} hex={focusHex} data={data} fogCampaignId={fogCamp} explored={fogQ.data?.includes(focusHex.id) ?? false}
            label={r?.label(focusHex) ?? ''} onClose={() => setFocus(null)} onFocus={setFocus}
            snap={(() => { const h = r?.hexById(focusHex.id); return h ? snapAt(h.cx, h.cy, 2.1) : () => null; })()} />
        )}
        {data && focusToken && !align && (
          <TokenPanel key={`tok-${focusToken.id}`} token={focusToken} data={data} onClose={() => setFocus(null)} onFocus={setFocus}
            onLocate={() => { const p = r?.tokenPos(focusToken); if (p && r) centerOn(p.x, p.y, Math.max(r.target.zoom, 1.5)); }}
            snap={(() => { const p = r?.tokenPos(focusToken); return p ? snapAt(p.x, p.y, 2.1) : () => null; })()} />
        )}
        {data && focus?.kind === 'faction' && !align && (
          <FactionPanel key={`fac-${focus.id}`} factionId={focus.id} data={data} onClose={() => setFocus(null)} onFocus={setFocus} snap={factionSnap(focus.id)} />
        )}
      </AnimatePresence>

      <Dialog open={confirmArt === 'remove'} onClose={() => setConfirmArt(null)} title="Remove the map art?">
        <p className="muted" style={{ marginTop: 0 }}>The hexes, borders and markers stay exactly as they are. The map falls back to painted terrain.</p>
        <div className="actions"><button className="btn ghost" onClick={() => setConfirmArt(null)}>Keep it</button><button className="btn danger-solid" onClick={() => { setConfirmArt(null); void removeArt(); }}>Remove art</button></div>
      </Dialog>
      <span hidden data-art-loaded={artLoaded} />
    </div>
  );
}

/** Corner handles over the art while aligning: drag one to scale about the opposite corner. */
function ArtHandles({ renderer, align, onChange }: { renderer: HexMapRenderer | null; align: ArtPlacement; onChange: (a: ArtPlacement) => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!renderer) return;
    const prev = renderer.onAfterFrame;
    renderer.onAfterFrame = () => { prev?.(); force((n) => n + 1); };
    return () => { renderer.onAfterFrame = prev; };
  }, [renderer]);
  if (!renderer) return null;
  const a = renderer.worldToScreen(align.x, align.y), b = renderer.worldToScreen(align.x + align.w, align.y + align.h);
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
  const start = (cx: number, cy: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const fixed = { x: cx ? align.x : align.x + align.w, y: cy ? align.y : align.y + align.h };
    const aspect = align.w / align.h;
    const move = (ev: PointerEvent) => {
      const bnd = renderer.canvas.getBoundingClientRect();
      const p = renderer.screenToWorld(ev.clientX - bnd.left, ev.clientY - bnd.top);
      let w = Math.abs(p.x - fixed.x);
      const h0 = Math.abs(p.y - fixed.y);
      w = Math.max(40, Math.max(w, h0 * aspect));
      const h = w / aspect;
      onChange({ ...align, w, h, x: cx ? fixed.x : fixed.x - w, y: cy ? fixed.y : fixed.y - h });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="art-frame" style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }} />
      {corners.map(([cx, cy]) => (
        <div key={`${cx}${cy}`} className="art-handle" style={{ left: cx ? b.x : a.x, top: cy ? b.y : a.y }} onPointerDown={start(cx, cy)} />
      ))}
    </>
  );
}
