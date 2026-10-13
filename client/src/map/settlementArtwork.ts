import { settlementArtUrl, type SettlementArtFaction } from '../../../shared/settlementArt';

/** Load only the art used by this map; keep procedural ground art while an image loads or fails. */
export class SettlementArtwork {
  private entries = new Map<string, { image: HTMLImageElement; ready: boolean }>();
  private disposed = false;
  constructor(private invalidate: () => void) {}

  image(faction: SettlementArtFaction | undefined, kind: string) {
    const url = settlementArtUrl(faction, kind);
    if (!url || this.disposed) return undefined;
    const cached = this.entries.get(url);
    if (cached) return cached.ready ? cached.image : undefined;
    const image = new Image(), entry = { image, ready: false };
    this.entries.set(url, entry);
    image.decoding = 'async';
    image.onload = () => { if (!this.disposed) { entry.ready = true; this.invalidate(); } };
    image.onerror = () => { if (!this.disposed) this.invalidate(); };
    image.src = url;
    return undefined;
  }

  destroy() {
    this.disposed = true;
    for (const {image} of this.entries.values()) { image.onload = null; image.onerror = null; }
    this.entries.clear();
  }
}
