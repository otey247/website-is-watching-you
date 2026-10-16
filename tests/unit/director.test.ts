import { describe, expect, it } from 'vitest';
import { ANOMALIES, ANOMALY_BY_ID } from '../../src/director/anomalies';
import { PACING, type DecisionRecord } from '../../src/director/Director';
import type { Phase } from '../../src/director/phaseMachine';
import { makeDirector, pointerOn } from './helpers';

const worldJson = (d: ReturnType<typeof makeDirector>) => JSON.stringify(d.world.snapshot().objects);

function inspectPhoto(d: ReturnType<typeof makeDirector>, n = 1) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(d.telemetry.record({ type: 'object_inspected', target: 'photograph', area: 'photo_wall', durationMs: 3000, meta: {} }).id);
  return ids;
}

describe('events obey phase requirements', () => {
  it('force() fails outside the anomaly phases and reports the gate reason', () => {
    const d = makeDirector();
    expect(d.director.phase).toBe('normalcy');
    expect(d.director.force('photo_first_change')).toEqual({ ok: false, reason: 'phase normalcy' });
    expect(d.director.force('chair_face_now')).toEqual({ ok: false, reason: 'phase normalcy' });
    d.director.forcePhase('inconsistency');
    expect(d.director.force('chair_face_now')).toEqual({ ok: false, reason: 'phase inconsistency' });
    expect(d.director.force('nope')).toEqual({ ok: false, reason: 'unknown anomaly' });
    expect(d.world.mutationLog()).toHaveLength(0);
  });

  it('no anomaly is allowed in normalcy and a passive player sees nothing change there', () => {
    expect(ANOMALIES.filter((a) => (a.phases as readonly Phase[]).includes('normalcy'))).toEqual([]);
    const d = makeDirector();
    const before = worldJson(d);
    d.step(20 * 60_000, { frame: 250, auto: true });
    expect(d.director.phase).toBe('normalcy');
    expect(worldJson(d)).toBe(before);
    expect(d.world.mutationLog()).toHaveLength(0);
    expect(d.sink.effects).toHaveLength(0);
    expect(d.sink.sounds).toHaveLength(0);
  });

  it('candidate reports explain each gate', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    const reports = new Map(d.director.candidates(d.director.ctx(), false).map((c) => [c.def.id, c.report]));
    expect(reports.get('photo_first_change')!.reason).toBe('behavioral requirement unmet');
    expect(reports.get('chair_face_now')!.reason).toBe('phase inconsistency');
    expect(reports.get('clock_skip_tick')!.eligible).toBe(true);
    expect(reports.has('anticipate_door_handle')).toBe(false); // anticipation responses are evaluated separately
  });
});

describe('photograph changes only when eligible', () => {
  it('requires a prior inspection, an original photograph, and an unseen photograph for minUnseenMs', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    const minUnseen = ANOMALY_BY_ID.photo_first_change.visibility.minUnseenMs;
    expect(d.director.force('photo_first_change').reason).toBe('behavioral requirement unmet');
    const before = worldJson(d);
    d.step(30_000);
    expect(worldJson(d)).toBe(before);

    const [inspection] = inspectPhoto(d);
    d.vis.set('photograph', 'attended', d.clock.now);
    expect(d.director.force('photo_first_change')).toEqual({ ok: true, reason: 'scheduled' });
    expect(d.telemetry.get(inspection)!.usedBy).toContain('director:photo_first_change');

    // While watched, nothing happens.
    d.step(10_000, { frame: 50 });
    expect(d.world.get('photograph').state).toBe('original');
    // Looked away, but not for long enough.
    d.vis.set('photograph', 'offscreen', d.clock.now);
    d.step(minUnseen - 100, { frame: 50 });
    expect(d.world.get('photograph').state).toBe('original');
    // Peripheral glance resets the unseen timer.
    d.vis.set('photograph', 'peripheral', d.clock.now);
    d.step(100, { frame: 50 });
    d.vis.set('photograph', 'offscreen', d.clock.now);
    d.step(minUnseen - 100, { frame: 50 });
    expect(d.world.get('photograph').state).toBe('original');
    d.step(200, { frame: 50 });
    const s = d.world.get('photograph').state;
    expect(['removed', 'shifted']).toContain(s);
    const rec = d.world.historyOf('photograph').at(-1)!;
    expect(rec).toMatchObject({ source: 'director', cause: 'photo_first_change', evidence: [inspection] });
    expect(d.director.historyOf('photo_first_change').count).toBe(1);
    expect(d.director.executor.running).toHaveLength(0);
    expect(d.world.claimOwner('photograph')).toBeUndefined();
  });

  it('expires without effect when the photograph is never unseen, and does not count as a repeat', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    inspectPhoto(d);
    d.vis.set('photograph', 'attended', d.clock.now);
    expect(d.director.force('photo_first_change').ok).toBe(true);
    d.step(ANOMALY_BY_ID.photo_first_change.visibility.waitMs + 1000, { frame: 250 });
    expect(d.world.get('photograph').state).toBe('original');
    expect(d.director.decisions.some((x) => x.anomalyId === 'photo_first_change' && x.result === 'expired')).toBe(true);
    expect(d.director.historyOf('photo_first_change').count).toBe(0);
    expect(d.world.claimOwner('photograph')).toBeUndefined();
    expect(d.director.force('photo_first_change').ok).toBe(true);
  });

  it('is rejected when the room-state prerequisite is unmet', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    inspectPhoto(d);
    d.world.apply('photograph', { state: 'removed' }, { source: 'director', cause: 'setup' });
    const before = worldJson(d);
    expect(d.director.force('photo_first_change')).toEqual({ ok: false, reason: 'room state prerequisite unmet' });
    d.step(20_000);
    expect(worldJson(d)).toBe(before);
  });
});

describe('ineligible events cannot mutate the scene', () => {
  it('every anomaly with an unmet behavioral requirement is refused and leaves WorldState unchanged', () => {
    let checked = 0;
    for (const def of ANOMALIES) {
      if (!def.requires) continue;
      const d = makeDirector();
      d.director.forcePhase(def.phases[0] as Exclude<Phase, 'resolution'>);
      d.step(16);
      if (def.requires(d.director.ctx()) !== null) continue;
      checked++;
      const before = worldJson(d);
      const res = d.director.force(def.id, { anyPhase: true });
      expect(res, def.id).toEqual({ ok: false, reason: 'behavioral requirement unmet' });
      d.step(15_000, { frame: 100 });
      expect(worldJson(d), def.id).toBe(before);
      expect(d.world.mutationLog(), def.id).toHaveLength(0);
      expect(d.director.applied, def.id).toHaveLength(0);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('room-state prerequisites are enforced (lamp already off, drawer already open)', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    d.telemetry.record({ type: 'lamp_toggled', target: 'lamp', meta: { on: true } });
    expect(d.director.force('lamp_off_when_away').reason).toBe('room state prerequisite unmet');
    d.world.apply('lamp', { state: 'on', on: true }, { source: 'player', cause: 'click' });
    expect(d.director.force('lamp_off_when_away').ok).toBe(true);
  });
});

describe('cooldowns, quiet intervals and repetition limits', () => {
  it('a completed anomaly respects its cooldown and maxRepeats', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    const def = ANOMALY_BY_ID.chair_rotate_slight;
    expect(def.maxRepeats).toBe(2);
    expect(d.director.force(def.id).ok).toBe(true);
    d.step(3000);
    expect(d.world.get('chair').state).toBe('rotated_slight');
    expect(d.director.force(def.id)).toEqual({ ok: false, reason: 'cooldown' });
    d.step(def.cooldownMs - 4000, { frame: 1000 });
    expect(d.director.force(def.id).reason).toBe('cooldown');
    d.step(3000, { frame: 1000 });
    expect(d.director.force(def.id).ok).toBe(true);
    d.step(3000);
    expect(d.director.historyOf(def.id).count).toBe(2);
    d.step(def.cooldownMs + 1000, { frame: 1000 });
    expect(d.director.force(def.id)).toEqual({ ok: false, reason: 'max repeats reached' });
    expect(d.director.force('photo_first_change', { ignoreRequirements: true }).ok).toBe(true);
    d.step(9000, { frame: 100 });
    expect(d.director.force('photo_first_change', { ignoreRequirements: true }).reason).toBe('max repeats reached');
  });

  it('group spacing: a second photograph change must wait after the first', () => {
    const d = makeDirector();
    d.director.forcePhase('recognition');
    inspectPhoto(d, 2);
    expect(d.director.force('photo_first_change').ok).toBe(true);
    d.step(9000, { frame: 100 });
    expect(['removed', 'shifted']).toContain(d.world.get('photograph').state);
    expect(d.director.force('photo_gazing')).toEqual({ ok: false, reason: 'recent photo event' });
    d.step(120_000, { frame: 1000 });
    expect(d.director.force('photo_gazing').ok).toBe(true);
  });

  it('in free-running play, significant anomalies are followed by quiet, and cooldowns/maxRepeats hold', () => {
    const d = makeDirector(11);
    const decisions: DecisionRecord[] = [];
    d.director.emitter.on('decision', (x) => decisions.push(x));
    d.director.forcePhase('recognition');
    // Plenty of behavioral evidence so many anomalies are eligible.
    inspectPhoto(d, 3);
    d.telemetry.record({ type: 'object_inspected', target: 'clock', area: 'hallway', meta: {} });
    d.telemetry.record({ type: 'object_inspected', target: 'computer', area: 'desk', meta: {} });
    d.telemetry.record({ type: 'drawer_closed', target: 'drawer_top', area: 'desk', meta: {} });
    d.telemetry.record({ type: 'chair_moved', target: 'chair', area: 'desk', meta: {} });
    d.telemetry.record({ type: 'object_picked_up', target: 'figurine', area: 'shelf', meta: {} });
    d.director.playerIdleMs = 10_000;
    d.step(30 * 60_000, { frame: 100, auto: true });

    const done = decisions.filter((x) => x.result === 'done');
    const significant = done.filter((x) => ANOMALY_BY_ID[x.anomalyId].significance !== 'ambient');
    expect(significant.length).toBeGreaterThanOrEqual(3);
    expect(decisions.some((x) => x.result === 'quiet')).toBe(true);
    for (const f of significant) {
      const quietMin = PACING.quietMs[ANOMALY_BY_ID[f.anomalyId].significance][0];
      const violating = decisions.filter((x) => x.result === 'scheduled' && x.t >= f.t && x.t < f.t + quietMin);
      expect(violating, `${f.anomalyId} at ${f.t}`).toEqual([]);
    }
    for (const def of ANOMALIES) {
      const runs = done.filter((x) => x.anomalyId === def.id);
      expect(runs.length, def.id).toBeLessThanOrEqual(def.maxRepeats);
      const sched = decisions.filter((x) => x.anomalyId === def.id && x.result === 'scheduled');
      for (const s of sched) {
        const prev = runs.filter((r) => r.t <= s.t).at(-1);
        if (prev) expect(s.t - prev.t, def.id).toBeGreaterThanOrEqual(def.cooldownMs);
      }
    }
    // Tension never exceeds the phase cap by more than one anomaly's worth.
    expect(d.observer.state.tension).toBeLessThanOrEqual(PACING.tensionCap.recognition + 0.25);
  });
});

describe('offscreen mutations never visibly teleport', () => {
  it('a chair that becomes attended mid-animation freezes in place and commits the partial change', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    const start = { ...d.world.get('chair') };
    expect(d.director.force('chair_rotate_slight').ok).toBe(true);
    d.step(700);
    const moving = d.world.get('chair').yaw!;
    expect(moving).not.toBeCloseTo(start.yaw!, 5);
    d.vis.set('chair', 'attended', d.clock.now);
    let frozen = { ...d.world.get('chair') };
    for (let i = 0; i < 200; i++) {
      d.step(16);
      expect(d.world.get('chair')).toEqual(frozen);
      frozen = { ...d.world.get('chair') };
    }
    // Stopped part-way: not snapped back, not completed.
    expect(Math.abs(frozen.yaw! - start.yaw!)).toBeGreaterThan(0);
    expect(Math.abs(frozen.yaw! - start.yaw!)).toBeLessThan(0.087);
    expect(frozen.state).toBe('original');
    const rec = d.world.historyOf('chair').at(-1)!;
    expect(rec.cause).toBe('chair_rotate_slight:partial');
    expect(rec.from.yaw).toBe(start.yaw);
    expect(rec.to.yaw).toBe(frozen.yaw);
    expect(d.world.historyOf('chair')).toHaveLength(1);
    expect(d.director.executor.running).toHaveLength(0);
    expect(d.world.claimOwner('chair')).toBeUndefined();
    expect(d.director.decisions.at(-1)).toMatchObject({ anomalyId: 'chair_rotate_slight', result: 'interrupted' });
    // A partial change is still a change: it counts toward history and cooldown.
    expect(d.director.historyOf('chair_rotate_slight').count).toBe(1);
  });

  it('an unseen animation completes with a single history record', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    const start = d.world.get('chair').yaw!;
    d.director.force('chair_rotate_slight');
    d.step(3000);
    const c = d.world.get('chair');
    expect(c.state).toBe('rotated_slight');
    expect(Math.abs(c.yaw! - start)).toBeCloseTo(0.087, 5);
    expect(d.world.historyOf('chair')).toHaveLength(1);
    expect(d.world.historyOf('chair')[0].cause).toBe('chair_rotate_slight');
  });

  it('a chair that is visible when the event is scheduled never starts moving', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    d.vis.set('chair', 'peripheral', 0);
    const before = { ...d.world.get('chair') };
    d.director.force('chair_rotate_slight');
    d.step(5000, { frame: 50 });
    expect(d.world.get('chair')).toEqual(before);
    // Looking away for less than the contract's minimum is not enough either.
    d.vis.set('chair', 'offscreen', d.clock.now);
    d.step(ANOMALY_BY_ID.chair_rotate_slight.visibility.minUnseenMs - 200, { frame: 50 });
    expect(d.world.get('chair')).toEqual(before);
  });
});

describe('multiple event systems cannot assign conflicting states to one object', () => {
  it('a second anomaly cannot claim a busy object; non-owners cannot write it; the player preempts', () => {
    const d = makeDirector();
    d.director.forcePhase('recognition');
    expect(d.director.force('chair_rotate_slight').ok).toBe(true);
    d.step(500);
    const owner = d.world.claimOwner('chair')!;
    expect(owner).toMatch(/^anomaly:chair_rotate_slight#/);
    expect(d.director.force('chair_creep')).toEqual({ ok: false, reason: 'chair busy' });
    expect(d.director.force('chair_face_wall')).toEqual({ ok: false, reason: 'chair busy' });

    // Even bypassing the director's gates, the executor's atomic claim refuses.
    const plan = { targets: ['chair' as const], evidence: [], steps: [{ op: 'set' as const, object: 'chair' as const, patch: { state: 'crept' } }] };
    expect(d.director.executor.start(ANOMALY_BY_ID.chair_creep, plan, d.director.ctx())).toBeNull();
    expect(d.world.apply('chair', { yaw: 0 }, { source: 'director', cause: 'chair_creep' })).toEqual({ ok: false, reason: `chair is claimed by ${owner}` });
    expect(d.world.claimOwner('chair')).toBe(owner);

    // The player grabs the chair: the running anomaly is interrupted and cleaned up.
    const yawAtGrab = d.world.get('chair').yaw;
    expect(d.world.claim('chair', 'player')).toBe(true);
    expect(d.director.executor.running).toHaveLength(0);
    expect(d.world.claimOwner('chair')).toBe('player');
    expect(d.director.decisions.at(-1)).toMatchObject({ anomalyId: 'chair_rotate_slight', result: 'interrupted', detail: 'player took the object' });
    expect(d.world.historyOf('chair').at(-1)!.cause).toBe('chair_rotate_slight:partial');
    expect(d.world.get('chair').yaw).toBe(yawAtGrab);
    d.step(2000);
    expect(d.world.get('chair').yaw).toBe(yawAtGrab);
    expect(d.world.apply('chair', { yaw: 1 }, { source: 'director', cause: 'chair_rotate_slight', owner })).toMatchObject({ ok: false });
    expect(d.world.apply('chair', { state: 'player_moved', x: -0.4, z: 0.1 }, { source: 'player', cause: 'drag' }).ok).toBe(true);
    d.world.release('chair', 'player');
    expect(d.world.claimOwner('chair')).toBeUndefined();
  });

  it('a player holding an object blocks anomalies from scheduling on it', () => {
    const d = makeDirector();
    d.director.forcePhase('inconsistency');
    d.world.claim('chair', 'player');
    expect(d.director.force('chair_rotate_slight')).toEqual({ ok: false, reason: 'chair claimed by player' });
  });

  it('cancelAll interrupts everything and releases every claim', () => {
    const d = makeDirector();
    d.director.forcePhase('recognition');
    d.world.apply('lamp', { state: 'on', on: true }, { source: 'player', cause: 'click' });
    d.telemetry.record({ type: 'lamp_toggled', target: 'lamp', meta: { on: true } });
    d.vis.set('lamp', 'attended', 0);
    d.vis.set('chair', 'attended', 0);
    expect(d.director.force('chair_rotate_slight').ok).toBe(true);
    expect(d.director.force('lamp_off_when_away').ok).toBe(true);
    d.step(100);
    expect(d.director.executor.running).toHaveLength(2);
    d.director.executor.cancelAll(d.director.ctx(), 'test');
    expect(d.director.executor.running).toHaveLength(0);
    expect(d.world.claimOwner('chair')).toBeUndefined();
    expect(d.world.claimOwner('lamp')).toBeUndefined();
    // Nothing happened, so nothing counts.
    expect(d.director.applied).toHaveLength(0);
    expect(d.world.get('lamp').on).toBe(true);
  });
});

describe('anticipation responses', () => {
  it('anticipate_door_handle turns the handle and returns it to 0 when the prediction moves away', () => {
    const d = makeDirector();
    d.director.forcePhase('anticipation');
    const p = d.observer.predictor;
    const door = pointerOn('door');
    p.predict({ pointer: door.pointer, pointerVelocity: { x: 0, y: 0 }, candidates: door.candidates, now: d.clock.now });
    expect(p.activeCommit?.target).toBe('door');
    expect(d.director.force('anticipate_door_handle').ok).toBe(true);
    const handle: number[] = [];
    d.step(1500, { each: () => handle.push(d.world.get('door').handle!) });
    expect(d.world.get('door').handle).toBeCloseTo(0.35, 5);
    expect(p.activeCommit?.response).toBe('anticipate_door_handle');
    expect(d.sink.sounds.some((s) => s.id === 'door_handle' && s.at === 'door')).toBe(true);
    // Hovering keeps it held.
    d.step(1000, { each: () => handle.push(d.world.get('door').handle!) });
    expect(d.world.get('door').handle).toBeCloseTo(0.35, 5);
    // The pointer moves to the lamp: the prediction target moves away.
    const lamp = pointerOn('lamp');
    p.predict({ pointer: lamp.pointer, pointerVelocity: { x: 0, y: 0 }, candidates: lamp.candidates, now: d.clock.now });
    expect(p.current?.target).toBe('lamp');
    const peak = handle.length;
    d.step(2500, { each: () => handle.push(d.world.get('door').handle!) });
    expect(d.world.get('door').handle).toBe(0);
    expect(Math.max(...handle)).toBeLessThanOrEqual(0.35 + 1e-9);
    for (let i = peak + 1; i < handle.length; i++) expect(handle[i]).toBeLessThanOrEqual(handle[i - 1] + 1e-12);
    // Door otherwise untouched, claim released, two history records (turn + return).
    expect(d.world.get('door')).toMatchObject({ state: 'ajar', open: 0.12, handle: 0 });
    expect(d.world.claimOwner('door')).toBeUndefined();
    expect(d.director.executor.running).toHaveLength(0);
    expect(d.world.historyOf('door').map((r) => r.cause)).toEqual(['anticipate_door_handle', 'anticipate_door_handle']);
    expect(d.director.anticipationsExecuted).toBe(1);
  });

  it('a player grabbing the door mid-turn interrupts the response without snapping the handle', () => {
    const d = makeDirector();
    d.director.forcePhase('anticipation');
    const door = pointerOn('door');
    d.observer.predictor.predict({ pointer: door.pointer, pointerVelocity: { x: 0, y: 0 }, candidates: door.candidates, now: d.clock.now });
    d.director.force('anticipate_door_handle');
    d.step(350);
    const mid = d.world.get('door').handle!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.35);
    d.world.claim('door', 'player');
    d.step(3000);
    expect(d.world.get('door').handle).toBe(mid);
    expect(d.director.executor.running).toHaveLength(0);
  });

  it('onPrediction launches one response per committed prediction, only in late phases', () => {
    const early = makeDirector();
    early.director.forcePhase('recognition');
    const door = pointerOn('door');
    early.observer.predictor.predict({ pointer: door.pointer, pointerVelocity: { x: 0, y: 0 }, candidates: door.candidates, now: 0 });
    early.director.onPrediction(0);
    expect(early.director.executor.running).toHaveLength(0);

    const d = makeDirector();
    d.director.forcePhase('anticipation');
    d.observer.predictor.predict({ pointer: door.pointer, pointerVelocity: { x: 0, y: 0 }, candidates: door.candidates, now: 0 });
    d.director.onPrediction(0);
    expect(d.director.executor.running).toHaveLength(1);
    expect(d.director.executor.running[0].def.anticipation).toBe(true);
    expect(d.observer.predictor.activeCommit?.response).toBe(d.director.executor.running[0].def.id);
    d.director.onPrediction(10);
    expect(d.director.executor.running).toHaveLength(1);
  });
});
