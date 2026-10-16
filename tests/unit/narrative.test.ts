import { describe, expect, it } from 'vitest';
import { OBJECT_IDS, PLACEMENTS, type ObjectId } from '../../src/core/layout';
import { Rng } from '../../src/core/rng';
import { PHASES, type Phase } from '../../src/director/phaseMachine';
import type { DialogueModel, DialogueProposal } from '../../src/narrative/llm';
import { isLocalEndpoint, LocalOllamaAdapter, parseProposal } from '../../src/narrative/llm';
import { Narrative } from '../../src/narrative/Narrative';
import { agoPhrase, callbackSentence, fill, TEMPLATES } from '../../src/narrative/templates';
import type { AppliedAnomaly, NarrativeContext } from '../../src/narrative/types';
import { validateStatement } from '../../src/narrative/validator';
import { Observer } from '../../src/observer/Observer';
import { Telemetry } from '../../src/telemetry/Telemetry';
import { ACTION_TYPES, type ActionType } from '../../src/telemetry/types';
import { WorldState } from '../../src/world/WorldState';

function session() {
  let t = 0;
  const now = () => t;
  const telemetry = new Telemetry(now);
  const world = new WorldState(now);
  const observer = new Observer(telemetry);
  const ctx = (phase: Phase, applied: AppliedAnomaly[] = []): NarrativeContext => ({ now: t, phase, telemetry, world, observer, applied, predictions: [] });
  return { telemetry, world, observer, ctx, at: (v: number) => (t = v), now };
}

const FAKE_APPLIED: AppliedAnomaly[] = [
  { anomalyId: 'returning_object', targets: ['book_1'], at: 1000, evidence: [] },
  { anomalyId: 'photo_first_change', targets: ['photograph'], at: 2000, evidence: [] },
  { anomalyId: 'chair_creep', targets: ['chair'], at: 3000, evidence: [] },
  { anomalyId: 'clock_lose_seconds', targets: ['clock'], at: 4000, evidence: [] },
  { anomalyId: 'drawer_ajar', targets: ['drawer_top'], at: 5000, evidence: [] },
];

/** A dense, realistic session that satisfies many templates at once. */
function richSession() {
  const s = session();
  const r = (type: ActionType, target?: ObjectId, meta: Record<string, string | number | boolean> = {}, durationMs?: number) =>
    s.telemetry.record({ type, target, area: target ? PLACEMENTS[target].area : undefined, meta, durationMs });
  let t = 0;
  const next = (ms = 2000) => s.at((t += ms));
  r('session_started');
  for (let i = 0; i < 3; i++) (next(), r('object_inspected', 'photograph', {}, 6000));
  next(), r('drawer_opened', 'drawer_top');
  next(), r('drawer_closed', 'drawer_top');
  next(), r('drawer_opened', 'drawer_top');
  next(), r('lamp_toggled', 'lamp', { on: true });
  next(), r('lamp_toggled', 'lamp', { on: false });
  next(), r('lamp_toggled', 'lamp', { on: true });
  next(), r('lamp_toggled', 'lamp', { on: false });
  next(), r('lamp_toggled', 'lamp', { on: true });
  next(), r('lamp_toggled', 'lamp', { on: false });
  next(), r('lamp_toggled', 'lamp', { on: true });
  s.world.apply('lamp', { state: 'on', on: true }, { source: 'player', cause: 'click' });
  next(), r('chair_moved', 'chair');
  next(), r('door_handle_tried', 'door');
  next(), r('object_hesitated', 'door', { outcome: 'abandoned' }, 1500);
  next(), r('look_away_test', 'chair', { cycles: 2 });
  next(), r('look_away_test', 'photograph', { cycles: 2 });
  for (let i = 0; i < 4; i++) (next(), r('anomaly_witnessed', 'photograph'), r('anomaly_investigated', 'photograph'));
  next(), r('prediction_resolved', 'lamp', { predicted: 'door', outcome: 'miss' });
  next(), r('prediction_resolved', 'clock', { predicted: 'clock', outcome: 'hit' });
  next(), r('object_placed', 'book_1', { slot: 's1_b' });
  next(), r('player_idle', undefined, {}, 13000);
  next(), r('message_read', 'computer', {}, 900);
  next(70_000), s.telemetry.record({ type: 'area_avoided', area: 'hallway', meta: { score: 0.7 } });
  return s;
}

describe('templates never reference nonexistent actions', () => {
  it('with an empty telemetry every template has no evidence, in every phase', () => {
    for (const lampOn of [false, true]) {
      const s = session();
      s.at(600_000);
      if (lampOn) s.world.apply('lamp', { state: 'on', on: true }, { source: 'player', cause: 'click' });
      for (const phase of PHASES) {
        for (const t of TEMPLATES) {
          expect(t.evidence(s.ctx(phase, FAKE_APPLIED)), `${t.id} in ${phase}`).toBeNull();
          expect(t.evidence(s.ctx(phase, [])), `${t.id} in ${phase}`).toBeNull();
        }
      }
      const n = new Narrative(s.telemetry, new Rng(1));
      for (const phase of PHASES) expect(n.candidates(s.ctx(phase, FAKE_APPLIED))).toEqual([]);
      expect(n.callbackMessage(s.ctx('recognition'))).toBeNull();
    }
  });

  it('only derived/non-matching events still produce no evidence', () => {
    const s = session();
    s.telemetry.record({ type: 'session_started', meta: {} });
    s.telemetry.record({ type: 'area_glanced', area: 'desk', meta: {} });
    s.telemetry.record({ type: 'object_inspected', target: 'photograph', meta: {} });
    s.at(10_000);
    for (const t of TEMPLATES) expect(t.evidence(s.ctx('confrontation', [])), t.id).toBeNull();
  });

  it('with a rich session, every produced reference exists and supports the statement', () => {
    const s = richSession();
    let produced = 0;
    for (const t of TEMPLATES) {
      for (const phase of t.phases) {
        const ev = t.evidence(s.ctx(phase, FAKE_APPLIED));
        if (!ev) continue;
        produced++;
        expect(ev.refs.length, t.id).toBeGreaterThan(0);
        for (const id of ev.refs) expect(s.telemetry.get(id), `${t.id} ref ${id}`).toBeDefined();
        const text = fill(t.text, ev.facts);
        expect(text).not.toMatch(/[{}]/);
        expect(validateStatement({ text, refs: ev.refs, facts: ev.facts }, s.telemetry).ok, `${t.id}: ${text}`).toBe(true);
      }
    }
    expect(produced).toBeGreaterThan(12);
    // Spot-check semantic support.
    const tel = s.telemetry;
    const photo = TEMPLATES.find((t) => t.id === 'photo_repeat')!.evidence(s.ctx('recognition'))!;
    expect(photo.refs.every((id) => tel.get(id)!.type === 'object_inspected' && tel.get(id)!.target === 'photograph')).toBe(true);
    const chair = TEMPLATES.find((t) => t.id === 'chair_moved')!.evidence(s.ctx('recognition'))!;
    expect(tel.get(chair.refs[0])!.type).toBe('chair_moved');
    const returned = TEMPLATES.find((t) => t.id === 'book_returned')!.evidence(s.ctx('anticipation', FAKE_APPLIED))!;
    expect(tel.get(returned.refs[0])).toMatchObject({ type: 'object_placed', target: 'book_1' });
    // The door was opened: door templates no longer hold.
    tel.record({ type: 'door_opened', target: 'door', meta: {} });
    expect(TEMPLATES.find((t) => t.id === 'door_not_opened')!.evidence(s.ctx('recognition'))).toBeNull();
    expect(TEMPLATES.find((t) => t.id === 'hallway_avoided')!.evidence(s.ctx('recognition'))).toBeNull();
  });

  it('fuzzed sessions: any evidence a template returns references recorded events', () => {
    const rng = new Rng(2024);
    const targets = OBJECT_IDS.filter((id) => PLACEMENTS[id].interaction !== 'none');
    for (let run = 0; run < 25; run++) {
      const s = session();
      let t = 0;
      const n = rng.int(5, 120);
      for (let i = 0; i < n; i++) {
        s.at((t += rng.range(100, 9000)));
        const type = rng.pick(ACTION_TYPES);
        const target = rng.chance(0.85) ? rng.pick(targets) : undefined;
        s.telemetry.record({
          type,
          target,
          area: target ? PLACEMENTS[target].area : rng.pick(['hallway', 'desk', 'shelf'] as const),
          durationMs: rng.int(0, 9000),
          meta: { on: rng.chance(0.5), open: rng.chance(0.5), outcome: rng.pick(['hit', 'miss', 'expired', 'abandoned']), predicted: rng.pick(targets), slot: rng.pick(['s1_b', 's3_a']) },
        });
      }
      for (const tpl of TEMPLATES) {
        for (const phase of tpl.phases) {
          const ev = tpl.evidence(s.ctx(phase, FAKE_APPLIED));
          if (!ev) continue;
          expect(ev.refs.length).toBeGreaterThan(0);
          for (const id of ev.refs) expect(s.telemetry.get(id)).toBeDefined();
        }
      }
      const narrative = new Narrative(s.telemetry, new Rng(run));
      for (const phase of PHASES) {
        for (const c of narrative.candidates(s.ctx(phase, FAKE_APPLIED))) {
          expect(c.template.phases).toContain(phase);
          expect(validateStatement(c, s.telemetry).ok).toBe(true);
        }
      }
    }
  });

  it('templates are restricted to their phases and once-only lines do not repeat', () => {
    const s = richSession();
    const n = new Narrative(s.telemetry, new Rng(3));
    expect(n.candidates(s.ctx('normalcy', FAKE_APPLIED))).toEqual([]);
    expect(n.candidates(s.ctx('inconsistency', FAKE_APPLIED))).toEqual([]);
    const first = n.candidates(s.ctx('recognition', FAKE_APPLIED))[0];
    expect(first).toBeDefined();
    n.deliver({ templateId: first.template.id, intent: first.template.intent, text: first.text, refs: first.refs, facts: first.facts }, s.now());
    expect(n.messagesShown).toBe(1);
    for (const id of first.refs) expect(s.telemetry.get(id)!.usedBy).toContain(`narrative:${first.template.id}`);
    expect(n.candidates(s.ctx('recognition', FAKE_APPLIED)).some((c) => c.template.id === first.template.id)).toBe(false);
  });
});

describe('validateStatement', () => {
  function tel() {
    const t = new Telemetry(() => 0);
    const lamp = t.record({ type: 'lamp_toggled', target: 'lamp', meta: { on: true } });
    const photo = t.record({ type: 'object_inspected', target: 'photograph', meta: {} });
    const drawer1 = t.record({ type: 'drawer_opened', target: 'drawer_top', meta: {} });
    const drawer2 = t.record({ type: 'drawer_opened', target: 'drawer_top', meta: {} });
    return { t, lamp, photo, drawer1, drawer2 };
  }

  it('strict mode accepts text that only mentions evidenced objects and numbers', () => {
    const { t, photo, lamp } = tel();
    expect(validateStatement({ text: 'You looked at the picture.', refs: [photo.id], facts: {} }, t, { strict: true }).ok).toBe(true);
    expect(validateStatement({ text: 'The light was on. You did that.', refs: [lamp.id], facts: {} }, t, { strict: true }).ok).toBe(true);
  });

  it('strict mode rejects objects that are not in the evidence', () => {
    const { t, photo } = tel();
    const r = validateStatement({ text: 'You looked at the clock again.', refs: [photo.id], facts: {} }, t, { strict: true });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/clock/);
    expect(validateStatement({ text: 'You opened the drawer.', refs: [photo.id], facts: {} }, t, { strict: true }).ok).toBe(false);
  });

  it('strict mode rejects unsupported numbers and count words', () => {
    const { t, drawer1, drawer2 } = tel();
    const refs = [drawer1.id, drawer2.id];
    expect(validateStatement({ text: 'You opened the drawer twice.', refs, facts: { count: 2 } }, t, { strict: true }).ok).toBe(true);
    expect(validateStatement({ text: 'You opened the drawer 7 times.', refs, facts: { count: 2 } }, t, { strict: true }).ok).toBe(false);
    expect(validateStatement({ text: 'You opened the drawer five times.', refs, facts: { count: 2 } }, t, { strict: true }).ok).toBe(false);
    expect(validateStatement({ text: 'You opened the drawer 9 times.', refs, facts: { count: 9 } }, t, { strict: true }).ok).toBe(true);
  });

  it('strict mode requires supporting events, and any mode rejects unknown refs', () => {
    const { t } = tel();
    expect(validateStatement({ text: 'I am here.', refs: [], facts: {} }, t, { strict: true }).ok).toBe(false);
    expect(validateStatement({ text: 'I am here.', refs: [999], facts: {} }, t).ok).toBe(false);
    expect(validateStatement({ text: 'I am here.', refs: [], facts: {} }, t).ok).toBe(true);
  });

  it('rejects forbidden real-device and real-identity claims in every mode', () => {
    const { t, photo } = tel();
    const bad = [
      'I can see you through your webcam.',
      'I turned on the camera.',
      'Your microphone is on.',
      'I am inside your real computer.',
      'I read your files.',
      'I know your location.',
      'Your browser history is interesting.',
      'Visit https://example.com now.',
      'Please download this.',
      'I know who you are.',
      'You are afraid.',
      'Your device is infected.',
    ];
    for (const text of bad) {
      expect(validateStatement({ text, refs: [photo.id], facts: {} }, t).ok, text).toBe(false);
      expect(validateStatement({ text, refs: [photo.id], facts: {} }, t, { strict: true }).ok, text).toBe(false);
    }
  });

  it('rejects overly long or rambling statements', () => {
    const { t } = tel();
    expect(validateStatement({ text: 'x'.repeat(91), refs: [], facts: {} }, t).ok).toBe(false);
    expect(validateStatement({ text: 'One. Two. Three.', refs: [], facts: {} }, t).ok).toBe(false);
  });
});

describe('optional language model', () => {
  const fixed = (p: DialogueProposal | null): DialogueModel => ({ name: 'fake', propose: async () => p });

  it('falls back to the authored line when the model is invalid, and accepts valid variations', async () => {
    const s = session();
    const photo = s.telemetry.record({ type: 'object_inspected', target: 'photograph', meta: {} });
    const lamp = s.telemetry.record({ type: 'lamp_toggled', target: 'lamp', meta: {} });
    const n = new Narrative(s.telemetry, new Rng(1));
    const authored = { text: 'You keep looking at that picture.', refs: [photo.id], facts: {}, intent: 'observation' as const };
    const ctx = s.ctx('recognition');

    expect((await n.vary(authored, ctx)).source).toBe('template'); // no model

    n.model = fixed({ text: 'That picture again.', refs: [photo.id] });
    expect(await n.vary(authored, ctx)).toEqual({ text: 'That picture again.', refs: [photo.id], source: 'llm' });

    n.model = fixed({ text: 'You turned on the light.', refs: [lamp.id] }); // ref it was not given
    expect((await n.vary(authored, ctx)).text).toBe(authored.text);

    n.model = fixed({ text: 'You looked at the clock.', refs: [photo.id] }); // object not in evidence
    expect((await n.vary(authored, ctx)).source).toBe('template');

    n.model = fixed({ text: 'You looked at the picture 4 times.', refs: [photo.id] }); // number not in facts
    expect((await n.vary(authored, ctx)).source).toBe('template');

    n.model = fixed({ text: 'I see the picture through your webcam.', refs: [photo.id] });
    expect((await n.vary(authored, ctx)).source).toBe('template');

    n.model = fixed(null);
    expect((await n.vary(authored, ctx)).source).toBe('template');

    n.model = { name: 'broken', propose: async () => Promise.reject(new Error('down')) };
    expect((await n.vary(authored, ctx)).source).toBe('template');
  });

  it('only local endpoints are allowed and proposals are parsed defensively', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalEndpoint('https://api.example.com')).toBe(false);
    expect(isLocalEndpoint('not a url')).toBe(false);
    expect(() => new LocalOllamaAdapter('https://api.example.com')).toThrow();
    expect(parseProposal('{"text":"Hi.","refs":[1,"x",2.5,3]}')).toEqual({ text: 'Hi.', refs: [1, 3] });
    expect(parseProposal('nope')).toBeNull();
    expect(parseProposal('{"text":3,"refs":[]}')).toBeNull();
  });
});

describe('delayed callbacks respect recorded timestamps', () => {
  it('agoPhrase follows the recorded timestamp', () => {
    expect(agoPhrase(10_000, 0)).toBe('just now');
    expect(agoPhrase(60_000, 0)).toBe('a minute ago');
    expect(agoPhrase(3 * 60_000, 0)).toBe('a few minutes ago');
    expect(agoPhrase(10 * 60_000, 0)).toBe('earlier');
    expect(agoPhrase(10 * 60_000 + 5000, 10 * 60_000)).toBe('just now');
  });

  function withCallback(type: ActionType, target: ObjectId, meta: Record<string, string | number | boolean> = {}, durationMs?: number) {
    for (let seed = 1; seed < 200; seed++) {
      const s = session();
      const n = new Narrative(s.telemetry, new Rng(seed));
      s.at(30_000);
      const e = s.telemetry.record({ type, target, area: PLACEMENTS[target].area, meta, durationMs });
      if (n.callbacks.length) return { s, n, e, entry: n.callbacks[0] };
    }
    throw new Error('no callback remembered');
  }

  it('a remembered action is not due before notBefore and is due after it', () => {
    const { s, n, e, entry } = withCallback('drawer_opened', 'drawer_top');
    expect(entry.eventId).toBe(e.id);
    expect(entry.notBefore).toBeGreaterThanOrEqual(e.timestampMs + 140_000);
    expect(entry.notBefore).toBeLessThanOrEqual(e.timestampMs + 320_000);
    expect(n.dueCallbacks(entry.notBefore - 1)).toEqual([]);
    s.at(entry.notBefore - 1);
    expect(n.callbackMessage(s.ctx('recognition'))).toBeNull();
    expect(n.dueCallbacks(entry.notBefore)).toEqual([entry]);
    s.at(entry.notBefore + 1000);
    const msg = n.callbackMessage(s.ctx('recognition'))!;
    expect(msg.refs).toEqual([e.id]);
    expect(msg.text).toBe(`You opened the drawer ${agoPhrase(entry.notBefore + 1000, e.timestampMs)}.`);
    n.deliver({ templateId: 'callback', intent: 'callback', text: msg.text, refs: msg.refs, facts: msg.facts }, s.now(), msg.entry);
    expect(n.callbacksDelivered).toBe(1);
    expect(n.dueCallbacks(s.now() + 1e6)).toEqual([]);
  });

  it('callbacks that are no longer true are dropped', () => {
    const { s, n, entry } = withCallback('door_handle_tried', 'door');
    s.telemetry.record({ type: 'door_opened', target: 'door', meta: {} });
    s.at(entry.notBefore + 1);
    expect(n.callbackMessage(s.ctx('recognition'))).toBeNull();
    expect(entry.delivered).toBe(true);
  });

  it('short inspections are not remembered; long ones state the recorded duration', () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = session();
      const n = new Narrative(s.telemetry, new Rng(seed));
      s.telemetry.record({ type: 'object_inspected', target: 'clock', meta: {}, durationMs: 1200 });
      expect(n.callbacks).toHaveLength(0);
    }
    const { s, e } = withCallback('object_inspected', 'clock', {}, 7400);
    s.at(e.timestampMs + 200_000);
    const ev = callbackSentence(e, s.ctx('recognition'))!;
    expect(ev.facts.sentence).toBe('A few minutes ago, you looked at the clock for 7 seconds.');
    expect(validateStatement({ text: String(ev.facts.sentence), refs: ev.refs, facts: ev.facts }, s.telemetry, { strict: true }).ok).toBe(true);
  });
});
