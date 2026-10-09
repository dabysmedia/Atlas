import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, ChevronLeft, ChevronRight, ChevronsUpDown, Flag, Hexagon, LogOut, Moon, Pause, Play, ScrollText, Search, Settings, Sunrise, Sunset, Swords, Sun } from 'lucide-react';
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
  const world = useQuery({
    queryKey: qk.world(worldId ?? ''), enabled: !!worldId,
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

  const day = useMutation({
    mutationFn: (advance: number) => api<{ currentDay: number }>(`/api/worlds/${worldId}/day`, { body: { advance } }),
    onSuccess: (r) => {
      qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, currentDay: r.currentDay } : w));
      qc.invalidateQueries({ queryKey: qk.events(worldId!) });
      qc.invalidateQueries({ queryKey: qk.worlds });
      daySweep.emit();
    },
    onError: toastError,
  });
  const daylight = useMutation({
    mutationFn: (body: { hour?: number; speed?: DaySpeed }) => api<{ daylight: Daylight }>(`/api/worlds/${worldId}/daylight`, { method: 'PATCH', body }),
    onSuccess: (r) => qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, daylight: r.daylight } : w)),
    onError: toastError,
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
        const r = await api<{ currentDay: number; daylight: Daylight }>(`/api/worlds/${worldId}/day`, { body: { rollover: { from: current } } });
        qc.setQueryData<World>(qk.world(worldId!), (w) => (w ? { ...w, currentDay: r.currentDay, daylight: r.daylight } : w));
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
          <button className="searchbox" onClick={() => setPalette(true)} title="Search the atlas (Ctrl+K)">
            <Search size={14} /> <span className="grow">Search the atlas</span> <span className="kbd">Ctrl K</span>
          </button>
        )}
        <div className="spacer" />
        {w && (
          <div className="clock" title="World clock (in-game day)">
            <button onClick={() => day.mutate(-1)} aria-label="Previous day"><ChevronLeft size={14} /></button>
            <span className="day"><small>Day</small> {w.currentDay}</span>
            <TimeOfDay daylight={w.daylight} onChange={(b) => daylight.mutate(b)} />
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

/** The hour on the world clock, with the day cycle's speed (a per-world DM setting) and a dial. */
function TimeOfDay({ daylight, onChange }: { daylight: Daylight; onChange: (b: { hour?: number; speed?: DaySpeed }) => void }) {
  const [open, setOpen] = useState(false);
  const hour = useHour(daylight);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? hour % 24;
  const part = partOfDay(shown);
  const Icon = part === 'Night' ? Moon : part === 'Dawn' ? Sunrise : part === 'Dusk' || part === 'Golden hour' ? Sunset : Sun;
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.tod')) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <span className="tod">
      <button className="tod-btn" onClick={() => setOpen((o) => !o)} aria-label="Time of day" aria-expanded={open} title={`${part} · day cycle ${DAY_SPEEDS[daylight.speed].label.toLowerCase()}`}>
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
