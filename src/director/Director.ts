import { Emitter } from '../core/emitter';
import type { ObjectId } from '../core/layout';
import type { Rng } from '../core/rng';
import type { Narrative } from '../narrative/Narrative';
import type { AppliedAnomaly, NarrativeContext } from '../narrative/types';
import type { Observer } from '../observer/Observer';
import type { Telemetry } from '../telemetry/Telemetry';
import { PLAYER_ACTIONS } from '../telemetry/Telemetry';
import type { CameraSample } from '../telemetry/types';
import type { ObjectState } from '../world/objects';
import type { WorldState } from '../world/WorldState';
import { ANOMALIES, ANOMALY_BY_ID } from './anomalies';
import { Executor, type RunningEvent } from './Executor';
import { createPhaseActor, phaseOf, type EndingId, type Phase, type PhaseActor, type PhaseMetrics } from './phaseMachine';
import type { AnomalyDef, AnomalyPlan, DirectorCtx, EffectSink, Significance, VisibilityOracle } from './types';

export interface CandidateReport {
  id: string;
  eligible: boolean;
  reason: string;
  weight: number;
}

export interface DecisionRecord {
  t: number;
  phase: Phase;
  anomalyId: string;
  result: 'scheduled' | 'done' | 'interrupted' | 'expired' | 'rejected' | 'quiet' | 'skipped';
  detail: string;
  evidence: number[];
}

export interface DirectorEvents {
  phase: { from: Phase; to: Phase; at: number };
  finished: { run: RunningEvent };
  gateways: { gateways: EndingId[] };
  decision: DecisionRecord;
  mutation: { run: RunningEvent; objectId: ObjectId; recordId: number | null };
}

export interface DirectorDeps {
  world: WorldState;
  telemetry: Telemetry;
  observer: Observer;
  narrative: Narrative;
  rng: Rng;
  vis: VisibilityOracle;
  sink: EffectSink;
  camera: () => CameraSample;
  settings: { suddenEvents: boolean; reducedMotion: boolean };
}

/** Pacing configuration; documented in docs/BEHAVIOR.md. */
export const PACING = {
  evalIntervalMs: 500,
  attemptIntervalMs: [5000, 11000] as [number, number],
  quietMs: {
    ambient: [8000, 15000],
    subtle: [20000, 40000],
    notable: [40000, 70000],
    major: [70000, 110000],
  } as Record<Significance, [number, number]>,
  /** Maximum Observer tension per phase; anomalies that would exceed it wait. */
  tensionCap: { normalcy: 0, inconsistency: 0.4, recognition: 0.6, anticipation: 0.8, confrontation: 1.2, resolution: 0 } as Record<Phase, number>,
  /** Probability the room deliberately does nothing at an attempt even when it could. */
  restraint: { normalcy: 1, inconsistency: 0.45, recognition: 0.35, anticipation: 0.3, confrontation: 0.2, resolution: 1 } as Record<Phase, number>,
  maxConcurrent: 2,
  allGatewaysAfterMs: 360_000,
};

/**
 * The Horror Director: selects, schedules and executes anomalies.
 *
 * Every candidate passes the same gates, in order: phase → repetition limit →
 * cooldowns → sudden-event setting → behavioral requirement → room-state
 * prerequisite → tension budget → plan construction → object claims →
 * visibility contract. The Observer cannot touch the scene; it only shapes
 * weights through the context the Director reads.
 */
export class Director {
  readonly emitter = new Emitter<DirectorEvents>();
  readonly executor: Executor;
  readonly actor: PhaseActor;
  readonly applied: AppliedAnomaly[] = [];
  readonly decisions: DecisionRecord[] = [];
  lastReport: CandidateReport[] = [];
  private history = new Map<string, { count: number; lastAt: number }>();
  private groupLast = new Map<string, number>();
  private followUps: { id: string; at: number; evidence: number[] }[] = [];
  private lastEval = -Infinity;
  private nextAttemptAt = 20_000;
  private quietUntil = 0;
  private currentPhase: Phase = 'normalcy';
  anticipationsExecuted = 0;
  confrontationEvents = 0;
  followerStage = 0;
  gateways: EndingId[] = [];
  private gatewayLeader: EndingId | null = null;
  readonly protectedObjects = new Map<ObjectId, number>();
  /** Snapshots stored with telemetry events (event id → capture). */
  readonly snapshots = new Map<number, { captureId: number; world: [ObjectId, ObjectState][] }>();
  pointerIdleMs = 0;
  playerIdleMs = 0;
  enabled = true;
  private now = 0;

  constructor(private readonly deps: DirectorDeps) {
    this.actor = createPhaseActor();
    this.executor = new Executor({
      onFinished: (run) => this.onFinished(run),
      onMutation: (run, objectId, recordId) => this.emitter.emit('mutation', { run, objectId, recordId }),
    });
    deps.world.emitter.on('claimPreempted', ({ objectId }) => this.executor.preempt(objectId, this.ctx()));
    this.actor.subscribe(() => {
      const p = phaseOf(this.actor);
      if (p !== this.currentPhase) {
        const from = this.currentPhase;
        this.currentPhase = p;
        // A phase change is itself a significant moment; let the room settle.
        this.quietUntil = Math.max(this.quietUntil, this.now + 12_000);
        this.emitter.emit('phase', { from, to: p, at: this.now });
      }
    });
  }

  get phase(): Phase {
    return this.currentPhase;
  }

  get ending(): EndingId | null {
    return this.actor.getSnapshot().context.ending;
  }

  phaseEnteredAt(p: Phase): number {
    return this.actor.getSnapshot().context.enteredAt[p] ?? 0;
  }

  historyOf(id: string): { count: number; lastAt: number } {
    return this.history.get(id) ?? { count: 0, lastAt: -Infinity };
  }

  ctx(): DirectorCtx {
    const d = this.deps;
    const self = this;
    const ctx: DirectorCtx = {
      now: this.now,
      phase: this.currentPhase,
      rng: d.rng,
      world: d.world,
      telemetry: d.telemetry,
      observer: d.observer,
      narrative: d.narrative,
      vis: d.vis,
      camera: d.camera,
      sink: d.sink,
      history: (id) => this.historyOf(id),
      groupLastAt: (g) => this.groupLast.get(g) ?? -Infinity,
      narrativeCtx: () => this.narrativeCtx(),
      get followerStage() {
        return self.followerStage;
      },
      setFollowerStage: (n) => {
        this.followerStage = Math.max(this.followerStage, n);
        d.sink.effect('follower_stage', { stage: this.followerStage });
      },
      settings: d.settings,
      protectedObjects: this.protectedObjects,
      prediction: d.observer.predictor.current,
      commit: d.observer.predictor.activeCommit,
      pointerIdleMs: this.pointerIdleMs,
      playerIdleMs: this.playerIdleMs,
      snapshots: this.snapshots,
    };
    return ctx;
  }

  narrativeCtx(): NarrativeContext {
    return {
      now: this.now,
      phase: this.currentPhase,
      telemetry: this.deps.telemetry,
      world: this.deps.world,
      observer: this.deps.observer,
      applied: this.applied,
      predictions: this.deps.observer.predictor.resolved,
    };
  }

  metrics(): PhaseMetrics {
    const t = this.deps.telemetry;
    const targets = new Set<string>();
    const areas = new Set<string>();
    for (const e of t.all()) {
      if (!PLAYER_ACTIONS.includes(e.type) || !e.target) continue;
      targets.add(e.target);
      if (e.area) areas.add(e.area);
    }
    return {
      now: this.now,
      interactions: t.interactionCount(),
      distinctObjects: targets.size,
      distinctAreas: areas.size,
      anomaliesApplied: this.applied.length,
      anomaliesWitnessed: t.count('anomaly_witnessed'),
      anomaliesInvestigated: t.count('anomaly_investigated'),
      messagesShown: this.deps.narrative.messagesShown,
      callbacksDelivered: this.deps.narrative.callbacksDelivered,
      anticipationsExecuted: this.anticipationsExecuted,
      followerStage: this.followerStage,
      confrontationEvents: this.confrontationEvents,
      predictorInteractions: this.deps.observer.predictor.interactions,
      familiarity: this.deps.observer.state.familiarity,
      tension: this.deps.observer.state.tension,
    };
  }

  /** Called every frame with the session time. */
  tick(now: number): void {
    this.now = now;
    if (!this.enabled) return;
    const ctx = this.ctx();
    this.executor.update(ctx);
    if (now - this.lastEval >= PACING.evalIntervalMs) {
      const dt = now - (Number.isFinite(this.lastEval) ? this.lastEval : now);
      this.lastEval = now;
      this.deps.observer.update(dt);
      this.evaluate(ctx);
    }
  }

  private evaluate(ctx: DirectorCtx): void {
    for (const [id, until] of this.protectedObjects) if (ctx.now > until) this.protectedObjects.delete(id);
    if (this.currentPhase === 'resolution') return;
    this.actor.send({ type: 'EVALUATE', metrics: this.metrics() });
    this.updateGateways(ctx);

    // Follow-ups scheduled by earlier anomalies.
    for (const f of [...this.followUps]) {
      if (ctx.now >= f.at) {
        this.followUps.splice(this.followUps.indexOf(f), 1);
        this.tryStart(ANOMALY_BY_ID[f.id], this.ctx(), 'follow-up');
      }
    }

    if (ctx.now < this.nextAttemptAt) return;
    this.nextAttemptAt = ctx.now + ctx.rng.range(...PACING.attemptIntervalMs);
    const report = this.candidates(this.ctx(), false);
    this.lastReport = report.map((r) => r.report);
    if (ctx.now < this.quietUntil) {
      this.log({ t: ctx.now, phase: this.currentPhase, anomalyId: '-', result: 'quiet', detail: 'settling after a significant event', evidence: [] });
      return;
    }
    if (this.executor.running.length >= PACING.maxConcurrent) return;
    const eligible = report.filter((r) => r.report.eligible);
    if (!eligible.length) return;
    // Restraint: the Observer is selective. Sometimes nothing happens on purpose.
    if (ctx.rng.chance(PACING.restraint[this.currentPhase])) {
      this.log({ t: ctx.now, phase: this.currentPhase, anomalyId: '-', result: 'skipped', detail: 'restraint', evidence: [] });
      return;
    }
    const idx = ctx.rng.weightedIndex(eligible.map((e) => e.report.weight));
    if (idx < 0) return;
    const pick = eligible[idx];
    this.launch(pick.def, pick.plan!, this.ctx(), 'weighted pick');
  }

  /** Prediction-driven responses; called when the predictor updates (≈10 Hz). */
  onPrediction(now: number): void {
    this.now = now;
    if (!this.enabled || this.currentPhase === 'resolution') return;
    const ctx = this.ctx();
    if (!ctx.commit || ctx.commit.response) return;
    if (this.executor.running.length >= PACING.maxConcurrent + 1) return;
    const cands = this.candidates(ctx, true).filter((c) => c.report.eligible);
    if (!cands.length) return;
    const idx = ctx.rng.weightedIndex(cands.map((c) => c.report.weight));
    if (idx >= 0) this.launch(cands[idx].def, cands[idx].plan!, ctx, `prediction ${ctx.commit.target} @${ctx.commit.confidence.toFixed(2)}`);
  }

  /** Evaluate every anomaly's gates. Exposed to the inspector and tests. */
  candidates(ctx: DirectorCtx, anticipation: boolean): { def: AnomalyDef; plan: AnomalyPlan | null; report: CandidateReport }[] {
    const out: { def: AnomalyDef; plan: AnomalyPlan | null; report: CandidateReport }[] = [];
    for (const def of ANOMALIES) {
      if (!!def.anticipation !== anticipation) continue;
      const verdict = this.gate(def, ctx);
      out.push({ def, plan: verdict.plan, report: { id: def.id, eligible: verdict.ok, reason: verdict.reason, weight: verdict.weight } });
    }
    return out;
  }

  private gate(def: AnomalyDef, ctx: DirectorCtx, ignoreRequirements = false): { ok: boolean; reason: string; weight: number; plan: AnomalyPlan | null } {
    const no = (reason: string) => ({ ok: false, reason, weight: 0, plan: null });
    if (!(def.phases as readonly Phase[]).includes(ctx.phase)) return no(`phase ${ctx.phase}`);
    const h = this.historyOf(def.id);
    if (h.count >= def.maxRepeats) return no('max repeats reached');
    if (ctx.now - h.lastAt < def.cooldownMs) return no('cooldown');
    for (const [g, ms] of Object.entries(def.minSinceGroups ?? {})) {
      if (ctx.now - (this.groupLast.get(g) ?? -Infinity) < (ms ?? 0)) return no(`recent ${g} event`);
    }
    if (def.sudden && !ctx.settings.suddenEvents) return no('sudden events disabled');
    if (this.executor.running.some((r) => r.def.id === def.id)) return no('already running');
    let evidence: number[] = [];
    if (def.requires && !ignoreRequirements) {
      const ev = def.requires(ctx);
      if (!ev) return no('behavioral requirement unmet');
      evidence = ev;
    }
    if (def.prerequisite && !def.prerequisite(ctx)) return no('room state prerequisite unmet');
    const cap = PACING.tensionCap[ctx.phase];
    if (ctx.observer.state.tension + def.tension > cap + 1e-9) return no('tension budget');
    const plan = def.plan(ctx, evidence);
    if (!plan) return no('no valid target');
    for (const t of plan.targets) {
      if (this.protectedObjects.has(t)) return no(`${t} is being tested`);
      if (this.executor.isBusy(t)) return no(`${t} busy`);
      const owner = ctx.world.claimOwner(t);
      if (owner) return no(`${t} claimed by ${owner}`);
    }
    // Weight: base × Observer affinity × novelty × fatigue.
    const exposure = ctx.observer.anomalyExposure.get(def.id) ?? 0;
    const novelty = 1 / (1 + exposure * 0.8);
    const fatigue = 1 - 0.5 * ctx.observer.state.fatigue;
    const affinity = def.affinity ? def.affinity(ctx) : 1;
    const weight = def.baseWeight * affinity * novelty * fatigue;
    return { ok: weight > 0, reason: 'eligible', weight, plan };
  }

  private launch(def: AnomalyDef, plan: AnomalyPlan, ctx: DirectorCtx, why: string): RunningEvent | null {
    const run = this.executor.start(def, plan, ctx);
    if (!run) {
      this.log({ t: ctx.now, phase: ctx.phase, anomalyId: def.id, result: 'rejected', detail: 'could not claim targets', evidence: plan.evidence });
      return null;
    }
    for (const id of plan.evidence) this.deps.telemetry.markUsed(id, `director:${def.id}`);
    this.log({ t: ctx.now, phase: ctx.phase, anomalyId: def.id, result: 'scheduled', detail: why, evidence: plan.evidence });
    if (def.anticipation) this.deps.observer.predictor.attachResponse(def.id);
    return run;
  }

  private tryStart(def: AnomalyDef | undefined, ctx: DirectorCtx, why: string, ignoreRequirements = false): RunningEvent | null {
    if (!def) return null;
    const g = this.gate(def, ctx, ignoreRequirements);
    if (!g.ok || !g.plan) {
      this.log({ t: ctx.now, phase: ctx.phase, anomalyId: def.id, result: 'rejected', detail: g.reason, evidence: [] });
      return null;
    }
    return this.launch(def, g.plan, ctx, why);
  }

  private onFinished(run: RunningEvent): void {
    const def = run.def;
    const now = this.now;
    const status = run.status as DecisionRecord['result'];
    this.log({ t: now, phase: this.currentPhase, anomalyId: def.id, result: status, detail: run.outcome ?? '', evidence: run.plan.evidence });
    // Expired events never happened; they do not count.
    if (run.status === 'expired' || (!run.changed && run.status === 'interrupted' && run.records.length === 0 && def.visibility.mode !== 'direct')) {
      this.emitter.emit('finished', { run });
      return;
    }
    const h = this.historyOf(def.id);
    this.history.set(def.id, { count: h.count + 1, lastAt: now });
    this.groupLast.set(def.group, now);
    this.applied.push({ anomalyId: def.id, targets: run.plan.targets, at: now, evidence: run.plan.evidence });
    if (this.applied.length > 200) this.applied.shift();
    this.deps.observer.registerAnomaly(def.id, def.tension);
    if (def.anticipation) this.anticipationsExecuted++;
    if (this.currentPhase === 'confrontation' && def.significance !== 'ambient') this.confrontationEvents++;
    if (def.significance !== 'ambient') {
      const [a, b] = PACING.quietMs[def.significance];
      this.quietUntil = Math.max(this.quietUntil, now + this.deps.rng.range(a, b));
    }
    for (const f of def.followUps ?? []) {
      if (this.deps.rng.chance(f.chance)) this.followUps.push({ id: f.id, at: now + this.deps.rng.range(...f.delayMs), evidence: run.plan.evidence });
    }
    this.emitter.emit('finished', { run });
  }

  private updateGateways(ctx: DirectorCtx): void {
    if (this.currentPhase !== 'confrontation') {
      if (this.gateways.length) this.setGateways([]);
      return;
    }
    const a = ctx.observer.endingAffinity();
    const ranked = (Object.entries(a) as [EndingId, number][]).sort((x, y) => y[1] - x[1]);
    let leader = ranked[0][0];
    // Hysteresis: keep the current leader unless another is clearly ahead.
    if (this.gatewayLeader && this.gatewayLeader !== leader && a[leader] - a[this.gatewayLeader] < 0.08) leader = this.gatewayLeader;
    this.gatewayLeader = leader;
    const inPhase = ctx.now - this.phaseEnteredAt('confrontation');
    let next: EndingId[] = this.confrontationEvents >= 2 ? (inPhase > PACING.allGatewaysAfterMs ? ['acknowledgment', 'refusal', 'reversal'] : [leader]) : [];
    if (this.testGateways) next = this.testGateways;
    if (next.join() !== this.gateways.join()) this.setGateways(next);
  }

  private setGateways(g: EndingId[]): void {
    this.gateways = g;
    this.actor.send({ type: 'GATEWAYS', gateways: g });
    this.emitter.emit('gateways', { gateways: g });
  }

  /** Attempt to begin an ending. Guarded by the phase machine. */
  beginEnding(ending: EndingId): boolean {
    this.actor.send({ type: 'BEGIN_ENDING', ending, metrics: this.metrics() });
    const ok = this.currentPhase === 'resolution' && this.ending === ending;
    if (ok) this.executor.cancelAll(this.ctx(), 'ending');
    return ok;
  }

  private log(d: DecisionRecord): void {
    this.decisions.push(d);
    if (this.decisions.length > 160) this.decisions.shift();
    this.emitter.emit('decision', d);
  }

  // ——— deterministic test / debug controls ———

  private testGateways: EndingId[] | null = null;

  /**
   * Test mode only: jump to confrontation with the given gateways open, as if
   * two confrontation events had already happened. The ending itself still
   * goes through the phase machine's BEGIN_ENDING guard.
   */
  testOpenGateways(endings: EndingId[]): void {
    if (this.currentPhase !== 'confrontation') this.forcePhase('confrontation');
    this.confrontationEvents = Math.max(this.confrontationEvents, 2);
    this.testGateways = endings;
    this.setGateways(endings);
  }

  forcePhase(phase: Exclude<Phase, 'resolution'>): void {
    this.actor.send({ type: 'FORCE', phase, now: this.now });
  }

  /**
   * Schedule a specific anomaly. Gates still apply (phase is ignored only when
   * `anyPhase`), so a forced event still cannot violate visibility contracts.
   */
  force(id: string, opts: { ignoreRequirements?: boolean; anyPhase?: boolean } = {}): { ok: boolean; reason: string } {
    const def = ANOMALY_BY_ID[id];
    if (!def) return { ok: false, reason: 'unknown anomaly' };
    const ctx = this.ctx();
    if (opts.anyPhase && !(def.phases as readonly Phase[]).includes(ctx.phase)) ctx.phase = def.phases[0];
    const g = this.gate(def, ctx, !!opts.ignoreRequirements);
    if (!g.ok || !g.plan) return { ok: false, reason: g.reason };
    this.launch(def, g.plan, ctx, 'forced');
    return { ok: true, reason: 'scheduled' };
  }

  setFollowerStage(n: number): void {
    this.ctx().setFollowerStage(n);
  }

  /** Clear transient scheduling (used after resume). */
  resetScheduling(now: number): void {
    this.nextAttemptAt = now + 8000;
    this.quietUntil = now + 8000;
  }

  snapshot(): object {
    const s = this.actor.getSnapshot();
    return {
      phase: this.currentPhase,
      enteredAt: s.context.enteredAt,
      history: [...this.history],
      groupLast: [...this.groupLast],
      applied: this.applied,
      anticipationsExecuted: this.anticipationsExecuted,
      confrontationEvents: this.confrontationEvents,
      followerStage: this.followerStage,
    };
  }

  restore(o: object, now: number): void {
    const s = o as {
      phase: Phase;
      enteredAt: Record<string, number>;
      history: [string, { count: number; lastAt: number }][];
      groupLast: [string, number][];
      applied: AppliedAnomaly[];
      anticipationsExecuted: number;
      confrontationEvents: number;
      followerStage: number;
    };
    this.now = now;
    if (s.phase !== 'resolution' && s.phase !== 'normalcy') this.forcePhase(s.phase);
    this.history = new Map(s.history);
    this.groupLast = new Map(s.groupLast);
    this.applied.splice(0, this.applied.length, ...s.applied);
    this.anticipationsExecuted = s.anticipationsExecuted;
    this.confrontationEvents = s.confrontationEvents;
    if (s.followerStage) this.setFollowerStage(s.followerStage);
    this.resetScheduling(now);
  }
}
