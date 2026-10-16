import type { VisibilityClass } from '../../src/attention/AttentionEstimator';
import { SessionClock } from '../../src/core/clock';
import type { ObjectId, V3 } from '../../src/core/layout';
import { Rng } from '../../src/core/rng';
import { Director } from '../../src/director/Director';
import type { EffectName, EffectSink, SoundAt, VisibilityOracle } from '../../src/director/types';
import { Narrative } from '../../src/narrative/Narrative';
import type { NarrativeContext } from '../../src/narrative/types';
import { Observer } from '../../src/observer/Observer';
import type { PredictionCandidate } from '../../src/observer/Predictor';
import { Telemetry } from '../../src/telemetry/Telemetry';
import type { CameraSample } from '../../src/telemetry/types';
import { WorldState } from '../../src/world/WorldState';

/**
 * Scriptable visibility oracle. Every object is offscreen (and has been for
 * ever) unless a test says otherwise.
 */
export class FakeOracle implements VisibilityOracle {
  private readonly vis = new Map<ObjectId, VisibilityClass>();
  private readonly lastSeen = new Map<ObjectId, number>();
  pointVisible: (p: V3) => boolean = () => false;

  /** Set an object's visibility at time `now` (records when it was last seen). */
  set(id: ObjectId, v: VisibilityClass, now: number): void {
    const prev = this.visibility(id);
    if (prev === 'attended' || prev === 'peripheral' || v === 'attended' || v === 'peripheral') this.lastSeen.set(id, now);
    this.vis.set(id, v);
  }

  visibility(id: ObjectId): VisibilityClass {
    return this.vis.get(id) ?? 'offscreen';
  }
  isUnseen(id: ObjectId): boolean {
    const v = this.visibility(id);
    return v === 'offscreen' || v === 'occluded';
  }
  unseenForMs(id: ObjectId, now: number): number {
    if (!this.isUnseen(id)) return 0;
    return now - (this.lastSeen.get(id) ?? -Infinity);
  }
  score(id: ObjectId): number {
    const v = this.visibility(id);
    return v === 'attended' ? 0.8 : v === 'peripheral' ? 0.2 : 0;
  }
  isPointVisible(p: V3): boolean {
    return this.pointVisible(p);
  }
  focus(): ObjectId | null {
    for (const [id, v] of this.vis) if (v === 'attended') return id;
    return null;
  }
}

export class RecordingSink implements EffectSink {
  readonly sounds: { id: string; at: SoundAt }[] = [];
  readonly effects: { name: EffectName; params: Record<string, unknown> }[] = [];
  private nextCapture = 1;
  sound(id: string, at: SoundAt): void {
    this.sounds.push({ id, at });
  }
  effect(name: EffectName, params: Record<string, unknown>): void {
    this.effects.push({ name, params });
  }
  capture(): number {
    return this.nextCapture++;
  }
}

export const HOME_CAMERA: CameraSample = { position: [0.15, 1.6, 0.45], yaw: 0.45, pitch: -0.12 };

export function makeDirector(seed = 7) {
  const clock = new SessionClock();
  const now = () => clock.now;
  const world = new WorldState(now);
  const telemetry = new Telemetry(now, () => HOME_CAMERA, () => ({ ...world.context(), phase: 'normalcy' }));
  const observer = new Observer(telemetry);
  const rng = new Rng(seed);
  const narrative = new Narrative(telemetry, rng);
  const vis = new FakeOracle();
  const sink = new RecordingSink();
  const settings = { suddenEvents: true, reducedMotion: false };
  const director = new Director({ world, telemetry, observer, narrative, rng, vis, sink, camera: () => HOME_CAMERA, settings });

  /**
   * Advance in frames. With `auto: false` (default) the director's own random
   * scheduling is held back so only explicitly forced events run.
   */
  const step = (ms: number, opts: { frame?: number; auto?: boolean; each?: () => void } = {}) => {
    const frame = opts.frame ?? 16;
    let left = ms;
    while (left > 0) {
      const d = Math.min(frame, left);
      left -= d;
      clock.advance(d);
      if (!opts.auto) director.resetScheduling(clock.now);
      director.tick(clock.now);
      opts.each?.();
    }
  };

  return { clock, world, telemetry, observer, rng, narrative, vis, sink, settings, director, step };
}

export function narrativeCtx(d: ReturnType<typeof makeDirector>): NarrativeContext {
  return d.director.narrativeCtx();
}

/** A prediction candidate list with the pointer resting on `target`. */
export function pointerOn(target: ObjectId, others: ObjectId[] = []): { pointer: { x: number; y: number }; candidates: PredictionCandidate[] } {
  return {
    pointer: { x: 0, y: 0 },
    candidates: [
      { id: target, ndc: { x: 0, y: 0 }, centerAngle: 0.05, dwellMs: 1500 },
      ...others.map((id, i) => ({ id, ndc: { x: 0.9, y: -0.9 + i * 0.1 }, centerAngle: 1.0, dwellMs: 0 })),
    ],
  };
}
