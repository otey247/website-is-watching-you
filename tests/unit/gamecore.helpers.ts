import { AREA_IDS, PLACEMENTS, type AreaId, type ObjectId } from '../../src/core/layout';
import { GameCore } from '../../src/game/GameCore';
import type { ActionType, MetaValue } from '../../src/telemetry/types';
import { FakeOracle, HOME_CAMERA, pointerOn } from './helpers';

export function makeCore(seed = 1) {
  const vis = new FakeOracle();
  let captures = 0;
  const core = new GameCore(seed, { vis, camera: () => HOME_CAMERA, capture: () => ++captures });
  return { core, vis };
}

export type Core = ReturnType<typeof makeCore>;

export const areaScores = (m: Partial<Record<AreaId, number>>) => new Map(AREA_IDS.map((a) => [a, m[a] ?? 0] as [AreaId, number]));

/** One deliberate in-room action, applied to the world the way the interaction layer would. */
export function act(c: Core, type: ActionType, target: ObjectId, opts: { durationMs?: number; meta?: Record<string, MetaValue> } = {}): void {
  const { core } = c;
  const w = core.world;
  core.pointerMoved();
  if (w.has(target)) core.grab(target);
  if (type === 'lamp_toggled') w.apply('lamp', opts.meta?.on ? { state: 'on', on: true } : { state: 'off', on: false }, { source: 'player', cause: type });
  if (type === 'drawer_opened') w.apply(target, { state: 'open', open: 1 }, { source: 'player', cause: type });
  if (type === 'drawer_closed') w.apply(target, { state: 'closed', open: 0 }, { source: 'player', cause: type });
  if (type === 'curtains_toggled') w.apply('curtains', opts.meta?.open ? { state: 'open', open: 1 } : { state: 'closed', open: 0 }, { source: 'player', cause: type });
  if (type === 'chair_moved') w.apply('chair', { state: 'player_moved', x: -0.3, z: 0.2 }, { source: 'player', cause: type });
  core.report(type, target, opts);
  if (w.has(target)) core.release(target);
}

/** An ordinary, curious player: a varied loop of interactions across the room. */
export const CURIOUS: [ActionType, ObjectId, { durationMs?: number; meta?: Record<string, MetaValue> }?][] = [
  ['object_inspected', 'photograph', { durationMs: 6000 }],
  ['drawer_opened', 'drawer_top'],
  ['drawer_closed', 'drawer_top'],
  ['lamp_toggled', 'lamp', { meta: { on: true } }],
  ['object_inspected', 'clock', { durationMs: 5500 }],
  ['door_handle_tried', 'door'],
  ['object_inspected', 'computer', { durationMs: 2000 }],
  ['chair_moved', 'chair'],
  ['lamp_toggled', 'lamp', { meta: { on: false } }],
  ['curtains_toggled', 'curtains', { meta: { open: false } }],
  ['object_inspected', 'mirror', { durationMs: 3000 }],
  ['object_picked_up', 'figurine'],
  ['object_placed', 'figurine', { meta: { slot: 's4_a' } }],
  ['curtains_toggled', 'curtains', { meta: { open: true } }],
  ['object_inspected', 'photograph', { durationMs: 4000 }],
  ['object_inspected', 'note', { durationMs: 2500 }],
];

export interface DriveOpts {
  /** Actions performed in order, one every `actionEveryMs`. */
  script?: typeof CURIOUS;
  actionEveryMs?: number;
  scores?: Map<AreaId, number>;
  /** Pointer resting on this object for predictions (null: no pointer). */
  pointerTarget?: ObjectId | null;
  /** Called every 100 ms step. */
  each?: (c: Core) => void;
  until?: (c: Core) => boolean;
  moving?: boolean;
}

/** Drive the core in 100 ms steps of simulated active play. Returns elapsed ms. */
export function drive(c: Core, maxMs: number, o: DriveOpts = {}): number {
  const { core } = c;
  const every = o.actionEveryMs ?? 3000;
  const scores = o.scores ?? areaScores({ desk: 0.5, photo_wall: 0.3, shelf: 0.25, window: 0.2, table: 0.2, mirror: 0.2, lamp_corner: 0.2, hallway: 0.2 });
  const st = c as Core & { _i?: number; _next?: number };
  st._i ??= 0;
  st._next ??= core.clock.now + every;
  const candidatesOthers = GameCore.interactableIds();
  let elapsed = 0;
  while (elapsed < maxMs) {
    if (o.until?.(c)) break;
    core.clock.advance(100);
    elapsed += 100;
    if (o.moving !== false) core.pointerMoved();
    core.tick(0);
    core.sampleAttention(scores, 100, 0);
    if (o.pointerTarget !== null) {
      const target = o.pointerTarget ?? 'door';
      const { pointer, candidates } = pointerOn(target, candidatesOthers.filter((x) => x !== target).slice(0, 4));
      core.updatePrediction(pointer, { x: 0, y: 0 }, candidates);
    }
    if (o.script && o.script.length && core.clock.now >= st._next) {
      const [type, target, opts] = o.script[st._i % o.script.length];
      st._i++;
      st._next = core.clock.now + every;
      act(c, type, target, opts);
    }
    o.each?.(c);
  }
  return elapsed;
}

export const areaOf = (id: ObjectId) => PLACEMENTS[id].area;
