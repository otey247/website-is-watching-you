import { describe, expect, it } from 'vitest';
import { CHAIR, FLOOR_OBSTACLES, ROOM } from '../../src/core/layout';
import { Rng } from '../../src/core/rng';
import { collides, resolvePosition, sweep } from '../../src/world/collision';
import { MUTABLE_DEFINITIONS } from '../../src/world/objects';
import { WorldState, type ChangeEvent } from '../../src/world/WorldState';

const makeWorld = () => {
  let t = 0;
  const world = new WorldState(() => t);
  return { world, setTime: (v: number) => (t = v) };
};

describe('WorldState initial state', () => {
  it('loads every mutable object in its definition initial state, unclaimed, with no history', () => {
    const { world } = makeWorld();
    const defs = Object.values(MUTABLE_DEFINITIONS);
    expect(defs.length).toBeGreaterThan(10);
    expect(world.ids().sort()).toEqual(defs.map((d) => d!.id).sort());
    for (const def of defs) {
      expect(world.get(def!.id)).toEqual(def!.initial);
      expect(def!.states).toContain(def!.initial.state);
      expect(world.validate(def!.id, def!.initial)).toBeNull();
      expect(world.claimOwner(def!.id)).toBeUndefined();
      expect(world.historyOf(def!.id)).toHaveLength(0);
    }
    expect(world.mutationLog()).toHaveLength(0);
    expect(world.context()).toEqual({
      lampOn: false,
      doorOpen: false,
      drawerOpen: false,
      curtainsOpen: true,
      chairState: 'original',
      photoVariant: 'original',
    });
  });

  it('state is independent of the definition objects (no shared references)', () => {
    const { world } = makeWorld();
    world.apply('drawer_top', { state: 'open', open: 1 }, { source: 'player', cause: 'test' });
    expect(MUTABLE_DEFINITIONS.drawer_top!.initial.open).toBe(0);
    world.reset();
    expect(world.get('drawer_top')).toEqual(MUTABLE_DEFINITIONS.drawer_top!.initial);
  });

  it('get() throws for non-mutable objects', () => {
    const { world } = makeWorld();
    expect(() => world.get('desk')).toThrow();
    expect(world.apply('desk', { state: 'x' }, { source: 'player', cause: 't' }).ok).toBe(false);
  });
});

describe('chair collision constraints', () => {
  it('the initial chair position is collision free', () => {
    expect(collides({ x: CHAIR.initial.x, z: CHAIR.initial.z }, CHAIR.radius)).toBe(false);
  });

  it('resolvePosition never returns a colliding position', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 4000; i++) {
      const desired = { x: rng.range(ROOM.minX - 1, ROOM.maxX + 1), z: rng.range(ROOM.minZ - 1, ROOM.maxZ + 1) };
      const p = resolvePosition(desired, CHAIR.radius);
      expect(collides(p, CHAIR.radius), `desired ${desired.x.toFixed(3)},${desired.z.toFixed(3)} -> ${p.x.toFixed(3)},${p.z.toFixed(3)}`).toBe(false);
    }
  });

  it('resolvePosition handles points inside every obstacle', () => {
    for (const b of FLOOR_OBSTACLES) {
      const p = resolvePosition({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, CHAIR.radius);
      expect(collides(p, CHAIR.radius), b.id).toBe(false);
    }
  });

  it('sweep never returns a colliding position and stops before obstacles', () => {
    const rng = new Rng(7);
    const from = { x: CHAIR.initial.x, z: CHAIR.initial.z };
    for (let i = 0; i < 400; i++) {
      const to = { x: rng.range(ROOM.minX, ROOM.maxX), z: rng.range(ROOM.minZ, ROOM.maxZ) };
      const p = sweep(from, to, CHAIR.radius);
      expect(collides(p, CHAIR.radius)).toBe(false);
    }
    // Sweeping straight into the desk pedestal stops short of it.
    const blocked = sweep({ x: -0.42, z: -0.5 }, { x: -0.42, z: -1.8 }, CHAIR.radius);
    expect(blocked.z).toBeGreaterThan(-1.42 + CHAIR.radius - 0.03);
    expect(collides(blocked, CHAIR.radius)).toBe(false);
  });

  it('world.apply rejects colliding chair positions and leaves the chair unchanged', () => {
    const { world } = makeWorld();
    const before = { ...world.get('chair') };
    const changes: ChangeEvent[] = [];
    world.emitter.on('changed', (c) => changes.push(c));
    const inDesk = world.apply('chair', { x: -0.42, z: -1.7 }, { source: 'player', cause: 'drag' });
    expect(inDesk).toEqual({ ok: false, reason: 'chair position collides' });
    const throughWall = world.apply('chair', { x: ROOM.maxX + 0.5, z: 0 }, { source: 'director', cause: 'x' });
    expect(throughWall.ok).toBe(false);
    const doorSwing = world.apply('chair', { x: 2.0, z: -0.8 }, { source: 'player', cause: 'drag' });
    expect(doorSwing.ok).toBe(false);
    expect(world.get('chair')).toEqual(before);
    expect(changes).toHaveLength(0);
    expect(world.historyOf('chair')).toHaveLength(0);
    // A free spot is accepted.
    expect(world.apply('chair', { state: 'player_moved', x: -0.3, z: 0.2 }, { source: 'player', cause: 'drag' }).ok).toBe(true);
  });
});

describe('state validation', () => {
  it('rejects undeclared states, out-of-range values and occupied slots', () => {
    const { world } = makeWorld();
    expect(world.apply('photograph', { state: 'melting' }, { source: 'director', cause: 't' }).ok).toBe(false);
    expect(world.apply('door', { open: 1.4 }, { source: 'player', cause: 't' }).ok).toBe(false);
    expect(world.apply('door', { handle: -0.2 }, { source: 'player', cause: 't' }).ok).toBe(false);
    expect(world.apply('clock', { offsetMs: 5000 }, { source: 'director', cause: 't' }).ok).toBe(false);
    // book_1 sits in s3_b; book_0 cannot move there.
    const r = world.apply('book_0', { state: 'moved', slot: 's3_b' }, { source: 'director', cause: 't' });
    expect(r.ok).toBe(false);
    expect(world.apply('book_0', { state: 'moved', slot: 'nowhere' }, { source: 'director', cause: 't' }).ok).toBe(false);
    expect(world.apply('book_0', { state: 'moved', slot: 's1_b' }, { source: 'director', cause: 't' }).ok).toBe(true);
    expect(world.slotOccupant('s1_b')).toBe('book_0');
    expect(world.freeSlots('shelf')).toContain('s3_a');
  });
});

describe('persistence and history', () => {
  it('snapshot/restore round-trips every object state', () => {
    const { world, setTime } = makeWorld();
    setTime(1000);
    world.apply('lamp', { state: 'on', on: true }, { source: 'player', cause: 'click' });
    world.apply('chair', { state: 'player_moved', x: 0.4, z: 0.3, yaw: 1 }, { source: 'player', cause: 'drag' });
    world.apply('photograph', { state: 'removed' }, { source: 'director', cause: 'photo_first_change' });
    world.apply('book_2', { state: 'moved', slot: 's2_c' }, { source: 'player', cause: 'place' });
    const snap = world.snapshot();
    const json = JSON.parse(JSON.stringify(snap));

    const other = makeWorld().world;
    other.restore(json);
    for (const id of world.ids()) expect(other.get(id)).toEqual(world.get(id));

    // Mutating after the snapshot does not affect it; restoring returns to it.
    world.apply('lamp', { state: 'off', on: false }, { source: 'player', cause: 'click' });
    world.apply('chair', { x: -0.3, z: 0.6 }, { source: 'player', cause: 'drag' });
    world.restore(snap);
    expect(world.get('lamp').on).toBe(true);
    expect(world.get('chair')).toMatchObject({ state: 'player_moved', x: 0.4, z: 0.3, yaw: 1 });
    expect(world.get('photograph').state).toBe('removed');
  });

  it('records every discrete change with source, cause, evidence and timestamp', () => {
    const { world, setTime } = makeWorld();
    setTime(4242);
    const r = world.apply('clock', { state: 'lost_seconds', offsetMs: -7000 }, { source: 'director', cause: 'clock_lose_seconds', evidence: [3, 4] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({ objectId: 'clock', source: 'director', cause: 'clock_lose_seconds', timestampMs: 4242, evidence: [3, 4] });
    expect(r.record!.from.state).toBe('normal');
    expect(r.record!.to.state).toBe('lost_seconds');
    // Continuous changes are not individually recorded; commit coalesces them.
    const from = { ...world.get('door') };
    world.apply('door', { open: 0.3 }, { source: 'player', cause: 'drag', continuous: true });
    world.apply('door', { open: 0.6 }, { source: 'player', cause: 'drag', continuous: true });
    expect(world.historyOf('door')).toHaveLength(0);
    const rec = world.commit('door', from, 'player', 'drag');
    expect(rec.from.open).toBeCloseTo(0.12);
    expect(rec.to.open).toBeCloseTo(0.6);
    expect(world.lastPlayerRecord('door')?.id).toBe(rec.id);
  });

  it('revert restores a director mutation only if nothing changed since', () => {
    const { world } = makeWorld();
    const r = world.apply('lamp', { state: 'on', on: true }, { source: 'director', cause: 'a' });
    if (!r.ok) throw new Error('apply failed');
    expect(world.revert(r.record!.id).ok).toBe(true);
    expect(world.get('lamp')).toEqual(MUTABLE_DEFINITIONS.lamp!.initial);

    const r2 = world.apply('lamp', { state: 'on', on: true }, { source: 'director', cause: 'b' });
    world.apply('lamp', { state: 'off', on: false }, { source: 'player', cause: 'click' });
    if (!r2.ok) throw new Error('apply failed');
    expect(world.revert(r2.record!.id)).toEqual({ ok: false, reason: 'object changed since' });
  });
});

describe('claims prevent conflicting assignments', () => {
  it('a second non-player owner cannot claim; the player preempts; non-owners cannot apply', () => {
    const { world } = makeWorld();
    const preempted: unknown[] = [];
    world.emitter.on('claimPreempted', (p) => preempted.push(p));
    expect(world.claim('chair', 'anomaly:a#1')).toBe(true);
    expect(world.claim('chair', 'anomaly:a#1')).toBe(true);
    expect(world.claim('chair', 'anomaly:b#2')).toBe(false);
    expect(world.claimOwner('chair')).toBe('anomaly:a#1');

    const blocked = world.apply('chair', { yaw: 0.5 }, { source: 'director', cause: 'b', owner: 'anomaly:b#2' });
    expect(blocked).toEqual({ ok: false, reason: 'chair is claimed by anomaly:a#1' });
    const playerBlocked = world.apply('chair', { yaw: 0.5 }, { source: 'player', cause: 'drag' });
    expect(playerBlocked.ok).toBe(false);
    expect(world.apply('chair', { yaw: 0.5 }, { source: 'director', cause: 'a', owner: 'anomaly:a#1' }).ok).toBe(true);

    expect(world.claim('chair', 'player')).toBe(true);
    expect(preempted).toEqual([{ objectId: 'chair', owner: 'anomaly:a#1', by: 'player' }]);
    expect(world.claimOwner('chair')).toBe('player');
    expect(world.apply('chair', { yaw: 0.9 }, { source: 'director', cause: 'a', owner: 'anomaly:a#1' }).ok).toBe(false);
    // Release by a non-owner is a no-op.
    world.release('chair', 'anomaly:a#1');
    expect(world.claimOwner('chair')).toBe('player');
    world.release('chair', 'player');
    expect(world.claimOwner('chair')).toBeUndefined();
  });

  it('releaseAll only releases the given owner', () => {
    const { world } = makeWorld();
    world.claim('lamp', 'x');
    world.claim('door', 'x');
    world.claim('clock', 'y');
    world.releaseAll('x');
    expect(world.claimOwner('lamp')).toBeUndefined();
    expect(world.claimOwner('door')).toBeUndefined();
    expect(world.claimOwner('clock')).toBe('y');
  });
});
