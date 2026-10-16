import { Euler, MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CAMERA_HOME, type ObjectId, type V3 } from '../core/layout';
import { clamp, damp, easeInOutCubic } from '../core/math';
import type { CameraSample } from '../telemetry/types';

export interface InspectPose {
  position: V3;
  target: V3;
  fov: number;
  /** Allowed orbit around the target while inspecting (radians). */
  orbit?: number;
}

export const INSPECT_POSES: Partial<Record<ObjectId, InspectPose>> = {
  photograph: { position: [-1.82, 1.55, 0.25], target: [-2.46, 1.55, 0.25], fov: 42, orbit: 0.3 },
  computer: { position: [-1.05, 1.08, -1.3], target: [-1.05, 1.035, -1.9], fov: 44, orbit: 0.12 },
  clock: { position: [1.92, 1.9, 1.05], target: [2.47, 1.95, 1.05], fov: 40, orbit: 0.3 },
  mirror: { position: [0.1, 1.5, 1.2], target: [-0.7, 1.35, 2.07], fov: 46, orbit: 0.2 },
  note: { position: [1.36, 1.02, 1.2], target: [1.47, 0.62, 1.44], fov: 40, orbit: 0.2 },
};

const PITCH_MIN = -0.75;
const PITCH_MAX = 0.55;
const FOV_MIN = 30;
const FOV_MAX = 62;

/**
 * First-person camera with limited free look, interruptible inspection
 * transitions and a return that preserves spatial orientation.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  yaw: number = CAMERA_HOME.yaw;
  pitch: number = CAMERA_HOME.pitch;
  private targetYaw: number = CAMERA_HOME.yaw;
  private targetPitch: number = CAMERA_HOME.pitch;
  fov = 55;
  private targetFov = 55;
  private home = new Vector3(...CAMERA_HOME.position);
  mode: 'look' | 'transition' | 'inspect' | 'scripted' = 'look';
  inspecting: ObjectId | null = null;
  private from = { pos: new Vector3(), quat: new Quaternion(), fov: 55 };
  private to = { pos: new Vector3(), quat: new Quaternion(), fov: 55 };
  private t = 1;
  private duration = 1.1;
  private returning = false;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private pose: InspectPose | null = null;
  private saved: { yaw: number; pitch: number; fov: number } = { yaw: CAMERA_HOME.yaw, pitch: CAMERA_HOME.pitch, fov: 55 };
  reducedMotion = false;
  private sway = 0;
  /** Angular velocity of yaw (rad/s), used for anticipation heuristics. */
  yawVelocity = 0;
  private lastYaw: number = CAMERA_HOME.yaw;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(55, aspect, 0.03, 40);
    this.camera.position.copy(this.home);
    this.applyLook();
  }

  get busy(): boolean {
    return this.mode === 'transition' || this.mode === 'scripted';
  }

  rotateBy(dx: number, dy: number): void {
    if (this.mode === 'inspect' && this.pose) {
      const o = this.pose.orbit ?? 0.2;
      this.orbitYaw = clamp(this.orbitYaw - dx * 0.004, -o, o);
      this.orbitPitch = clamp(this.orbitPitch - dy * 0.003, -o * 0.6, o * 0.6);
      return;
    }
    if (this.mode !== 'look') return;
    const k = (this.fov / 55) * 0.0042;
    this.targetYaw += dx * k;
    this.targetPitch = clamp(this.targetPitch + dy * k, PITCH_MIN, PITCH_MAX);
  }

  zoom(delta: number): void {
    if (this.mode === 'scripted') return;
    this.targetFov = clamp(this.targetFov + delta, FOV_MIN, FOV_MAX);
  }

  inspect(id: ObjectId): boolean {
    const pose = INSPECT_POSES[id];
    if (!pose || this.mode === 'scripted') return false;
    if (this.mode === 'look') this.saved = { yaw: this.targetYaw, pitch: this.targetPitch, fov: this.targetFov };
    this.pose = pose;
    this.inspecting = id;
    this.orbitYaw = this.orbitPitch = 0;
    this.beginTransition(new Vector3(...pose.position), lookQuat(new Vector3(...pose.position), new Vector3(...pose.target)), pose.fov, false);
    return true;
  }

  exitInspect(): void {
    if (!this.inspecting && !(this.mode === 'transition' && !this.returning)) return;
    this.inspecting = null;
    this.pose = null;
    this.targetYaw = this.saved.yaw;
    this.targetPitch = this.saved.pitch;
    this.targetFov = this.saved.fov;
    const q = new Quaternion().setFromEuler(new Euler(this.saved.pitch, this.saved.yaw, 0, 'YXZ'));
    this.beginTransition(this.home.clone(), q, this.saved.fov, true);
  }

  /** Scripted camera move used by endings (input ignored meanwhile). */
  scripted(position: V3, target: V3, fov: number, seconds: number): void {
    this.mode = 'scripted';
    this.from = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
    this.to = { pos: new Vector3(...position), quat: lookQuat(new Vector3(...position), new Vector3(...target)), fov };
    this.t = 0;
    this.duration = seconds;
  }

  /** Reset to the starting pose instantly (used by the refusal loop and restarts). */
  resetHome(): void {
    this.mode = 'look';
    this.inspecting = null;
    this.pose = null;
    this.yaw = this.targetYaw = CAMERA_HOME.yaw;
    this.pitch = this.targetPitch = CAMERA_HOME.pitch;
    this.fov = this.targetFov = 55;
    this.camera.position.copy(this.home);
    this.applyLook();
  }

  private beginTransition(pos: Vector3, quat: Quaternion, fov: number, returning: boolean): void {
    // Interruptible: always start from wherever the camera is right now.
    this.from = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
    this.to = { pos, quat, fov };
    this.t = 0;
    const dist = this.from.pos.distanceTo(pos);
    this.duration = this.reducedMotion ? 0.35 : clamp(0.65 + dist * 0.28, 0.7, 1.4);
    this.returning = returning;
    this.mode = 'transition';
  }

  update(dt: number, time: number): void {
    this.yawVelocity = (this.yaw - this.lastYaw) / Math.max(dt, 1e-3);
    this.lastYaw = this.yaw;
    if (this.mode === 'transition' || this.mode === 'scripted') {
      this.t = Math.min(1, this.t + dt / this.duration);
      const e = easeInOutCubic(this.t);
      this.camera.position.lerpVectors(this.from.pos, this.to.pos, e);
      this.camera.quaternion.slerpQuaternions(this.from.quat, this.to.quat, e);
      this.camera.fov = MathUtils.lerp(this.from.fov, this.to.fov, e);
      this.camera.updateProjectionMatrix();
      if (this.t >= 1 && this.mode === 'transition') {
        if (this.returning) {
          this.mode = 'look';
          this.yaw = this.targetYaw;
          this.pitch = this.targetPitch;
          this.fov = this.targetFov;
        } else this.mode = 'inspect';
      }
      return;
    }
    if (this.mode === 'inspect' && this.pose) {
      // Gentle orbit around the inspected object.
      const target = new Vector3(...this.pose.target);
      const offset = new Vector3(...this.pose.position).sub(target);
      offset.applyAxisAngle(new Vector3(0, 1, 0), this.orbitYaw);
      const right = new Vector3().crossVectors(offset, new Vector3(0, 1, 0)).normalize();
      offset.applyAxisAngle(right, this.orbitPitch);
      const pos = target.clone().add(offset);
      this.camera.position.lerp(pos, Math.min(1, dt * 6));
      this.camera.quaternion.slerp(lookQuat(this.camera.position, target), Math.min(1, dt * 6));
      this.camera.fov = damp(this.camera.fov, this.pose.fov + (this.targetFov - this.saved.fov) * 0.3, 6, dt);
      this.camera.updateProjectionMatrix();
      return;
    }
    // Look mode: smoothed yaw/pitch with a subtle breathing sway.
    this.yaw = damp(this.yaw, this.targetYaw, 10, dt);
    this.pitch = damp(this.pitch, this.targetPitch, 10, dt);
    this.fov = damp(this.fov, this.targetFov, 8, dt);
    this.sway = this.reducedMotion ? 0 : 1;
    this.camera.position.set(this.home.x, this.home.y + Math.sin(time * 0.9) * 0.004 * this.sway, this.home.z);
    this.applyLook(Math.sin(time * 0.43) * 0.0025 * this.sway);
  }

  private applyLook(extraPitch = 0): void {
    this.camera.quaternion.setFromEuler(new Euler(this.pitch + extraPitch, this.yaw, 0, 'YXZ'));
    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  sample(): CameraSample {
    const p = this.camera.position;
    return { position: [round(p.x), round(p.y), round(p.z)], yaw: round(this.yaw), pitch: round(this.pitch) };
  }

  /** Point the look direction at a world point (used by tests and endings). */
  lookAtPoint(p: V3, instant = false): void {
    const d = new Vector3(p[0], p[1], p[2]).sub(this.home);
    this.targetYaw = Math.atan2(-d.x, -d.z);
    this.targetPitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), PITCH_MIN, PITCH_MAX);
    if (instant) {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
      this.applyLook();
      this.camera.updateMatrixWorld();
    }
  }
}

function lookQuat(from: Vector3, to: Vector3): Quaternion {
  const m = new Matrix4().lookAt(from, to, new Vector3(0, 1, 0));
  return new Quaternion().setFromRotationMatrix(m);
}

const round = (v: number) => Math.round(v * 1000) / 1000;
