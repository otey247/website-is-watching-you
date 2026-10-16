import { Vector2, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * A restrained postprocessing chain: render → (depth of field while inspecting)
 * → faint bloom → grade (temperature, saturation, contrast, vignette, grain,
 * fade) → output (tone mapping + sRGB). Distortion exists, but only rare
 * events raise it.
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTemp: { value: 0 },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0.22 },
    uGrain: { value: 0.018 },
    uTime: { value: 0 },
    uDistort: { value: 0 },
    uFade: { value: 1 },
    uShadow: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTemp, uSat, uContrast, uVignette, uGrain, uTime, uDistort, uFade, uShadow;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      if (uDistort > 0.0) {
        float w = sin(uv.y * 40.0 + uTime * 3.0) * 0.0015 * uDistort;
        uv.x += w;
      }
      vec3 c = texture2D(tDiffuse, uv).rgb;
      // White balance (linear space): positive = warmer.
      c *= vec3(1.0 + uTemp * 0.08, 1.0, 1.0 - uTemp * 0.1);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      // Contrast around mid-grey in linear-ish space, deeper shadows later.
      c = max(vec3(0.0), (c - 0.18) * uContrast + 0.18);
      c *= 1.0 - uShadow * (1.0 - smoothstep(0.0, 0.25, l));
      vec2 v = vUv - 0.5;
      c *= 1.0 - dot(v, v) * uVignette * 2.4;
      c += (hash(vUv * 1000.0 + uTime) - 0.5) * uGrain * (0.4 + l);
      gl_FragColor = vec4(c * uFade, 1.0);
    }`,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly bokeh: BokehPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private dofTarget = 0;
  private dof = 0;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, readonly quality: 'high' | 'low') {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bokeh = new BokehPass(scene, camera, { focus: 1.0, aperture: 0.0, maxblur: 0.006 });
    this.bokeh.enabled = false;
    if (quality === 'high') this.composer.addPass(this.bokeh);
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.14, 0.5, 0.98);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  /** Modest depth of field while inspecting an object at `focus` meters. */
  setInspection(focus: number | null): void {
    this.dofTarget = focus === null ? 0 : 1;
    if (focus !== null) (this.bokeh.uniforms as Record<string, { value: number }>).focus.value = focus;
  }

  uniform(name: keyof typeof GradeShader.uniforms): { value: number } {
    return this.grade.uniforms[name] as { value: number };
  }

  render(dtSec: number, time: number): void {
    this.dof += (this.dofTarget - this.dof) * Math.min(1, dtSec * 3);
    const u = this.bokeh.uniforms as Record<string, { value: number }>;
    u.aperture.value = this.dof * 0.0018;
    this.bokeh.enabled = this.quality === 'high' && this.dof > 0.02;
    this.uniform('uTime').value = time;
    this.composer.render(dtSec);
  }
}
