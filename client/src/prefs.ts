/** Small per-browser conveniences. Every access is guarded; nothing here is load-bearing. */
function store<T>(key: string) {
  return {
    get(): T | undefined {
      try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : undefined; } catch { return undefined; }
    },
    set(v: T) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } },
  };
}
export const lastWorld = store<string>('atlas.lastWorld');
export const fogCampaign = (worldId: string) => store<string | null>(`atlas.fogCampaign.${worldId}`);
export const cameraPref = (worldId: string) => store<{ x: number; y: number; zoom: number }>(`atlas.camera.${worldId}`);
export const lastPage = (worldId: string) => store<string>(`atlas.lastPage.${worldId}`);
export const layerPrefs = (worldId: string) =>
  store<Partial<{ terrainOverlay: number; grid: boolean; territory: boolean }>>(`atlas.layers.${worldId}`);
export const panelPrefs = store<{ territories?: boolean }>('atlas.panels');
