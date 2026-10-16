import { MeshStandardMaterial, type Mesh, type Texture } from 'three';

/**
 * Photograph material: a standard PBR material (so the print is lit by the
 * room like everything else) with a second map and a crossfade, plus a
 * film grade applied to textures captured from the 3D room so captured
 * "photographs" match the printed garden variants.
 */
export class PhotoFrame {
  readonly material: MeshStandardMaterial;
  private uniforms = {
    uMap2: { value: null as Texture | null },
    uMix: { value: 0 },
    uCapA: { value: 0 },
    uCapB: { value: 0 },
  };
  private fading = false;
  private fadeFrom: Texture | null = null;
  private currentKey = '';

  constructor(
    mesh: Mesh,
    initial: Texture,
  ) {
    this.material = new MeshStandardMaterial({ map: initial, roughness: 0.6, metalness: 0 });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <map_pars_fragment>',
          `#include <map_pars_fragment>
          uniform sampler2D uMap2; uniform float uMix; uniform float uCapA; uniform float uCapB;
          vec3 filmGrade(vec3 c, vec2 uv) {
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            c = mix(vec3(l), c, 0.7);
            c = c * vec3(1.06, 1.0, 0.86) * 1.15 + vec3(0.025, 0.02, 0.012);
            vec2 v = uv - 0.5;
            c *= 1.0 - dot(v, v) * 1.4;
            return c;
          }`,
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
            vec4 sA = texture2D(map, vMapUv);
            vec4 sB = texture2D(uMap2, vMapUv);
            vec3 a = uCapA > 0.5 ? filmGrade(sA.rgb, vMapUv) : sA.rgb;
            vec3 b = uCapB > 0.5 ? filmGrade(sB.rgb, vMapUv) : sB.rgb;
            diffuseColor.rgb *= mix(a, b, uMix);
          #endif`,
        );
    };
    mesh.material = this.material;
  }

  /**
   * Show a texture. `instant` swaps immediately (used only when the frame is
   * unseen); otherwise crossfades over `durationMs`.
   */
  show(key: string, tex: Texture, isCapture: boolean, instant: boolean): void {
    if (key === this.currentKey) return;
    this.currentKey = key;
    if (instant) {
      this.material.map = tex;
      this.uniforms.uCapA.value = isCapture ? 1 : 0;
      this.uniforms.uMix.value = 0;
      this.fading = false;
      this.material.needsUpdate = true;
      return;
    }
    this.fadeFrom = this.material.map;
    this.uniforms.uMap2.value = tex;
    this.uniforms.uCapB.value = isCapture ? 1 : 0;
    this.uniforms.uMix.value = 0;
    this.fading = true;
  }

  update(dtSec: number): void {
    if (!this.fading) return;
    this.uniforms.uMix.value = Math.min(1, this.uniforms.uMix.value + dtSec / 1.6);
    if (this.uniforms.uMix.value >= 1) {
      this.material.map = this.uniforms.uMap2.value;
      this.uniforms.uCapA.value = this.uniforms.uCapB.value;
      this.uniforms.uMix.value = 0;
      this.fading = false;
      this.fadeFrom = null;
      this.material.needsUpdate = true;
    }
  }

  get key(): string {
    return this.currentKey;
  }

  get isFading(): boolean {
    return this.fading || !!this.fadeFrom;
  }
}
