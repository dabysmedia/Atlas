import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../api';
import type { MapData } from '../types';
import { useWorld } from '../world';
import { ambientPref, layerPrefs } from '../prefs';
import { HexMapRenderer } from '../map/renderer';
import { gridBounds } from '../../../shared/hex';

/** Where the view drifts for each section, so moving down the rail reads as turning your head. */
const DRIFT: Record<string, number> = { wiki: 2.2, factions: 0.8, chronicle: -0.6, campaigns: -2, settings: -3.2 };
/** The backdrop renders at reduced resolution; the blur hides it and it costs a quarter of the pixels. */
const SCALE = 0.5;

export function useAmbientPref() {
  return useSyncExternalStore(ambientPref.subscribe, ambientPref.get, () => true);
}

/**
 * The world's map, blurred and dimmed, behind every page except the map itself.
 * It is drawn once into a still image (when the map data, art or size changes), never animated,
 * so scrolling and typing over it cost nothing extra.
 */
export function AmbientMap({ section }: { section: string }) {
  const world = useWorld();
  const enabled = useAmbientPref();
  const onMap = section === 'map' || !(section in DRIFT);
  const wanted = enabled && !onMap;
  const [seen, setSeen] = useState(wanted);
  useEffect(() => { if (wanted) setSeen(true); }, [wanted]);

  // Shares the map view's cache; only fetched once a non-map page has been opened.
  const mapQ = useQuery({ queryKey: qk.map(world.id), queryFn: () => api<MapData>(`/api/worlds/${world.id}/map`), enabled: enabled && seen });
  const data = mapQ.data;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [art, setArt] = useState<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const drawnFor = useRef<unknown[] | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let t = 0;
    const ro = new ResizeObserver(([e]) => {
      window.clearTimeout(t);
      // Re-render only after a resize settles, and only for real changes.
      t = window.setTimeout(() => setSize((s) => {
        const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
        if (s && Math.abs(s.w - w) < 24 && Math.abs(s.h - h) < 24) return s;
        return { w, h };
      }), 200);
    });
    ro.observe(el);
    return () => { ro.disconnect(); window.clearTimeout(t); };
  }, []);

  const artMeta = data?.map.art ?? null;
  useEffect(() => {
    if (!artMeta) { setArt(null); return; }
    const img = new Image();
    img.decoding = 'async';
    img.src = `/api/worlds/${world.id}/map/art?v=${artMeta.version}`;
    let live = true;
    img.decode().then(() => { if (live) setArt(img); }).catch(() => {});
    return () => { live = false; };
  }, [artMeta?.version, world.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Nothing to draw while the map itself is showing; edits made there are picked up on the way out.
    if (!wanted || !data || !size || !size.w || !size.h || !canvasRef.current) return;
    if (artMeta && !art) return; // wait for the painting rather than flashing the bare grid first
    const inputs = [data, size, art, artMeta?.placement, world.terrainTypes, world.hexStates];
    if (drawnFor.current && inputs.every((x, i) => x === drawnFor.current![i])) return; // already showing exactly this
    const out = canvasRef.current;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      const w = Math.max(1, Math.round(size.w * SCALE)), h = Math.max(1, Math.round(size.h * SCALE));
      const scratch = document.createElement('canvas');
      const r = new HexMapRenderer(scratch);
      try {
        r.resize(w, h);
        r.layers = { ...r.layers, ...layerPrefs(world.id).get(), grid: false };
        r.setData({
          orientation: data.map.layout.orientation, hexes: data.hexes, claims: data.claims, tokens: data.tokens,
          factions: data.factions, terrain: world.terrainTypes, states: world.hexStates, fog: null,
        });
        if (art && artMeta) r.setArt(art, artMeta.placement);
        // Frame the whole island, a little larger than the page so the drift never shows an edge.
        const { cols, rows, orientation } = data.map.layout;
        const b = gridBounds(cols, rows, orientation);
        const zoom = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY)) * 1.04;
        const still = r.snapshot((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, zoom, w, h);
        out.width = w; out.height = h;
        const ctx = out.getContext('2d')!;
        // Older Safari has no canvas filters; there the stylesheet blurs the element instead.
        const canFilter = typeof ctx.filter === 'string';
        if (canFilter) ctx.filter = 'blur(5px) saturate(0.8)';
        ctx.drawImage(still, 0, 0, w, h);
        if (canFilter) ctx.filter = 'none';
        out.classList.toggle('css-blur', !canFilter);
      } finally {
        r.destroy();
      }
      drawnFor.current = inputs;
      setReady(true);
    };
    // Draw when the browser is idle so it never competes with the page's own first paint.
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const id = ric ? ric(render, { timeout: 600 }) : window.setTimeout(render, 60);
    return () => {
      cancelled = true;
      const cic = (window as unknown as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback;
      if (ric && cic) cic(id); else window.clearTimeout(id);
    };
  }, [wanted, data, size, art, artMeta, world.id, world.terrainTypes, world.hexStates]);

  const drift = DRIFT[section] ?? 0;
  return (
    <div ref={wrapRef} className={`ambient ${wanted && ready ? 'on' : ''}`} aria-hidden>
      <canvas ref={canvasRef} style={{ transform: `translate3d(${drift}%, 0, 0)` }} />
    </div>
  );
}
