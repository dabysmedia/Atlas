import { useEffect, useState } from 'react';
import type { Token } from '../types';
import { MarkerIcon } from './panels';
export function TokenPreview({ token, color }: { token: Pick<Token, 'modelId' | 'worldId' | 'name' | 'kind'>; color: string }) {
  const [picture, setPicture] = useState<{ modelId: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true; setFailed(false);
    if (token.modelId) { const modelId = token.modelId; import('../map3d/miniaturePreview').then(m => m.miniaturePreview(token.worldId, modelId)).then(url => { if (alive) setPicture({ modelId, url }); }).catch(() => { if (alive) setFailed(true); }); }
    return () => { alive = false; };
  }, [token.worldId, token.modelId]);
  return <div className="piece-picture" style={{ '--piece-color': color } as React.CSSProperties}>
    {token.modelId && picture?.modelId === token.modelId ? <img src={picture.url} alt={`${token.name} miniature preview`} /> : <><MarkerIcon kind={token.kind} color={color} size={44} />{token.modelId && <small>{failed ? 'Preview unavailable' : 'Loading preview…'}</small>}</>}
  </div>;
}
