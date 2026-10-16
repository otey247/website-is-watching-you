import { clamp01, smoothstep } from '../core/math';
import type { ObjectId } from '../core/layout';

export const FEATURES = ['direction', 'proximity', 'centrality', 'dwell', 'transition', 'frequency'] as const;
export type FeatureName = (typeof FEATURES)[number];
export type FeatureVector = Record<FeatureName, number>;

export interface PredictionCandidate {
  id: ObjectId;
  /** Projected NDC position, or null when the object is off-screen. */
  ndc: { x: number; y: number } | null;
  centerAngle: number;
  /** Recent attention-weighted dwell (ms). */
  dwellMs: number;
}

export interface PredictorInput {
  pointer: { x: number; y: number } | null;
  /** Pointer velocity in NDC units per second. */
  pointerVelocity: { x: number; y: number };
  candidates: PredictionCandidate[];
  now: number;
}

export interface Prediction {
  target: ObjectId | null;
  confidence: number;
  /** Full distribution, sorted by probability. */
  ranked: { id: ObjectId; p: number }[];
  features: Map<ObjectId, FeatureVector>;
  t: number;
}

export interface PredictionCommit {
  target: ObjectId;
  confidence: number;
  t: number;
  /** Anticipation response the director attached to this prediction, if any. */
  response?: string;
}

export interface ResolvedPrediction extends PredictionCommit {
  outcome: 'hit' | 'miss' | 'expired';
  actual: ObjectId | null;
  resolvedAt: number;
}

const NONE_LOGIT = 1.2;
const COMMIT_THRESHOLD = 0.5;
const COMMIT_TTL_MS = 4500;

/**
 * Lightweight next-interaction predictor.
 *
 * A softmax over interactable targets (plus a "no interaction" option) using
 * hand-picked features. Weights adapt online with a cross-entropy gradient
 * step each time the player actually interacts, so the Observer is visibly
 * imperfect early on and improves with evidence. Predictions never override
 * player input; they only feed the Director.
 */
export class Predictor {
  weights: FeatureVector = { direction: 2.2, proximity: 2.6, centrality: 0.6, dwell: 0.8, transition: 1.4, frequency: 0.6 };
  private transitions = new Map<string, Map<ObjectId, number>>();
  private frequency = new Map<ObjectId, number>();
  private totalInteractions = 0;
  private lastTarget: ObjectId | null = null;
  private lastPrediction: Prediction | null = null;
  private commit: PredictionCommit | null = null;
  readonly resolved: ResolvedPrediction[] = [];
  /** Per-target confidence threshold offsets learned from misses. */
  private thresholdBias = new Map<ObjectId, number>();
  learningRate = 0.08;

  get interactions(): number {
    return this.totalInteractions;
  }

  get current(): Prediction | null {
    return this.lastPrediction;
  }

  get activeCommit(): PredictionCommit | null {
    return this.commit;
  }

  thresholdFor(id: ObjectId): number {
    return COMMIT_THRESHOLD + (this.thresholdBias.get(id) ?? 0);
  }

  transitionProbability(from: ObjectId | null, to: ObjectId, nTargets: number): number {
    if (!from) return 1 / nTargets;
    const row = this.transitions.get(from);
    const count = row?.get(to) ?? 0;
    let total = 0;
    if (row) for (const v of row.values()) total += v;
    return (count + 0.5) / (total + 0.5 * nTargets);
  }

  features(c: PredictionCandidate, input: PredictorInput, nTargets: number): FeatureVector {
    let direction = 0;
    let proximity = 0;
    if (input.pointer && c.ndc) {
      const dx = c.ndc.x - input.pointer.x;
      const dy = c.ndc.y - input.pointer.y;
      const d = Math.hypot(dx, dy);
      proximity = 1 - smoothstep(0.03, 0.7, d);
      const speed = Math.hypot(input.pointerVelocity.x, input.pointerVelocity.y);
      if (speed > 0.05 && d > 1e-3) {
        const cos = (dx * input.pointerVelocity.x + dy * input.pointerVelocity.y) / (d * speed);
        direction = Math.max(0, cos) * smoothstep(0.05, 0.8, speed) * (1 - smoothstep(0.4, 1.4, d));
      }
    }
    const centrality = c.ndc ? 1 - smoothstep(0.05, 0.9, c.centerAngle) : 0;
    const dwell = smoothstep(0, 2500, c.dwellMs);
    const transition = clamp01(this.transitionProbability(this.lastTarget, c.id, nTargets) * 3);
    const frequency = this.totalInteractions > 0 ? clamp01(((this.frequency.get(c.id) ?? 0) / this.totalInteractions) * 3) : 0;
    return { direction, proximity, centrality, dwell, transition, frequency };
  }

  predict(input: PredictorInput): Prediction {
    const n = Math.max(1, input.candidates.length);
    const feats = new Map<ObjectId, FeatureVector>();
    const logits: number[] = [];
    for (const c of input.candidates) {
      const f = this.features(c, input, n);
      feats.set(c.id, f);
      let z = 0;
      for (const k of FEATURES) z += this.weights[k] * f[k];
      logits.push(z);
    }
    const maxZ = Math.max(NONE_LOGIT, ...logits);
    const exps = logits.map((z) => Math.exp(z - maxZ));
    const noneExp = Math.exp(NONE_LOGIT - maxZ);
    const sum = exps.reduce((a, b) => a + b, noneExp);
    const ranked = input.candidates.map((c, i) => ({ id: c.id, p: exps[i] / sum })).sort((a, b) => b.p - a.p);
    const top = ranked[0];
    const prediction: Prediction = {
      target: top ? top.id : null,
      confidence: top ? top.p : 0,
      ranked,
      features: feats,
      t: input.now,
    };
    this.lastPrediction = prediction;
    this.expire(input.now);
    if (!this.commit && top && top.p >= this.thresholdFor(top.id)) {
      this.commit = { target: top.id, confidence: top.p, t: input.now };
    }
    return prediction;
  }

  /** The director attaches the anticipation response it executed to the active commit. */
  attachResponse(response: string): void {
    if (this.commit) this.commit.response = response;
  }

  private expire(now: number): void {
    if (this.commit && now - this.commit.t > COMMIT_TTL_MS) {
      this.resolveCommit(null, now, 'expired');
    }
  }

  private resolveCommit(actual: ObjectId | null, now: number, outcome: ResolvedPrediction['outcome']): ResolvedPrediction {
    const c = this.commit!;
    const r: ResolvedPrediction = { ...c, outcome, actual, resolvedAt: now };
    this.resolved.push(r);
    if (this.resolved.length > 60) this.resolved.shift();
    if (outcome !== 'hit') {
      // A wrong guess makes the Observer more cautious about this target.
      this.thresholdBias.set(c.target, Math.min(0.3, (this.thresholdBias.get(c.target) ?? 0) + 0.06));
    } else {
      this.thresholdBias.set(c.target, Math.max(-0.12, (this.thresholdBias.get(c.target) ?? 0) - 0.03));
    }
    this.commit = null;
    return r;
  }

  /**
   * Observe an actual interaction: resolve any pending commit, update the
   * transition model and take one online learning step.
   */
  observe(target: ObjectId, now: number): ResolvedPrediction | null {
    let resolved: ResolvedPrediction | null = null;
    if (this.commit) resolved = this.resolveCommit(target, now, this.commit.target === target ? 'hit' : 'miss');

    const p = this.lastPrediction;
    if (p && now - p.t < 2000 && p.features.has(target)) {
      const probs = new Map(p.ranked.map((r) => [r.id, r.p]));
      for (const k of FEATURES) {
        let grad = 0;
        for (const [id, f] of p.features) grad += ((id === target ? 1 : 0) - (probs.get(id) ?? 0)) * f[k];
        this.weights[k] = Math.max(0, Math.min(6, this.weights[k] + this.learningRate * grad));
      }
    }

    if (this.lastTarget) {
      let row = this.transitions.get(this.lastTarget);
      if (!row) this.transitions.set(this.lastTarget, (row = new Map()));
      row.set(target, (row.get(target) ?? 0) + 1);
    }
    this.frequency.set(target, (this.frequency.get(target) ?? 0) + 1);
    this.totalInteractions++;
    this.lastTarget = target;
    return resolved;
  }

  /** Hit rate over recent resolved predictions (0.5 prior with few samples). */
  accuracy(window = 12): number {
    const recent = this.resolved.slice(-window);
    if (recent.length === 0) return 0.5;
    const hits = recent.filter((r) => r.outcome === 'hit').length;
    return (hits + 1) / (recent.length + 2);
  }

  /** Most likely next interaction from history alone (no pointer information). */
  historicalNext(candidates: ObjectId[]): { id: ObjectId; p: number } | null {
    if (candidates.length === 0) return null;
    let best: { id: ObjectId; p: number } | null = null;
    for (const id of candidates) {
      const p = this.transitionProbability(this.lastTarget, id, candidates.length);
      if (!best || p > best.p) best = { id, p };
    }
    return best;
  }

  snapshot(): object {
    return {
      weights: this.weights,
      transitions: [...this.transitions].map(([k, v]) => [k, [...v]]),
      frequency: [...this.frequency],
      totalInteractions: this.totalInteractions,
      lastTarget: this.lastTarget,
      thresholdBias: [...this.thresholdBias],
      resolved: this.resolved,
    };
  }

  restore(s: ReturnType<Predictor['snapshot']>): void {
    const o = s as {
      weights: FeatureVector;
      transitions: [string, [ObjectId, number][]][];
      frequency: [ObjectId, number][];
      totalInteractions: number;
      lastTarget: ObjectId | null;
      thresholdBias: [ObjectId, number][];
      resolved: ResolvedPrediction[];
    };
    this.weights = { ...o.weights };
    this.transitions = new Map(o.transitions.map(([k, v]) => [k, new Map(v)]));
    this.frequency = new Map(o.frequency);
    this.totalInteractions = o.totalInteractions;
    this.lastTarget = o.lastTarget;
    this.thresholdBias = new Map(o.thresholdBias);
    this.resolved.splice(0, this.resolved.length, ...o.resolved);
    this.commit = null;
  }
}
