import * as THREE from 'three';
import { corner, type Orientation } from '../../../shared/hex';

/** A surface mask, never a projected copy of the map inside a cloud. */
export class HoverMask {
  readonly mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uPointy: { value: 1 }, uHighlight: { value: 1 }, uSelected: { value: 0 }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vP;
      void main(){vP=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader: `varying vec2 vP; uniform float uPointy,uHighlight,uSelected,uTime;
      void main(){
        float d=-1.0;
        for(int i=0;i<6;i++){
          float a=float(i)*1.0471975512+(1.0-uPointy)*0.5235987756;
          d=max(d,dot(vP,vec2(cos(a),sin(a)))-0.8660254038);
        }
        float edge=1.0-smoothstep(0.0,mix(1.6,2.4,uSelected)*fwidth(d),-d);
        float pulse=0.5+0.5*sin(uTime/420.0);
        vec3 color=mix(vec3(0.94,0.98,0.97),vec3(0.56,0.91,0.89),uSelected);
        float alpha=mix(mix(0.06,0.6,edge),mix(0.08+pulse*0.06,0.75+pulse*0.25,edge),uSelected);
        gl_FragColor=vec4(color,alpha*uHighlight);
      }`,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  }));
  private signature = '';

  constructor(selection = false) {
    this.mesh.material.uniforms.uSelected.value = selection ? 1 : 0;
    this.mesh.material.stencilWrite = !selection;
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(hex: { id: string; cx: number; cy: number } | undefined, size: number, orientation: Orientation,
    ground: (x: number, y: number) => number, groundId: number, selected = false) {
    this.mesh.visible = !!hex;
    this.mesh.material.uniforms.uHighlight.value = selected ? 0 : 1;
    this.mesh.material.uniforms.uPointy.value = orientation === 'pointy' ? 1 : 0;
    if (!hex) { this.signature = ''; return; }
    const signature = `${hex.id}|${groundId}|${orientation}|${size}`;
    if (signature === this.signature) return;
    this.signature = signature;
    const positions: number[] = [];
    const uv: number[] = [];
    // Subdivide the six wedges so the mask follows slopes, rather than flattening the hex.
    const n = 12;
    const vertex = (a: { x: number; y: number }, b: { x: number; y: number }, i: number, j: number) => {
      const x = hex.cx + (a.x * i + b.x * j) / n;
      const y = hex.cy + (a.y * i + b.y * j) / n;
      positions.push(x, ground(x, y) + 2, y);
      uv.push((x - hex.cx) / size, (y - hex.cy) / size);
    };
    for (let edge = 0; edge < 6; edge++) {
      const a = corner(edge, size, orientation), b = corner((edge + 1) % 6, size, orientation);
      for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
        vertex(a, b, i, j); vertex(a, b, i + 1, j); vertex(a, b, i, j + 1);
        if (i + j < n - 1) {
          vertex(a, b, i + 1, j); vertex(a, b, i + 1, j + 1); vertex(a, b, i, j + 1);
        }
      }
    }
    // Reuse GPU buffers across hexes. Allocating a fresh geometry on each selection can stall
    // the driver even when JavaScript's frame time is short.
    const attribute = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attribute) {
      (attribute.array as Float32Array).set(positions);
      attribute.needsUpdate = true;
      const texcoord = this.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
      (texcoord.array as Float32Array).set(uv); texcoord.needsUpdate = true;
    } else {
      this.mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      this.mesh.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
    }
  }
}
