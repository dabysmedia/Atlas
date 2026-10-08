import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, ChevronLeft, ChevronRight, ChevronsUpDown, Flag, Hexagon, LogOut, ScrollText, Search, Settings, Swords } from 'lucide-react';
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

// The editor is the heaviest dependency; load it on first visit to the wiki.
const WikiView = lazy(() => import('../wiki/WikiView').then((m) => ({ default: m.WikiView })));

const NAV = [
  { to: 'map', label: 'Map', icon: Hexagon },
  { to: 'wiki', label: 'Wiki', icon: BookOpen },
  { to: 'factions', label: 'Factions', icon: Swords },
  { to: 'chronicle', label: 'Chronicle', icon: ScrollText },
  { to: 'campaigns', label: 'Campaigns', icon: Flag },
  { to: 'settings', label: 'World', icon: Settings },
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
    },
    onError: toastError,
  });

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    qc.clear();
    qc.setQueryData(qk.me, null);
    navigate('/');
  };

  const w = world.data;
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
          <ChevronsUpDown size={14} className="faint" />
        </button>
        {w && (
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={`/w/${w.id}/${n.to}`} className={({ isActive }) => (isActive ? 'active' : '')}>
                {({ isActive }) => (
                  <>
                    {isActive && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                    <n.icon size={15} /> {n.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="spacer" />
        {w && (
          <>
            <button className="btn ghost" onClick={() => setPalette(true)} title="Search the wiki (Ctrl+K)">
              <Search size={15} /> <span className="kbd">Ctrl K</span>
            </button>
            <div className="daybox" title="World clock (in-game day)">
              <button className="btn ghost icon sm" onClick={() => day.mutate(-1)} aria-label="Previous day"><ChevronLeft size={15} /></button>
              <span className="day"><small>Day</small>{w.currentDay}</span>
              <button className="btn ghost icon sm" onClick={() => day.mutate(1)} aria-label="Next day"><ChevronRight size={15} /></button>
            </div>
          </>
        )}
        <button className="btn ghost icon" onClick={logout} title="Sign out"><LogOut size={16} /></button>
      </header>
      <main className="main">
        {w && (
          <WorldCtx.Provider value={w}>
            {/* Keyed by world: switching worlds remounts instead of cross-animating two worlds' routes. */}
            <WorldRoutes key={w.id} />
            <CommandPalette open={palette} onClose={() => setPalette(false)} />
          </WorldCtx.Provider>
        )}
      </main>
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
