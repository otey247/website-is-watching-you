import { Emitter } from '../core/emitter';
import type { ObjectId } from '../core/layout';
import type { ActionType, BehavioralEvent, CameraSample, EventInput, RoomContext } from './types';

export interface TelemetryEvents {
  recorded: BehavioralEvent;
}

const DEFAULT_CAMERA: CameraSample = { position: [0, 1.6, 0], yaw: 0, pitch: 0 };
const DEFAULT_CONTEXT: RoomContext = {
  lampOn: false,
  doorOpen: false,
  drawerOpen: false,
  curtainsOpen: true,
  chairState: 'original',
  photoVariant: 'original',
  phase: 'normalcy',
};

export interface TelemetrySnapshot {
  nextId: number;
  events: BehavioralEvent[];
  counters: [string, number][];
}

/**
 * Behavioral telemetry: a bounded, timestamped, in-memory log of in-game actions.
 *
 * - Bounded: old events are evicted beyond `capacity`; per-type/target counters
 *   persist so the Observer keeps long-run frequencies after eviction.
 * - Local: nothing here leaves the tab. Persistence only happens when the player
 *   explicitly chooses to save.
 */
export class Telemetry {
  readonly emitter = new Emitter<TelemetryEvents>();
  private events: BehavioralEvent[] = [];
  private nextId = 1;
  private counters = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly sampleCamera: () => CameraSample = () => DEFAULT_CAMERA,
    private readonly sampleContext: () => RoomContext = () => DEFAULT_CONTEXT,
    readonly capacity = 600,
  ) {}

  record(input: EventInput): BehavioralEvent {
    const event: BehavioralEvent = {
      id: this.nextId++,
      type: input.type,
      target: input.target,
      area: input.area,
      timestampMs: this.now(),
      durationMs: input.durationMs,
      camera: input.camera ?? this.sampleCamera(),
      context: { ...this.sampleContext(), ...input.context },
      meta: { ...input.meta },
      usedBy: [],
      used: false,
      snapshotId: input.snapshotId,
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.bump(event.type);
    if (event.target) this.bump(`${event.type}:${event.target}`);
    if (event.area) this.bump(`${event.type}@${event.area}`);
    this.emitter.emit('recorded', event);
    return event;
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Lifetime count (survives eviction). */
  count(type: ActionType, target?: ObjectId): number {
    return this.counters.get(target ? `${type}:${target}` : type) ?? 0;
  }

  countInArea(type: ActionType, area: string): number {
    return this.counters.get(`${type}@${area}`) ?? 0;
  }

  all(): readonly BehavioralEvent[] {
    return this.events;
  }

  get(id: number): BehavioralEvent | undefined {
    // Events are ordered by id; binary search.
    let lo = 0;
    let hi = this.events.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.events[mid];
      if (e.id === id) return e;
      if (e.id < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  query(filter: {
    type?: ActionType | ActionType[];
    target?: ObjectId;
    since?: number;
    before?: number;
    unusedBy?: string;
    meta?: Record<string, string | number | boolean>;
  }): BehavioralEvent[] {
    const types = filter.type === undefined ? null : Array.isArray(filter.type) ? filter.type : [filter.type];
    return this.events.filter((e) => {
      if (types && !types.includes(e.type)) return false;
      if (filter.target && e.target !== filter.target) return false;
      if (filter.since !== undefined && e.timestampMs < filter.since) return false;
      if (filter.before !== undefined && e.timestampMs >= filter.before) return false;
      if (filter.unusedBy && e.usedBy.includes(filter.unusedBy)) return false;
      if (filter.meta) {
        for (const [k, v] of Object.entries(filter.meta)) if (e.meta[k] !== v) return false;
      }
      return true;
    });
  }

  last(type?: ActionType | ActionType[], target?: ObjectId): BehavioralEvent | undefined {
    const types = type === undefined ? null : Array.isArray(type) ? type : [type];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (types && !types.includes(e.type)) continue;
      if (target && e.target !== target) continue;
      return e;
    }
    return undefined;
  }

  /** Mark that a system consumed an event (director anomaly, narrative template). */
  markUsed(id: number, by: string): void {
    const e = this.get(id);
    if (!e) return;
    if (!e.usedBy.includes(by)) e.usedBy.push(by);
    e.used = true;
  }

  /** Interactions are deliberate player actions (not derived/observer events). */
  interactionCount(): number {
    let n = 0;
    for (const t of PLAYER_ACTIONS) n += this.count(t);
    return n;
  }

  snapshot(): TelemetrySnapshot {
    return { nextId: this.nextId, events: structuredClone(this.events), counters: [...this.counters] };
  }

  restore(s: TelemetrySnapshot): void {
    this.nextId = s.nextId;
    this.events = structuredClone(s.events);
    this.counters = new Map(s.counters);
  }

  reset(): void {
    this.events = [];
    this.nextId = 1;
    this.counters.clear();
  }
}

/** Actions the player deliberately performs, as opposed to derived signals. */
export const PLAYER_ACTIONS: ActionType[] = [
  'object_inspected',
  'object_picked_up',
  'object_placed',
  'drawer_opened',
  'drawer_closed',
  'lamp_toggled',
  'curtains_toggled',
  'chair_moved',
  'door_opened',
  'door_closed',
  'door_handle_tried',
  'computer_note_opened',
  'computer_answered',
];
