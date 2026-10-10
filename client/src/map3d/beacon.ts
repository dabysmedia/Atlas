/**
 * The selected hex's beacon: a thin column of gilt light shooting up from the ground, so the
 * selection can be found at any zoom and through cloud, with a ripple spreading over the terrain
 * at its foot. Two draw calls, both additive, all motion in the shaders.
 *
 * The column is a camera-facing strip turned only about the vertical, at least a few pixels wide
 * however far out the camera is. The ripple is a disc whose vertices are set to the ground's height
 * when the beacon moves, so it hugs slopes; like the border lines it is pulled toward the camera
 * along the view ray so it never z-fights the ground.
 */
import * as THREE from 'three';

const GILT = new THREE.Color('#e3b55f');

const COLUMN_VERT = /* glsl */`
uniform vec3 uBase;
uniform float uHeight, uWidth, uMinPx, uPixAngle, uGrow;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 toCam = cameraPosition - uBase;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
  // Wide enough to see from far out: never under uMinPx pixels at the base's distance.
  float w = max(uWidth, uMinPx * length(toCam) * uPixAngle);
  vec3 p = uBase + right * (uv.x - 0.5) * w + vec3(0.0, uv.y * uHeight * uGrow, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const COLUMN_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime, uAlpha, uGrow;
varying vec2 vUv;
void main() {
  float x = abs(vUv.x - 0.5) * 2.0, y = vUv.y;
  float core = exp(-x * x * 160.0);
  float halo = exp(-x * x * 7.0) * 0.55 + exp(-x * 3.2) * 0.22;
  // Brightest at the foot, fading to nothing at the top; light rising up the shaft.
  float fall = pow(1.0 - y, 1.6) * smoothstep(0.0, 0.015, y);
  float rise = 0.75 + 0.25 * sin(y * 46.0 - uTime * 7.0) + 0.35 * pow(fract(y * 2.2 - uTime * 0.55), 14.0);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.6);
  // The head of the shaft as it shoots up.
  float head = uGrow < 0.999 ? exp(-pow((1.0 - y) * 30.0, 2.0)) * 1.4 : 0.0;
  vec3 c = (mix(uColor, vec3(1.0), core * 0.6) * core * 1.6 + uColor * halo) * (fall * rise * pulse + head);
  gl_FragColor = vec4(c * uAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
const RIPPLE_VERT = /* glsl */`
uniform float uBias;
varying vec2 vR;
void main() {
  vR = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xyz *= 1.0 - uBias;
  gl_Position = projectionMatrix * mv;
}
`;
const RIPPLE_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime, uAlpha;
varying vec2 vR;
void main() {
  float r = length(vR);
  if (r > 1.0) discard;
  float rings = 0.0;
  for (int i = 0; i < 3; i++) {
    float t = fract(uTime * 0.42 + float(i) / 3.0);
    float d = abs(r - t);
    rings += exp(-d * d * 2200.0) * (1.0 - t) * (1.0 - t) * 1.4;
  }
  // A small hot spot where the shaft meets the ground; a wide pool would gild the slope like paint.
  float pool = exp(-r * r * 40.0) * 0.18 + exp(-r * r * 700.0) * 1.8;
  float fade = 1.0 - smoothstep(0.85, 1.0, r);
  vec3 c = uColor * (rings * 1.3 + pool) * fade;
  gl_FragColor = vec4(c * uAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Beacon {
  readonly group = new THREE.Group();
  protected column: THREE.Mesh;
  protected ripple: THREE.Mesh;
  protected cu = {
    uBase: { value: new THREE.Vector3() }, uHeight: { value: 400 }, uWidth: { value: 10 }, uMinPx: { value: 30 }, uPixAngle: { value: 0.001 },
    uGrow: { value: 0 }, uColor: { value: GILT.clone() }, uTime: { value: 0 }, uAlpha: { value: 0 },
  };
  protected ru = { uBias: { value: 0.004 }, uColor: { value: GILT.clone() }, uTime: { value: 0 }, uAlpha: { value: 0 } };
  /** 0..1: how far the beacon has shot up (eases toward `want`). */
  protected grow = 0;
  protected want = 0;
  protected at: { x: number; y: number } | null = null;
  protected last = 0;
  protected R = 0;
  protected ground: (x: number, y: number) => number = () => 0;

  constructor() {
    const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
    this.column = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 24).translate(0.5, 0.5, 0),
      new THREE.ShaderMaterial({ uniforms: this.cu, vertexShader: COLUMN_VERT, fragmentShader: COLUMN_FRAG, side: THREE.DoubleSide, ...add }));
    this.ripple = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 24, 24).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({ uniforms: this.ru, vertexShader: RIPPLE_VERT, fragmentShader: RIPPLE_FRAG, ...add }));
    // Drawn after the clouds and rain, so the shaft pierces the deck.
    this.ripple.renderOrder = 9;
    this.column.renderOrder = 10;
    for (const m of [this.column, this.ripple]) m.frustumCulled = false;
    this.group.add(this.ripple, this.column);
    this.group.visible = false;
  }

  /** Stand the beacon on a ground point (null takes it down). `ground` gives the surface height. */
  place(p: { x: number; y: number } | null, ground: (x: number, y: number) => number) {
    if (!p) { this.want = 0; return; }
    const moved = !this.at || this.at.x !== p.x || this.at.y !== p.y || ground !== this.ground;
    this.want = 1;
    if (!moved) return;
    // A new place: start the shaft again from the ground.
    if (this.at && (this.at.x !== p.x || this.at.y !== p.y)) this.grow = 0;
    this.at = { ...p };
    this.ground = ground;
    this.cu.uBase.value.set(p.x, ground(p.x, p.y), p.y);
    this.R = 0;
  }

  /** Lay the ripple disc over the ground around the beacon, `R` world units out. */
  protected layRipple(R: number) {
    const p = this.at!;
    this.R = R;
    const pos = this.ripple.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      // The plane spans -0.5..0.5 before scaling.
      const u = pos.getX(i), v = pos.getZ(i);
      pos.setY(i, this.ground(p.x + u * 2 * R, p.y + v * 2 * R));
    }
    pos.needsUpdate = true;
    this.ripple.scale.set(2 * R, 1, 2 * R);
    this.ripple.position.set(p.x, 0.6, p.y);
  }

  /** Per frame. `camDist` sizes the shaft so it always reaches well up the screen. */
  update(now: number, camDist: number, hexSize: number, pixAngle: number) {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    // Shoots up fast, sinks away a little faster.
    this.grow = this.want ? Math.min(1, this.grow + dt * 1.9) : Math.max(0, this.grow - dt * 3);
    this.group.visible = this.grow > 0.001 && !!this.at;
    if (!this.group.visible) return;
    // The ripple grows with distance so it still reads from far out (looking straight down, the
    // shaft itself is end on).
    const R = Math.max(hexSize * 1.25, camDist * 0.022);
    if (!this.R || Math.abs(R - this.R) > this.R * 0.15) this.layRipple(R);
    const e = 1 - (1 - this.grow) ** 3;
    const t = (now / 1000) % 3600;
    const c = this.cu;
    c.uGrow.value = e;
    c.uAlpha.value = this.want ? Math.min(1, this.grow * 3) : e;
    c.uHeight.value = Math.max(hexSize * 9, camDist * 0.42);
    c.uWidth.value = hexSize * 0.5;
    c.uPixAngle.value = pixAngle;
    c.uTime.value = t;
    this.ru.uTime.value = t;
    this.ru.uAlpha.value = c.uAlpha.value;
    this.ru.uBias.value = Math.min(0.03, 24 * pixAngle);
  }

  dispose() {
    for (const m of [this.column, this.ripple]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
  }
}
