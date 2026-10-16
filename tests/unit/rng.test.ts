import { describe, expect, it } from 'vitest';
import { Rng, seedFromString } from '../../src/core/rng';
import { SessionClock } from '../../src/core/clock';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const sa = Array.from({ length: 200 }, () => a.next());
    const sb = Array.from({ length: 200 }, () => b.next());
    expect(sa).toEqual(sb);
    for (const v of sa) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const sa = Array.from({ length: 20 }, () => a.next());
    const sb = Array.from({ length: 20 }, () => b.next());
    expect(sa).not.toEqual(sb);
  });

  it('derived helpers are deterministic too, and state can be replayed', () => {
    const a = new Rng(99);
    const b = new Rng(99);
    const draw = (r: Rng) => [r.int(0, 10), r.range(-3, 3), r.chance(0.5), r.pick(['a', 'b', 'c']), r.weightedIndex([1, 2, 3])];
    expect(draw(a)).toEqual(draw(b));
    const saved = a.getState();
    const next = Array.from({ length: 5 }, () => a.next());
    a.setState(saved);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(next);
  });

  it('int stays in range inclusive and weightedIndex respects zero weights', () => {
    const r = new Rng(5);
    for (let i = 0; i < 500; i++) {
      const v = r.int(2, 4);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(4);
      expect(r.weightedIndex([0, 1, 0])).toBe(1);
    }
    expect(r.weightedIndex([0, 0])).toBe(-1);
  });

  it('seedFromString is stable', () => {
    expect(seedFromString('room')).toBe(seedFromString('room'));
    expect(seedFromString('room')).not.toBe(seedFromString('rooms'));
  });
});

describe('SessionClock', () => {
  it('does not advance while paused and clamps long frames', () => {
    const c = new SessionClock();
    c.tick(16);
    expect(c.now).toBe(16);
    c.tick(5000);
    expect(c.now).toBe(116);
    c.pause('menu');
    c.pause('hidden');
    expect(c.tick(16)).toBe(0);
    c.resume('menu');
    expect(c.isPaused).toBe(true);
    c.resume('hidden');
    c.tick(10);
    expect(c.now).toBe(126);
  });
});
