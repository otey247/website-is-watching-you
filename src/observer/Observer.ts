import { AREA_IDS, PLACEMENTS, type AreaId, type ObjectId } from '../core/layout';
import { clamp01, decay, smoothstep } from '../core/math';
import { PLAYER_ACTIONS, type Telemetry } from '../telemetry/Telemetry';
import type { BehavioralEvent } from '../telemetry/types';
import { Predictor } from './Predictor';

/** Continuous internal values of the Observer, all 0..1. */
export interface ObserverState {
  familiarity: number;
  suspicion: number;
  curiosity: number;
  avoidance: number;
  predictability: number;
  tension: number;
  exposure: number;
  fatigue: number;
  /** Evidence that the player is deliberately testing the room. */
  testing: number;
}

export interface BehavioralProfile {
  mostInspected: ObjectId | null;
  mostInspectedCount: number;
  leastVisitedArea: AreaId | null;
  /** Share of active time with the lamp on (0..1). */
  lightPreference: number;
  averageHesitationMs: number;
  /** Areas in the order the player first explored them. */
  explorationPath: AreaId[];
  /** investigated / witnessed anomalies. */
  anomalyInvestigation: number;
  /** Share of interactions that repeat a recent target. */
  repetition: number;
  /** -1 = tends to turn left, +1 = right. */
  turnBias: number;
  /** Share of time spent idle. */
  stillness: number;
  likelyNext: { id: ObjectId; p: number } | null;
}

export interface EndingAffinity {
  acknowledgment: number;
  refusal: number;
  reversal: number;
}

const AVOIDANCE_MIN_ACTIVE_MS = 150_000;
const AVOIDANCE_MIN_SAMPLES_MS = 90_000;

/**
 * The Observer: the hidden behavioral model watching the player.
 *
 * It never changes the scene. It only derives scores, a profile and
 * predictions that the Horror Director consults when choosing events.
 * Its values move because of what the player does, not because time passes:
 * every increase is traceable to telemetry or attention samples.
 */
export class Observer {
  readonly predictor = new Predictor();
  state: ObserverState = {
    familiarity: 0,
    suspicion: 0,
    curiosity: 0,
    avoidance: 0,
    predictability: 0,
    tension: 0,
    exposure: 0,
    fatigue: 0,
    testing: 0,
  };
  /** Interest per object; grows with inspections and dwell, decays slowly. */
  readonly interest = new Map<ObjectId, number>();
  /** Attention-weighted time per area (ms). */
  readonly areaAttentionMs = new Map<AreaId, number>();
  private attentionSampleMs = 0;
  private activeMs = 0;
  private idleMs = 0;
  private lampOnMs = 0;
  private hesitations: number[] = [];
  private recentTargets: ObjectId[] = [];
  private repeats = 0;
  private explorationPath: AreaId[] = [];
  private turnAccum = 0;
  private witnessed = 0;
  private investigated = 0;
  /** Per-anomaly exposure counts for repetition fatigue. */
  readonly anomalyExposure = new Map<string, number>();
  readonly areaAvoidance = new Map<AreaId, number>();

  constructor(private readonly telemetry: Telemetry) {
    telemetry.emitter.on('recorded', (e) => this.onEvent(e));
  }

  private onEvent(e: BehavioralEvent): void {
    const isAction = PLAYER_ACTIONS.includes(e.type);
    if (isAction && e.target) {
      const t = e.target;
      const prevInterest = this.interest.get(t) ?? 0;
      const weight = e.type === 'object_inspected' ? 1 + Math.min(2, (e.durationMs ?? 0) / 4000) : 0.6;
      this.interest.set(t, prevInterest + weight);
      if (this.recentTargets.slice(-4).includes(t)) this.repeats++;
      this.recentTargets.push(t);
      if (this.recentTargets.length > 40) this.recentTargets.shift();
      const area = PLACEMENTS[t].area;
      if (!this.explorationPath.includes(area)) this.explorationPath.push(area);
      this.predictor.observe(t, e.timestampMs);
      this.state.familiarity = clamp01(Math.log1p(this.telemetry.interactionCount()) / Math.log1p(60));
    }
    switch (e.type) {
      case 'object_hesitated':
        if (e.durationMs) this.hesitations.push(e.durationMs);
        if (this.hesitations.length > 50) this.hesitations.shift();
        break;
      case 'anomaly_witnessed':
        this.witnessed++;
        this.state.suspicion = clamp01(this.state.suspicion + 0.05);
        break;
      case 'anomaly_investigated':
        this.investigated++;
        this.state.suspicion = clamp01(this.state.suspicion + 0.12);
        this.state.curiosity = clamp01(this.state.curiosity + 0.08);
        break;
      case 'sound_reacted':
        this.state.suspicion = clamp01(this.state.suspicion + 0.04);
        break;
      case 'look_away_test':
        this.state.testing = clamp01(this.state.testing + 0.22);
        this.state.suspicion = clamp01(this.state.suspicion + 0.08);
        break;
      case 'object_inspected': {
        const distinct = new Set(this.telemetry.query({ type: 'object_inspected' }).map((x) => x.target)).size;
        this.state.curiosity = clamp01(Math.max(this.state.curiosity, distinct / 12) + 0.02);
        break;
      }
      case 'lamp_toggled': {
        // Rapid toggling is a way of testing the room.
        const recent = this.telemetry.query({ type: 'lamp_toggled', since: e.timestampMs - 10_000 });
        if (recent.length >= 4) this.state.testing = clamp01(this.state.testing + 0.1);
        break;
      }
    }
  }

  /** Called with each attention sample (≈10 Hz). */
  sampleAttention(areaScores: Map<AreaId, number>, dtMs: number, lampOn: boolean, yawDelta: number, idle: boolean): void {
    this.activeMs += dtMs;
    if (idle) this.idleMs += dtMs;
    if (lampOn) this.lampOnMs += dtMs;
    this.turnAccum += yawDelta;
    let any = 0;
    for (const a of AREA_IDS) {
      const s = areaScores.get(a) ?? 0;
      any = Math.max(any, s);
      this.areaAttentionMs.set(a, (this.areaAttentionMs.get(a) ?? 0) + s * dtMs);
    }
    if (any > 0) this.attentionSampleMs += dtMs;
  }

  /**
   * Avoidance of an area requires real evidence: enough active play, enough
   * attention samples, and an attention share far below an even split. It
   * also counts declined opportunities (sounds from that area that the
   * player did not turn toward, doors they hesitated at but did not open).
   */
  avoidanceOf(area: AreaId): number {
    if (this.activeMs < AVOIDANCE_MIN_ACTIVE_MS || this.attentionSampleMs < AVOIDANCE_MIN_SAMPLES_MS) return 0;
    let total = 0;
    for (const v of this.areaAttentionMs.values()) total += v;
    if (total <= 0) return 0;
    const share = (this.areaAttentionMs.get(area) ?? 0) / total;
    const expected = 1 / AREA_IDS.length;
    const lowShare = 1 - smoothstep(0.1 * expected, 0.6 * expected, share);
    const declined = this.telemetry.query({ type: 'object_hesitated', meta: { outcome: 'abandoned' } }).filter(
      (e) => e.target && PLACEMENTS[e.target].area === area,
    ).length;
    const ignoredSounds = this.telemetry.query({ type: 'sound_reacted', meta: { reacted: false, area } }).length;
    const evidence = clamp01(lowShare * 0.75 + Math.min(0.25, (declined + ignoredSounds) * 0.06));
    return lowShare > 0 ? evidence : 0;
  }

  /** Periodic update (≈2 Hz). Decays transient values; recomputes derived scores. */
  update(dtMs: number): void {
    this.state.exposure = decay(this.state.exposure, dtMs, 60_000);
    this.state.tension = decay(this.state.tension, dtMs, 90_000);
    this.state.suspicion = decay(this.state.suspicion, dtMs, 240_000);
    this.state.testing = decay(this.state.testing, dtMs, 120_000);
    for (const [k, v] of this.interest) this.interest.set(k, decay(v, dtMs, 300_000));

    let maxAvoid = 0;
    for (const a of AREA_IDS) {
      const v = this.avoidanceOf(a);
      this.areaAvoidance.set(a, v);
      maxAvoid = Math.max(maxAvoid, v);
    }
    this.state.avoidance = maxAvoid;
    const acc = this.predictor.accuracy();
    const n = this.predictor.interactions;
    const repetition = this.recentTargets.length > 0 ? this.repeats / Math.max(8, this.recentTargets.length) : 0;
    this.state.predictability = clamp01((0.6 * acc + 0.4 * clamp01(repetition * 1.5)) * smoothstep(4, 20, n));
    let fatigue = 0;
    for (const v of this.anomalyExposure.values()) fatigue = Math.max(fatigue, v);
    this.state.fatigue = clamp01(fatigue / 6);
  }

  /** Director feedback: anomalies raise exposure and tension. */
  registerAnomaly(id: string, tension: number): void {
    this.anomalyExposure.set(id, (this.anomalyExposure.get(id) ?? 0) + 1);
    this.state.exposure = clamp01(this.state.exposure + 0.15 + tension * 0.3);
    this.state.tension = clamp01(this.state.tension + tension);
  }

  interestOf(id: ObjectId): number {
    return this.interest.get(id) ?? 0;
  }

  /** Normalized interest (share of total), 0..1. */
  interestShare(id: ObjectId): number {
    let total = 0;
    for (const v of this.interest.values()) total += v;
    return total > 0 ? (this.interest.get(id) ?? 0) / total : 0;
  }

  profile(candidates: ObjectId[] = []): BehavioralProfile {
    let mostInspected: ObjectId | null = null;
    let mostCount = 0;
    for (const p of Object.values(PLACEMENTS)) {
      const c = this.telemetry.count('object_inspected', p.id);
      if (c > mostCount) {
        mostCount = c;
        mostInspected = p.id;
      }
    }
    let least: AreaId | null = null;
    let leastV = Infinity;
    for (const a of AREA_IDS) {
      const v = this.areaAttentionMs.get(a) ?? 0;
      if (v < leastV) {
        leastV = v;
        least = a;
      }
    }
    const avgH = this.hesitations.length ? this.hesitations.reduce((a, b) => a + b, 0) / this.hesitations.length : 0;
    return {
      mostInspected,
      mostInspectedCount: mostCount,
      leastVisitedArea: this.activeMs > 30_000 ? least : null,
      lightPreference: this.activeMs > 0 ? this.lampOnMs / this.activeMs : 0,
      averageHesitationMs: avgH,
      explorationPath: [...this.explorationPath],
      anomalyInvestigation: this.witnessed > 0 ? this.investigated / this.witnessed : 0,
      repetition: this.recentTargets.length > 0 ? this.repeats / this.recentTargets.length : 0,
      turnBias: Math.max(-1, Math.min(1, this.turnAccum / 20)),
      stillness: this.activeMs > 0 ? this.idleMs / this.activeMs : 0,
      likelyNext: this.predictor.historicalNext(candidates),
    };
  }

  /** Continuous scores used to select which ending gateway opens. */
  endingAffinity(): EndingAffinity {
    const p = this.profile();
    const investigation = clamp01(this.investigated / 4) * 0.6 + clamp01(p.anomalyInvestigation) * 0.4;
    const doorAttempts = this.telemetry.count('door_handle_tried') + this.telemetry.count('door_opened');
    return {
      acknowledgment: clamp01(0.5 * investigation + 0.3 * this.state.curiosity + 0.2 * this.state.testing),
      refusal: clamp01(0.55 * this.state.avoidance + 0.3 * (1 - investigation) + 0.15 * clamp01(doorAttempts / 3)),
      reversal: clamp01(0.55 * this.state.predictability + 0.3 * clamp01(p.repetition * 2) + 0.15 * p.stillness),
    };
  }

  get activeTimeMs(): number {
    return this.activeMs;
  }

  get counts(): { witnessed: number; investigated: number } {
    return { witnessed: this.witnessed, investigated: this.investigated };
  }

  snapshot(): object {
    return {
      state: this.state,
      interest: [...this.interest],
      areaAttentionMs: [...this.areaAttentionMs],
      attentionSampleMs: this.attentionSampleMs,
      activeMs: this.activeMs,
      idleMs: this.idleMs,
      lampOnMs: this.lampOnMs,
      hesitations: this.hesitations,
      recentTargets: this.recentTargets,
      repeats: this.repeats,
      explorationPath: this.explorationPath,
      turnAccum: this.turnAccum,
      witnessed: this.witnessed,
      investigated: this.investigated,
      anomalyExposure: [...this.anomalyExposure],
      predictor: this.predictor.snapshot(),
    };
  }

  restore(snap: object): void {
    const o = snap as {
      state: ObserverState;
      interest: [ObjectId, number][];
      areaAttentionMs: [AreaId, number][];
      attentionSampleMs: number;
      activeMs: number;
      idleMs: number;
      lampOnMs: number;
      hesitations: number[];
      recentTargets: ObjectId[];
      repeats: number;
      explorationPath: AreaId[];
      turnAccum: number;
      witnessed: number;
      investigated: number;
      anomalyExposure: [string, number][];
      predictor: object;
    };
    this.state = { ...o.state };
    this.interest.clear();
    for (const [k, v] of o.interest) this.interest.set(k, v);
    this.areaAttentionMs.clear();
    for (const [k, v] of o.areaAttentionMs) this.areaAttentionMs.set(k, v);
    this.attentionSampleMs = o.attentionSampleMs;
    this.activeMs = o.activeMs;
    this.idleMs = o.idleMs;
    this.lampOnMs = o.lampOnMs;
    this.hesitations = [...o.hesitations];
    this.recentTargets = [...o.recentTargets];
    this.repeats = o.repeats;
    this.explorationPath = [...o.explorationPath];
    this.turnAccum = o.turnAccum;
    this.witnessed = o.witnessed;
    this.investigated = o.investigated;
    this.anomalyExposure.clear();
    for (const [k, v] of o.anomalyExposure) this.anomalyExposure.set(k, v);
    this.predictor.restore(o.predictor);
  }
}
