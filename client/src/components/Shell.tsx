import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookOpen, ChevronLeft, ChevronRight, ChevronsUpDown, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudRainWind, CloudSun,
  Dices, Flag, Hexagon, LogOut, Moon, Pause, Play, ScrollText, Search, Settings, Sunrise, Sunset, Swords, Sun, Wind, type LucideIcon,
} from 'lucide-react';
import { api, ApiError, qk } from '../api';
import type { World } from '../types';
import { WorldCtx } from '../world';
import { lastWorld } from '../prefs';
import { Sigil } from './Sigil';
import { WorldSwitcher } from './WorldSwitcher';
import { CommandPalette } from './CommandPalette';
import { toastError } from './toast';
import { MapView } from '../map/MapView';
import { FactionsView } from '../factions/FactionsView';
import { ChronicleView } from '../chronicle/ChronicleView';
import { CampaignsView } from './CampaignsView';
import { SettingsView } from './SettingsView';
import { AmbientMap, useAmbientPref } from './AmbientMap';
import { daySweep, formatHour, useHour } from '../daylight';
import { DAY_SPEEDS, hoursNow, type Daylight, type DaySpeed } from '../../../shared/daylight';
import { WEATHER, WEATHER_KINDS, type Weather, type WeatherKind } from '../../../shared/weather';
import { partOfDay } from '../map3d/sky';

// The editor is the heaviest dependency; load it on first visit to the wiki.
const WikiView = lazy(() => import('../wiki/WikiView').then((m) => ({ default: m.WikiView })));

const NAV = [
  { to: 'map', label: 'Map', icon: Hexagon },
  { to: 'wiki', label: 'Wiki', icon: BookOpen },
  { to: 'factions', label: 'Factions', icon: Swords },
  { to: 'chronicle', label: 'Chronicle', icon: ScrollText },
  { to: 'campaigns', label: 'Campaigns', icon: Flag },
  { to: 'settings', label: 'World settings', icon: Settings },
];

export function Shell({ noWorld }: { noWorld?: boolean }) {
  const { worldId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [switcher, setSwitcher] = useState(!!noWorld);
  const [palette, setPalette] = useState(false);
  // Polled gently so weather, the day and the clock set from another screen reach this one; unchanged data doesn't re-render.
  const world = useQuery({
    queryKey: qk.world(worldId ?? ''), enabled: !!worldId, refetchInterval: 30_000,
    queryFn: () => api<World>(`/api/worlds/${worldId}`),
  });

  useEffect(() => { if (worldId && world.data) lastWorld.set(worldId); }, [worldId, world.data]);
  // Warm the wiki chunk in the background so the first visit is instant.
  useEffect(() => { const t = window.setTimeout(() => { void import('../wiki/WikiView'); }, 1500); return () => window.clearTimeout(t); }, []);
  useEffect(() => {
    if (world.error instanceof ApiError && (world.error.status === 404 || world.error.status === 400)) navigate('/', { replace: true });
  }, [world.error, navigate]);
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', world.data?.accent ?? '#d4a64a');
    document.title = world.data ? `${world.data.name} · Campaign Atlas` : 'Campaign Atlas';
  }, [world.data]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A poll on its way could land after a change and put the old world back, so a change drops it first.
  const hold = () => qc.cancelQueries({ queryKey: qk.world(worldId!), exact: true });
  const day = useMutation({
    mutationFn: (advance: number) => api<{ currentDay: number; weather: Weather }>(`/api/worlds/${worldId}/day`, { body: { advance } }),
    onSuccess: async (r) => {
      await hold();
      // A new day may bring new weather (when the world rolls its own each day).
      qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, currentDay: r.currentDay, weather: r.weather } : w));
      qc.invalidateQueries({ queryKey: qk.events(worldId!) });
      qc.invalidateQueries({ queryKey: qk.worlds });
      daySweep.emit();
    },
    onError: toastError,
  });
  const daylight = useMutation({
    mutationFn: (body: { hour?: number; speed?: DaySpeed }) => api<{ daylight: Daylight }>(`/api/worlds/${worldId}/daylight`, { method: 'PATCH', body }),
    onSuccess: async (r) => { await hold(); qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, daylight: r.daylight } : w)); },
    onError: toastError,
  });
  const putWeather = (weather: Weather) => qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, weather } : w));
  // Weather changes can overlap (two quick picks, a pick during a roll) and their replies can arrive out of order,
  // so only the last to settle touches the cache: with its own answer when it ran alone, else from a fresh read.
  const wxKey = ['weather', worldId];
  const wxCrossed = useRef(false);
  const weatherSettled = async (r: { weather: Weather } | undefined, prev?: Weather) => {
    if (qc.isMutating({ mutationKey: wxKey }) > 1) { wxCrossed.current = true; return; }
    await hold();
    if (wxCrossed.current) { wxCrossed.current = false; qc.invalidateQueries({ queryKey: qk.world(worldId!), exact: true }); }
    else if (r) putWeather(r.weather);
    else if (prev) putWeather(prev);
    qc.invalidateQueries({ queryKey: qk.events(worldId!) });
  };
  // Picking a kind shows at once (the map starts easing into it); a failed save puts the old weather back.
  const weather = useMutation({
    mutationKey: wxKey,
    mutationFn: (body: { kind?: WeatherKind; auto?: boolean }) => api<{ weather: Weather }>(`/api/worlds/${worldId}/weather`, { method: 'PATCH', body }),
    onMutate: async (body) => {
      await hold();
      const prev = qc.getQueryData<World>(qk.world(worldId!))?.weather;
      if (prev) putWeather({ ...prev, ...body });
      return prev;
    },
    onError: toastError,
    onSettled: (r, _e, _b, prev) => weatherSettled(r, prev),
  });
  const rollWeather = useMutation({
    mutationKey: wxKey,
    mutationFn: () => api<{ weather: Weather }>(`/api/worlds/${worldId}/weather/roll`, { method: 'POST' }),
    onError: toastError,
    onSettled: (r) => weatherSettled(r),
  });

  // A running hour that passes midnight starts the next day on the world clock. The server only
  // honours the first tab to ask for a given day, and a long absence advances a single day.
  const dl = world.data?.daylight;
  const current = world.data?.currentDay;
  useEffect(() => {
    if (!dl || dl.speed === 'paused' || current === undefined) return;
    let busy = false;
    const id = window.setInterval(async () => {
      if (busy || hoursNow(dl) < 24) return;
      busy = true;
      try {
        const r = await api<{ currentDay: number; daylight: Daylight; weather: Weather }>(`/api/worlds/${worldId}/day`, { body: { rollover: { from: current } } });
        await hold();
        qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, currentDay: r.currentDay, daylight: r.daylight, weather: r.weather } : w));
        qc.invalidateQueries({ queryKey: qk.events(worldId!) });
      } catch { /* the next tick retries */ } finally { busy = false; }
    }, 1000);
    return () => window.clearInterval(id);
  }, [dl, current, worldId, qc]);

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    qc.clear();
    qc.setQueryData(qk.me, null);
    navigate('/');
  };

  const w = world.data;
  const loc = useLocation();
  const section = loc.pathname.split('/')[3] ?? 'map';
  const ambient = useAmbientPref() && section !== 'map';
  return (
    <div className="shell">
      <header className="topbar">
        <button className="world-button" onClick={() => setSwitcher(true)} title="Switch world">
          <Sigil color={w?.accent ?? '#d4a64a'} />
          <AnimatePresence mode="wait">
            <motion.span key={w?.id ?? 'none'} className="name"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              {w?.name ?? 'Choose a world'}
            </motion.span>
          </AnimatePresence>
          <ChevronsUpDown size={13} className="faint" />
        </button>
        <div className="spacer" />
        {w && (
          <button className="searchbox" onClick={() => setPalette(true)} title="Search the atlas (Ctrl+K)" aria-label="Search the atlas">
            <Search size={14} /> <span className="grow">Search the atlas</span> <span className="kbd">Ctrl K</span>
          </button>
        )}
        <div className="spacer" />
        {w && (
          <div className="clock" title="World clock (in-game day)">
            <button onClick={() => day.mutate(-1)} aria-label="Previous day"><ChevronLeft size={14} /></button>
            <span className="day"><small>Day</small> {w.currentDay}</span>
            <TimeOfDay daylight={w.daylight} onChange={(b) => daylight.mutate(b)} />
            <WeatherControl weather={w.weather} daylight={w.daylight} onChange={(b) => weather.mutate(b)} onRoll={() => rollWeather.mutate()} rolling={rollWeather.isPending} />
            <button onClick={() => day.mutate(1)} aria-label="Next day"><ChevronRight size={14} /></button>
          </div>
        )}
        <button className="iconbtn" onClick={logout} title="Sign out" aria-label="Sign out"><LogOut size={15} /></button>
      </header>
      <div className="body">
        {w && (
          <nav className="rail" aria-label="Sections">
            {NAV.map((n, i) => (
              <NavLink key={n.to} to={`/w/${w.id}/${n.to}`} className={({ isActive }) => `${isActive ? 'active' : ''} ${i === NAV.length - 1 ? 'end' : ''}`} data-tip={n.label} aria-label={n.label}>
                {({ isActive }) => (
                  <>
                    {isActive && <motion.span layoutId="rail-mark" className="rail-mark" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                    <n.icon size={19} strokeWidth={1.6} />
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}
        <main className={`main ${ambient ? 'ambient-live' : ''}`}>
          {w && (
            <WorldCtx.Provider value={w}>
              <AmbientMap key={w.id} section={section} />
              {/* Keyed by world: switching worlds remounts instead of cross-animating two worlds' routes. */}
              <WorldRoutes key={w.id} />
              <CommandPalette open={palette} onClose={() => setPalette(false)} />
            </WorldCtx.Provider>
          )}
        </main>
      </div>
      <WorldSwitcher open={switcher} onClose={() => setSwitcher(false)} currentId={worldId} forced={!!noWorld} />
    </div>
  );
}

function WorldRoutes() {
  const loc = useLocation();
  // World id + section: switching either cross-fades; moving between wiki pages doesn't.
  const section = loc.pathname.split('/').slice(0, 4).join('/');
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={section} className="page-enter"
        initial={{ opacity: 0, scale: 0.995 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
        <Suspense fallback={null}>
          <Routes location={loc}>
          <Route path="map" element={<MapView />} />
          <Route path="wiki" element={<WikiView />} />
          <Route path="wiki/:pageId" element={<WikiView />} />
          <Route path="factions" element={<FactionsView />} />
          <Route path="chronicle" element={<ChronicleView />} />
          <Route path="campaigns" element={<CampaignsView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="map" replace />} />
        </Routes>
        </Suspense>
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * A popover off the world clock: it closes on a click elsewhere or Escape (focus back on its button). The keys it
 * uses stop at its edge, since the map listens on the window and takes Space (pan) and Escape (deselect) for itself.
 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    // Escape pressed with focus elsewhere on the page; inside, onKey below handles it first.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || (open && e.key === 'Escape')) e.stopPropagation();
    if (open && e.key === 'Escape' && e.type === 'keydown') { setOpen(false); btn.current?.focus(); }
  };
  return { open, setOpen, btn, rootProps: { ref: root, onKeyDown: onKey, onKeyUp: onKey } };
}

/** The hour on the world clock, with the day cycle's speed (a per-world DM setting) and a dial. */
function TimeOfDay({ daylight, onChange }: { daylight: Daylight; onChange: (b: { hour?: number; speed?: DaySpeed }) => void }) {
  const { open, setOpen, btn, rootProps } = usePopover();
  const hour = useHour(daylight);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? hour % 24;
  const part = partOfDay(shown);
  const Icon = part === 'Night' ? Moon : part === 'Dawn' ? Sunrise : part === 'Dusk' || part === 'Golden hour' ? Sunset : Sun;
  return (
    <span className="tod" {...rootProps}>
      <button ref={btn} className="tod-btn" onClick={() => setOpen((o) => !o)} aria-label="Time of day" aria-expanded={open} title={`${part} · day cycle ${DAY_SPEEDS[daylight.speed].label.toLowerCase()}`}>
        <Icon size={13} className="clock-icon" />
        <span className="hour">{formatHour(shown)}</span>
        {daylight.speed === 'paused' && <Pause size={10} className="faint" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="panel tod-pop" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div className="tod-head"><Icon size={15} /> <b>{part}</b> <span className="faint">{formatHour(shown)}</span></div>
            <label className="slider"><span>Time of day</span>
              <input type="range" min={0} max={23.99} step={0.05} value={shown} aria-label="Hour"
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={() => { if (drag !== null) { onChange({ hour: drag }); setDrag(null); } }}
                onKeyUp={() => { if (drag !== null) { onChange({ hour: drag }); setDrag(null); } }} />
            </label>
            <div className="tod-title">Day cycle speed</div>
            <div className="tod-speeds" role="radiogroup" aria-label="Day cycle speed">
              {(Object.keys(DAY_SPEEDS) as DaySpeed[]).map((k) => (
                <button key={k} role="radio" aria-checked={daylight.speed === k} className={`brush ${daylight.speed === k ? 'on' : ''}`} onClick={() => onChange({ speed: k })}>
                  {k === 'paused' ? <Pause size={12} /> : <Play size={12} />} {DAY_SPEEDS[k].label}
                </button>
              ))}
            </div>
            <p className="faint tod-note">For this world. A running clock starts the next day at midnight.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

const WEATHER_ICON: Record<WeatherKind, LucideIcon> = {
  clear: Sun, fair: CloudSun, overcast: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, downpour: CloudRainWind, thunderstorm: CloudLightning, gale: Wind,
};

/** Today's weather on the world clock (a per-world DM setting): pick a kind, roll one, or let each new day roll its own. */
function WeatherControl({ weather, daylight, onChange, onRoll, rolling }: {
  weather: Weather; daylight: Daylight; onChange: (b: { kind?: WeatherKind; auto?: boolean }) => void; onRoll: () => void; rolling: boolean;
}) {
  const { open, setOpen, btn, rootProps } = usePopover();
  const grid = useRef<HTMLDivElement>(null);
  // Clear and fair skies show the moon at night, next to the clock's own moon.
  const night = partOfDay(useHour(daylight, 15_000)) === 'Night';
  const icon = (k: WeatherKind) => (night && k === 'clear' ? Moon : night && k === 'fair' ? CloudMoon : WEATHER_ICON[k]);
  const Icon = icon(weather.kind);
  const info = WEATHER[weather.kind];
  useEffect(() => { if (open) grid.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true }); }, [open]);
  // Arrows move through the grid and Enter or Space picks, so looking around doesn't change the sky (and the chronicle) at every step.
  const onKey = (e: React.KeyboardEvent) => {
    const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 } as Record<string, number>)[e.key];
    if (!step || !grid.current) return;
    e.preventDefault();
    const items = [...grid.current.querySelectorAll<HTMLElement>('[role="radio"]')];
    items[(items.indexOf(document.activeElement as HTMLElement) + step + items.length) % items.length]?.focus();
  };
  return (
    <span className="wx" {...rootProps}>
      <button ref={btn} className="wx-btn" onClick={() => setOpen((o) => !o)} aria-label={`Weather: ${info.label}`} aria-expanded={open} aria-haspopup="dialog"
        title={`${info.label} · ${info.note}${weather.auto ? ' · new weather each day' : ''}`}>
        <Icon size={14} className="clock-icon" />
        <span className="wx-label">{info.label}</span>
        {weather.auto && <Dices size={10} className="faint" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div className="panel tod-pop wx-pop" role="dialog" aria-label="Weather" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}>
            <div>
              <div className="tod-head"><Icon size={15} /> <b>{info.label}</b></div>
              <div className="faint wx-sub">{info.note}</div>
            </div>
            <div className="tod-title" id="wx-today">Today's weather</div>
            <div className="wx-kinds" role="radiogroup" aria-labelledby="wx-today" ref={grid} onKeyDown={onKey}>
              {WEATHER_KINDS.map((k) => {
                const K = icon(k), on = weather.kind === k;
                return (
                  <button key={k} role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className={`wx-kind ${on ? 'on' : ''}`} title={WEATHER[k].note} onClick={() => onChange({ kind: k })}>
                    {on && <motion.span layoutId="wx-mark" className="wx-mark" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
                    <K size={18} strokeWidth={1.6} />
                    <span>{WEATHER[k].label}</span>
                  </button>
                );
              })}
            </div>
            {/* Busy rather than disabled while rolling, so keyboard focus stays on it. */}
            <button className={`wx-roll ${rolling ? 'rolling' : ''}`} onClick={() => { if (!rolling) onRoll(); }} aria-disabled={rolling}><Dices size={14} /> Roll today's weather</button>
            <label className="toggle"><input type="checkbox" checked={weather.auto} onChange={(e) => onChange({ auto: e.target.checked })} /> Roll new weather each day</label>
            <p className="faint tod-note">For this world. Shown on the 3D map.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}
