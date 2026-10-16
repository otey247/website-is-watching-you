import type { VisibilityClass } from '../attention/AttentionEstimator';
import type { SoundId, AmbientLayer } from '../audio/sounds';
import type { NavNodeId, ObjectId, V3 } from '../core/layout';
import type { Rng } from '../core/rng';
import type { Narrative } from '../narrative/Narrative';
import type { NarrativeContext, NarrativeIntent } from '../narrative/types';
import type { Observer } from '../observer/Observer';
import type { Prediction, PredictionCommit } from '../observer/Predictor';
import type { Telemetry } from '../telemetry/Telemetry';
import type { CameraSample } from '../telemetry/types';
import type { ObjectState } from '../world/objects';
import type { WorldState } from '../world/WorldState';
import type { CallbackEntry } from '../narrative/Narrative';
import type { Phase } from './phaseMachine';

/** What the event engine needs to know about the player's view. */
export interface VisibilityOracle {
  visibility(id: ObjectId): VisibilityClass;
  isUnseen(id: ObjectId): boolean;
  unseenForMs(id: ObjectId, now: number): number;
  score(id: ObjectId): number;
  isPointVisible(p: V3): boolean;
  focus(): ObjectId | null;
}

export type VisibilityMode = 'unseen' | 'peripheral' | 'direct';

/**
 * Visibility contract every anomaly declares.
 * - mode: the most visible the target may be while it changes
 * - minUnseenMs: how long the target must have been out of sight first
 * - interruption: what happens if the player looks while it is changing
 *     freeze  — stop exactly where it is (no snap), commit the partial change
 *     revert  — undo if still unseen, otherwise freeze
 *     continue — keep going in plain view (confrontation only)
 * - waitMs: how long a scheduled event waits for its contract before expiring
 */
export interface VisibilityContract {
  mode: VisibilityMode;
  minUnseenMs: number;
  interruption: 'freeze' | 'revert' | 'continue';
  waitMs: number;
}

export type NumericKey = 'x' | 'z' | 'yaw' | 'open' | 'tilt' | 'handle' | 'offsetMs';

export type EffectName =
  | 'mirror_lag'
  | 'mirror_past_chair'
  | 'mirror_presence'
  | 'mirror_distort'
  | 'silence'
  | 'flicker'
  | 'cursor_nudge'
  | 'shadow_pass'
  | 'light_shift'
  | 'follower_stage'
  | 'clock_skip'
  | 'surveillance'
  | 'replay_sounds'
  | 'entity_move'
  | 'grade_pulse';

export type SoundAt = ObjectId | NavNodeId | 'entity' | V3;

export type Step =
  | { op: 'set'; object: ObjectId; patch: Partial<ObjectState> }
  | { op: 'animate'; object: ObjectId; to: Partial<Record<NumericKey, number>>; durationMs: number; state?: string; ease?: 'linear' | 'inOut'; sweep?: boolean }
  | { op: 'sound'; sound: SoundId; at: SoundAt; gain?: number; rate?: number }
  | { op: 'effect'; name: EffectName; params?: Record<string, unknown> }
  | { op: 'message'; templateId: string; intent: NarrativeIntent; text: string; refs: number[]; facts: Record<string, string | number>; callback?: CallbackEntry }
  | { op: 'wait'; ms: number }
  | { op: 'until'; cond: (ctx: DirectorCtx) => boolean; timeoutMs: number }
  | { op: 'call'; fn: (ctx: DirectorCtx) => void };

export interface AnomalyPlan {
  steps: Step[];
  /** Telemetry evidence that justified this anomaly. */
  evidence: number[];
  /** Objects the plan mutates (claimed for its whole duration). */
  targets: ObjectId[];
  label?: string;
}

export type Significance = 'ambient' | 'subtle' | 'notable' | 'major';

export interface AnomalyDef {
  id: string;
  description: string;
  group: string;
  phases: Phase[];
  significance: Significance;
  baseWeight: number;
  tension: number;
  cooldownMs: number;
  /** Minimum time since any anomaly of the listed groups. */
  minSinceGroups?: Partial<Record<string, number>>;
  maxRepeats: number;
  visibility: VisibilityContract;
  /** Tagged events are skipped when the player disables sudden events. */
  sudden?: boolean;
  /** Prediction-driven responses are evaluated on prediction updates, not the main tick. */
  anticipation?: boolean;
  /** Behavioral requirement: returns evidence ids (possibly empty) or null when unmet. */
  requires?: (ctx: DirectorCtx) => number[] | null;
  /** Room-state prerequisite. */
  prerequisite?: (ctx: DirectorCtx) => boolean;
  /** Extra weight multiplier from the Observer model (interest, avoidance, stillness...). */
  affinity?: (ctx: DirectorCtx) => number;
  /** Build the concrete plan. May return null if no valid target exists right now. */
  plan: (ctx: DirectorCtx, evidence: number[]) => AnomalyPlan | null;
  followUps?: { id: string; delayMs: [number, number]; chance: number }[];
}

export interface EffectSink {
  sound(id: SoundId, at: SoundAt, opts?: { gain?: number; rate?: number }): void;
  effect(name: EffectName, params: Record<string, unknown>): void;
  /** Render the fictional room into a stored texture; returns its id. */
  capture(kind: 'now' | 'figure' | 'snapshot', snapshotEventId?: number): number;
  ambient?(layer: AmbientLayer, gain: number, rampMs: number): void;
}

export interface DirectorCtx {
  now: number;
  phase: Phase;
  rng: Rng;
  world: WorldState;
  telemetry: Telemetry;
  observer: Observer;
  narrative: Narrative;
  vis: VisibilityOracle;
  camera: () => CameraSample;
  sink: EffectSink;
  history: (id: string) => { count: number; lastAt: number };
  groupLastAt: (group: string) => number;
  narrativeCtx: () => NarrativeContext;
  followerStage: number;
  setFollowerStage: (n: number) => void;
  settings: { suddenEvents: boolean; reducedMotion: boolean };
  /** Objects the player is actively testing; the room deliberately leaves them alone. */
  protectedObjects: Map<ObjectId, number>;
  prediction: Prediction | null;
  commit: PredictionCommit | null;
  pointerIdleMs: number;
  playerIdleMs: number;
  /** Room snapshots stored alongside telemetry events (event id → snapshot capture id). */
  snapshots: Map<number, { captureId: number; world: [ObjectId, ObjectState][] }>;
}
