import { NAV_EDGES, NAV_NODES, PLACEMENTS, type NavNodeId, type ObjectId, type V3 } from '../core/layout';
import type { Rng } from '../core/rng';

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface EntityState {
  node: NavNodeId;
  focus: ObjectId | null;
  lastPlayerTarget: ObjectId | null;
  predictedNext: ObjectId | null;
  awareness: number;
  objective: 'observe' | 'approach' | 'follow' | 'withdraw';
  moves: number;
}

/**
 * The hidden presence. It has no model and is never rendered directly. It
 * moves between navigation nodes only when both nodes are out of the player's
 * sight, and its position decides where localized sounds, shadows and mirror
 * disturbances come from. Whether it is a presence or the room itself is left
 * ambiguous.
 */
export class Entity {
  state: EntityState = { node: 'hallway_far', focus: null, lastPlayerTarget: null, predictedNext: null, awareness: 0, objective: 'observe', moves: 0 };
  private neighbors = new Map<NavNodeId, NavNodeId[]>();
  private lastMoveAt = 0;

  constructor(private readonly rng: Rng) {
    for (const [a, b] of NAV_EDGES) {
      this.neighbors.set(a, [...(this.neighbors.get(a) ?? []), b]);
      this.neighbors.set(b, [...(this.neighbors.get(b) ?? []), a]);
    }
  }

  get position(): V3 {
    return NAV_NODES[this.state.node];
  }

  /**
   * Update the entity. `isVisible` tests a world point against the player's view.
   * The entity drifts toward its focus object (the player's likely next target
   * when known, otherwise their last target) and withdraws when the player's
   * suspicion is high.
   */
  update(
    now: number,
    inputs: { lastTarget: ObjectId | null; predicted: ObjectId | null; awareness: number; suspicion: number; avoidance: number },
    isVisible: (p: V3) => boolean,
  ): boolean {
    const s = this.state;
    s.lastPlayerTarget = inputs.lastTarget;
    s.predictedNext = inputs.predicted;
    s.awareness = inputs.awareness;
    s.focus = inputs.predicted ?? inputs.lastTarget;
    s.objective = inputs.suspicion > 0.75 ? 'withdraw' : inputs.avoidance > 0.5 ? 'follow' : inputs.awareness > 0.4 ? 'approach' : 'observe';
    if (now - this.lastMoveAt < 9000) return false;
    const here = NAV_NODES[s.node];
    if (isVisible(here)) return false;
    const goal: V3 = s.objective === 'withdraw' ? NAV_NODES.hallway_far : s.focus ? PLACEMENTS[s.focus].center : here;
    const options = (this.neighbors.get(s.node) ?? []).filter((n) => !isVisible(NAV_NODES[n]));
    if (!options.length) return false;
    options.sort((a, b) => dist(NAV_NODES[a], goal) - dist(NAV_NODES[b], goal));
    const pick = this.rng.chance(0.75) ? options[0] : this.rng.pick(options);
    if (dist(NAV_NODES[pick], goal) > dist(here, goal) && s.objective !== 'observe') return false;
    s.node = pick;
    s.moves++;
    this.lastMoveAt = now;
    return true;
  }

  reset(): void {
    this.state = { node: 'hallway_far', focus: null, lastPlayerTarget: null, predictedNext: null, awareness: 0, objective: 'observe', moves: 0 };
    this.lastMoveAt = 0;
  }
}
