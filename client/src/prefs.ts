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

/** The blurred world map behind non-map pages. On unless turned off in World settings. */
const ambientStore = store<boolean>('atlas.ambient');
const ambientSubs = new Set<() => void>();
export const ambientPref = {
  get: () => ambientStore.get() ?? true,
  set(v: boolean) { ambientStore.set(v); ambientSubs.forEach((f) => f()); },
  subscribe(f: () => void) { ambientSubs.add(f); return () => { ambientSubs.delete(f); }; },
};
