import { HalfFloatType, PerspectiveCamera, Vector3, WebGLRenderTarget, type Object3D, type Scene, type Texture, type WebGLRenderer } from 'three';
import { LAYER_FIGURE } from './RoomBuilder';

/**
 * Captures the fictional 3D room into preallocated render targets, used as
 * photograph content and for the in-room surveillance feed. It only ever
 * renders the virtual scene. There is no access to any real camera.
 */
export class CaptureService {
  readonly camera = new PerspectiveCamera(46, 4 / 3, 0.05, 30);
  private targets: WebGLRenderTarget[] = [];
  private lastUsed: number[] = [];
  private pinned = new Set<number>();
  private tick = 0;
  readonly feedCamera = new PerspectiveCamera(70, 16 / 10, 0.05, 30);
  readonly feedTarget: WebGLRenderTarget;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly hide: Object3D[],
    private readonly figure: Object3D,
    pool = 6,
  ) {
    for (let i = 0; i < pool; i++) {
      // Preallocate: no render target is created during play.
      this.targets.push(new WebGLRenderTarget(640, 480, { type: HalfFloatType, samples: 4 }));
      this.lastUsed.push(-1);
    }
    this.camera.position.set(2.05, 1.72, 1.6);
    this.camera.lookAt(new Vector3(-1.0, 0.75, -1.3));
    this.camera.layers.enable(0);
    this.feedTarget = new WebGLRenderTarget(512, 320, { type: HalfFloatType });
    this.feedCamera.position.set(-2.3, 2.45, -1.95);
  }

  texture(id: number): Texture | null {
    return this.targets[id]?.texture ?? null;
  }

  /** Keep a capture alive while it is on the wall. */
  pin(ids: number[]): void {
    this.pinned = new Set(ids);
  }

  capture(kind: 'now' | 'figure' | 'snapshot', playerPosition: Vector3): number {
    let id = -1;
    let oldest = Infinity;
    for (let i = 0; i < this.targets.length; i++) {
      if (this.pinned.has(i)) continue;
      if (this.lastUsed[i] < oldest) {
        oldest = this.lastUsed[i];
        id = i;
      }
    }
    if (id < 0) id = 0;
    this.lastUsed[id] = ++this.tick;
    const vis = this.hide.map((o) => o.visible);
    this.hide.forEach((o) => (o.visible = false));
    const prevFigure = this.figure.position.clone();
    if (kind === 'figure') {
      this.camera.layers.enable(LAYER_FIGURE);
      // The extra figure stands exactly where the player stands.
      this.figure.position.set(playerPosition.x, 0.85, playerPosition.z);
    } else this.camera.layers.disable(LAYER_FIGURE);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.targets[id]);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    this.hide.forEach((o, i) => (o.visible = vis[i]));
    this.figure.position.copy(prevFigure);
    this.camera.layers.disable(LAYER_FIGURE);
    return id;
  }

  /** Low-rate surveillance feed from the ceiling corner, pointed at the player. */
  renderFeed(playerPosition: Vector3): void {
    this.feedCamera.lookAt(playerPosition.x, 1.2, playerPosition.z);
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.feedTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.feedCamera);
    this.renderer.setRenderTarget(prev);
  }
}
