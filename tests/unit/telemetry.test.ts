import { describe, expect, it } from 'vitest';
import { PLAYER_ACTIONS, Telemetry } from '../../src/telemetry/Telemetry';
import type { CameraSample, RoomContext } from '../../src/telemetry/types';

const ctx: RoomContext = {
  lampOn: true,
  doorOpen: false,
  drawerOpen: true,
  curtainsOpen: true,
  chairState: 'player_moved',
  photoVariant: 'original',
  phase: 'inconsistency',
};

function make(capacity = 600) {
  let t = 0;
  let cam: CameraSample = { position: [1, 1.6, 2], yaw: 0.3, pitch: -0.1 };
  const tel = new Telemetry(
    () => t,
    () => cam,
    () => ctx,
    capacity,
  );
  return {
    tel,
    at: (v: number) => (t = v),
    setCam: (c: CameraSample) => (cam = c),
  };
}

describe('Telemetry event log', () => {
  it('records actual interactions with timestamp, camera, room context and metadata', () => {
    const { tel, at, setCam } = make();
    at(1500);
    const e = tel.record({ type: 'drawer_opened', target: 'drawer_top', area: 'desk', meta: { force: 0.4 } });
    expect(e).toMatchObject({
      id: 1,
      type: 'drawer_opened',
      target: 'drawer_top',
      area: 'desk',
      timestampMs: 1500,
      camera: { position: [1, 1.6, 2], yaw: 0.3, pitch: -0.1 },
      context: ctx,
      meta: { force: 0.4 },
      used: false,
      usedBy: [],
    });
    at(2600);
    setCam({ position: [0, 1.6, 0], yaw: 1, pitch: 0 });
    const e2 = tel.record({ type: 'lamp_toggled', target: 'lamp', area: 'lamp_corner', meta: { on: false }, context: { lampOn: false } });
    expect(e2.id).toBe(2);
    expect(e2.timestampMs).toBe(2600);
    expect(e2.camera.yaw).toBe(1);
    // Partial context overrides the sampled context.
    expect(e2.context.lampOn).toBe(false);
    expect(e2.context.chairState).toBe('player_moved');
    expect(tel.all().map((x) => x.id)).toEqual([1, 2]);
  });

  it('emits each recorded event', () => {
    const { tel } = make();
    const seen: number[] = [];
    tel.emitter.on('recorded', (e) => seen.push(e.id));
    tel.record({ type: 'object_inspected', target: 'clock', meta: {} });
    tel.record({ type: 'area_glanced', area: 'hallway', meta: {} });
    expect(seen).toEqual([1, 2]);
  });

  it('is bounded but keeps lifetime counters after eviction', () => {
    const { tel, at } = make(50);
    for (let i = 0; i < 180; i++) {
      at(i * 100);
      tel.record({ type: i % 3 === 0 ? 'lamp_toggled' : 'object_inspected', target: i % 3 === 0 ? 'lamp' : 'photograph', area: i % 3 === 0 ? 'lamp_corner' : 'photo_wall', meta: {} });
    }
    expect(tel.all()).toHaveLength(50);
    expect(tel.all()[0].id).toBe(131);
    expect(tel.count('lamp_toggled')).toBe(60);
    expect(tel.count('object_inspected', 'photograph')).toBe(120);
    expect(tel.countInArea('object_inspected', 'photo_wall')).toBe(120);
    expect(tel.interactionCount()).toBe(180);
    // Evicted ids are gone, retained ids are found.
    expect(tel.get(10)).toBeUndefined();
    expect(tel.get(131)?.id).toBe(131);
    expect(tel.get(180)?.id).toBe(180);
    expect(tel.get(181)).toBeUndefined();
  });

  it('interactionCount only counts deliberate player actions', () => {
    const { tel } = make();
    tel.record({ type: 'session_started', meta: {} });
    tel.record({ type: 'area_glanced', area: 'desk', meta: {} });
    tel.record({ type: 'anomaly_witnessed', target: 'photograph', meta: {} });
    tel.record({ type: 'prediction_resolved', meta: {} });
    expect(tel.interactionCount()).toBe(0);
    tel.record({ type: 'door_handle_tried', target: 'door', meta: {} });
    expect(tel.interactionCount()).toBe(1);
    expect(PLAYER_ACTIONS).not.toContain('area_glanced');
  });

  it('query filters by type, target, time window, meta and consumer', () => {
    const { tel, at } = make();
    at(0);
    const a = tel.record({ type: 'lamp_toggled', target: 'lamp', meta: { on: true } });
    at(1000);
    tel.record({ type: 'lamp_toggled', target: 'lamp', meta: { on: false } });
    at(2000);
    const c = tel.record({ type: 'object_inspected', target: 'clock', meta: {} });
    expect(tel.query({ type: 'lamp_toggled', meta: { on: true } }).map((e) => e.id)).toEqual([a.id]);
    expect(tel.query({ since: 1000 }).length).toBe(2);
    expect(tel.query({ before: 1000 }).map((e) => e.id)).toEqual([a.id]);
    expect(tel.query({ type: ['object_inspected', 'drawer_opened'] }).map((e) => e.id)).toEqual([c.id]);
    expect(tel.last('lamp_toggled')?.meta.on).toBe(false);
    expect(tel.last(undefined, 'clock')?.id).toBe(c.id);
    tel.markUsed(a.id, 'director:x');
    tel.markUsed(a.id, 'director:x');
    expect(tel.get(a.id)?.usedBy).toEqual(['director:x']);
    expect(tel.get(a.id)?.used).toBe(true);
    expect(tel.query({ type: 'lamp_toggled', unusedBy: 'director:x' }).length).toBe(1);
  });

  it('snapshot/restore round-trips events and counters', () => {
    const { tel } = make();
    tel.record({ type: 'object_inspected', target: 'mirror', meta: {} });
    tel.record({ type: 'chair_moved', target: 'chair', meta: {} });
    const snap = JSON.parse(JSON.stringify(tel.snapshot()));
    const other = make().tel;
    other.restore(snap);
    expect(other.all()).toEqual(tel.all());
    expect(other.count('chair_moved')).toBe(1);
    expect(other.record({ type: 'lamp_toggled', target: 'lamp', meta: {} }).id).toBe(3);
    tel.reset();
    expect(tel.all()).toHaveLength(0);
    expect(tel.count('chair_moved')).toBe(0);
  });
});
