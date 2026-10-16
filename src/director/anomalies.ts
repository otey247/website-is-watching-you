import { BOOK_IDS, CHAIR, INITIAL_SLOTS, NAV_NODES, PLACEMENTS, SLOTS, type BookId, type NavNodeId, type ObjectId, type V3 } from '../core/layout';
import { wrapAngle } from '../core/math';
import { resolvePosition, sweep } from '../world/collision';
import type { AnomalyDef, AnomalyPlan, DirectorCtx, Step, VisibilityContract } from './types';

// ——— helpers ————————————————————————————————————————————————

const unseen = (minUnseenMs = 4000, interruption: VisibilityContract['interruption'] = 'freeze', waitMs = 25_000): VisibilityContract => ({
  mode: 'unseen',
  minUnseenMs,
  interruption,
  waitMs,
});
const peripheral = (waitMs = 20_000): VisibilityContract => ({ mode: 'peripheral', minUnseenMs: 0, interruption: 'freeze', waitMs });
const direct = (interruption: VisibilityContract['interruption'] = 'continue'): VisibilityContract => ({ mode: 'direct', minUnseenMs: 0, interruption, waitMs: 4000 });

const ids = (e: { id: number }[]): number[] => e.map((x) => x.id);

function yawToward(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function chairPos(ctx: DirectorCtx): { x: number; z: number; yaw: number } {
  const c = ctx.world.get('chair');
  return { x: c.x ?? CHAIR.initial.x, z: c.z ?? CHAIR.initial.z, yaw: c.yaw ?? CHAIR.initial.yaw };
}

/** Pick an unseen nav node, preferring ones far from the current attention focus. */
export function unseenNode(ctx: DirectorCtx, prefer?: NavNodeId[]): NavNodeId | null {
  const nodes = (prefer ?? (Object.keys(NAV_NODES) as NavNodeId[])).filter((n) => !ctx.vis.isPointVisible(NAV_NODES[n]));
  return nodes.length ? ctx.rng.pick(nodes) : null;
}

function slotY(slot: string): number {
  return SLOTS.find((s) => s.id === slot)!.position[1];
}

const inspected = (ctx: DirectorCtx, id: ObjectId) => ctx.telemetry.query({ type: 'object_inspected', target: id });

/** Books the player has placed somewhere other than their original slot. */
function displacedBooks(ctx: DirectorCtx): { book: BookId; eventId: number }[] {
  const out: { book: BookId; eventId: number }[] = [];
  for (const b of BOOK_IDS) {
    const s = ctx.world.get(b);
    if (s.state === 'held' || s.slot === INITIAL_SLOTS[b]) continue;
    const placed = ctx.telemetry.last('object_placed', b);
    if (placed && placed.meta.slot === s.slot) out.push({ book: b, eventId: placed.id });
  }
  return out;
}

function messageStep(ctx: DirectorCtx, intents?: Parameters<DirectorCtx['narrative']['candidates']>[1]): { step: Step; refs: number[] } | null {
  const c = ctx.narrative.candidates(ctx.narrativeCtx(), intents)[0];
  if (!c) return null;
  return {
    step: { op: 'message', templateId: c.template.id, intent: c.template.intent, text: c.text, refs: c.refs, facts: c.facts },
    refs: c.refs,
  };
}

const LATE = ['recognition', 'anticipation', 'confrontation'] as const;
const EARLY_ON = ['inconsistency', 'recognition', 'anticipation', 'confrontation'] as const;

// ——— the catalog ————————————————————————————————————————————————

export const ANOMALIES: AnomalyDef[] = [
  // ───────────── Phase 2: Inconsistency — small, unseen, unacknowledged ─────────────
  {
    id: 'photo_first_change',
    description: 'The photograph changes while nobody is looking: one person moves, or is gone.',
    group: 'photo',
    phases: ['inconsistency', 'recognition'],
    significance: 'notable',
    baseWeight: 3,
    tension: 0.12,
    cooldownMs: 0,
    maxRepeats: 1,
    visibility: unseen(8000, 'freeze', 60_000),
    requires: (ctx) => {
      const e = inspected(ctx, 'photograph');
      return e.length >= 1 ? ids(e) : null;
    },
    prerequisite: (ctx) => ctx.world.get('photograph').state === 'original',
    affinity: (ctx) => 1 + ctx.observer.interestShare('photograph') * 4,
    plan: (ctx, evidence) => {
      // The gazing variant later keeps whichever composition this produced (state.mode).
      const variant = ctx.rng.chance(0.5) ? 'removed' : 'shifted';
      return { targets: ['photograph'], evidence, steps: [{ op: 'set', object: 'photograph', patch: { state: variant, mode: variant } }] };
    },
  },
  {
    id: 'chair_rotate_slight',
    description: 'The chair rotates by five degrees while off-screen.',
    group: 'chair',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 2,
    tension: 0.05,
    cooldownMs: 120_000,
    maxRepeats: 2,
    visibility: unseen(3000),
    prerequisite: (ctx) => ['original', 'player_moved', 'rotated_slight'].includes(ctx.world.get('chair').state),
    plan: (ctx) => {
      const c = chairPos(ctx);
      return {
        targets: ['chair'],
        evidence: [],
        steps: [{ op: 'animate', object: 'chair', to: { yaw: c.yaw + (ctx.rng.chance(0.5) ? 1 : -1) * 0.087 }, durationMs: 1400, state: 'rotated_slight', ease: 'inOut' }],
      };
    },
  },
  {
    id: 'book_shift',
    description: 'A book moves to a different shelf.',
    group: 'books',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.6,
    tension: 0.06,
    cooldownMs: 150_000,
    maxRepeats: 2,
    visibility: unseen(5000),
    requires: (ctx) => (ctx.observer.areaAttentionMs.get('shelf') ?? 0) > 2000 ? [] : null,
    plan: (ctx) => {
      const books = BOOK_IDS.filter((b) => ctx.world.get(b).state === 'shelved');
      if (!books.length) return null;
      const book = ctx.rng.pick(books);
      const y = slotY(ctx.world.get(book).slot!);
      const free = ctx.world.freeSlots('shelf').filter((s) => Math.abs(slotY(s) - y) > 0.2);
      if (!free.length) return null;
      return { targets: [book], evidence: [], steps: [{ op: 'set', object: book, patch: { state: 'moved', slot: ctx.rng.pick(free) } }] };
    },
  },
  {
    id: 'clock_lose_seconds',
    description: 'The clock loses seven seconds.',
    group: 'clock',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.4,
    tension: 0.04,
    cooldownMs: 200_000,
    maxRepeats: 2,
    visibility: unseen(4000),
    requires: (ctx) => {
      const e = inspected(ctx, 'clock');
      return e.length >= 1 || (ctx.observer.areaAttentionMs.get('hallway') ?? 0) > 1500 ? ids(e) : null;
    },
    plan: (ctx, evidence) => ({
      targets: ['clock'],
      evidence,
      steps: [{ op: 'set', object: 'clock', patch: { state: 'lost_seconds', offsetMs: (ctx.world.get('clock').offsetMs ?? 0) - 7000 } }],
    }),
  },
  {
    id: 'clock_skip_tick',
    description: 'A momentary interruption in the ticking.',
    group: 'audio',
    phases: [...EARLY_ON],
    significance: 'ambient',
    baseWeight: 1.2,
    tension: 0.02,
    cooldownMs: 90_000,
    maxRepeats: 4,
    visibility: direct(),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'clock_skip', params: { ticks: 2 } }] }),
  },
  {
    id: 'lamp_off_when_away',
    description: 'The lamp turns off after the player moves away.',
    group: 'lamp',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.6,
    tension: 0.07,
    cooldownMs: 160_000,
    maxRepeats: 2,
    visibility: unseen(6000),
    requires: (ctx) => {
      const on = ctx.telemetry.last('lamp_toggled');
      return on && on.meta.on === true ? [on.id] : null;
    },
    prerequisite: (ctx) => !!ctx.world.get('lamp').on,
    plan: (_ctx, evidence) => ({ targets: ['lamp'], evidence, steps: [{ op: 'set', object: 'lamp', patch: { state: 'off', on: false } }] }),
  },
  {
    id: 'drawer_ajar',
    description: 'A drawer the player closed is slightly open when revisited.',
    group: 'drawer',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.8,
    tension: 0.06,
    cooldownMs: 140_000,
    maxRepeats: 2,
    visibility: unseen(4000),
    requires: (ctx) => {
      const c = ctx.telemetry.last('drawer_closed');
      return c ? [c.id] : null;
    },
    plan: (ctx, evidence) => {
      const closed = ctx.telemetry.get(evidence[0]);
      const d = (closed?.target ?? 'drawer_top') as 'drawer_top' | 'drawer_bottom';
      if ((ctx.world.get(d).open ?? 0) > 0.05) return null;
      return { targets: [d], evidence, steps: [{ op: 'animate', object: d, to: { open: 0.14 }, durationMs: 900, state: 'ajar' }] };
    },
  },
  {
    id: 'figurine_faces_camera',
    description: 'A small object examined earlier is now facing the camera.',
    group: 'figurine',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.5,
    tension: 0.06,
    cooldownMs: 180_000,
    maxRepeats: 2,
    visibility: unseen(5000),
    requires: (ctx) => {
      const e = [...ctx.telemetry.query({ type: 'object_picked_up', target: 'figurine' }), ...inspected(ctx, 'figurine')];
      return e.length ? ids(e) : null;
    },
    prerequisite: (ctx) => ['shelved', 'moved', 'facing_camera'].includes(ctx.world.get('figurine').state),
    plan: (ctx, evidence) => {
      const cam = ctx.camera().position;
      const slot = SLOTS.find((s) => s.id === ctx.world.get('figurine').slot);
      if (!slot) return null;
      const yaw = yawToward({ x: slot.position[0], z: slot.position[2] }, { x: cam[0], z: cam[2] });
      return { targets: ['figurine'], evidence, steps: [{ op: 'set', object: 'figurine', patch: { state: 'facing_camera', yaw } }] };
    },
  },
  {
    id: 'cursor_nudge',
    description: 'The cursor on the fictional screen moves one pixel by itself.',
    group: 'computer',
    phases: [...EARLY_ON],
    significance: 'ambient',
    baseWeight: 1.0,
    tension: 0.02,
    cooldownMs: 100_000,
    maxRepeats: 3,
    visibility: peripheral(),
    requires: (ctx) => (ctx.telemetry.count('object_inspected', 'computer') > 0 ? [] : null),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'cursor_nudge', params: { px: 1 } }] }),
  },
  {
    id: 'mirror_lag',
    description: 'The reflection briefly lags behind the ceiling fan.',
    group: 'mirror',
    phases: [...EARLY_ON],
    significance: 'subtle',
    baseWeight: 1.0,
    tension: 0.05,
    cooldownMs: 160_000,
    maxRepeats: 2,
    visibility: direct(),
    prerequisite: (ctx) => ctx.vis.visibility('mirror') !== 'offscreen',
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'mirror_lag', params: { ms: 1600, delayMs: 380 } }] }),
  },
  {
    id: 'scrape_offscreen',
    description: 'A quiet scrape from outside the current view.',
    group: 'audio',
    phases: [...EARLY_ON],
    significance: 'ambient',
    baseWeight: 1.2,
    tension: 0.03,
    cooldownMs: 70_000,
    maxRepeats: 6,
    visibility: direct(),
    affinity: (ctx) => 1 + ctx.observer.state.avoidance,
    plan: (ctx) => {
      const node = unseenNode(ctx, ['under_desk', 'lamp_corner', 'shelf_corner', 'table_corner', 'behind_curtain']);
      if (!node) return null;
      return { targets: [], evidence: [], steps: [{ op: 'sound', sound: ctx.rng.chance(0.5) ? 'scrape' : 'wood_click', at: node, gain: 0.35 }] };
    },
  },
  {
    id: 'footstep_hallway',
    description: 'A single footstep in the adjacent hallway. More frequent if the player avoids it.',
    group: 'audio',
    phases: [...EARLY_ON],
    significance: 'ambient',
    baseWeight: 0.9,
    tension: 0.05,
    cooldownMs: 110_000,
    maxRepeats: 6,
    visibility: direct(),
    // Sounds come from the hallway when it is avoided, and from elsewhere when it is over-investigated.
    affinity: (ctx) => {
      const share = ctx.observer.interestShare('door');
      return (1 + 2.5 * (ctx.observer.areaAvoidance.get('hallway') ?? 0)) * (share > 0.25 ? 0.2 : 1);
    },
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'sound', sound: 'footstep', at: 'hallway_far', gain: 0.28 }] }),
  },

  // ───────────── Phase 3: Recognition — the room responds to observed behavior ─────────────
  {
    id: 'photo_gazing',
    description: 'One person in the photograph now looks directly toward the viewer.',
    group: 'photo',
    phases: [...LATE],
    significance: 'notable',
    baseWeight: 3,
    tension: 0.14,
    cooldownMs: 0,
    minSinceGroups: { photo: 120_000 },
    maxRepeats: 1,
    visibility: unseen(8000, 'freeze', 60_000),
    requires: (ctx) => {
      const e = inspected(ctx, 'photograph');
      return e.length >= 2 ? ids(e) : null;
    },
    prerequisite: (ctx) => ['shifted', 'removed'].includes(ctx.world.get('photograph').state),
    affinity: (ctx) => 1 + ctx.observer.interestShare('photograph') * 4,
    plan: (_ctx, evidence) => ({ targets: ['photograph'], evidence, steps: [{ op: 'set', object: 'photograph', patch: { state: 'gazing' } }] }),
  },
  {
    id: 'photo_revert',
    description: 'After the player has checked a change, the photograph quietly returns to how it was. Harder to verify.',
    group: 'photo',
    phases: [...LATE],
    significance: 'subtle',
    baseWeight: 1.4,
    tension: 0.08,
    cooldownMs: 300_000,
    minSinceGroups: { photo: 60_000 },
    maxRepeats: 1,
    visibility: unseen(6000, 'freeze', 60_000),
    requires: (ctx) => {
      const inv = ctx.telemetry.query({ type: 'anomaly_investigated', target: 'photograph' });
      return inv.length && ctx.observer.profile().anomalyInvestigation >= 0.5 ? ids(inv) : null;
    },
    prerequisite: (ctx) => ['shifted', 'removed', 'gazing'].includes(ctx.world.get('photograph').state),
    plan: (ctx, evidence) => {
      const h = ctx.world.historyOf('photograph');
      const prev = h[h.length - 1]?.from.state;
      if (!prev) return null;
      return { targets: ['photograph'], evidence, steps: [{ op: 'set', object: 'photograph', patch: { state: prev } }] };
    },
  },
  {
    id: 'chair_creep',
    description: 'The chair moves a few centimeters toward where the player stands.',
    group: 'chair',
    phases: [...LATE],
    significance: 'subtle',
    baseWeight: 1.6,
    tension: 0.08,
    cooldownMs: 120_000,
    minSinceGroups: { chair: 60_000 },
    maxRepeats: 4,
    visibility: unseen(3000),
    // A still player finds the room becoming more attentive to their location.
    affinity: (ctx) => 1 + ctx.observer.profile().stillness * 3,
    plan: (ctx) => {
      const c = chairPos(ctx);
      const cam = ctx.camera().position;
      const dx = cam[0] - c.x;
      const dz = cam[2] - c.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.0) return null;
      const step = ctx.rng.range(0.05, 0.1);
      const to = sweep(c, { x: c.x + (dx / d) * step, z: c.z + (dz / d) * step }, CHAIR.radius);
      if (Math.hypot(to.x - c.x, to.z - c.z) < 0.02) return null;
      return { targets: ['chair'], evidence: [], steps: [{ op: 'animate', object: 'chair', to: { x: to.x, z: to.z }, durationMs: 2600, state: 'crept', sweep: true }] };
    },
  },
  {
    id: 'chair_return_desk',
    description: 'The player moved the chair; it is back at the desk, a little closer than before.',
    group: 'chair',
    phases: [...LATE],
    significance: 'notable',
    baseWeight: 2,
    tension: 0.1,
    cooldownMs: 150_000,
    minSinceGroups: { chair: 60_000 },
    maxRepeats: 2,
    visibility: unseen(5000),
    requires: (ctx) => {
      const e = ctx.telemetry.last('chair_moved');
      return e && ctx.world.get('chair').state === 'player_moved' ? [e.id] : null;
    },
    plan: (ctx, evidence) => {
      const target = resolvePosition({ x: CHAIR.initial.x, z: CHAIR.initial.z - 0.12 }, CHAIR.radius);
      const c = chairPos(ctx);
      if (Math.hypot(target.x - c.x, target.z - c.z) < 0.1) return null;
      return {
        targets: ['chair'],
        evidence,
        steps: [{ op: 'animate', object: 'chair', to: { x: target.x, z: target.z, yaw: CHAIR.initial.yaw }, durationMs: 3200, state: 'closer_desk', sweep: true, ease: 'inOut' }],
      };
    },
  },
  {
    id: 'chair_face_wall',
    description: 'The chair has turned to face the wall.',
    group: 'chair',
    phases: ['recognition', 'anticipation'],
    significance: 'notable',
    baseWeight: 1.2,
    tension: 0.1,
    cooldownMs: 240_000,
    minSinceGroups: { chair: 60_000 },
    maxRepeats: 1,
    visibility: unseen(6000),
    plan: (ctx) => {
      const c = chairPos(ctx);
      // Face the nearest wall.
      const walls = [
        { yaw: Math.PI, d: c.z + 2.1 },
        { yaw: 0, d: 2.1 - c.z },
        { yaw: -Math.PI / 2, d: c.x + 2.5 },
        { yaw: Math.PI / 2, d: 2.5 - c.x },
      ].sort((a, b) => a.d - b.d);
      const yaw = c.yaw + wrapAngle(walls[0].yaw - c.yaw);
      return { targets: ['chair'], evidence: [], steps: [{ op: 'animate', object: 'chair', to: { yaw }, durationMs: 2400, state: 'facing_wall', ease: 'inOut' }] };
    },
  },
  {
    id: 'returning_object',
    description: 'An item the player moved reappears in its original place, now facing the player.',
    group: 'books',
    phases: [...LATE],
    significance: 'notable',
    baseWeight: 2.4,
    tension: 0.12,
    cooldownMs: 160_000,
    maxRepeats: 2,
    visibility: unseen(6000),
    requires: (ctx) => {
      const d = displacedBooks(ctx).filter((b) => ctx.now - ctx.telemetry.get(b.eventId)!.timestampMs > 45_000);
      return d.length ? [d[0].eventId] : null;
    },
    plan: (ctx, evidence) => {
      const e = ctx.telemetry.get(evidence[0]);
      const book = e?.target as BookId | undefined;
      if (!book) return null;
      const orig = INITIAL_SLOTS[book];
      if (ctx.world.slotOccupant(orig) && ctx.world.slotOccupant(orig) !== book) return null;
      return { targets: [book], evidence, steps: [{ op: 'set', object: book, patch: { state: 'returned_facing', slot: orig, yaw: 1.2 } }] };
    },
  },
  {
    id: 'observer_message',
    description: 'A short message on the computer referring to something the player actually did.',
    group: 'message',
    phases: [...LATE],
    significance: 'notable',
    baseWeight: 2.6,
    tension: 0.1,
    cooldownMs: 70_000,
    minSinceGroups: { message: 70_000 },
    maxRepeats: 30,
    visibility: unseen(1500, 'freeze', 45_000),
    requires: (ctx) => {
      const m = messageStep(ctx, ['observation', 'count', 'testing', 'direct']);
      return m ? m.refs : null;
    },
    plan: (ctx) => {
      const m = messageStep(ctx, ['observation', 'count', 'testing', 'direct']);
      if (!m) return null;
      return { targets: ['computer'], evidence: m.refs, steps: [m.step] };
    },
  },
  {
    id: 'callback_message',
    description: 'A delayed reference, minutes later, to an ordinary action.',
    group: 'message',
    phases: [...LATE],
    significance: 'notable',
    baseWeight: 3,
    tension: 0.12,
    cooldownMs: 90_000,
    minSinceGroups: { message: 60_000 },
    maxRepeats: 12,
    visibility: unseen(1500, 'freeze', 45_000),
    requires: (ctx) => {
      const c = ctx.narrative.callbackMessage(ctx.narrativeCtx());
      return c ? c.refs : null;
    },
    plan: (ctx) => {
      const c = ctx.narrative.callbackMessage(ctx.narrativeCtx());
      if (!c) return null;
      return {
        targets: ['computer'],
        evidence: c.refs,
        steps: [{ op: 'message', templateId: 'callback', intent: 'callback', text: c.text, refs: c.refs, facts: c.facts, callback: c.entry }],
      };
    },
  },
  {
    id: 'unnatural_silence',
    description: 'When the player stops moving, the ambient layers become unusually quiet.',
    group: 'silence',
    phases: [...LATE],
    significance: 'subtle',
    baseWeight: 2,
    tension: 0.08,
    cooldownMs: 150_000,
    maxRepeats: 4,
    visibility: direct(),
    requires: (ctx) => (ctx.playerIdleMs > 6000 ? [] : null),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'silence', params: { ms: 9000, level: 0.12 } }] }),
  },
  {
    id: 'test_noticed',
    description: 'The player is testing whether things move when they look away. The tested object stays; something behind them changes instead.',
    group: 'testing',
    phases: [...LATE],
    significance: 'major',
    baseWeight: 6,
    tension: 0.2,
    cooldownMs: 180_000,
    maxRepeats: 2,
    visibility: unseen(1500, 'freeze', 30_000),
    requires: (ctx) => {
      const e = ctx.telemetry.query({ type: 'look_away_test', unusedBy: 'director:test_noticed' });
      return e.length ? [e[e.length - 1].id] : null;
    },
    plan: (ctx, evidence) => {
      const test = ctx.telemetry.get(evidence[0]);
      const tested = test?.target;
      if (!tested) return null;
      // The tested object is protected (the director refuses to touch it for a minute).
      ctx.protectedObjects.set(tested, ctx.now + 60_000);
      const c = chairPos(ctx);
      const p = PLACEMENTS[tested].center;
      const yaw = c.yaw + wrapAngle(yawToward(c, { x: p[0], z: p[2] }) - c.yaw);
      const steps: Step[] = [];
      if (tested !== 'chair' && ctx.vis.isUnseen('chair')) steps.push({ op: 'animate', object: 'chair', to: { yaw }, durationMs: 2000, state: 'rotated_slight', ease: 'inOut' });
      const msg = messageStep(ctx, ['testing']);
      if (msg) steps.push(msg.step);
      if (!steps.length) return null;
      return { targets: steps.some((s) => s.op === 'animate') ? ['chair', 'computer'] : ['computer'], evidence: [...evidence, ...(msg?.refs ?? [])], steps };
    },
  },
  {
    id: 'follower_marks',
    description: 'Faint marks begin appearing along the pointer path.',
    group: 'follower',
    phases: ['recognition', 'anticipation'],
    significance: 'notable',
    baseWeight: 2.4,
    tension: 0.08,
    cooldownMs: 0,
    maxRepeats: 1,
    visibility: direct(),
    requires: (ctx) => (ctx.followerStage === 0 && ctx.narrative.messagesShown >= 1 ? [] : null),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'call', fn: (c) => c.setFollowerStage(1) }] }),
  },
  {
    id: 'familiar_sound',
    description: "The room replays a sequence of the player's own clicks and object sounds from their sources.",
    group: 'replay',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    baseWeight: 2,
    tension: 0.14,
    cooldownMs: 200_000,
    maxRepeats: 2,
    visibility: direct(),
    requires: (ctx) => {
      const recent = ctx.telemetry.query({ type: ['drawer_opened', 'drawer_closed', 'lamp_toggled', 'door_handle_tried', 'object_placed', 'curtains_toggled'], since: ctx.now - 240_000 });
      return recent.length >= 4 ? ids(recent.slice(-6)) : null;
    },
    plan: (_ctx, evidence) => ({ targets: [], evidence, steps: [{ op: 'effect', name: 'replay_sounds', params: { events: evidence } }] }),
  },

  // ───────────── Phase 4: Anticipation — acting before the player does ─────────────
  {
    id: 'anticipate_door_handle',
    description: 'As the pointer approaches the door, the handle turns slightly. It stops when the player pauses, and returns when they move away.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    anticipation: true,
    baseWeight: 3,
    tension: 0.12,
    cooldownMs: 90_000,
    minSinceGroups: { anticipation: 25_000 },
    maxRepeats: 4,
    visibility: direct(),
    requires: (ctx) => (ctx.commit?.target === 'door' && !ctx.commit.response ? [] : null),
    plan: () => ({
      targets: ['door'],
      evidence: [],
      steps: [
        { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_door_handle') },
        { op: 'sound', sound: 'door_handle', at: 'door', gain: 0.25 },
        { op: 'animate', object: 'door', to: { handle: 0.35 }, durationMs: 700, ease: 'inOut' },
        // Stop when the player pauses; hold while they hover.
        { op: 'until', cond: (c) => c.pointerIdleMs > 350 || c.prediction?.target !== 'door', timeoutMs: 2500 },
        { op: 'until', cond: (c) => c.prediction?.target !== 'door' || c.prediction.confidence < 0.3, timeoutMs: 8000 },
        { op: 'animate', object: 'door', to: { handle: 0 }, durationMs: 1800, ease: 'inOut' },
      ],
    }),
  },
  {
    id: 'anticipate_lamp',
    description: 'The player habitually turns on the lamp; the lamp turns on as the pointer approaches.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    anticipation: true,
    baseWeight: 3,
    tension: 0.14,
    cooldownMs: 120_000,
    minSinceGroups: { anticipation: 25_000 },
    maxRepeats: 2,
    visibility: direct(),
    requires: (ctx) => {
      if (ctx.commit?.target !== 'lamp' || ctx.commit.response) return null;
      const ons = ctx.telemetry.query({ type: 'lamp_toggled', meta: { on: true } });
      return ons.length >= 2 ? ids(ons) : null;
    },
    prerequisite: (ctx) => !ctx.world.get('lamp').on,
    plan: (_ctx, evidence) => ({
      targets: ['lamp'],
      evidence,
      steps: [
        { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_lamp') },
        { op: 'sound', sound: 'lamp_click', at: 'lamp', gain: 0.6 },
        { op: 'set', object: 'lamp', patch: { state: 'on', on: true } },
      ],
    }),
  },
  {
    id: 'anticipate_photo_turn',
    description: 'For a player obsessed with the photograph, it tilts slightly toward them as the camera turns to it.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    anticipation: true,
    baseWeight: 3,
    tension: 0.12,
    cooldownMs: 150_000,
    minSinceGroups: { anticipation: 25_000 },
    maxRepeats: 2,
    visibility: { mode: 'peripheral', minUnseenMs: 0, interruption: 'continue', waitMs: 3000 },
    requires: (ctx) => {
      const e = inspected(ctx, 'photograph');
      if (e.length < 3) return null;
      return ctx.vis.visibility('photograph') === 'peripheral' && ctx.prediction?.target === 'photograph' ? ids(e) : null;
    },
    plan: (ctx, evidence) => {
      const cam = ctx.camera().position;
      const tilt = Math.max(-0.1, Math.min(0.1, (cam[2] - 0.25) * 0.06));
      return {
        targets: ['photograph'],
        evidence,
        steps: [
          { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_photo_turn') },
          { op: 'animate', object: 'photograph', to: { tilt }, durationMs: 1200, ease: 'inOut' },
        ],
      };
    },
  },
  {
    id: 'anticipate_book_open',
    description: 'A book opens slightly just before the player reaches for it.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    anticipation: true,
    baseWeight: 2.6,
    tension: 0.12,
    cooldownMs: 120_000,
    minSinceGroups: { anticipation: 25_000 },
    maxRepeats: 2,
    visibility: direct(),
    requires: (ctx) => (ctx.commit && ctx.commit.target.startsWith('book') && !ctx.commit.response ? [] : null),
    plan: (ctx) => {
      const book = ctx.commit!.target as BookId;
      if (ctx.world.get(book).state === 'held') return null;
      return {
        targets: [book],
        evidence: [],
        steps: [
          { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_book_open') },
          { op: 'sound', sound: 'paper', at: book, gain: 0.25 },
          { op: 'animate', object: book, to: { tilt: 0.35 }, durationMs: 600, state: 'ajar', ease: 'inOut' },
          { op: 'until', cond: (c) => c.prediction?.target !== book, timeoutMs: 6000 },
          { op: 'animate', object: book, to: { tilt: 0 }, durationMs: 1500, state: 'shelved' },
        ],
      };
    },
  },
  {
    id: 'anticipate_drawer',
    description: 'The drawer slides open a centimeter as the pointer approaches it.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    anticipation: true,
    baseWeight: 2.2,
    tension: 0.1,
    cooldownMs: 120_000,
    minSinceGroups: { anticipation: 25_000 },
    maxRepeats: 2,
    visibility: direct(),
    requires: (ctx) => (ctx.commit && ctx.commit.target.startsWith('drawer') && !ctx.commit.response ? [] : null),
    plan: (ctx) => {
      const d = ctx.commit!.target as 'drawer_top' | 'drawer_bottom';
      if ((ctx.world.get(d).open ?? 0) > 0.05) return null;
      return {
        targets: [d],
        evidence: [],
        steps: [
          { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_drawer') },
          { op: 'animate', object: d, to: { open: 0.06 }, durationMs: 500, state: 'ajar' },
        ],
      };
    },
  },
  {
    id: 'anticipate_sound',
    description: 'A subtle sound precedes the predicted interaction, from the object itself.',
    group: 'anticipation',
    phases: ['anticipation', 'confrontation'],
    significance: 'subtle',
    anticipation: true,
    baseWeight: 1.6,
    tension: 0.06,
    cooldownMs: 60_000,
    minSinceGroups: { anticipation: 20_000 },
    maxRepeats: 5,
    visibility: direct(),
    requires: (ctx) => (ctx.commit && !ctx.commit.response ? [] : null),
    plan: (ctx) => ({
      targets: [],
      evidence: [],
      steps: [
        { op: 'call', fn: (c) => c.observer.predictor.attachResponse('anticipate_sound') },
        { op: 'sound', sound: ctx.commit!.target === 'door' ? 'door_handle' : 'wood_click', at: ctx.commit!.target, gain: 0.2 },
      ],
    }),
  },
  {
    id: 'prediction_message',
    description: 'The computer mentions a prediction — only after an observed decision supports it.',
    group: 'message',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    baseWeight: 3,
    tension: 0.12,
    cooldownMs: 90_000,
    minSinceGroups: { message: 50_000 },
    maxRepeats: 4,
    visibility: unseen(1500, 'freeze', 30_000),
    requires: (ctx) => messageStep(ctx, ['prediction'])?.refs ?? null,
    plan: (ctx) => {
      const m = messageStep(ctx, ['prediction']);
      return m ? { targets: ['computer'], evidence: m.refs, steps: [m.step] } : null;
    },
  },
  {
    id: 'follower_appears',
    description: 'A second trail of marks follows the original path with a delay.',
    group: 'follower',
    phases: ['anticipation', 'confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.16,
    cooldownMs: 0,
    minSinceGroups: { follower: 60_000 },
    maxRepeats: 1,
    visibility: direct(),
    requires: (ctx) => (ctx.followerStage === 1 ? [] : null),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'call', fn: (c) => c.setFollowerStage(2) }] }),
  },
  {
    id: 'follower_closes_in',
    description: 'The follower delay shortens; it stops when the player stops.',
    group: 'follower',
    phases: ['anticipation', 'confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.16,
    cooldownMs: 0,
    minSinceGroups: { follower: 90_000 },
    maxRepeats: 1,
    visibility: direct(),
    requires: (ctx) => (ctx.followerStage === 2 ? [] : null),
    affinity: (ctx) => 1 + ctx.observer.state.avoidance * 2,
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'call', fn: (c) => c.setFollowerStage(3) }] }),
  },
  {
    id: 'mirror_past_chair',
    description: 'The mirror shows the chair in its previous position, then catches up.',
    group: 'mirror',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    baseWeight: 2,
    tension: 0.12,
    cooldownMs: 150_000,
    maxRepeats: 2,
    visibility: direct(),
    requires: (ctx) => {
      const h = ctx.world.historyOf('chair');
      const last = h[h.length - 1];
      return last && ctx.now - last.timestampMs < 120_000 ? last.evidence : null;
    },
    prerequisite: (ctx) => ctx.vis.visibility('mirror') === 'attended',
    plan: (ctx, evidence) => {
      const h = ctx.world.historyOf('chair');
      const from = h[h.length - 1].from;
      return { targets: [], evidence, steps: [{ op: 'effect', name: 'mirror_past_chair', params: { x: from.x, z: from.z, yaw: from.yaw, ms: 1800 } }] };
    },
  },
  {
    id: 'impossible_drawer',
    description: 'The player opens a drawer and finds a book they placed elsewhere.',
    group: 'drawer',
    phases: ['anticipation', 'confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.18,
    cooldownMs: 300_000,
    maxRepeats: 1,
    visibility: unseen(5000),
    requires: (ctx) => {
      const d = displacedBooks(ctx);
      return d.length ? [d[0].eventId] : null;
    },
    prerequisite: (ctx) => (ctx.world.get('drawer_top').open ?? 0) < 0.05 && !ctx.world.slotOccupant('drawer_in'),
    plan: (ctx, evidence) => {
      const book = ctx.telemetry.get(evidence[0])?.target as BookId | undefined;
      if (!book) return null;
      return { targets: [book, 'drawer_top'], evidence, steps: [{ op: 'set', object: book, patch: { state: 'in_drawer', slot: 'drawer_in', yaw: 0 } }] };
    },
  },
  {
    id: 'photo_room_now',
    description: 'The photograph depicts this room, with the chair exactly where it was earlier.',
    group: 'photo',
    phases: ['anticipation', 'confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.18,
    cooldownMs: 0,
    minSinceGroups: { photo: 150_000 },
    maxRepeats: 1,
    visibility: unseen(8000, 'freeze', 60_000),
    requires: (ctx) => (inspected(ctx, 'photograph').length >= 2 ? ids(inspected(ctx, 'photograph')) : null),
    prerequisite: (ctx) => ['gazing', 'shifted', 'removed'].includes(ctx.world.get('photograph').state),
    plan: (ctx, evidence) => {
      // Prefer the room as it was when the player last moved the chair.
      const moved = ctx.telemetry.last('chair_moved');
      const snap = moved ? ctx.snapshots.get(moved.id) : undefined;
      const captureId = snap ? snap.captureId : ctx.sink.capture('now');
      return {
        targets: ['photograph'],
        evidence: moved && snap ? [...evidence, moved.id] : evidence,
        steps: [{ op: 'set', object: 'photograph', patch: { state: 'room_now', captureId } }],
      };
    },
  },

  // ───────────── Phase 5: Confrontation — the room stops pretending ─────────────
  {
    id: 'photo_room_past',
    description: 'The photograph shows an earlier arrangement the player created (drawer open, lamp off...).',
    group: 'photo',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 3.5,
    tension: 0.2,
    cooldownMs: 0,
    minSinceGroups: { photo: 100_000 },
    maxRepeats: 1,
    visibility: unseen(6000, 'freeze', 60_000),
    requires: (ctx) => {
      const cur = ctx.world.context();
      for (const [eventId, snap] of [...ctx.snapshots].reverse()) {
        const e = ctx.telemetry.get(eventId);
        if (!e || ctx.now - e.timestampMs < 90_000) continue;
        const differs = e.context.lampOn !== cur.lampOn || e.context.drawerOpen !== cur.drawerOpen || e.context.chairState !== cur.chairState;
        if (differs && snap) return [eventId];
      }
      return null;
    },
    plan: (ctx, evidence) => {
      const snap = ctx.snapshots.get(evidence[0]);
      if (!snap) return null;
      return { targets: ['photograph'], evidence, steps: [{ op: 'set', object: 'photograph', patch: { state: 'room_past', captureId: snap.captureId } }] };
    },
  },
  {
    id: 'photo_figure',
    description: 'The photograph shows the current room with one more, indistinct figure: standing where the player stands.',
    group: 'photo',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.24,
    cooldownMs: 0,
    minSinceGroups: { photo: 100_000 },
    maxRepeats: 1,
    visibility: unseen(6000, 'freeze', 60_000),
    requires: (ctx) => (ctx.history('photo_room_now').count + ctx.history('photo_room_past').count > 0 ? [] : null),
    plan: (ctx) => ({ targets: ['photograph'], evidence: [], steps: [{ op: 'set', object: 'photograph', patch: { state: 'room_figure', captureId: ctx.sink.capture('figure') } }] }),
  },
  {
    id: 'chair_face_prev',
    description: "The chair faces the player's previous camera location.",
    group: 'chair',
    phases: ['anticipation', 'confrontation'],
    significance: 'notable',
    baseWeight: 2.2,
    tension: 0.14,
    cooldownMs: 120_000,
    minSinceGroups: { chair: 50_000 },
    maxRepeats: 2,
    visibility: unseen(4000),
    requires: (ctx) => {
      const old = ctx.telemetry.query({ before: ctx.now - 45_000, since: ctx.now - 180_000 }).filter((e) => e.type !== 'session_started');
      return old.length ? [old[old.length - 1].id] : null;
    },
    plan: (ctx, evidence) => {
      const e = ctx.telemetry.get(evidence[0]);
      if (!e) return null;
      const c = chairPos(ctx);
      const p = e.camera.position;
      const yaw = c.yaw + wrapAngle(yawToward(c, { x: p[0], z: p[2] }) - c.yaw);
      return { targets: ['chair'], evidence, steps: [{ op: 'animate', object: 'chair', to: { yaw }, durationMs: 2500, state: 'facing_player_prev', ease: 'inOut' }] };
    },
  },
  {
    id: 'chair_face_now',
    description: 'The chair turns to face the player — slowly, even while watched.',
    group: 'chair',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 2.4,
    tension: 0.2,
    cooldownMs: 160_000,
    minSinceGroups: { chair: 60_000 },
    maxRepeats: 2,
    visibility: direct('continue'),
    requires: (ctx) => (ctx.history('chair_face_prev').count > 0 ? [] : null),
    plan: (ctx) => {
      const c = chairPos(ctx);
      const p = ctx.camera().position;
      const yaw = c.yaw + wrapAngle(yawToward(c, { x: p[0], z: p[2] }) - c.yaw);
      return {
        targets: ['chair'],
        evidence: [],
        steps: [
          { op: 'sound', sound: 'chair_creak', at: 'chair', gain: 0.45 },
          { op: 'animate', object: 'chair', to: { yaw }, durationMs: ctx.settings.reducedMotion ? 2500 : 5200, state: 'facing_player_now', ease: 'inOut' },
        ],
      };
    },
  },
  {
    id: 'room_rearrange',
    description: 'Several objects rearrange while the player looks away.',
    group: 'rearrange',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 2,
    tension: 0.25,
    cooldownMs: 300_000,
    maxRepeats: 1,
    visibility: unseen(4000),
    plan: (ctx) => {
      const steps: Step[] = [];
      const targets: ObjectId[] = [];
      const books = BOOK_IDS.filter((b) => ctx.world.get(b).state === 'shelved' && ctx.vis.isUnseen(b));
      const free = ctx.world.freeSlots('shelf');
      for (const b of books.slice(0, 2)) {
        const slot = free.shift();
        if (!slot) break;
        steps.push({ op: 'set', object: b, patch: { state: 'moved', slot } });
        targets.push(b);
      }
      if (ctx.vis.isUnseen('cup') && ctx.world.get('cup').state !== 'held') {
        const s = ctx.world.freeSlots('table')[0] ?? ctx.world.freeSlots('desk')[0];
        if (s) {
          steps.push({ op: 'set', object: 'cup', patch: { state: 'moved', slot: s } });
          targets.push('cup');
        }
      }
      if (ctx.vis.isUnseen('curtains')) {
        const open = (ctx.world.get('curtains').open ?? 1) > 0.5;
        steps.push({ op: 'animate', object: 'curtains', to: { open: open ? 0.55 : 1 }, durationMs: 1800, state: open ? 'closed' : 'open' });
        targets.push('curtains');
      }
      return steps.length >= 2 ? { targets, evidence: [], steps } : null;
    },
  },
  {
    id: 'lamp_flicker',
    description: 'The lamp flickers once.',
    group: 'lamp',
    phases: ['confrontation'],
    significance: 'notable',
    sudden: true,
    baseWeight: 1.4,
    tension: 0.12,
    cooldownMs: 160_000,
    maxRepeats: 2,
    visibility: direct(),
    prerequisite: (ctx) => !!ctx.world.get('lamp').on,
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'flicker', params: { ms: 900 } }, { op: 'sound', sound: 'electrical_tick', at: 'lamp', gain: 0.3 }] }),
  },
  {
    id: 'light_shift',
    description: 'Daylight comes from a slightly wrong direction for a while.',
    group: 'light',
    phases: ['confrontation'],
    significance: 'notable',
    baseWeight: 1.4,
    tension: 0.14,
    cooldownMs: 240_000,
    maxRepeats: 1,
    visibility: direct(),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'light_shift', params: { ms: 40_000 } }] }),
  },
  {
    id: 'shadow_pass',
    description: 'A shadow crosses the sunlight on the floor. Nothing casts it.',
    group: 'entity',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 1.8,
    tension: 0.2,
    cooldownMs: 200_000,
    maxRepeats: 2,
    visibility: direct(),
    prerequisite: (ctx) => (ctx.world.get('curtains').open ?? 1) > 0.5,
    affinity: (ctx) => 1 + ctx.observer.state.avoidance * 2,
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'shadow_pass', params: { ms: 2400 } }, { op: 'sound', sound: 'creak', at: 'behind_curtain', gain: 0.25 }] }),
  },
  {
    id: 'mirror_presence',
    description: 'For a moment the mirror shows something standing in the room.',
    group: 'mirror',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 1.4,
    tension: 0.22,
    cooldownMs: 240_000,
    maxRepeats: 1,
    visibility: { mode: 'peripheral', minUnseenMs: 0, interruption: 'continue', waitMs: 20_000 },
    prerequisite: (ctx) => ctx.vis.visibility('mirror') === 'peripheral',
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'effect', name: 'mirror_presence', params: { ms: 700 } }] }),
  },
  {
    id: 'surveillance_feed',
    description: 'The computer shows the room from the corner, looking at where the player stands.',
    group: 'computer',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 2.4,
    tension: 0.2,
    cooldownMs: 300_000,
    maxRepeats: 1,
    visibility: unseen(1500, 'freeze', 40_000),
    plan: () => ({ targets: ['computer'], evidence: [], steps: [{ op: 'effect', name: 'surveillance', params: { ms: 30_000 } }] }),
  },
  {
    id: 'follower_shortcut',
    description: 'The follower stops replaying the exact path and heads for the object the player will inspect next.',
    group: 'follower',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 3,
    tension: 0.18,
    cooldownMs: 0,
    minSinceGroups: { follower: 60_000 },
    maxRepeats: 1,
    visibility: direct(),
    requires: (ctx) => (ctx.followerStage === 3 ? [] : null),
    plan: () => ({ targets: [], evidence: [], steps: [{ op: 'call', fn: (c) => c.setFollowerStage(4) }] }),
  },
  {
    id: 'door_drift',
    description: 'For a player who avoids the hallway, the door drifts further open on its own.',
    group: 'door',
    phases: ['confrontation'],
    significance: 'major',
    baseWeight: 1.6,
    tension: 0.2,
    cooldownMs: 200_000,
    maxRepeats: 1,
    visibility: unseen(4000, 'freeze'),
    requires: (ctx) => {
      const a = ctx.telemetry.last('area_avoided');
      return a && a.area === 'hallway' ? [a.id] : null;
    },
    prerequisite: (ctx) => (ctx.world.get('door').open ?? 0) < 0.3,
    plan: (_ctx, evidence) => ({ targets: ['door'], evidence, steps: [{ op: 'animate', object: 'door', to: { open: 0.4 }, durationMs: 3000, state: 'open', ease: 'inOut' }] }),
  },
  {
    id: 'confrontation_message',
    description: 'Direct lines in confrontation.',
    group: 'message',
    phases: ['confrontation'],
    significance: 'notable',
    baseWeight: 2.5,
    tension: 0.12,
    cooldownMs: 60_000,
    minSinceGroups: { message: 45_000 },
    maxRepeats: 10,
    visibility: unseen(1000, 'freeze', 30_000),
    requires: (ctx) => messageStep(ctx, ['direct', 'testing', 'prediction'])?.refs ?? null,
    plan: (ctx) => {
      const m = messageStep(ctx, ['direct', 'testing', 'prediction']);
      return m ? { targets: ['computer'], evidence: m.refs, steps: [m.step] } : null;
    },
  },
];

export const ANOMALY_BY_ID: Record<string, AnomalyDef> = Object.fromEntries(ANOMALIES.map((a) => [a.id, a]));

/** Exposed for tests/docs: which anomalies may fire in each phase. */
export function anomaliesForPhase(phase: string): AnomalyDef[] {
  return ANOMALIES.filter((a) => (a.phases as readonly string[]).includes(phase));
}

export type { AnomalyPlan, V3 };
