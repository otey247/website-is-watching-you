import { describe, expect, it } from 'vitest';
import { NAV_EDGES, NAV_NODES, type NavNodeId, type V3 } from '../../src/core/layout';
import { Rng } from '../../src/core/rng';
import { Entity } from '../../src/entity/Entity';

const nodeAt = (p: V3): NavNodeId => (Object.keys(NAV_NODES) as NavNodeId[]).find((n) => NAV_NODES[n] === p)!;
const adjacent = (a: NavNodeId, b: NavNodeId) => NAV_EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

describe('Entity', () => {
  it('only moves between adjacent nodes that are both out of sight', () => {
    const rng = new Rng(3);
    const e = new Entity(new Rng(9));
    let moves = 0;
    for (let t = 0; t < 3_000_000; t += 1000) {
      // A random subset of nodes is visible each step.
      const visible = new Set((Object.keys(NAV_NODES) as NavNodeId[]).filter(() => rng.chance(0.4)));
      const from = e.state.node;
      const inputs = {
        lastTarget: rng.pick(['lamp', 'door', 'photograph', 'cup'] as const),
        predicted: rng.chance(0.5) ? rng.pick(['clock', 'mirror'] as const) : null,
        awareness: rng.next(),
        suspicion: rng.next(),
        avoidance: rng.next(),
      };
      const moved = e.update(t, inputs, (p) => visible.has(nodeAt(p)));
      if (moved) {
        moves++;
        expect(visible.has(from)).toBe(false);
        expect(visible.has(e.state.node)).toBe(false);
        expect(adjacent(from, e.state.node)).toBe(true);
      } else {
        expect(e.state.node).toBe(from);
      }
    }
    expect(moves).toBeGreaterThan(10);
    expect(e.state.moves).toBe(moves);
  });

  it('never moves while its current node is visible, and rests between moves', () => {
    const e = new Entity(new Rng(1));
    const inputs = { lastTarget: 'lamp' as const, predicted: null, awareness: 0.6, suspicion: 0, avoidance: 0 };
    for (let t = 10_000; t < 200_000; t += 500) expect(e.update(t, inputs, () => true)).toBe(false);
    expect(e.state.node).toBe('hallway_far');
    expect(e.update(200_000, inputs, () => false)).toBe(true);
    expect(e.update(205_000, inputs, () => false)).toBe(false); // < 9 s since last move
  });

  it('withdraws toward the hallway when suspicion is high', () => {
    const e = new Entity(new Rng(1));
    e.state.node = 'lamp_corner';
    e.update(10_000, { lastTarget: 'lamp', predicted: null, awareness: 1, suspicion: 0.9, avoidance: 0 }, () => false);
    expect(e.state.objective).toBe('withdraw');
  });
});
