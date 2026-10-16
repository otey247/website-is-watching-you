import { describe, expect, it } from 'vitest';
import { dist, FOLLOWER_DELAY, FollowerSim, PointerHistory, type TrailPoint, type V3m } from '../../src/trail/Follower';

const N: V3m = [0, 0, 1];

/** A straight line of pointer points on one surface, one every `dtMs`. */
function line(h: PointerHistory, from: number, count: number, dtMs = 100, surface = 'wall', y = 1.2): void {
  for (let i = 0; i < count; i++) h.push({ t: from + i * dtMs, p: [i * 0.06, y, -2], n: N, surface });
}

describe('PointerHistory', () => {
  it('drops points closer than the minimum spacing on the same surface, and is bounded', () => {
    const h = new PointerHistory(10, 0.035);
    expect(h.push({ t: 0, p: [0, 0, 0], n: N, surface: 'a' })).not.toBeNull();
    expect(h.push({ t: 1, p: [0.01, 0, 0], n: N, surface: 'a' })).toBeNull();
    expect(h.push({ t: 2, p: [0.01, 0, 0], n: N, surface: 'b' })).not.toBeNull();
    for (let i = 0; i < 20; i++) h.push({ t: 10 + i, p: [i, 0, 0], n: N, surface: 'a' });
    expect(h.points).toHaveLength(10);
    expect(h.indexAt(h.points[3].t)).toBe(3);
    expect(h.indexAt(-5)).toBe(-1);
  });
});

describe('FollowerSim', () => {
  it('emits no marks before stage 2', () => {
    const h = new PointerHistory();
    line(h, 0, 200);
    const f = new FollowerSim(() => 0.5);
    for (const stage of [0, 1]) {
      f.setStage(stage);
      for (let t = 0; t < 30_000; t += 100) expect(f.update(t, h, false)).toEqual([]);
    }
    expect(f.emitted).toHaveLength(0);
    expect(f.position).toBeNull();
  });

  it('at stage 2 it retraces the path with the stage delay', () => {
    const h = new PointerHistory();
    line(h, 0, 300);
    const f = new FollowerSim(() => 0.5);
    f.setStage(2);
    expect(f.delayMs).toBe(FOLLOWER_DELAY[2]);
    expect(f.update(FOLLOWER_DELAY[2] - 1, h, false)).toEqual([]);
    for (let t = FOLLOWER_DELAY[2]; t <= 25_000; t += 100) {
      const marks = f.update(t, h, false);
      for (const m of marks) {
        // Every mark lies on a recorded point that is at least `delay` old.
        const src = h.points.find((p) => dist(p.p, m.p) < 1e-9)!;
        expect(src).toBeDefined();
        expect(t - src.t).toBeGreaterThanOrEqual(FOLLOWER_DELAY[2]);
        expect(m.surface).toBe('wall');
        expect(m.shortcut).toBe(false);
      }
    }
    expect(f.emitted.length).toBeGreaterThan(50);
  });

  it('at stage 2 it keeps following while the player is still', () => {
    const h = new PointerHistory();
    line(h, 0, 300);
    const f = new FollowerSim(() => 0.5);
    f.setStage(2);
    f.update(7000, h, false);
    const c = f.cursor;
    f.update(9000, h, true);
    expect(f.cursor).toBeGreaterThan(c);
  });

  it('at stage 3 the delay shrinks with each interaction, down to a floor', () => {
    const f = new FollowerSim(() => 0.5);
    f.setStage(2);
    f.onInteraction();
    expect(f.delayMs).toBe(FOLLOWER_DELAY[2]); // no tightening before stage 3
    f.setStage(3);
    expect(f.delayMs).toBe(FOLLOWER_DELAY[3]);
    let prev = f.delayMs;
    for (let i = 0; i < 5; i++) {
      f.onInteraction();
      expect(f.delayMs).toBeLessThan(prev);
      prev = f.delayMs;
    }
    for (let i = 0; i < 50; i++) f.onInteraction();
    expect(f.delayMs).toBe(1100);
    // Stages never go backwards.
    f.setStage(2);
    expect(f.stage).toBe(3);
  });

  it('at stage 3 it stops when the player is still and resumes when they move', () => {
    const h = new PointerHistory();
    line(h, 0, 300);
    const f = new FollowerSim(() => 0.5);
    f.setStage(3);
    f.update(5000, h, false);
    const cursor = f.cursor;
    const pos = f.position;
    for (let t = 5100; t < 20_000; t += 100) expect(f.update(t, h, true)).toEqual([]);
    expect(f.cursor).toBe(cursor);
    expect(f.position).toEqual(pos);
    f.update(20_100, h, false);
    expect(f.cursor).toBeGreaterThan(cursor);
  });

  it('stage 4 shortcuts only ever stay on one surface', () => {
    const h = new PointerHistory();
    let t = 0;
    // A short approach, a small loop on the wall (long path that returns near its start), then the desk.
    for (let i = 0; i < 5; i++) h.push({ t: (t += 100), p: [-0.5 + i * 0.06, 1.2, -2], n: N, surface: 'wall' });
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      h.push({ t: (t += 100), p: [-0.2 + Math.sin(a) * 0.15, 1.35 - Math.cos(a) * 0.15, -2], n: N, surface: 'wall' });
    }
    for (let i = 0; i < 40; i++) h.push({ t: (t += 100), p: [i * 0.06, 0.75, -1.5], n: [0, 1, 0], surface: 'desk' });
    const f = new FollowerSim(() => 0); // always try a shortcut
    f.setStage(4);
    // Loop shortcuts are found among the points the follower is due to replay, so
    // updates here are sparse enough for the whole loop to be due at once.
    const times = [1900, 4400, ...Array.from({ length: 400 }, (_, i) => 4400 + (i + 1) * 50)];
    let surface: string | null = null;
    for (const now of times) {
      for (const m of f.update(now, h, false)) {
        if (m.shortcut) expect(m.surface).toBe(surface);
        else surface = m.surface;
      }
    }
    expect(f.shortcuts).toBeGreaterThan(0);
    expect(f.emitted.some((m) => m.shortcut && m.surface === 'wall')).toBe(true);
    expect(f.emitted.every((m) => !m.shortcut || m.surface === 'wall')).toBe(true);
    expect(f.emitted.some((m) => m.surface === 'desk')).toBe(true);
  });

  it('never shortcuts across a change of surface', () => {
    const h = new PointerHistory();
    let t = 0;
    // Half a loop on the wall, the rest on the desk: spatially a loop, but across two surfaces.
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      h.push({ t: (t += 100), p: [Math.sin(a) * 0.15, 1.2 - Math.cos(a) * 0.15, -2], n: N, surface: i < 10 ? 'wall' : 'desk' });
    }
    const f = new FollowerSim(() => 0);
    f.setStage(4);
    for (const now of [1500, 5000, 9000]) f.update(now, h, false);
    expect(f.shortcuts).toBe(0);
  });

  it('heads for a predicted point only when it is on the same surface', () => {
    const run = (predicted: TrailPoint) => {
      const h = new PointerHistory();
      line(h, 0, 120, 100, 'wall');
      const f = new FollowerSim(() => 0);
      f.setStage(4);
      for (let now = 0; now < 30_000; now += 50) f.update(now, h, false, predicted);
      return f;
    };
    const same = run({ t: 0, p: [0.5, 1.8, -2], n: N, surface: 'wall' });
    expect(same.emitted.some((m) => m.shortcut)).toBe(true);
    expect(same.emitted.filter((m) => m.shortcut).every((m) => m.surface === 'wall')).toBe(true);
    const other = run({ t: 0, p: [0.5, 0.75, -1.5], n: [0, 1, 0], surface: 'desk' });
    expect(other.emitted.some((m) => m.shortcut)).toBe(false);
    expect(other.emitted.every((m) => m.surface === 'wall')).toBe(true);
  });
});

describe('FollowerSim loop shortcuts at frame rate', () => {
  it('cuts across a loop the player drew, even when updated every frame', () => {
    // The player scribbles quick circles (radius 0.16 m, 0.7 s per loop) on the
    // wall, live: points are recorded as time passes and the follower is updated every 16 ms.
    const h = new PointerHistory();
    const f = new FollowerSim(() => 0.01); // always roll a shortcut chance
    f.setStage(4);
    let shortcutMarks = 0;
    for (let t = 0; t < 20_000; t += 16) {
      const a = (t / 700) * Math.PI * 2;
      h.push({ t, p: [Math.cos(a) * 0.16 + t * 0.00002, 1.2 + Math.sin(a) * 0.16, -2], n: N, surface: 'wall' });
      for (const m of f.update(t, h, false)) {
        expect(m.surface).toBe('wall');
        if (m.shortcut) shortcutMarks++;
      }
    }
    expect(f.shortcuts).toBeGreaterThan(0);
    expect(shortcutMarks).toBeGreaterThan(0);
  });
});
