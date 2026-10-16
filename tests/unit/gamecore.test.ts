import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../src/core/layout';
import { ENDINGS, PHASE_REQUIREMENTS, type EndingId, type Phase, type PhaseMetrics } from '../../src/director/phaseMachine';
import { act, areaScores, CURIOUS, drive, makeCore, type Core } from './gamecore.helpers';

/** The player looks at whatever just changed, then examines it. */
function witnessing(c: Core): (x: Core) => void {
  const queue: { obj: ObjectId; at: number }[] = [];
  c.core.director.emitter.on('mutation', ({ objectId, recordId }) => {
    if (recordId !== null) queue.push({ obj: objectId, at: c.core.clock.now });
  });
  return (x) => {
    const now = x.core.clock.now;
    for (const w of [...queue]) {
      if (now - w.at === 1000) x.vis.set(w.obj, 'attended', now);
      if (now - w.at >= 2000) {
        act(x, 'object_inspected', w.obj, { durationMs: 1500 });
        x.vis.set(w.obj, 'offscreen', now);
        queue.splice(queue.indexOf(w), 1);
      }
    }
  };
}

const confrontationReady = (x: Core) => x.core.director.confrontationEvents >= 2 && x.core.director.gateways.length > 0;

function expectAllClaimsReleased(c: Core) {
  for (const id of c.core.world.ids()) expect(c.core.world.claimOwner(id), id).toBeUndefined();
}

function expectOnlyEnding(c: Core, ending: EndingId) {
  expect(c.core.director.gateways).toEqual([ending]);
  for (const other of ENDINGS.filter((e) => e !== ending)) {
    expect(c.core.requestEnding(other), other).toBe(false);
    expect(c.core.phase).toBe('confrontation');
  }
  expect(c.core.requestEnding(ending)).toBe(true);
  expect(c.core.phase).toBe('resolution');
  expect(c.core.director.ending).toBe(ending);
  expect(c.core.director.executor.running).toHaveLength(0);
  expectAllClaimsReleased(c);
}

/** A player who keeps away from the hallway and only tries the door handle. */
const AVOIDANT_SCORES = areaScores({ desk: 0.6, shelf: 0.5, table: 0.4, window: 0.4, photo_wall: 0.3 });
const AVOIDANT: typeof CURIOUS = [
  ['door_handle_tried', 'door'],
  ['object_inspected', 'note', { durationMs: 1000 }],
];
/** A creature of habit: the same few actions in the same order. */
const HABIT: typeof CURIOUS = [
  ['lamp_toggled', 'lamp', { meta: { on: true } }],
  ['drawer_opened', 'drawer_top'],
  ['lamp_toggled', 'lamp', { meta: { on: false } }],
  ['drawer_closed', 'drawer_top'],
];

function refusalPlayer(seed: number): Core {
  const c = makeCore(seed);
  drive(c, 200_000, { scores: AVOIDANT_SCORES, pointerTarget: null, moving: false, script: AVOIDANT, actionEveryMs: 20_000 });
  c.core.director.forcePhase('confrontation');
  return c;
}

function reversalPlayer(seed: number): Core {
  const c = makeCore(seed);
  drive(c, 200_000, { script: HABIT, actionEveryMs: 4000, pointerTarget: null });
  c.core.director.forcePhase('confrontation');
  return c;
}

describe('GameCore: time alone is never sufficient', () => {
  it('a passive player stays in normalcy and the room never changes', () => {
    const c = makeCore(5);
    const before = JSON.stringify(c.core.world.snapshot().objects);
    drive(c, 20 * 60_000, { pointerTarget: null, moving: false });
    expect(c.core.phase).toBe('normalcy');
    expect(JSON.stringify(c.core.world.snapshot().objects)).toBe(before);
    expect(c.core.world.mutationLog()).toHaveLength(0);
    expect(c.core.telemetry.query({ type: 'player_idle' }).length).toBe(1);
  });

  it('enough interactions but too few distinct objects stays in normalcy', () => {
    const c = makeCore(5);
    drive(c, 10 * 60_000, { script: HABIT.slice(0, 2), actionEveryMs: 3000 });
    expect(c.core.phase).toBe('normalcy');
  });
});

describe('GameCore: a full session through real metrics', () => {
  it('reaches confrontation by satisfying every guard, then the acknowledgment ending', () => {
    const c = makeCore(2);
    const transitions: { to: Phase; m: PhaseMetrics; inPrev: number }[] = [];
    c.core.director.emitter.on('phase', ({ from, to, at }) => {
      transitions.push({ to, m: c.core.director.metrics(), inPrev: at - c.core.director.phaseEnteredAt(from) });
    });
    // Every message must cite events that exist (and already happened) when it is shown.
    let messages = 0;
    c.core.narrative.emitter.on('message', (m) => {
      messages++;
      expect(m.refs.length).toBeGreaterThan(0);
      for (const id of m.refs) expect(c.core.telemetry.get(id)!.timestampMs).toBeLessThanOrEqual(m.createdAt);
    });
    drive(c, 60 * 60_000, { script: CURIOUS, each: witnessing(c), until: confrontationReady });

    expect(transitions.map((t) => t.to)).toEqual(['inconsistency', 'recognition', 'anticipation', 'confrontation']);
    const R = PHASE_REQUIREMENTS;
    const [toInc, toRec, toAnt, toCon] = transitions;
    expect(toInc.inPrev).toBeGreaterThanOrEqual(R.inconsistency.minPhaseMs);
    expect(toInc.m.interactions).toBeGreaterThanOrEqual(R.inconsistency.interactions);
    expect(toInc.m.distinctObjects).toBeGreaterThanOrEqual(R.inconsistency.distinctObjects);
    expect(toRec.inPrev).toBeGreaterThanOrEqual(R.recognition.minPhaseMs);
    expect(toRec.m.anomaliesApplied).toBeGreaterThanOrEqual(R.recognition.anomaliesApplied);
    expect(toRec.m.interactions).toBeGreaterThanOrEqual(R.recognition.interactions);
    expect(toAnt.inPrev).toBeGreaterThanOrEqual(R.anticipation.minPhaseMs);
    expect(toAnt.m.messagesShown).toBeGreaterThanOrEqual(R.anticipation.messagesShown);
    expect(toAnt.m.callbacksDelivered).toBeGreaterThanOrEqual(R.anticipation.callbacksDelivered);
    expect(toAnt.m.predictorInteractions).toBeGreaterThanOrEqual(R.anticipation.predictorInteractions);
    expect(toCon.inPrev).toBeGreaterThanOrEqual(R.confrontation.minPhaseMs);
    expect(toCon.m.anticipationsExecuted).toBeGreaterThanOrEqual(R.confrontation.anticipationsExecuted);
    expect(toCon.m.followerStage).toBeGreaterThanOrEqual(R.confrontation.followerStage);
    expect(toCon.m.tension).toBeGreaterThanOrEqual(R.confrontation.tension);

    // The player saw and examined changes.
    expect(messages).toBeGreaterThanOrEqual(2);
    expect(c.core.telemetry.count('anomaly_witnessed')).toBeGreaterThan(0);
    expect(c.core.telemetry.count('anomaly_investigated')).toBeGreaterThanOrEqual(4);

    const a = c.core.observer.endingAffinity();
    expect(a.acknowledgment).toBeGreaterThan(Math.max(a.refusal, a.reversal));
    expectOnlyEnding(c, 'acknowledgment');

    // After the ending, the director is done with the room.
    let directorChanges = 0;
    c.core.world.emitter.on('changed', (ch) => {
      if (ch.record?.source === 'director' || (ch.continuous && c.core.world.claimOwner(ch.objectId)?.startsWith('anomaly:'))) directorChanges++;
    });
    drive(c, 5 * 60_000, { script: CURIOUS });
    expect(directorChanges).toBe(0);
    expect(c.core.phase).toBe('resolution');
  });
});

describe('GameCore: each ending is reachable through its gateway', () => {
  it('refusal: a player who avoids the hallway and never investigates', () => {
    const c = refusalPlayer(1);
    drive(c, 30 * 60_000, { scores: AVOIDANT_SCORES, pointerTarget: null, moving: false, until: confrontationReady });
    expect(c.core.observer.state.avoidance).toBeGreaterThan(0.6);
    expect(c.core.telemetry.query({ type: 'area_avoided' }).some((e) => e.area === 'hallway')).toBe(true);
    const a = c.core.observer.endingAffinity();
    expect(a.refusal).toBeGreaterThan(Math.max(a.acknowledgment, a.reversal));
    expectOnlyEnding(c, 'refusal');
  });

  it('reversal: a predictable player who repeats the same actions', () => {
    const c = reversalPlayer(1);
    drive(c, 30 * 60_000, { script: HABIT, actionEveryMs: 4000, pointerTarget: null, until: confrontationReady });
    expect(c.core.observer.state.predictability).toBeGreaterThan(0.5);
    const a = c.core.observer.endingAffinity();
    expect(a.reversal).toBeGreaterThan(Math.max(a.acknowledgment, a.refusal));
    expectOnlyEnding(c, 'reversal');
  });

  it('no ending can begin before two confrontation events, even with all affinity in place', () => {
    const c = reversalPlayer(3);
    expect(c.core.phase).toBe('confrontation');
    expect(c.core.director.confrontationEvents).toBe(0);
    // Hold the director's own scheduling back so nothing else happens.
    for (let i = 0; i < 20; i++) {
      c.core.clock.advance(500);
      c.core.director.resetScheduling(c.core.clock.now);
      c.core.tick(0);
    }
    expect(c.core.director.gateways).toEqual([]);
    for (const e of ENDINGS) expect(c.core.requestEnding(e), e).toBe(false);
    expect(c.core.phase).toBe('confrontation');
  });

  it('endings cannot be requested before confrontation', () => {
    const c = makeCore(4);
    for (const e of ENDINGS) expect(c.core.requestEnding(e)).toBe(false);
    c.core.director.forcePhase('anticipation');
    for (const e of ENDINGS) expect(c.core.requestEnding(e)).toBe(false);
    expect(c.core.phase).toBe('anticipation');
  });

  it('after enough time in confrontation every gateway opens', () => {
    const c = reversalPlayer(2);
    drive(c, 30 * 60_000, { script: HABIT, actionEveryMs: 4000, pointerTarget: null, until: confrontationReady });
    expect(c.core.director.gateways).toEqual(['reversal']);
    expect(c.core.requestEnding('acknowledgment')).toBe(false);
    const entered = c.core.director.phaseEnteredAt('confrontation');
    drive(c, 30 * 60_000, { script: HABIT, actionEveryMs: 4000, pointerTarget: null, until: (x) => x.core.director.gateways.length === 3 });
    expect(c.core.clock.now - entered).toBeGreaterThan(360_000);
    expect([...c.core.director.gateways].sort()).toEqual([...ENDINGS].sort());
    expect(c.core.requestEnding('acknowledgment')).toBe(true);
    expect(c.core.director.ending).toBe('acknowledgment');
  });
});

describe('GameCore persistence', () => {
  it('snapshot/restore round-trips the session', () => {
    const c = makeCore(8);
    drive(c, 4 * 60_000, { script: CURIOUS });
    const snap = JSON.parse(JSON.stringify(c.core.snapshot()));
    const d = makeCore(8);
    d.core.restore(snap);
    expect(d.core.clock.now).toBe(c.core.clock.now);
    expect(d.core.phase).toBe(c.core.phase);
    for (const id of c.core.world.ids()) expect(d.core.world.get(id)).toEqual(c.core.world.get(id));
    expect(d.core.telemetry.all()).toEqual(c.core.telemetry.all());
    expect(d.core.telemetry.interactionCount()).toBe(c.core.telemetry.interactionCount());
    expect(d.core.observer.state).toEqual(c.core.observer.state);
    expect(d.core.narrative.messagesShown).toBe(c.core.narrative.messagesShown);
    expect(d.core.rng.getState()).toBe(c.core.rng.getState());
  });

  it('the same seed and the same inputs replay the same session', () => {
    const run = () => {
      const c = makeCore(12);
      drive(c, 8 * 60_000, { script: CURIOUS });
      return { phase: c.core.phase, log: c.core.world.mutationLog().map((r) => `${r.objectId}:${r.cause}@${r.timestampMs}`), events: c.core.telemetry.all().length };
    };
    expect(run()).toEqual(run());
  });
});
