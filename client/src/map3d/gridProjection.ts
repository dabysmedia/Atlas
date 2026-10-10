import * as THREE from 'three';
import { corner, HEX_SIZE, type Orientation } from '../../../shared/hex';

/** Shared by terrain and sea: the grid is independent of washes, fog and other map ink. */
export const GRID_GLSL = /* glsl */`
uniform sampler2D uHexGrid;
uniform float uGridEnabled, uGridOverview, uGridSelected, uGridPointy, uGridRadius;
uniform vec2 uGridCenter;
vec4 atlasGrid(vec2 p, vec2 uv) {
  if (uGridEnabled < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec2 axial = mix(vec2(2.0 * p.x / 3.0, -p.x / 3.0 + p.y / 1.7320508076),
    vec2(p.x / 1.7320508076 - p.y / 3.0, 2.0 * p.y / 3.0), uGridPointy) / ${HEX_SIZE.toFixed(1)};
  vec2 d = axial - uGridCenter;
  // Continuous cube distance gives a smooth fade over three hex steps in either orientation.
  float distance = max(max(abs(d.x), abs(d.y)), abs(d.x + d.y));
  float local = uGridSelected * (1.0 - smoothstep(0.0, uGridRadius, distance));
  return texture2D(uHexGrid, uv) * max(uGridOverview, local);
}
`;

export function gridUniforms() {
  return {
    uHexGrid: { value: null as THREE.Texture | null },
    uGridEnabled: { value: 0 }, uGridOverview: { value: 0 }, uGridSelected: { value: 0 },
    uGridPointy: { value: 1 }, uGridRadius: { value: 3 }, uGridCenter: { value: new THREE.Vector2() },
  };
}

/** Cached grid ink; hover and selection update uniforms, without uploading a whole map texture. */
export class GridProjection {
  readonly uniforms = gridUniforms();
  readonly canvas = document.createElement('canvas');
  texture = this.makeTexture();

  private makeTexture() {
    const texture = new THREE.CanvasTexture(this.canvas);
    texture.flipY = false;
    texture.premultiplyAlpha = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.uniforms.uHexGrid.value = texture;
    return texture;
  }

  draw(hexes: Iterable<{ cx: number; cy: number; terrain: string }>, orientation: Orientation,
    rect: { x: number; y: number; w: number; h: number }, width: number, height: number, zoom: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      const anisotropy = this.texture.anisotropy;
      this.texture.dispose();
      this.canvas.width = width; this.canvas.height = height;
      this.texture = this.makeTexture();
      this.texture.anisotropy = anisotropy;
    }
    const ctx = this.canvas.getContext('2d')!, ppw = width / rect.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.setTransform(ppw, 0, 0, ppw, -rect.x * ppw, -rect.y * ppw);
    const path = new Path2D();
    for (const h of hexes) {
      if (h.terrain === 'deep' || h.cx < rect.x - HEX_SIZE || h.cy < rect.y - HEX_SIZE ||
        h.cx > rect.x + rect.w + HEX_SIZE || h.cy > rect.y + rect.h + HEX_SIZE) continue;
      for (let i = 0; i < 6; i++) {
        const p = corner(i, HEX_SIZE, orientation);
        if (i) path.lineTo(h.cx + p.x, h.cy + p.y); else path.moveTo(h.cx + p.x, h.cy + p.y);
      }
      path.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.globalAlpha = .35; ctx.strokeStyle = 'rgba(6,12,16,0.9)'; ctx.lineWidth = 2 / zoom; ctx.stroke(path);
    ctx.globalAlpha = .3; ctx.strokeStyle = '#e9f2ee'; ctx.lineWidth = .9 / zoom; ctx.stroke(path);
    this.texture.needsUpdate = true;
  }
}
