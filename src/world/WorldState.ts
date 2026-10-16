import { Emitter } from '../core/emitter';
import { CHAIR, SLOTS, type ObjectId } from '../core/layout';
import { collides } from './collision';
import { MUTABLE_DEFINITIONS, isValidState, type ObjectState } from './objects';

export type MutationSource = 'player' | 'director' | 'ending' | 'restore';

export interface MutationRecord {
  id: number;
  objectId: ObjectId;
  from: ObjectState;
  to: ObjectState;
  source: MutationSource;
  /** Anomaly id or interaction name that caused it. */
  cause: string;
  timestampMs: number;
  /** Telemetry event ids that justified the mutation, if any. */
  evidence: number[];
}

export interface ChangeEvent {
  objectId: ObjectId;
  state: ObjectState;
  previous: ObjectState;
  record: MutationRecord | null;
  /** Continuous updates (drag, creeping) are not history-worthy individually. */
  continuous: boolean;
}

export interface WorldEvents {
  changed: ChangeEvent;
  claimPreempted: { objectId: ObjectId; owner: string; by: string };
}

export type ApplyResult = { ok: true; record: MutationRecord | null } | { ok: false; reason: string };

export interface WorldSnapshot {
  objects: [ObjectId, ObjectState][];
  t: number;
}

const HISTORY_PER_OBJECT = 32;

/**
 * Environmental mutation engine state.
 *
 * - Every mutable object has an explicit set of valid states (objects.ts).
 * - Every change is recorded with its source and evidence, so it can be
 *   reversed, intensified or referenced later.
 * - Objects are claimed by a single owner while they are being changed. The
 *   player always wins a claim; a director anomaly can never steal an object
 *   from the player or from another anomaly. This is how conflicting state
 *   assignments are prevented.
 */
export class WorldState {
  readonly emitter = new Emitter<WorldEvents>();
  private objects = new Map<ObjectId, ObjectState>();
  private history = new Map<ObjectId, MutationRecord[]>();
  private log: MutationRecord[] = [];
  private claims = new Map<ObjectId, string>();
  private nextRecordId = 1;

  constructor(private readonly now: () => number) {
    this.reset();
  }

  reset(): void {
    this.objects.clear();
    this.history.clear();
    this.log = [];
    this.claims.clear();
    for (const def of Object.values(MUTABLE_DEFINITIONS)) {
      if (def) this.objects.set(def.id, structuredClone(def.initial));
    }
  }

  get(id: ObjectId): Readonly<ObjectState> {
    const s = this.objects.get(id);
    if (!s) throw new Error(`Object ${id} is not mutable`);
    return s;
  }

  has(id: ObjectId): boolean {
    return this.objects.has(id);
  }

  ids(): ObjectId[] {
    return [...this.objects.keys()];
  }

  /** Previous states of an object, most recent last. */
  historyOf(id: ObjectId): readonly MutationRecord[] {
    return this.history.get(id) ?? [];
  }

  mutationLog(): readonly MutationRecord[] {
    return this.log;
  }

  claimOwner(id: ObjectId): string | undefined {
    return this.claims.get(id);
  }

  /**
   * Claim an object. The player can preempt any non-player claim; anything
   * else fails if the object is already claimed by someone else.
   */
  claim(id: ObjectId, owner: string): boolean {
    const current = this.claims.get(id);
    if (current === owner) return true;
    if (current && owner !== 'player') return false;
    if (current && owner === 'player') this.emitter.emit('claimPreempted', { objectId: id, owner: current, by: owner });
    this.claims.set(id, owner);
    return true;
  }

  release(id: ObjectId, owner: string): void {
    if (this.claims.get(id) === owner) this.claims.delete(id);
  }

  releaseAll(owner: string): void {
    for (const [id, o] of [...this.claims]) if (o === owner) this.claims.delete(id);
  }

  /** Validate a candidate state without applying it. */
  validate(id: ObjectId, next: ObjectState): string | null {
    const def = MUTABLE_DEFINITIONS[id];
    if (!def) return `${id} is not mutable`;
    if (!isValidState(id, next.state)) return `${next.state} is not a valid state of ${id}`;
    if (def.ranges) {
      for (const [k, range] of Object.entries(def.ranges) as [keyof ObjectState, [number, number]][]) {
        const v = next[k];
        if (typeof v === 'number' && (v < range[0] - 1e-9 || v > range[1] + 1e-9)) return `${String(k)}=${v} out of range`;
      }
    }
    if (id === 'chair' && next.x !== undefined && next.z !== undefined) {
      if (collides({ x: next.x, z: next.z }, CHAIR.radius)) return 'chair position collides';
    }
    if (next.slot !== undefined) {
      if (!SLOTS.some((s) => s.id === next.slot)) return `unknown slot ${next.slot}`;
      const occupant = this.slotOccupant(next.slot);
      if (occupant && occupant !== id) return `slot ${next.slot} occupied by ${occupant}`;
    }
    return null;
  }

  slotOccupant(slot: string): ObjectId | undefined {
    for (const [id, s] of this.objects) if (s.slot === slot && s.state !== 'held') return id;
    return undefined;
  }

  freeSlots(surface?: string): string[] {
    return SLOTS.filter((s) => (!surface || s.surface === surface) && !this.slotOccupant(s.id)).map((s) => s.id);
  }

  /**
   * Apply a mutation. `owner` must hold the claim when one exists.
   * `continuous` updates (dragging, creeping) emit change events but are
   * coalesced into history only when `commit` is called.
   */
  apply(
    id: ObjectId,
    patch: Partial<ObjectState>,
    opts: { source: MutationSource; cause: string; owner?: string; evidence?: number[]; continuous?: boolean },
  ): ApplyResult {
    const current = this.objects.get(id);
    if (!current) return { ok: false, reason: `${id} is not mutable` };
    const owner = opts.owner ?? (opts.source === 'player' ? 'player' : opts.cause);
    const claimant = this.claims.get(id);
    if (claimant && claimant !== owner && opts.source !== 'restore') {
      return { ok: false, reason: `${id} is claimed by ${claimant}` };
    }
    const next: ObjectState = { ...current, ...patch };
    const err = this.validate(id, next);
    if (err) return { ok: false, reason: err };
    this.objects.set(id, next);
    let record: MutationRecord | null = null;
    if (!opts.continuous) {
      record = this.pushRecord(id, current, next, opts.source, opts.cause, opts.evidence ?? []);
    }
    this.emitter.emit('changed', { objectId: id, state: next, previous: current, record, continuous: !!opts.continuous });
    return { ok: true, record };
  }

  /** Commit a continuous change as one history record (e.g. after a drag). */
  commit(id: ObjectId, from: ObjectState, source: MutationSource, cause: string, evidence: number[] = []): MutationRecord {
    const to = this.get(id);
    return this.pushRecord(id, from, { ...to }, source, cause, evidence);
  }

  private pushRecord(
    id: ObjectId,
    from: ObjectState,
    to: ObjectState,
    source: MutationSource,
    cause: string,
    evidence: number[],
  ): MutationRecord {
    const record: MutationRecord = {
      id: this.nextRecordId++,
      objectId: id,
      from: structuredClone(from),
      to: structuredClone(to),
      source,
      cause,
      timestampMs: this.now(),
      evidence,
    };
    let h = this.history.get(id);
    if (!h) this.history.set(id, (h = []));
    h.push(record);
    if (h.length > HISTORY_PER_OBJECT) h.shift();
    this.log.push(record);
    if (this.log.length > 400) this.log.shift();
    return record;
  }

  /** Revert a director mutation if the object hasn't changed since. */
  revert(recordId: number, cause = 'revert'): ApplyResult {
    const rec = this.log.find((r) => r.id === recordId);
    if (!rec) return { ok: false, reason: 'unknown record' };
    const h = this.history.get(rec.objectId) ?? [];
    if (h[h.length - 1]?.id !== rec.id) return { ok: false, reason: 'object changed since' };
    return this.apply(rec.objectId, rec.from, { source: 'director', cause, owner: this.claims.get(rec.objectId) ?? cause });
  }

  /** Most recent state set by the player for an object (for callbacks / impossible drawer). */
  lastPlayerRecord(id: ObjectId): MutationRecord | undefined {
    const h = this.history.get(id) ?? [];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].source === 'player') return h[i];
    return undefined;
  }

  snapshot(): WorldSnapshot {
    return { objects: [...this.objects].map(([k, v]) => [k, structuredClone(v)]), t: this.now() };
  }

  restore(s: WorldSnapshot): void {
    for (const [id, state] of s.objects) {
      const prev = this.objects.get(id) ?? state;
      this.objects.set(id, structuredClone(state));
      this.emitter.emit('changed', { objectId: id, state: this.objects.get(id)!, previous: prev, record: null, continuous: false });
    }
  }

  /** Lightweight room context used by telemetry events. */
  context(): { lampOn: boolean; doorOpen: boolean; drawerOpen: boolean; curtainsOpen: boolean; chairState: string; photoVariant: string } {
    return {
      lampOn: !!this.get('lamp').on,
      doorOpen: (this.get('door').open ?? 0) > 0.3,
      drawerOpen: (this.get('drawer_top').open ?? 0) > 0.3 || (this.get('drawer_bottom').open ?? 0) > 0.3,
      curtainsOpen: (this.get('curtains').open ?? 1) > 0.5,
      chairState: this.get('chair').state,
      photoVariant: this.get('photograph').state,
    };
  }
}
