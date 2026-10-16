import { CHAIR, type ObjectId } from '../core/layout';
import { easeInOutCubic } from '../core/math';
import { sweep } from '../world/collision';
import type { ObjectState } from '../world/objects';
import type { AnomalyDef, AnomalyPlan, DirectorCtx, NumericKey, Step, VisibilityContract } from './types';

export type RunStatus = 'waiting' | 'running' | 'done' | 'interrupted' | 'expired' | 'rejected';

export interface RunningEvent {
  runId: number;
  def: AnomalyDef;
  plan: AnomalyPlan;
  owner: string;
  status: RunStatus;
  stepIndex: number;
  startedAt: number;
  scheduledAt: number;
  stepStartedAt: number;
  /** Starting values of the animate step in progress. */
  animFrom: Partial<Record<NumericKey, number>> | null;
  /** Full object state when the current animate step began. */
  animStartState: ObjectState | null;
  /** States of each target when the event began (for revert/commit). */
  initialStates: Map<ObjectId, ObjectState>;
  /** Whether anything visible has changed yet. */
  changed: boolean;
  /** Uncommitted continuous changes in the current animate step. */
  animChanged: boolean;
  outcome?: string;
  /** Mutation record ids produced (for witness tracking and reversal). */
  records: number[];
}

export interface ExecutorHooks {
  onFinished(run: RunningEvent): void;
  onMutation(run: RunningEvent, objectId: ObjectId, recordId: number | null): void;
}

/**
 * Executes anomaly plans step by step, enforcing each anomaly's visibility
 * contract on every frame. This is the only path by which the Director can
 * change the room.
 */
export class Executor {
  readonly running: RunningEvent[] = [];
  private nextRunId = 1;

  constructor(private readonly hooks: ExecutorHooks) {}

  isBusy(objectId: ObjectId): boolean {
    return this.running.some((r) => r.plan.targets.includes(objectId));
  }

  /** Try to start a plan: claims all targets atomically or rejects. */
  start(def: AnomalyDef, plan: AnomalyPlan, ctx: DirectorCtx): RunningEvent | null {
    const owner = `anomaly:${def.id}#${this.nextRunId}`;
    const claimed: ObjectId[] = [];
    for (const t of plan.targets) {
      if (!ctx.world.has(t)) continue;
      if (!ctx.world.claim(t, owner)) {
        for (const c of claimed) ctx.world.release(c, owner);
        return null;
      }
      claimed.push(t);
    }
    const run: RunningEvent = {
      runId: this.nextRunId++,
      def,
      plan,
      owner,
      status: 'waiting',
      stepIndex: 0,
      startedAt: ctx.now,
      scheduledAt: ctx.now,
      stepStartedAt: ctx.now,
      animFrom: null,
      animStartState: null,
      initialStates: new Map(claimed.map((t) => [t, structuredClone(ctx.world.get(t)) as ObjectState])),
      changed: false,
      animChanged: false,
      records: [],
    };
    this.running.push(run);
    return run;
  }

  /** Whether a step touching `objectId` is permitted right now under `contract`. */
  static permitted(contract: VisibilityContract, objectId: ObjectId, ctx: DirectorCtx, starting: boolean): boolean {
    if (contract.mode === 'direct') return true;
    const vis = ctx.vis.visibility(objectId);
    if (contract.mode === 'unseen') {
      if (!ctx.vis.isUnseen(objectId)) return false;
      return !starting || ctx.vis.unseenForMs(objectId, ctx.now) >= contract.minUnseenMs;
    }
    // peripheral: anything but direct attention (and not via the mirror while attended)
    return vis !== 'attended';
  }

  /** Called when the player takes an object an event is changing. */
  preempt(objectId: ObjectId, ctx: DirectorCtx): void {
    for (const r of this.running) {
      if (r.plan.targets.includes(objectId) && (r.status === 'running' || r.status === 'waiting')) {
        this.finish(r, 'interrupted', 'player took the object', ctx);
      }
    }
  }

  cancelAll(ctx: DirectorCtx, reason: string): void {
    for (const r of [...this.running]) this.finish(r, 'interrupted', reason, ctx);
  }

  update(ctx: DirectorCtx): void {
    for (const r of [...this.running]) this.advance(r, ctx);
  }

  private advance(r: RunningEvent, ctx: DirectorCtx): void {
    // Run as many instantaneous steps as possible this frame.
    for (let guard = 0; guard < 16; guard++) {
      if (r.status === 'done' || r.status === 'interrupted' || r.status === 'expired') return;
      const step = r.plan.steps[r.stepIndex];
      if (!step) {
        this.finish(r, 'done', 'completed', ctx);
        return;
      }
      const touches = stepObject(step);
      if (r.status === 'waiting') {
        if (touches && !Executor.permitted(r.def.visibility, touches, ctx, true)) {
          if (ctx.now - r.scheduledAt > r.def.visibility.waitMs) this.finish(r, 'expired', 'contract never satisfied', ctx);
          return;
        }
        r.status = 'running';
        r.stepStartedAt = ctx.now;
      }
      const done = this.runStep(r, step, ctx);
      if (!done) return;
      r.stepIndex++;
      r.stepStartedAt = ctx.now;
      r.animFrom = null;
      // The next object step must satisfy the contract again before it starts.
      const next = r.plan.steps[r.stepIndex];
      if (next && stepObject(next) && r.def.visibility.mode !== 'direct') {
        r.status = 'waiting';
        r.scheduledAt = ctx.now;
      }
    }
  }

  /** Returns true when the step has completed. */
  private runStep(r: RunningEvent, step: Step, ctx: DirectorCtx): boolean {
    switch (step.op) {
      case 'set': {
        const res = ctx.world.apply(step.object, step.patch, { source: 'director', cause: r.def.id, owner: r.owner, evidence: r.plan.evidence });
        if (!res.ok) {
          this.finish(r, 'interrupted', `rejected: ${res.reason}`, ctx);
          return false;
        }
        r.changed = true;
        r.records.push(res.record!.id);
        this.hooks.onMutation(r, step.object, res.record!.id);
        return true;
      }
      case 'animate':
        return this.animate(r, step, ctx);
      case 'sound':
        ctx.sink.sound(step.sound, step.at, { gain: step.gain, rate: step.rate });
        return true;
      case 'effect':
        ctx.sink.effect(step.name, step.params ?? {});
        return true;
      case 'message':
        ctx.narrative.deliver(
          { templateId: step.templateId, intent: step.intent, text: step.text, refs: step.refs, facts: step.facts },
          ctx.now,
          step.callback,
        );
        ctx.world.apply('computer', { state: 'message' }, { source: 'director', cause: r.def.id, owner: r.owner });
        this.hooks.onMutation(r, 'computer', null);
        return true;
      case 'wait':
        return ctx.now - r.stepStartedAt >= step.ms;
      case 'until':
        return step.cond(ctx) || ctx.now - r.stepStartedAt >= step.timeoutMs;
      case 'call':
        step.fn(ctx);
        return true;
    }
  }

  private animate(r: RunningEvent, step: Extract<Step, { op: 'animate' }>, ctx: DirectorCtx): boolean {
    const obj = step.object;
    const contract = r.def.visibility;
    if (!r.animFrom) {
      const s = ctx.world.get(obj);
      r.animStartState = structuredClone(s) as ObjectState;
      r.animFrom = {};
      for (const k of Object.keys(step.to) as NumericKey[]) r.animFrom[k] = (s[k] as number | undefined) ?? 0;
    }
    // Visibility enforcement on every frame.
    if (!Executor.permitted(contract, obj, ctx, false)) {
      if (contract.interruption === 'continue') {
        // allowed to keep moving in view
      } else if (contract.interruption === 'revert' && !r.changed) {
        this.finish(r, 'interrupted', 'seen before any change', ctx);
        return false;
      } else {
        // freeze: stop exactly where it is, commit the partial change, no snap.
        this.commitPartial(r, obj, ctx);
        this.finish(r, 'interrupted', 'seen while moving; froze in place', ctx);
        return false;
      }
    }
    const tRaw = Math.min(1, (ctx.now - r.stepStartedAt) / Math.max(1, step.durationMs));
    const t = step.ease === 'linear' ? tRaw : easeInOutCubic(tRaw);
    const patch: Partial<ObjectState> = {};
    for (const k of Object.keys(step.to) as NumericKey[]) {
      const from = r.animFrom[k] ?? 0;
      patch[k] = from + ((step.to[k] as number) - from) * t;
    }
    if (step.sweep && obj === 'chair' && patch.x !== undefined && patch.z !== undefined) {
      const cur = ctx.world.get('chair');
      const p = sweep({ x: cur.x!, z: cur.z! }, { x: patch.x, z: patch.z }, CHAIR.radius);
      patch.x = p.x;
      patch.z = p.z;
    }
    if (tRaw >= 1 && step.state) patch.state = step.state;
    const res = ctx.world.apply(obj, patch, { source: 'director', cause: r.def.id, owner: r.owner, continuous: true });
    if (!res.ok) {
      this.commitPartial(r, obj, ctx);
      this.finish(r, 'interrupted', `animation blocked: ${res.reason}`, ctx);
      return false;
    }
    r.changed = true;
    r.animChanged = true;
    if (tRaw >= 1) {
      // One history record spanning the whole animation.
      const rec = ctx.world.commit(obj, r.animStartState!, 'director', r.def.id, r.plan.evidence);
      r.animChanged = false;
      r.records.push(rec.id);
      this.hooks.onMutation(r, obj, rec.id);
      return true;
    }
    return false;
  }

  private commitPartial(r: RunningEvent, obj: ObjectId, ctx: DirectorCtx): void {
    if (!r.animChanged || !r.animStartState) return;
    const rec = ctx.world.commit(obj, r.animStartState, 'director', `${r.def.id}:partial`, r.plan.evidence);
    r.animChanged = false;
    r.records.push(rec.id);
    this.hooks.onMutation(r, obj, rec.id);
  }

  private finish(r: RunningEvent, status: RunStatus, outcome: string, ctx: DirectorCtx): void {
    if (r.status === 'done' || r.status === 'interrupted' || r.status === 'expired') return;
    const step = r.plan.steps[r.stepIndex];
    if (step?.op === 'animate') this.commitPartial(r, step.object, ctx);
    r.status = status;
    r.outcome = outcome;
    ctx.world.releaseAll(r.owner);
    const i = this.running.indexOf(r);
    if (i >= 0) this.running.splice(i, 1);
    this.hooks.onFinished(r);
  }
}

function stepObject(step: Step): ObjectId | null {
  if (step.op === 'set' || step.op === 'animate') return step.object;
  if (step.op === 'message') return 'computer';
  return null;
}
