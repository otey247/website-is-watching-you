import type { VisibilityClass } from '../attention/AttentionEstimator';
import type { SoundId } from '../audio/sounds';
import { SessionClock } from '../core/clock';
import { Emitter } from '../core/emitter';
import { AREA_CENTERS, AREA_IDS, INTERACTABLES, NAV_NODES, PLACEMENTS, type AreaId, type ObjectId, type V3 } from '../core/layout';
import { Rng } from '../core/rng';
import { ANOMALY_BY_ID } from '../director/anomalies';
import { Director } from '../director/Director';
import type { EndingId, Phase } from '../director/phaseMachine';
import type { EffectName, EffectSink, SoundAt, VisibilityOracle } from '../director/types';
import { Entity } from '../entity/Entity';
import { Narrative } from '../narrative/Narrative';
import { Observer } from '../observer/Observer';
import type { PredictionCandidate } from '../observer/Predictor';
import { Telemetry } from '../telemetry/Telemetry';
import type { ActionType, CameraSample, MetaValue } from '../telemetry/types';
import { FollowerSim, PointerHistory, type FollowerMark, type TrailPoint } from '../trail/Follower';
import { WorldState } from '../world/WorldState';

export interface CoreSettings {
  suddenEvents: boolean;
  reducedMotion: boolean;
}

export interface CoreEvents {
  sound: { id: SoundId; at: V3; gain: number; rate: number };
  effect: { name: EffectName; params: Record<string, unknown> };
  followerMarks: { marks: FollowerMark[] };
  gateways: { gateways: EndingId[] };
  phase: { from: Phase; to: Phase };
  instructionDismissed: undefined;
}

/** Renderer-provided services the pure core calls back into. */
export interface CorePorts {
  vis: VisibilityOracle;
  camera: () => CameraSample;
  /** Render the fictional room into a stored texture (never the player's real camera). */
  capture: (kind: 'now' | 'figure' | 'snapshot') => number;
}

const CHECKABLE: ObjectId[] = ['photograph', 'chair', 'clock', 'figurine', 'mirror', 'lamp', 'door', 'drawer_top', 'book_0', 'book_1', 'book_2', 'book_3', 'book_4', 'book_5', 'cup'];

interface LookTrack {
  attendedMs: number;
  awayAt: number;
  cycles: number[];
  lastTestAt: number;
}

/**
 * The simulation core: telemetry → Observer → Director → mutations, with no
 * rendering dependencies. The browser app and the headless tests both drive
 * this same object, which is how the integration tests exercise real logic.
 */
export class GameCore {
  readonly clock = new SessionClock();
  readonly rng: Rng;
  readonly world: WorldState;
  readonly telemetry: Telemetry;
  readonly observer: Observer;
  readonly narrative: Narrative;
  readonly director: Director;
  readonly entity: Entity;
  readonly follower: FollowerSim;
  readonly history = new PointerHistory();
  readonly emitter = new Emitter<CoreEvents>();
  readonly settings: CoreSettings = { suddenEvents: true, reducedMotion: false };

  // Derived-signal tracking state
  private hoverTarget: ObjectId | null = null;
  private hoverStart = 0;
  private pendingWitness = new Map<ObjectId, { anomalyId: string; at: number; attendedMs: number }>();
  private investigateWindow = new Map<ObjectId, { anomalyId: string; until: number; witnessId: number }>();
  private pendingSounds: { area: AreaId; at: number; reacted: boolean }[] = [];
  private lastAttendedArea = new Map<AreaId, number>();
  private lastGlanceEvent = new Map<AreaId, number>();
  private lastAvoidEvent = new Map<AreaId, number>();
  private looks = new Map<ObjectId, LookTrack>();
  private messageAttention: { createdAt: number; attendedMs: number; recorded: boolean } | null = null;
  private lastPointerMoveAt = 0;
  private lastActivityAt = 0;
  private idleRecorded = false;
  private lastSnapshotAt = -Infinity;
  private resolvedSeen = 0;
  private lastYaw = 0;
  private instructionVisible = true;

  constructor(
    seed: number,
    private readonly ports: CorePorts,
  ) {
    this.rng = new Rng(seed);
    const now = () => this.clock.now;
    this.world = new WorldState(now);
    this.telemetry = new Telemetry(now, ports.camera, () => ({ ...this.world.context(), phase: this.director?.phase ?? 'normalcy' }));
    this.observer = new Observer(this.telemetry);
    this.narrative = new Narrative(this.telemetry, this.rng);
    this.entity = new Entity(this.rng);
    this.follower = new FollowerSim(() => this.rng.next());
    const sink: EffectSink = {
      sound: (id, at, opts) => this.playSound(id, at, opts?.gain ?? 0.5, opts?.rate ?? 1, true),
      effect: (name, params) => this.emitter.emit('effect', { name, params }),
      capture: (kind) => ports.capture(kind === 'snapshot' ? 'snapshot' : kind),
    };
    this.director = new Director({
      world: this.world,
      telemetry: this.telemetry,
      observer: this.observer,
      narrative: this.narrative,
      rng: this.rng,
      vis: ports.vis,
      sink,
      camera: ports.camera,
      settings: this.settings,
    });
    this.director.emitter.on('mutation', ({ run, objectId, recordId }) => {
      if (recordId !== null || objectId === 'computer') {
        this.pendingWitness.set(objectId, { anomalyId: run.def.id, at: this.clock.now, attendedMs: 0 });
      }
      if (objectId === 'computer') this.messageAttention = { createdAt: this.clock.now, attendedMs: 0, recorded: false };
    });
    this.director.emitter.on('gateways', (g) => this.emitter.emit('gateways', g));
    this.director.emitter.on('phase', ({ from, to }) => this.emitter.emit('phase', { from, to }));
    this.telemetry.emitter.on('recorded', (e) => {
      // Resolve predictions the observer just scored.
      this.flushPredictions();
      if (e.target && ['object_inspected', 'object_picked_up', 'drawer_opened', 'lamp_toggled', 'door_handle_tried', 'door_opened', 'chair_moved', 'curtains_toggled'].includes(e.type)) {
        const win = this.investigateWindow.get(e.target);
        if (win && this.clock.now <= win.until) {
          this.investigateWindow.delete(e.target);
          this.telemetry.record({ type: 'anomaly_investigated', target: e.target, area: PLACEMENTS[e.target].area, meta: { anomalyId: win.anomalyId, witnessEvent: win.witnessId } });
        }
        this.follower.onInteraction();
      }
    });
    this.telemetry.record({ type: 'session_started', meta: { seed } });
  }

  get phase(): Phase {
    return this.director.phase;
  }

  // ——— Player actions (called by the interaction layer) ————————————————

  /** Record a deliberate in-room action. */
  report(type: ActionType, target: ObjectId, opts: { durationMs?: number; meta?: Record<string, MetaValue> } = {}): void {
    const now = this.clock.now;
    this.lastActivityAt = now;
    this.idleRecorded = false;
    if (this.hoverTarget === target && now - this.hoverStart >= 300 && type !== 'object_placed') {
      this.telemetry.record({ type: 'object_hesitated', target, area: PLACEMENTS[target].area, durationMs: now - this.hoverStart, meta: { outcome: 'clicked' } });
      this.hoverStart = now;
    }
    const e = this.telemetry.record({ type, target, area: PLACEMENTS[target].area, durationMs: opts.durationMs, meta: opts.meta ?? {} });
    if (this.instructionVisible) {
      this.instructionVisible = false;
      this.emitter.emit('instructionDismissed', undefined);
    }
    // Store a room snapshot with notable arrangement changes, for later photographs.
    if (['drawer_opened', 'lamp_toggled', 'chair_moved', 'curtains_toggled'].includes(type) && now - this.lastSnapshotAt > 40_000) {
      this.lastSnapshotAt = now;
      const captureId = this.ports.capture('snapshot');
      this.director.snapshots.set(e.id, { captureId, world: this.world.snapshot().objects });
      while (this.director.snapshots.size > 3) this.director.snapshots.delete(this.director.snapshots.keys().next().value!);
      e.snapshotId = captureId;
    }
  }

  /** The player started touching an object: the player always wins its claim. */
  grab(target: ObjectId): void {
    if (this.world.has(target)) this.world.claim(target, 'player');
  }

  release(target: ObjectId): void {
    if (this.world.has(target)) this.world.release(target, 'player');
  }

  hover(target: ObjectId | null): void {
    const now = this.clock.now;
    if (target === this.hoverTarget) return;
    if (this.hoverTarget && now - this.hoverStart >= 900) {
      this.telemetry.record({ type: 'object_hesitated', target: this.hoverTarget, area: PLACEMENTS[this.hoverTarget].area, durationMs: now - this.hoverStart, meta: { outcome: 'abandoned' } });
    }
    this.hoverTarget = target;
    this.hoverStart = now;
  }

  pointerMoved(): void {
    this.lastPointerMoveAt = this.clock.now;
    this.lastActivityAt = this.clock.now;
    this.idleRecorded = false;
  }

  cameraMoved(): void {
    this.lastActivityAt = this.clock.now;
    this.idleRecorded = false;
  }

  /** Record a pointer position projected onto a room surface. */
  trail(pt: Omit<TrailPoint, 't'>): TrailPoint | null {
    if (this.director.followerStage < 1) return null;
    return this.history.push({ ...pt, t: this.clock.now });
  }

  // ——— Periodic updates ————————————————————————————————————————————

  /** Every frame. */
  tick(realDtMs: number): void {
    this.clock.tick(realDtMs);
    if (this.clock.isPaused) return;
    const now = this.clock.now;
    this.director.pointerIdleMs = now - this.lastPointerMoveAt;
    this.director.playerIdleMs = now - this.lastActivityAt;
    this.director.tick(now);
    // Follower (stage ≥ 2).
    if (this.director.followerStage >= 2) {
      this.follower.setStage(this.director.followerStage);
      const predicted = this.predictedTrailPoint();
      const marks = this.follower.update(now, this.history, now - this.lastPointerMoveAt > 700, predicted);
      if (marks.length) this.emitter.emit('followerMarks', { marks });
    }
  }

  private predictedTrailPoint(): TrailPoint | null {
    const p = this.observer.predictor.current;
    if (!p?.target || p.confidence < 0.35) return null;
    // Use the most recent pointer point recorded on that object's surface, if any.
    for (let i = this.history.points.length - 1; i >= 0; i--) {
      const pt = this.history.points[i];
      if (pt.surface === `obj:${p.target}`) return pt;
    }
    return null;
  }

  /**
   * Attention sample (≈10 Hz): derive glances, avoidance, look-away tests,
   * witnesses, message reads, sound reactions and idleness.
   */
  sampleAttention(areaScores: Map<AreaId, number>, dtMs: number, yaw: number): void {
    if (this.clock.isPaused) return;
    const now = this.clock.now;
    const vis = this.ports.vis;
    const yawDelta = yaw - this.lastYaw;
    this.lastYaw = yaw;
    const idle = now - this.lastActivityAt > 4000;
    this.observer.sampleAttention(areaScores, dtMs, !!this.world.get('lamp').on, Math.abs(yawDelta) < 1 ? yawDelta : 0, idle);

    for (const area of AREA_IDS) {
      const s = areaScores.get(area) ?? 0;
      if (s >= 0.42) {
        const last = this.lastAttendedArea.get(area) ?? -Infinity;
        if (now - last > 20_000 && now - (this.lastGlanceEvent.get(area) ?? -Infinity) > 20_000) {
          this.lastGlanceEvent.set(area, now);
          this.telemetry.record({ type: 'area_glanced', area, meta: {} });
        }
        this.lastAttendedArea.set(area, now);
        for (const ps of this.pendingSounds) if (!ps.reacted && ps.area === area && now - ps.at < 2500) {
          ps.reacted = true;
          this.telemetry.record({ type: 'sound_reacted', area, meta: { reacted: true, area } });
        }
      }
      const avoid = this.observer.areaAvoidance.get(area) ?? 0;
      if (avoid >= 0.6 && now - (this.lastAvoidEvent.get(area) ?? -Infinity) > 180_000) {
        this.lastAvoidEvent.set(area, now);
        this.telemetry.record({ type: 'area_avoided', area, meta: { score: Math.round(avoid * 100) / 100 } });
      }
    }
    this.pendingSounds = this.pendingSounds.filter((ps) => {
      if (ps.reacted) return false;
      if (now - ps.at > 4000) {
        this.telemetry.record({ type: 'sound_reacted', area: ps.area, meta: { reacted: false, area: ps.area } });
        return false;
      }
      return true;
    });

    // Witnessing a changed object.
    for (const [obj, w] of [...this.pendingWitness]) {
      if (vis.visibility(obj) === 'attended') {
        w.attendedMs += dtMs;
        if (w.attendedMs >= 600) {
          this.pendingWitness.delete(obj);
          const ev = this.telemetry.record({ type: 'anomaly_witnessed', target: obj, area: PLACEMENTS[obj].area, meta: { anomalyId: w.anomalyId } });
          this.investigateWindow.set(obj, { anomalyId: w.anomalyId, until: now + 30_000, witnessId: ev.id });
        }
      } else if (now - w.at > 600_000) this.pendingWitness.delete(obj);
    }

    // Message reads on the computer.
    const m = this.messageAttention;
    if (m && !m.recorded) {
      const v: VisibilityClass = vis.visibility('computer');
      if (v === 'attended') m.attendedMs += dtMs;
      else if (m.attendedMs > 300) {
        m.recorded = true;
        const last = this.narrative.shown[this.narrative.shown.length - 1];
        this.telemetry.record({ type: 'message_read', target: 'computer', area: 'desk', durationMs: m.attendedMs, meta: { template: last?.templateId ?? '' } });
      }
    }

    // Look-away tests: watch → look away → come back quickly, repeatedly.
    for (const id of CHECKABLE) {
      let tr = this.looks.get(id);
      if (!tr) this.looks.set(id, (tr = { attendedMs: 0, awayAt: -Infinity, cycles: [], lastTestAt: -Infinity }));
      const v = vis.visibility(id);
      if (v === 'attended') {
        if (Number.isFinite(tr.awayAt)) {
          const away = now - tr.awayAt;
          if (away >= 1200 && away <= 8000) tr.cycles.push(now);
          tr.awayAt = -Infinity;
        }
        tr.attendedMs += dtMs;
      } else if (vis.isUnseen(id)) {
        if (tr.attendedMs >= 700 && !Number.isFinite(tr.awayAt)) tr.awayAt = now;
        if (!Number.isFinite(tr.awayAt)) tr.attendedMs = 0;
      }
      tr.cycles = tr.cycles.filter((t) => now - t < 45_000);
      if (tr.cycles.length >= 2 && now - tr.lastTestAt > 30_000) {
        tr.lastTestAt = now;
        tr.cycles = [];
        this.telemetry.record({ type: 'look_away_test', target: id, area: PLACEMENTS[id].area, meta: { cycles: 2 } });
      }
      if (v !== 'attended' && !vis.isUnseen(id)) tr.attendedMs = Math.max(0, tr.attendedMs - dtMs);
    }

    // Idle.
    if (now - this.lastActivityAt > 12_000 && !this.idleRecorded) {
      this.idleRecorded = true;
      this.telemetry.record({ type: 'player_idle', durationMs: now - this.lastActivityAt, meta: {} });
    }

    // The presence drifts between unseen nodes.
    const moved = this.entity.update(
      now,
      {
        lastTarget: this.telemetry.last(['object_inspected', 'object_picked_up', 'drawer_opened', 'lamp_toggled'])?.target ?? null,
        predicted: this.observer.predictor.current?.target ?? null,
        awareness: this.observer.state.familiarity * 0.5 + this.observer.state.suspicion * 0.5,
        suspicion: this.observer.state.suspicion,
        avoidance: this.observer.state.avoidance,
      },
      (p) => vis.isPointVisible(p),
    );
    if (moved && this.director.phase !== 'normalcy') this.emitter.emit('effect', { name: 'entity_move', params: { node: this.entity.state.node } });
  }

  /** Prediction update (≈10 Hz). */
  updatePrediction(pointer: { x: number; y: number } | null, velocity: { x: number; y: number }, candidates: PredictionCandidate[]): void {
    if (this.clock.isPaused) return;
    const now = this.clock.now;
    this.observer.predictor.predict({ pointer, pointerVelocity: velocity, candidates, now });
    this.flushPredictions();
    this.director.onPrediction(now);
  }

  private flushPredictions(): void {
    const r = this.observer.predictor.resolved;
    // The resolved list is bounded; compare by identity of the tail.
    while (this.resolvedSeen < r.length) {
      const p = r[this.resolvedSeen++];
      this.telemetry.record({
        type: 'prediction_resolved',
        target: p.actual ?? undefined,
        meta: { predicted: p.target, outcome: p.outcome, confidence: Math.round(p.confidence * 100) / 100, response: p.response ?? '' },
      });
    }
    if (r.length >= 60) this.resolvedSeen = Math.min(this.resolvedSeen, r.length);
  }

  /** Candidates for prediction from interactable placements. */
  static interactableIds(): ObjectId[] {
    return INTERACTABLES.map((p) => p.id);
  }

  // ——— Audio routing (sounds carry their world position and area) ———

  playSound(id: SoundId, at: SoundAt, gain: number, rate: number, fromDirector: boolean): void {
    const pos = this.resolvePosition(at);
    this.emitter.emit('sound', { id, at: pos, gain, rate });
    if (fromDirector) this.pendingSounds.push({ area: nearestArea(pos), at: this.clock.now, reacted: false });
  }

  resolvePosition(at: SoundAt): V3 {
    if (Array.isArray(at)) return at as V3;
    if (at === 'entity') return this.entity.position;
    if (typeof at === 'string' && at in NAV_NODES) return NAV_NODES[at as keyof typeof NAV_NODES];
    return PLACEMENTS[at as ObjectId].center;
  }

  // ——— Endings ———

  requestEnding(ending: EndingId): boolean {
    return this.director.beginEnding(ending);
  }

  // ——— Test-mode controls ———

  forceAnomaly(id: string, opts?: { ignoreRequirements?: boolean; anyPhase?: boolean }): { ok: boolean; reason: string } {
    if (!ANOMALY_BY_ID[id]) return { ok: false, reason: 'unknown' };
    return this.director.force(id, opts);
  }

  // ——— Persistence ———

  snapshot(): object {
    return {
      v: 1,
      seed: this.rng.seed,
      rngState: this.rng.getState(),
      clock: this.clock.now,
      telemetry: this.telemetry.snapshot(),
      world: this.world.snapshot(),
      observer: this.observer.snapshot(),
      narrative: this.narrative.snapshot(),
      director: this.director.snapshot(),
      settings: this.settings,
    };
  }

  restore(s: object): void {
    const o = s as {
      rngState: number;
      clock: number;
      telemetry: Parameters<Telemetry['restore']>[0];
      world: Parameters<WorldState['restore']>[0];
      observer: object;
      narrative: object;
      director: object;
      settings: CoreSettings;
    };
    this.clock.restore(o.clock);
    this.rng.setState(o.rngState);
    this.telemetry.restore(o.telemetry);
    this.world.restore(o.world);
    this.observer.restore(o.observer);
    this.narrative.restore(o.narrative);
    this.director.restore(o.director, o.clock);
    Object.assign(this.settings, o.settings);
    this.resolvedSeen = this.observer.predictor.resolved.length;
    this.lastActivityAt = o.clock;
    this.lastPointerMoveAt = o.clock;
    this.instructionVisible = false;
  }
}

function nearestArea(p: V3): AreaId {
  let best: AreaId = 'desk';
  let bd = Infinity;
  for (const a of AREA_IDS) {
    const c = AREA_CENTERS[a];
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  return best;
}
