import { describe, expect, it } from 'vitest';
import { createPhaseActor, PHASE_REQUIREMENTS, phaseOf, type Phase, type PhaseMetrics } from '../../src/director/phaseMachine';

const zero: PhaseMetrics = {
  now: 0,
  interactions: 0,
  distinctObjects: 0,
  distinctAreas: 0,
  anomaliesApplied: 0,
  anomaliesWitnessed: 0,
  anomaliesInvestigated: 0,
  messagesShown: 0,
  callbacksDelivered: 0,
  anticipationsExecuted: 0,
  followerStage: 0,
  confrontationEvents: 0,
  predictorInteractions: 0,
  familiarity: 0,
  tension: 0,
};

/** Metrics that exactly meet every requirement of the transition into `to`, entered at `enteredAt`. */
function meeting(to: Exclude<Phase, 'normalcy' | 'resolution'>, enteredAt: number): PhaseMetrics {
  const R = PHASE_REQUIREMENTS;
  switch (to) {
    case 'inconsistency':
      return { ...zero, now: enteredAt + R.inconsistency.minPhaseMs, interactions: R.inconsistency.interactions, distinctObjects: R.inconsistency.distinctObjects };
    case 'recognition':
      return { ...zero, now: enteredAt + R.recognition.minPhaseMs, anomaliesApplied: R.recognition.anomaliesApplied, interactions: R.recognition.interactions, anomaliesWitnessed: 1 };
    case 'anticipation':
      return {
        ...zero,
        now: enteredAt + R.anticipation.minPhaseMs,
        messagesShown: R.anticipation.messagesShown,
        callbacksDelivered: R.anticipation.callbacksDelivered,
        predictorInteractions: R.anticipation.predictorInteractions,
      };
    case 'confrontation':
      return {
        ...zero,
        now: enteredAt + R.confrontation.minPhaseMs,
        anticipationsExecuted: R.confrontation.anticipationsExecuted,
        followerStage: R.confrontation.followerStage,
        tension: R.confrontation.tension,
      };
  }
}

const PREV: Record<string, Phase> = { inconsistency: 'normalcy', recognition: 'inconsistency', anticipation: 'recognition', confrontation: 'anticipation' };

function actorIn(phase: Phase, at = 1000) {
  const a = createPhaseActor();
  if (phase !== 'normalcy') a.send({ type: 'FORCE', phase: phase as Exclude<Phase, 'resolution'>, now: at });
  expect(phaseOf(a)).toBe(phase);
  return a;
}

describe('phase transitions require their defined conditions', () => {
  it('elapsed time alone never leaves normalcy', () => {
    const a = createPhaseActor();
    for (const now of [75_000, 600_000, 10_000_000]) a.send({ type: 'EVALUATE', metrics: { ...zero, now, familiarity: 1, tension: 1 } });
    expect(phaseOf(a)).toBe('normalcy');
  });

  for (const to of ['inconsistency', 'recognition', 'anticipation', 'confrontation'] as const) {
    describe(`→ ${to}`, () => {
      const from = PREV[to];
      const entered = from === 'normalcy' ? 0 : 1000;

      it('transitions when every requirement is met', () => {
        const a = actorIn(from, entered);
        a.send({ type: 'EVALUATE', metrics: meeting(to, entered) });
        expect(phaseOf(a)).toBe(to);
        expect(a.getSnapshot().context.enteredAt[to]).toBe(meeting(to, entered).now);
      });

      it('does not transition with elapsed time alone', () => {
        const a = actorIn(from, entered);
        a.send({ type: 'EVALUATE', metrics: { ...zero, now: entered + 10_000_000 } });
        expect(phaseOf(a)).toBe(from);
      });

      const met = meeting(to, entered);
      const keys = (Object.keys(met) as (keyof PhaseMetrics)[]).filter((k) => met[k] !== zero[k] && k !== 'anomaliesWitnessed');
      for (const k of keys) {
        it(`stays when ${k} is just under its requirement`, () => {
          const a = actorIn(from, entered);
          const under = { ...met, [k]: k === 'tension' ? met[k] - 0.001 : met[k] - 1 };
          a.send({ type: 'EVALUATE', metrics: under });
          expect(phaseOf(a)).toBe(from);
          // Plenty of extra time does not compensate for a missing behavioral condition.
          if (k !== 'now') {
            a.send({ type: 'EVALUATE', metrics: { ...under, now: met.now + 1_000_000 } });
            expect(phaseOf(a)).toBe(from);
          }
          a.send({ type: 'EVALUATE', metrics: met });
          expect(phaseOf(a)).toBe(to);
        });
      }
    });
  }

  it('recognition accepts many interactions instead of a witnessed anomaly', () => {
    const base = meeting('recognition', 1000);
    const a = actorIn('inconsistency');
    a.send({ type: 'EVALUATE', metrics: { ...base, anomaliesWitnessed: 0, interactions: 21 } });
    expect(phaseOf(a)).toBe('inconsistency');
    a.send({ type: 'EVALUATE', metrics: { ...base, anomaliesWitnessed: 0, interactions: 22 } });
    expect(phaseOf(a)).toBe('recognition');
  });

  it('phases cannot be skipped by evaluation', () => {
    const a = createPhaseActor();
    a.send({ type: 'EVALUATE', metrics: meeting('confrontation', 0) });
    a.send({ type: 'EVALUATE', metrics: meeting('anticipation', 0) });
    expect(phaseOf(a)).toBe('normalcy');
  });

  it('resolution requires an open gateway and two confrontation events', () => {
    const a = actorIn('confrontation');
    const m = { ...zero, now: 5000, confrontationEvents: 2 };
    a.send({ type: 'BEGIN_ENDING', ending: 'refusal', metrics: m });
    expect(phaseOf(a)).toBe('confrontation'); // gateway closed
    a.send({ type: 'GATEWAYS', gateways: ['refusal'] });
    a.send({ type: 'BEGIN_ENDING', ending: 'refusal', metrics: { ...m, confrontationEvents: 1 } });
    expect(phaseOf(a)).toBe('confrontation');
    a.send({ type: 'BEGIN_ENDING', ending: 'reversal', metrics: m });
    expect(phaseOf(a)).toBe('confrontation');
    a.send({ type: 'BEGIN_ENDING', ending: 'refusal', metrics: m });
    expect(phaseOf(a)).toBe('resolution');
    expect(a.getSnapshot().value).toEqual({ resolution: 'refusal' });
  });

  it('endings cannot begin outside confrontation', () => {
    const a = actorIn('anticipation');
    a.send({ type: 'GATEWAYS', gateways: ['acknowledgment'] });
    a.send({ type: 'BEGIN_ENDING', ending: 'acknowledgment', metrics: { ...zero, confrontationEvents: 5 } });
    expect(phaseOf(a)).toBe('anticipation');
  });
});
