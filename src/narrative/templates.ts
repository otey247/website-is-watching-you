import { INITIAL_SLOTS, PLACEMENTS, type ObjectId } from '../core/layout';
import type { Phase } from '../director/phaseMachine';
import type { BehavioralEvent } from '../telemetry/types';
import type { Evidence, NarrativeContext, Template } from './types';

const LATE: Phase[] = ['recognition', 'anticipation', 'confrontation'];
const MID_LATE: Phase[] = ['anticipation', 'confrontation'];

const ids = (events: BehavioralEvent[]): number[] => events.map((e) => e.id);
const BOOKS: ObjectId[] = ['book_0', 'book_1', 'book_2', 'book_3', 'book_4', 'book_5'];

/** Human phrase for how long ago an event happened, from its recorded timestamp. */
export function agoPhrase(now: number, t: number): string {
  const min = (now - t) / 60_000;
  if (min < 0.75) return 'just now';
  if (min < 1.6) return 'a minute ago';
  if (min < 5.5) return 'a few minutes ago';
  return 'earlier';
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Authored Observer lines. Every template derives its evidence from recorded
 * telemetry; if the evidence function returns null the line cannot be shown.
 * Lines are short on purpose: short statements carry the weight.
 */
export const TEMPLATES: Template[] = [
  {
    id: 'photo_repeat',
    intent: 'observation',
    phases: LATE,
    text: 'You keep looking at that picture.',
    once: true,
    priority: 3,
    evidence: ({ telemetry }) => {
      const e = telemetry.query({ type: 'object_inspected', target: 'photograph' });
      return e.length >= 3 ? { refs: ids(e), facts: { count: e.length } } : null;
    },
  },
  {
    id: 'drawer_second_time',
    intent: 'observation',
    phases: LATE,
    text: 'Did you expect something different the second time?',
    once: true,
    priority: 3,
    evidence: ({ telemetry }) => {
      const e = telemetry.query({ type: 'drawer_opened' });
      return e.length >= 2 ? { refs: ids(e.slice(0, 2)), facts: { count: e.length } } : null;
    },
  },
  {
    id: 'hallway_avoided',
    intent: 'observation',
    phases: LATE,
    text: "You haven't looked through the door.",
    once: true,
    priority: 4,
    evidence: ({ telemetry }) => {
      const avoided = telemetry.last('area_avoided');
      if (!avoided || avoided.area !== 'hallway') return null;
      if (telemetry.count('door_opened') > 0) return null;
      const glances = telemetry.query({ type: 'area_glanced', since: avoided.timestampMs - 60_000 }).filter((e) => e.area === 'hallway');
      if (glances.length > 0) return null;
      return { refs: [avoided.id], facts: {} };
    },
  },
  {
    id: 'preferred_darker',
    intent: 'observation',
    phases: LATE,
    text: 'You preferred it darker before.',
    once: true,
    priority: 3,
    evidence: ({ telemetry, world, now }) => {
      if (!world.get('lamp').on) return null;
      const offs = telemetry.query({ type: 'lamp_toggled', meta: { on: false }, before: now - 60_000 });
      return offs.length >= 1 ? { refs: [offs[offs.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'chair_moved',
    intent: 'observation',
    phases: LATE,
    text: 'I noticed you moved the chair.',
    once: true,
    priority: 2,
    evidence: ({ telemetry }) => {
      const e = telemetry.query({ type: 'chair_moved' });
      return e.length >= 1 ? { refs: [e[e.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'third_time',
    intent: 'count',
    phases: LATE,
    text: "That's the third time.",
    priority: 5,
    evidence: ({ telemetry, now }) => {
      // The third occurrence of the same action on the same object, within the last minute.
      const kinds: [BehavioralEvent['type'], ObjectId | undefined][] = [
        ['lamp_toggled', 'lamp'],
        ['drawer_opened', 'drawer_top'],
        ['drawer_opened', 'drawer_bottom'],
        ['object_inspected', 'photograph'],
        ['object_inspected', 'clock'],
        ['object_inspected', 'mirror'],
        ['door_handle_tried', 'door'],
        ['curtains_toggled', 'curtains'],
      ];
      for (const [type, target] of kinds) {
        const e = telemetry.query({ type, target });
        if (e.length === 3 && now - e[2].timestampMs < 60_000) return { refs: ids(e), facts: { count: 3, target: target ?? '' } };
      }
      return null;
    },
  },
  {
    id: 'door_not_opened',
    intent: 'observation',
    phases: LATE,
    text: "You didn't open the door.",
    once: true,
    priority: 3,
    evidence: ({ telemetry }) => {
      if (telemetry.count('door_opened') > 0) return null;
      const tries = telemetry.query({ type: 'door_handle_tried' });
      const hes = telemetry.query({ type: 'object_hesitated', target: 'door', meta: { outcome: 'abandoned' } });
      const all = [...tries, ...hes];
      return all.length >= 1 ? { refs: ids(all), facts: {} } : null;
    },
  },
  {
    id: 'looked_away',
    intent: 'observation',
    phases: LATE,
    text: 'You looked away.',
    priority: 2,
    evidence: ({ telemetry, now }) => {
      const reads = telemetry.query({ type: 'message_read', since: now - 45_000 }).filter((e) => (e.durationMs ?? 0) < 1600);
      return reads.length ? { refs: [reads[reads.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'light_back_on',
    intent: 'observation',
    phases: LATE,
    text: 'You always turn the light back on.',
    once: true,
    priority: 3,
    evidence: ({ telemetry }) => {
      const toggles = telemetry.query({ type: 'lamp_toggled' });
      const ons = toggles.filter((e, i) => e.meta.on === true && i > 0 && toggles[i - 1].meta.on === false);
      const offs = toggles.filter((e) => e.meta.on === false);
      // "Always": every time it went off, the player turned it back on, at least three times.
      if (ons.length < 3 || ons.length < offs.length) return null;
      return { refs: ids(ons), facts: { count: ons.length } };
    },
  },
  {
    id: 'attention',
    intent: 'direct',
    phases: ['confrontation'],
    text: "I've been trying to get your attention.",
    once: true,
    priority: 4,
    evidence: ({ telemetry, applied }) => {
      const witnessed = telemetry.query({ type: 'anomaly_witnessed' });
      if (applied.length < 4 || witnessed.length < 2) return null;
      return { refs: ids(witnessed.slice(-3)), facts: { applied: applied.length } };
    },
  },
  {
    id: 'predicted_door',
    intent: 'prediction',
    phases: MID_LATE,
    text: "I thought you'd check the door.",
    once: true,
    priority: 5,
    evidence: ({ telemetry }) => {
      const e = telemetry
        .query({ type: 'prediction_resolved' })
        .filter((x) => x.meta.predicted === 'door' && x.meta.outcome !== 'hit');
      return e.length ? { refs: [e[e.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'predicted_hit',
    intent: 'prediction',
    phases: MID_LATE,
    text: 'You were going to touch the {label}. I knew.',
    priority: 4,
    evidence: ({ telemetry, now }) => {
      const e = telemetry
        .query({ type: 'prediction_resolved', since: now - 40_000 })
        .filter((x) => x.meta.outcome === 'hit' && typeof x.meta.predicted === 'string' && x.meta.predicted !== 'door');
      if (!e.length) return null;
      const last = e[e.length - 1];
      return { refs: [last.id], facts: { label: PLACEMENTS[last.meta.predicted as ObjectId].label } };
    },
  },
  {
    id: 'testing_lookaway',
    intent: 'testing',
    phases: LATE,
    text: 'You think I only move when you look away.',
    once: true,
    priority: 6,
    evidence: ({ telemetry }) => {
      const e = telemetry.query({ type: 'look_away_test' });
      return e.length >= 2 ? { refs: ids(e.slice(-2)), facts: { count: e.length } } : null;
    },
  },
  {
    id: 'testing_checking',
    intent: 'testing',
    phases: LATE,
    text: "You keep checking. So do I.",
    once: true,
    priority: 5,
    evidence: ({ telemetry }) => {
      const tests = telemetry.query({ type: 'look_away_test' });
      const inv = telemetry.query({ type: 'anomaly_investigated' });
      if (tests.length >= 1 && inv.length >= 2) return { refs: [...ids(tests.slice(-1)), ...ids(inv.slice(-2))], facts: {} };
      if (inv.length >= 4) return { refs: ids(inv.slice(-4)), facts: {} };
      return null;
    },
  },
  {
    id: 'testing_lamp',
    intent: 'testing',
    phases: LATE,
    text: 'On. Off. On. I can see what you are doing.',
    once: true,
    priority: 6,
    evidence: ({ telemetry, now }) => {
      const e = telemetry.query({ type: 'lamp_toggled', since: now - 20_000 });
      return e.length >= 4 ? { refs: ids(e), facts: { count: e.length } } : null;
    },
  },
  {
    id: 'noticed_photo',
    intent: 'direct',
    phases: MID_LATE,
    text: 'You noticed the picture. Nobody else does.',
    once: true,
    priority: 4,
    evidence: ({ telemetry }) => {
      const e = telemetry.query({ type: 'anomaly_investigated', target: 'photograph' });
      return e.length ? { refs: [e[e.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'book_returned',
    intent: 'direct',
    phases: MID_LATE,
    text: 'You moved it. I put it back.',
    once: true,
    priority: 5,
    evidence: ({ telemetry, applied }) => {
      const ret = applied.filter((a) => a.anomalyId === 'returning_object');
      if (!ret.length) return null;
      const last = ret[ret.length - 1];
      const placed = telemetry.query({ type: 'object_placed' }).filter((e) => e.target && last.targets.includes(e.target));
      return placed.length ? { refs: [placed[placed.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'stillness',
    intent: 'observation',
    phases: MID_LATE,
    text: 'You stopped moving. So did I.',
    once: true,
    priority: 3,
    evidence: ({ telemetry, now }) => {
      const e = telemetry.query({ type: 'player_idle', since: now - 90_000 });
      return e.length ? { refs: [e[e.length - 1].id], facts: {} } : null;
    },
  },
  {
    id: 'favorite',
    intent: 'observation',
    phases: MID_LATE,
    text: 'You always come back to the {label}.',
    once: true,
    priority: 2,
    evidence: ({ telemetry }) => {
      const counts = new Map<ObjectId, BehavioralEvent[]>();
      for (const e of telemetry.query({ type: ['object_inspected', 'object_picked_up', 'lamp_toggled', 'drawer_opened'] })) {
        if (!e.target) continue;
        const key = e.target.startsWith('drawer') ? 'drawer_top' : e.target;
        const list = counts.get(key) ?? [];
        list.push(e);
        counts.set(key, list);
      }
      let best: [ObjectId, BehavioralEvent[]] | null = null;
      for (const [k, v] of counts) if (!best || v.length > best[1].length) best = [k, v];
      if (!best || best[1].length < 5) return null;
      return { refs: ids(best[1].slice(-5)), facts: { label: PLACEMENTS[best[0]].label, count: best[1].length } };
    },
  },
  // ——— Delayed callbacks (the callback queue supplies the referenced event) ———
  {
    id: 'callback',
    intent: 'callback',
    phases: LATE,
    text: '{sentence}',
    priority: 4,
    evidence: () => null, // produced by Narrative.callbackMessage()
  },
];

/** Build the callback sentence for a remembered event, or null if it no longer holds. */
export function callbackSentence(e: BehavioralEvent, ctx: NarrativeContext): Evidence | null {
  const ago = agoPhrase(ctx.now, e.timestampMs);
  const label = e.target ? PLACEMENTS[e.target].label : '';
  let sentence: string | null = null;
  switch (e.type) {
    case 'drawer_opened':
      sentence = `You opened the ${label} ${ago}.`;
      break;
    case 'drawer_closed':
      sentence = `${capitalize(ago)}, you closed the ${label}. Gently.`;
      break;
    case 'lamp_toggled':
      sentence = e.meta.on ? `You turned the light on ${ago}. What were you expecting?` : `You turned the light off ${ago}. You wanted it darker.`;
      break;
    case 'chair_moved':
      sentence = `You moved the chair ${ago}.`;
      break;
    case 'curtains_toggled':
      sentence = e.meta.open ? `You opened the curtains ${ago}.` : `You closed the curtains ${ago}. Why?`;
      break;
    case 'door_handle_tried':
      if (ctx.telemetry.count('door_opened') > 0) return null;
      sentence = `You touched the door ${ago}. You didn't go through.`;
      break;
    case 'object_placed': {
      if (!e.target) return null;
      const original = (INITIAL_SLOTS as Record<string, string>)[e.target];
      if (!original || e.meta.slot === original) return null;
      sentence = `You put the ${label} somewhere else ${ago}.`;
      break;
    }
    case 'object_inspected': {
      const secs = Math.round((e.durationMs ?? 0) / 1000);
      if (secs < 5) return null;
      sentence = `${capitalize(ago)}, you looked at the ${label} for ${secs} seconds.`;
      return { refs: [e.id], facts: { sentence, seconds: secs } };
    }
    case 'object_picked_up':
      sentence = BOOKS.includes(e.target!) ? `You picked up a book ${ago}. Did you read it?` : `You picked up the ${label} ${ago}.`;
      break;
    default:
      return null;
  }
  return { refs: [e.id], facts: { sentence } };
}

export const CALLBACK_TYPES: BehavioralEvent['type'][] = [
  'drawer_opened',
  'drawer_closed',
  'lamp_toggled',
  'chair_moved',
  'curtains_toggled',
  'door_handle_tried',
  'object_placed',
  'object_inspected',
  'object_picked_up',
];

/** Lines used by the endings; they are authored, not inferred. */
export const ENDING_LINES = {
  ask: 'Can you see me?',
  yes: 'I can see you too.',
  no: 'Then why are you still looking?',
  requestLight: 'Turn the light off if you are still there.',
  requestAgain: 'Again.',
  thanks: 'Thank you for looking.',
  reversal: 'Now I know how you move.',
  reversalFinal: 'Stay where you are. I will do the rest.',
  refusal: '',
} as const;

export function fill(text: string, facts: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => String(facts[k] ?? ''));
}
