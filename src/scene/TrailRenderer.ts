import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from 'three';

const CAPACITY = 720;

/**
 * Instanced decals for the pointer trail and the follower's marks.
 * One draw call; each mark has a birth time, a kind and a seed, and fades in
 * the shader so nothing is updated per frame on the CPU.
 */
export class TrailRenderer {
  readonly mesh: InstancedMesh;
  private birth: InstancedBufferAttribute;
  private kind: InstancedBufferAttribute;
  private seed: InstancedBufferAttribute;
  private next = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly up = new Vector3(0, 0, 1);
  private readonly n = new Vector3();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  readonly material: ShaderMaterial;
  count = 0;

  constructor() {
    const g = new PlaneGeometry(1, 1);
    this.birth = new InstancedBufferAttribute(new Float32Array(CAPACITY).fill(-1000), 1);
    this.kind = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    this.seed = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
    for (const a of [this.birth, this.kind, this.seed]) a.setUsage(DynamicDrawUsage);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aKind', this.kind);
    g.setAttribute('aSeed', this.seed);
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      uniforms: { uTime: { value: 0 }, uStrength: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aBirth; attribute float aKind; attribute float aSeed;
        uniform float uTime;
        varying vec2 vUv; varying float vAge; varying float vKind; varying float vSeed;
        void main() {
          vUv = uv; vAge = uTime - aBirth; vKind = aKind; vSeed = aSeed;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying vec2 vUv; varying float vAge; varying float vKind; varying float vSeed;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + vSeed * 91.7) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }
        void main() {
          float life = vKind > 0.5 ? 7.5 : 5.0;
          if (vAge < 0.0 || vAge > life) discard;
          vec2 c = vUv - 0.5;
          float r = length(c * vec2(1.0, 1.35));
          float grain = noise(vUv * 18.0) * 0.6 + noise(vUv * 41.0) * 0.4;
          float shape = smoothstep(0.5, 0.12, r) * smoothstep(0.25, 0.6, grain + 0.25);
          float fadeIn = smoothstep(0.0, vKind > 0.5 ? 0.9 : 0.25, vAge);
          float fadeOut = 1.0 - smoothstep(life * 0.45, life, vAge);
          // Player marks: faint dusty impressions. Follower marks: darker, damp, more defined.
          vec3 col = vKind > 0.5 ? vec3(0.05, 0.055, 0.06) : vec3(0.32, 0.29, 0.25);
          float alpha = shape * fadeIn * fadeOut * (vKind > 0.5 ? 0.34 : 0.16) * uStrength;
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.mesh = new InstancedMesh(g, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, new Matrix4().makeScale(0, 0, 0));
  }

  add(p: [number, number, number], n: [number, number, number], kind: 0 | 1, tSec: number, seed: number): void {
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    this.count = Math.min(CAPACITY, this.count + 1);
    this.n.set(n[0], n[1], n[2]).normalize();
    this.q.setFromUnitVectors(this.up, this.n);
    const spin = new Quaternion().setFromAxisAngle(this.up, seed * Math.PI * 2);
    this.q.multiply(spin);
    const size = kind ? 0.05 + seed * 0.02 : 0.035 + seed * 0.015;
    this.p.set(p[0], p[1], p[2]).addScaledVector(this.n, 0.002);
    this.s.set(size, size * (kind ? 1.4 : 1.1), 1);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.birth.setX(i, tSec);
    this.kind.setX(i, kind);
    this.seed.setX(i, seed);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.needsUpdate = this.kind.needsUpdate = this.seed.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) this.birth.setX(i, -1000);
    this.birth.needsUpdate = true;
    this.count = 0;
  }
}
