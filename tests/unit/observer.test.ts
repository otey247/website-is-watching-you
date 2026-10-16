import { describe, expect, it } from 'vitest';
import { AREA_IDS, type AreaId, type ObjectId } from '../../src/core/layout';
import { Observer } from '../../src/observer/Observer';
import { Predictor, type PredictionCandidate } from '../../src/observer/Predictor';
import { Telemetry } from '../../src/telemetry/Telemetry';
import { pointerOn } from './helpers';

function make() {
  let t = 0;
  const tel = new Telemetry(() => t);
  const obs = new Observer(tel);
  return { tel, obs, at: (v: number) => (t = v), now: () => t };
}

const scores = (m: Partial<Record<AreaId, number>>) => new Map(AREA_IDS.map((a) => [a, m[a] ?? 0] as [AreaId, number]));

describe('Observer interest', () => {
  it('repeated interactions raise interest in that object', () => {
    const { tel, obs } = make();
    expect(obs.interestOf('photograph')).toBe(0);
    let prev = 0;
    for (let i = 0; i < 4; i++) {
      tel.record({ type: 'object_inspected', target: 'photograph', area: 'photo_wall', durationMs: 3000, meta: {} });
      expect(obs.interestOf('photograph')).toBeGreaterThan(prev);
      prev = obs.interestOf('photograph');
    }
    tel.record({ type: 'object_inspected', target: 'clock', area: 'hallway', durationMs: 3000, meta: {} });
    expect(obs.interestShare('photograph')).toBeGreaterThan(obs.interestShare('clock'));
    expect(obs.profile().mostInspected).toBe('photograph');
    expect(obs.profile().mostInspectedCount).toBe(4);
    expect(obs.state.familiarity).toBeGreaterThan(0);
  });

  it('derived signals do not count as interest', () => {
    const { tel, obs } = make();
    tel.record({ type: 'anomaly_witnessed', target: 'chair', meta: {} });
    tel.record({ type: 'object_hesitated', target: 'door', durationMs: 1200, meta: { outcome: 'abandoned' } });
    expect(obs.interestOf('chair')).toBe(0);
    expect(obs.interestOf('door')).toBe(0);
    expect(obs.predictor.interactions).toBe(0);
  });

  it('interest decays slowly over active time, not instantly', () => {
    const { tel, obs } = make();
    tel.record({ type: 'object_inspected', target: 'mirror', meta: {} });
    const v = obs.interestOf('mirror');
    obs.update(300_000);
    expect(obs.interestOf('mirror')).toBeCloseTo(v / 2);
  });
});

describe('Observer avoidance requires sufficient evidence', () => {
  it('is zero before the active-time and sample thresholds even with zero attention to an area', () => {
    const { obs } = make();
    // 140 s of play, the hallway never looked at.
    for (let i = 0; i < 1400; i++) obs.sampleAttention(scores({ desk: 0.6, shelf: 0.5, table: 0.4, window: 0.4 }), 100, false, 0, false);
    expect(obs.activeTimeMs).toBe(140_000);
    expect(obs.avoidanceOf('hallway')).toBe(0);
    obs.update(100);
    expect(obs.state.avoidance).toBe(0);
  });

  it('is zero after long play when there were no attention samples at all', () => {
    const { obs } = make();
    for (let i = 0; i < 3000; i++) obs.sampleAttention(scores({}), 100, false, 0, false);
    expect(obs.activeTimeMs).toBe(300_000);
    expect(obs.avoidanceOf('hallway')).toBe(0);
  });

  it('becomes positive after enough active samples with the area ignored', () => {
    const { obs } = make();
    for (let i = 0; i < 1600; i++) obs.sampleAttention(scores({ desk: 0.6, shelf: 0.5, table: 0.4, window: 0.4, photo_wall: 0.3, mirror: 0.3, lamp_corner: 0.3 }), 100, false, 0, false);
    expect(obs.avoidanceOf('hallway')).toBeGreaterThan(0.6);
    // Areas that received a fair share are not avoided.
    expect(obs.avoidanceOf('desk')).toBe(0);
    obs.update(100);
    expect(obs.state.avoidance).toBeGreaterThan(0.6);
    expect(obs.areaAvoidance.get('hallway')).toBeGreaterThan(0.6);
  });

  it('declined opportunities add evidence', () => {
    const a = make();
    const b = make();
    for (const m of [a, b]) for (let i = 0; i < 1600; i++) m.obs.sampleAttention(scores({ desk: 0.6, shelf: 0.5, table: 0.4, window: 0.4, mirror: 0.2, photo_wall: 0.2, lamp_corner: 0.2, hallway: 0.03 }), 100, false, 0, false);
    b.tel.record({ type: 'object_hesitated', target: 'door', durationMs: 1500, meta: { outcome: 'abandoned' } });
    b.tel.record({ type: 'sound_reacted', area: 'hallway', meta: { reacted: false, area: 'hallway' } });
    expect(a.obs.avoidanceOf('hallway')).toBeGreaterThan(0);
    expect(b.obs.avoidanceOf('hallway')).toBeGreaterThan(a.obs.avoidanceOf('hallway'));
  });
});

describe('Predictor', () => {
  const A: ObjectId = 'lamp';
  const B: ObjectId = 'drawer_top';
  const C: ObjectId = 'clock';

  it('repeated A→B sequences raise P(B|A)', () => {
    const p = new Predictor();
    const before = p.transitionProbability(A, B, 3);
    expect(before).toBeCloseTo(1 / 3);
    let t = 0;
    let last = before;
    for (let i = 0; i < 6; i++) {
      p.observe(A, (t += 1000));
      p.observe(B, (t += 1000));
      const now = p.transitionProbability(A, B, 3);
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(p.transitionProbability(A, C, 3)).toBeLessThan(0.1);
    // The last target was B, and history says B is followed by A.
    expect(p.historicalNext([A, B, C])?.id).toBe(A);
  });

  it('prediction confidence for B after A grows with interaction history', () => {
    const p = new Predictor();
    const noPointer = (now: number) => ({
      pointer: null,
      pointerVelocity: { x: 0, y: 0 },
      now,
      candidates: [A, B, C].map((id): PredictionCandidate => ({ id, ndc: { x: 0, y: 0 }, centerAngle: 0.5, dwellMs: 0 })),
    });
    p.observe(A, 0);
    const early = p.predict(noPointer(10)).ranked.find((r) => r.id === B)!.p;
    let t = 100;
    for (let i = 0; i < 8; i++) {
      p.observe(B, (t += 3000));
      p.observe(A, (t += 3000));
    }
    const late = p.predict(noPointer((t += 10))).ranked.find((r) => r.id === B)!;
    expect(late.p).toBeGreaterThan(early);
    expect(p.current?.ranked[0].id).toBe(B);
  });

  it('online learning increases the weight of features that predicted the actual choice', () => {
    const p = new Predictor();
    const w0 = p.weights.proximity;
    const { pointer, candidates } = pointerOn('lamp', ['clock', 'mirror']);
    p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 1000 });
    p.observe('lamp', 1200);
    expect(p.weights.proximity).toBeGreaterThan(w0);
    // A stale prediction (> 2 s old) does not train the weights.
    const w1 = { ...p.weights };
    p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 5000 });
    p.observe('lamp', 9000);
    expect(p.weights).toEqual(w1);
  });

  it('commits high-confidence predictions and resolves them as hit, miss or expired', () => {
    const p = new Predictor();
    const { pointer, candidates } = pointerOn('door');
    const pred = p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 0 });
    expect(pred.target).toBe('door');
    expect(pred.confidence).toBeGreaterThan(0.5);
    expect(p.activeCommit?.target).toBe('door');
    expect(p.accuracy()).toBe(0.5);

    expect(p.observe('door', 500)?.outcome).toBe('hit');
    expect(p.activeCommit).toBeNull();

    p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 1000 });
    expect(p.observe('lamp', 1500)?.outcome).toBe('miss');
    // A miss makes the predictor more cautious about that target.
    expect(p.thresholdFor('door')).toBeCloseTo(0.5 - 0.03 + 0.06);

    p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 2000 });
    p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: 7000 });
    expect(p.resolved.map((r) => r.outcome)).toEqual(['hit', 'miss', 'expired']);
  });

  it('accuracy tracks hit rate over resolved predictions', () => {
    const p = new Predictor();
    const { pointer, candidates } = pointerOn('door');
    let t = 0;
    for (let i = 0; i < 10; i++) {
      p.predict({ pointer, pointerVelocity: { x: 0, y: 0 }, candidates, now: (t += 1000) });
      p.observe('door', (t += 100));
    }
    expect(p.accuracy()).toBeGreaterThan(0.85);
  });

  it('snapshot/restore preserves the model', () => {
    const p = new Predictor();
    p.observe(A, 0);
    p.observe(B, 1000);
    const q = new Predictor();
    q.restore(JSON.parse(JSON.stringify(p.snapshot())));
    expect(q.transitionProbability(A, B, 3)).toBe(p.transitionProbability(A, B, 3));
    expect(q.interactions).toBe(2);
  });
});

describe('Observer ending affinity', () => {
  it('investigation drives acknowledgment; avoidance and door attempts drive refusal', () => {
    const ack = make();
    for (let i = 0; i < 4; i++) {
      ack.tel.record({ type: 'anomaly_witnessed', target: 'photograph', meta: {} });
      ack.tel.record({ type: 'anomaly_investigated', target: 'photograph', meta: {} });
    }
    const a = ack.obs.endingAffinity();
    expect(a.acknowledgment).toBeGreaterThan(a.refusal);
    expect(a.acknowledgment).toBeGreaterThan(a.reversal);

    const ref = make();
    for (let i = 0; i < 1600; i++) ref.obs.sampleAttention(scores({ desk: 0.6, shelf: 0.5, table: 0.4, window: 0.4 }), 100, false, 0, false);
    ref.obs.update(100);
    for (let i = 0; i < 3; i++) ref.tel.record({ type: 'door_handle_tried', target: 'door', meta: {} });
    const r = ref.obs.endingAffinity();
    expect(r.refusal).toBeGreaterThan(r.acknowledgment);
    expect(r.refusal).toBeGreaterThan(r.reversal);
  });
});
