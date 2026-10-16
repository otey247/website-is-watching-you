import type { ObjectId } from '../core/layout';
import type { Phase } from '../director/phaseMachine';
import type { Observer } from '../observer/Observer';
import type { ResolvedPrediction } from '../observer/Predictor';
import type { Telemetry } from '../telemetry/Telemetry';
import type { WorldState } from '../world/WorldState';

export type NarrativeIntent = 'observation' | 'callback' | 'count' | 'prediction' | 'testing' | 'direct' | 'ending';

export interface AppliedAnomaly {
  anomalyId: string;
  targets: ObjectId[];
  at: number;
  evidence: number[];
}

export interface NarrativeContext {
  now: number;
  phase: Phase;
  telemetry: Telemetry;
  world: WorldState;
  observer: Observer;
  applied: readonly AppliedAnomaly[];
  predictions: readonly ResolvedPrediction[];
}

export interface Evidence {
  /** Telemetry event ids that make the statement true. */
  refs: number[];
  /** Values substituted into the text and re-checked by the validator. */
  facts: Record<string, string | number>;
}

export interface Template {
  id: string;
  intent: NarrativeIntent;
  phases: Phase[];
  /** Plain text with {fact} slots. */
  text: string;
  /** Returns supporting evidence, or null when the statement would be false. */
  evidence(ctx: NarrativeContext): Evidence | null;
  /** Show at most once per session. */
  once?: boolean;
  priority?: number;
}

export interface ObserverMessage {
  templateId: string;
  intent: NarrativeIntent;
  text: string;
  refs: number[];
  facts: Record<string, string | number>;
  source: 'template' | 'llm';
  createdAt: number;
}
