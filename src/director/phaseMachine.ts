import { assign, createActor, setup } from 'xstate';

export const PHASES = ['normalcy', 'inconsistency', 'recognition', 'anticipation', 'confrontation', 'resolution'] as const;
export type Phase = (typeof PHASES)[number];
export const ENDINGS = ['acknowledgment', 'refusal', 'reversal'] as const;
export type EndingId = (typeof ENDINGS)[number];

/** Everything the phase guards are allowed to look at. */
export interface PhaseMetrics {
  now: number;
  interactions: number;
  distinctObjects: number;
  distinctAreas: number;
  anomaliesApplied: number;
  anomaliesWitnessed: number;
  anomaliesInvestigated: number;
  messagesShown: number;
  callbacksDelivered: number;
  anticipationsExecuted: number;
  followerStage: number;
  confrontationEvents: number;
  predictorInteractions: number;
  familiarity: number;
  tension: number;
}

/**
 * Phase-transition requirements. Elapsed time in a phase is one input among
 * several, never the only one: a player who does nothing stays in Normalcy.
 */
export const PHASE_REQUIREMENTS = {
  inconsistency: { minPhaseMs: 75_000, interactions: 6, distinctObjects: 4 },
  recognition: { minPhaseMs: 120_000, anomaliesApplied: 3, interactions: 14, witnessedOrInteractions: [1, 22] as const },
  anticipation: { minPhaseMs: 150_000, messagesShown: 2, callbacksDelivered: 1, predictorInteractions: 18 },
  confrontation: { minPhaseMs: 150_000, anticipationsExecuted: 2, followerStage: 2, tension: 0.2 },
  resolution: { confrontationEvents: 2 },
} as const;

export interface PhaseContext {
  enteredAt: Record<string, number>;
  ending: EndingId | null;
  gateways: EndingId[];
}

export type PhaseEvent =
  | { type: 'EVALUATE'; metrics: PhaseMetrics }
  | { type: 'FORCE'; phase: Phase; now: number }
  | { type: 'GATEWAYS'; gateways: EndingId[] }
  | { type: 'BEGIN_ENDING'; ending: EndingId; metrics: PhaseMetrics }
  | { type: 'RESET' };

const timeIn = (ctx: PhaseContext, phase: Phase, now: number): number => now - (ctx.enteredAt[phase] ?? 0);

export const phaseMachine = setup({
  types: { context: {} as PhaseContext, events: {} as PhaseEvent },
  guards: {
    toInconsistency: ({ context, event }) => {
      if (event.type !== 'EVALUATE') return false;
      const m = event.metrics;
      const r = PHASE_REQUIREMENTS.inconsistency;
      return timeIn(context, 'normalcy', m.now) >= r.minPhaseMs && m.interactions >= r.interactions && m.distinctObjects >= r.distinctObjects;
    },
    toRecognition: ({ context, event }) => {
      if (event.type !== 'EVALUATE') return false;
      const m = event.metrics;
      const r = PHASE_REQUIREMENTS.recognition;
      return (
        timeIn(context, 'inconsistency', m.now) >= r.minPhaseMs &&
        m.anomaliesApplied >= r.anomaliesApplied &&
        m.interactions >= r.interactions &&
        (m.anomaliesWitnessed >= r.witnessedOrInteractions[0] || m.interactions >= r.witnessedOrInteractions[1])
      );
    },
    toAnticipation: ({ context, event }) => {
      if (event.type !== 'EVALUATE') return false;
      const m = event.metrics;
      const r = PHASE_REQUIREMENTS.anticipation;
      return (
        timeIn(context, 'recognition', m.now) >= r.minPhaseMs &&
        m.messagesShown >= r.messagesShown &&
        m.callbacksDelivered >= r.callbacksDelivered &&
        m.predictorInteractions >= r.predictorInteractions
      );
    },
    toConfrontation: ({ context, event }) => {
      if (event.type !== 'EVALUATE') return false;
      const m = event.metrics;
      const r = PHASE_REQUIREMENTS.confrontation;
      return (
        timeIn(context, 'anticipation', m.now) >= r.minPhaseMs &&
        m.anticipationsExecuted >= r.anticipationsExecuted &&
        m.followerStage >= r.followerStage &&
        m.tension >= r.tension
      );
    },
    canResolve: ({ context, event }) =>
      event.type === 'BEGIN_ENDING' &&
      context.gateways.includes(event.ending) &&
      event.metrics.confrontationEvents >= PHASE_REQUIREMENTS.resolution.confrontationEvents,
  },
  actions: {
    stamp: assign({
      enteredAt: ({ context, event }, params: { phase: Phase }) => {
        const now = event.type === 'EVALUATE' || event.type === 'BEGIN_ENDING' ? event.metrics.now : event.type === 'FORCE' ? event.now : 0;
        return { ...context.enteredAt, [params.phase]: now };
      },
    }),
  },
}).createMachine({
  id: 'horrorDirector',
  initial: 'normalcy',
  context: { enteredAt: { normalcy: 0 }, ending: null, gateways: [] },
  on: {
    FORCE: [
      ...(['normalcy', 'inconsistency', 'recognition', 'anticipation', 'confrontation'] as const).map((p) => ({
        guard: ({ event }: { event: PhaseEvent }) => event.type === 'FORCE' && event.phase === p,
        target: `.${p}`,
        actions: { type: 'stamp' as const, params: { phase: p } },
      })),
    ],
    GATEWAYS: { actions: assign({ gateways: ({ event }) => (event.type === 'GATEWAYS' ? event.gateways : []) }) },
    RESET: { target: '.normalcy', actions: assign({ enteredAt: { normalcy: 0 }, ending: null, gateways: [] }) },
  },
  states: {
    normalcy: {
      on: { EVALUATE: { guard: 'toInconsistency', target: 'inconsistency', actions: { type: 'stamp', params: { phase: 'inconsistency' } } } },
    },
    inconsistency: {
      on: { EVALUATE: { guard: 'toRecognition', target: 'recognition', actions: { type: 'stamp', params: { phase: 'recognition' } } } },
    },
    recognition: {
      on: { EVALUATE: { guard: 'toAnticipation', target: 'anticipation', actions: { type: 'stamp', params: { phase: 'anticipation' } } } },
    },
    anticipation: {
      on: { EVALUATE: { guard: 'toConfrontation', target: 'confrontation', actions: { type: 'stamp', params: { phase: 'confrontation' } } } },
    },
    confrontation: {
      on: {
        BEGIN_ENDING: {
          guard: 'canResolve',
          target: 'resolution',
          actions: [
            { type: 'stamp', params: { phase: 'resolution' } },
            assign({ ending: ({ event }) => (event.type === 'BEGIN_ENDING' ? event.ending : null) }),
          ],
        },
      },
    },
    resolution: {
      initial: 'pending',
      states: {
        pending: {
          always: [
            { guard: ({ context }) => context.ending === 'acknowledgment', target: 'acknowledgment' },
            { guard: ({ context }) => context.ending === 'refusal', target: 'refusal' },
            { guard: ({ context }) => context.ending === 'reversal', target: 'reversal' },
          ],
        },
        acknowledgment: { type: 'final' },
        refusal: { type: 'final' },
        reversal: { type: 'final' },
      },
    },
  },
});

export function createPhaseActor() {
  const actor = createActor(phaseMachine);
  actor.start();
  return actor;
}

export type PhaseActor = ReturnType<typeof createPhaseActor>;

export function phaseOf(actor: PhaseActor): Phase {
  const v = actor.getSnapshot().value;
  return (typeof v === 'string' ? v : Object.keys(v)[0]) as Phase;
}
