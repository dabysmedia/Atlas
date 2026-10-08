import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from './api';
import type { WorldSummary } from './types';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { lastWorld } from './prefs';

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: () => api<{ username: string }>('/api/auth/me'), retry: false, staleTime: Infinity });
  useEffect(() => {
    const onUnauth = () => qc.setQueryData(qk.me, null);
    window.addEventListener('atlas:unauthenticated', onUnauth);
    return () => window.removeEventListener('atlas:unauthenticated', onUnauth);
  }, [qc]);

  if (me.isLoading) return null;
  if (!me.data) return <Login onDone={() => { qc.clear(); me.refetch(); }} />;
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/w/:worldId/*" element={<Shell />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RootRedirect() {
  const worlds = useQuery({ queryKey: qk.worlds, queryFn: () => api<WorldSummary[]>('/api/worlds') });
  if (!worlds.data) return null;
  const last = lastWorld.get();
  const target = worlds.data.find((w) => w.id === last) ?? worlds.data[0];
  if (!target) return <Shell noWorld />;
  return <Navigate to={`/w/${target.id}/map`} replace />;
}
