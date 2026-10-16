import { Frustum, Matrix4, Object3D, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp01, smoothstep } from '../core/math';
import type { AreaId, ObjectId } from '../core/layout';

export type VisibilityClass = 'attended' | 'peripheral' | 'occluded' | 'offscreen';

export interface AttentionTarget {
  id: ObjectId;
  area: AreaId;
  /** World-space center (kept current by the renderer for movable objects). */
  center: Vector3;
  radius: number;
  /** Meshes belonging to this object; ignored when testing its occlusion. */
  meshes: Object3D[];
}

export interface AttentionEstimate {
  id: ObjectId;
  area: AreaId;
  inFrustum: boolean;
  occluded: boolean;
  /** Fraction of sample points with a clear line of sight (0..1). */
  visibleFraction: number;
  /** Visible through the mirror even though not directly in view. */
  viaMirror: boolean;
  /** Projected radius as a fraction of the viewport height. */
  screenSize: number;
  /** Angle (rad) between camera forward and the object center. */
  centerAngle: number;
  /** Distance from the pointer in NDC units (Infinity without pointer). */
  pointerDistance: number;
  visibility: VisibilityClass;
  /** 0..1 approximate visual attention. Zero when not visible. */
  score: number;
  /** Pointer dwell contribution, independent of screen centrality. */
  pointerAttention: number;
  lastSeenMs: number;
  lastAttendedMs: number;
  /** Accumulated attention-weighted dwell (ms). */
  dwellMs: number;
}

export interface MirrorSpec {
  center: Vector3;
  normal: Vector3;
  halfWidth: number;
  halfHeight: number;
}

const ATTENDED_THRESHOLD = 0.42;
const SAMPLE_OFFSETS: [number, number][] = [
  [0, 0],
  [0.7, 0],
  [-0.7, 0],
  [0, 0.7],
  [0, -0.7],
];

/**
 * Attention approximation. Pointer position is treated as a weak hint of
 * attention, never as eye tracking. Visual attention requires the object to be
 * inside the frustum and not occluded by room geometry.
 */
export class AttentionEstimator {
  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();
  private readonly raycaster = new Raycaster();
  private readonly estimates = new Map<ObjectId, AttentionEstimate>();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly camPos = new Vector3();
  private readonly mirrorPlane = new Plane();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly targets: AttentionTarget[],
    private readonly occluders: Object3D[],
    private readonly mirror?: MirrorSpec,
  ) {
    for (const t of targets) {
      this.estimates.set(t.id, {
        id: t.id,
        area: t.area,
        inFrustum: false,
        occluded: false,
        visibleFraction: 0,
        viaMirror: false,
        screenSize: 0,
        centerAngle: Math.PI,
        pointerDistance: Infinity,
        visibility: 'offscreen',
        score: 0,
        pointerAttention: 0,
        lastSeenMs: -Infinity,
        lastAttendedMs: -Infinity,
        dwellMs: 0,
      });
    }
    if (mirror) this.mirrorPlane.setFromNormalAndCoplanarPoint(mirror.normal, mirror.center);
  }

  get(id: ObjectId): AttentionEstimate | undefined {
    return this.estimates.get(id);
  }

  all(): AttentionEstimate[] {
    return [...this.estimates.values()];
  }

  /** True when the object cannot currently be seen at all (directly or via the mirror). */
  isUnseen(id: ObjectId): boolean {
    const e = this.estimates.get(id);
    return !e || ((e.visibility === 'offscreen' || e.visibility === 'occluded') && !e.viaMirror);
  }

  unseenForMs(id: ObjectId, now: number): number {
    const e = this.estimates.get(id);
    if (!e) return Infinity;
    if (!this.isUnseen(id)) return 0;
    return now - e.lastSeenMs;
  }

  /**
   * Re-estimate attention for every target.
   * @param pointer pointer position in NDC (-1..1), or null when not over the canvas
   * @param dtMs elapsed time since the previous sample, for dwell accumulation
   */
  sample(pointer: Vector2 | null, now: number, dtMs: number): void {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    cam.getWorldPosition(this.camPos);
    cam.getWorldDirection(this.forward);
    this.right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
    const halfFov = (cam.fov * Math.PI) / 360;
    const mirrorEst = this.mirror ? this.estimates.get('mirror') : undefined;
    const mirrorVisible = !!mirrorEst && mirrorEst.visibleFraction > 0;

    for (const t of this.targets) {
      const e = this.estimates.get(t.id)!;
      this.tmp.subVectors(t.center, this.camPos);
      const dist = Math.max(0.05, this.tmp.length());
      e.centerAngle = this.tmp.angleTo(this.forward);

      // Frustum + occlusion via several sample points over the bounding sphere.
      let inFrustumSamples = 0;
      let clearSamples = 0;
      for (const [ox, oy] of SAMPLE_OFFSETS) {
        const p = this.tmp2
          .copy(t.center)
          .addScaledVector(this.right, ox * t.radius)
          .addScaledVector(this.up, oy * t.radius);
        if (!this.frustum.containsPoint(p)) continue;
        inFrustumSamples++;
        if (!this.isOccluded(p, t)) clearSamples++;
      }
      e.inFrustum = inFrustumSamples > 0 || this.frustum.intersectsSphere({ center: t.center, radius: t.radius } as never);
      e.visibleFraction = inFrustumSamples > 0 ? clearSamples / SAMPLE_OFFSETS.length : 0;
      e.occluded = e.inFrustum && clearSamples === 0;

      // Seen in the mirror? (Only matters if the mirror itself is visible.)
      e.viaMirror = t.id !== 'mirror' && mirrorVisible && this.visibleInMirror(t);

      e.screenSize = t.radius / (dist * Math.tan(halfFov));

      // Pointer proximity in NDC.
      if (pointer && e.inFrustum) {
        const ndc = this.tmp2.copy(t.center).project(cam);
        const r = e.screenSize;
        e.pointerDistance = Math.max(0, Math.hypot(ndc.x - pointer.x, (ndc.y - pointer.y) * 0.75) - r * 0.5);
      } else {
        e.pointerDistance = Infinity;
      }

      if (e.visibleFraction <= 0) {
        e.score = 0;
        e.pointerAttention = 0;
        e.visibility = e.occluded ? 'occluded' : 'offscreen';
        if (e.viaMirror) e.lastSeenMs = now;
        continue;
      }

      const centrality = 1 - smoothstep(0.05, halfFov * 1.25, e.centerAngle);
      const size = smoothstep(0.02, 0.35, e.screenSize);
      const pointerAtt = Number.isFinite(e.pointerDistance) ? 1 - smoothstep(0.02, 0.25, e.pointerDistance) : 0;
      e.pointerAttention = pointerAtt;
      e.score = clamp01(e.visibleFraction * (0.6 * centrality + 0.2 * size + 0.35 * pointerAtt));
      e.visibility = e.score >= ATTENDED_THRESHOLD ? 'attended' : 'peripheral';
      e.lastSeenMs = now;
      if (e.visibility === 'attended') e.lastAttendedMs = now;
      e.dwellMs += dtMs * e.score;
    }
  }

  private isOccluded(point: Vector3, target: AttentionTarget): boolean {
    const dir = this.tmp.subVectors(point, this.camPos);
    const len = dir.length();
    dir.divideScalar(len);
    this.raycaster.set(this.camPos, dir);
    this.raycaster.near = 0.01;
    this.raycaster.far = len - Math.min(0.05, target.radius * 0.5);
    const hits = this.raycaster.intersectObjects(this.occluders, true);
    for (const h of hits) {
      if (isDescendantOf(h.object, target.meshes)) continue;
      if (!h.object.visible) continue;
      return true;
    }
    return false;
  }

  /** Reflect the target center across the mirror plane and test the line of sight through the glass. */
  private visibleInMirror(t: AttentionTarget): boolean {
    const m = this.mirror!;
    const reflected = this.tmp2.copy(t.center);
    const d = this.mirrorPlane.distanceToPoint(reflected);
    if (d <= 0) return false; // behind the mirror
    reflected.addScaledVector(m.normal, -2 * d);
    const dir = new Vector3().subVectors(reflected, this.camPos);
    const denom = dir.dot(m.normal);
    if (Math.abs(denom) < 1e-6) return false;
    const s = -(this.camPos.dot(m.normal) + this.mirrorPlane.constant) / denom;
    if (s <= 0 || s >= 1) return false;
    const hit = this.camPos.clone().addScaledVector(dir, s);
    const local = hit.sub(m.center);
    // Mirror lies in a vertical plane; its horizontal axis is perpendicular to normal and up.
    const horiz = new Vector3(0, 1, 0).cross(m.normal).normalize();
    const u = Math.abs(local.dot(horiz));
    const v = Math.abs(local.y);
    if (u > m.halfWidth + t.radius * 0.5 || v > m.halfHeight + t.radius * 0.5) return false;
    return this.frustum.containsPoint(this.camPos.clone().addScaledVector(dir, s));
  }

  /** Aggregate per area: the best attention score of any target in it. */
  areaScores(): Map<AreaId, number> {
    const m = new Map<AreaId, number>();
    for (const e of this.estimates.values()) m.set(e.area, Math.max(m.get(e.area) ?? 0, e.score));
    return m;
  }

  /** Object with the highest current attention (if any is attended). */
  focus(): AttentionEstimate | undefined {
    let best: AttentionEstimate | undefined;
    for (const e of this.estimates.values()) {
      if (e.visibility !== 'attended') continue;
      if (!best || e.score > best.score) best = e;
    }
    return best;
  }

  serialize(): { id: string; v: VisibilityClass; s: number }[] {
    return this.all().map((e) => ({ id: e.id, v: e.visibility, s: Math.round(e.score * 100) / 100 }));
  }
}

function isDescendantOf(obj: Object3D, roots: Object3D[]): boolean {
  let o: Object3D | null = obj;
  while (o) {
    if (roots.includes(o)) return true;
    o = o.parent;
  }
  return false;
}
