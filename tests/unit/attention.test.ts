import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector2, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { AttentionEstimator, type AttentionTarget } from '../../src/attention/AttentionEstimator';
import type { AreaId, ObjectId } from '../../src/core/layout';

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 16 / 9, 0.05, 50);
  cam.position.set(0, 1.6, 0);
  cam.lookAt(0, 1.6, -1); // looking down -z
  cam.updateMatrixWorld(true);
  return cam;
}

function target(id: ObjectId, area: AreaId, center: [number, number, number], radius = 0.25): { t: AttentionTarget; mesh: Mesh } {
  const mesh = new Mesh(new BoxGeometry(radius * 1.4, radius * 1.4, radius * 1.4), new MeshBasicMaterial());
  mesh.position.set(...center);
  mesh.updateMatrixWorld(true);
  return { t: { id, area, center: new Vector3(...center), radius, meshes: [mesh] }, mesh };
}

function wall(z: number): Mesh {
  const m = new Mesh(new BoxGeometry(3, 3, 0.1), new MeshBasicMaterial());
  m.position.set(0, 1.6, z);
  m.updateMatrixWorld(true);
  return m;
}

describe('AttentionEstimator', () => {
  it('an object in front of the camera is attended with a positive score', () => {
    const { t, mesh } = target('clock', 'hallway', [0, 1.6, -3]);
    const est = new AttentionEstimator(camera(), [t], [mesh]);
    est.sample(null, 1000, 100);
    const e = est.get('clock')!;
    expect(e.inFrustum).toBe(true);
    expect(e.occluded).toBe(false);
    expect(e.visibleFraction).toBe(1);
    expect(e.visibility).toBe('attended');
    expect(e.score).toBeGreaterThan(0.42);
    expect(e.lastSeenMs).toBe(1000);
    expect(e.lastAttendedMs).toBe(1000);
    expect(est.isUnseen('clock')).toBe(false);
    expect(est.focus()?.id).toBe('clock');
    expect(e.dwellMs).toBeCloseTo(100 * e.score);
  });

  it('an object behind the camera is offscreen with score 0 even with the pointer on screen', () => {
    const { t, mesh } = target('photograph', 'photo_wall', [0, 1.6, 3]);
    const est = new AttentionEstimator(camera(), [t], [mesh]);
    est.sample(new Vector2(0, 0), 500, 100);
    const e = est.get('photograph')!;
    expect(e.inFrustum).toBe(false);
    expect(e.visibility).toBe('offscreen');
    expect(e.score).toBe(0);
    expect(e.pointerAttention).toBe(0);
    expect(e.pointerDistance).toBe(Infinity);
    expect(e.dwellMs).toBe(0);
    expect(est.isUnseen('photograph')).toBe(true);
    expect(est.focus()).toBeUndefined();
  });

  it('an object hidden behind a wall is occluded, not visible', () => {
    const { t, mesh } = target('lamp', 'lamp_corner', [0, 1.6, -4]);
    const w = wall(-2);
    const est = new AttentionEstimator(camera(), [t], [w, mesh]);
    est.sample(new Vector2(0, 0), 100, 100);
    const e = est.get('lamp')!;
    expect(e.inFrustum).toBe(true);
    expect(e.occluded).toBe(true);
    expect(e.visibleFraction).toBe(0);
    expect(e.visibility).toBe('occluded');
    expect(e.score).toBe(0);
    expect(est.isUnseen('lamp')).toBe(true);
  });

  it("an object's own meshes and invisible occluders do not hide it", () => {
    const { t, mesh } = target('lamp', 'lamp_corner', [0, 1.6, -4]);
    const w = wall(-2);
    w.visible = false;
    const est = new AttentionEstimator(camera(), [t], [w, mesh as Object3D]);
    est.sample(null, 100, 100);
    expect(est.get('lamp')!.visibility).toBe('attended');
  });

  it('an object near the edge of the view is peripheral, not attended', () => {
    // ~40° to the side: inside the 16:9 horizontal frustum (≈ ±50°), far from centre.
    const { t, mesh } = target('cup', 'table', [Math.tan((40 * Math.PI) / 180) * 3, 1.6, -3], 0.06);
    const est = new AttentionEstimator(camera(), [t], [mesh]);
    est.sample(null, 100, 100);
    const e = est.get('cup')!;
    expect(e.inFrustum).toBe(true);
    expect(e.visibility).toBe('peripheral');
    expect(e.score).toBeGreaterThan(0);
    expect(e.score).toBeLessThan(0.42);
  });

  it('the pointer is a weak hint that raises attention of what it rests on', () => {
    const { t, mesh } = target('cup', 'table', [Math.tan((40 * Math.PI) / 180) * 3, 1.6, -3], 0.06);
    const cam = camera();
    const est = new AttentionEstimator(cam, [t], [mesh]);
    est.sample(null, 100, 100);
    const without = est.get('cup')!.score;
    const ndc = t.center.clone().project(cam);
    est.sample(new Vector2(ndc.x, ndc.y), 200, 100);
    const e = est.get('cup')!;
    expect(e.pointerAttention).toBeGreaterThan(0.9);
    expect(e.score).toBeGreaterThan(without);
  });

  it('tracks how long an object has been unseen', () => {
    const { t, mesh } = target('clock', 'hallway', [0, 1.6, -3]);
    const cam = camera();
    const est = new AttentionEstimator(cam, [t], [mesh]);
    est.sample(null, 1000, 100);
    expect(est.unseenForMs('clock', 1000)).toBe(0);
    cam.lookAt(0, 1.6, 1); // turn around
    est.sample(null, 1100, 100);
    expect(est.get('clock')!.visibility).toBe('offscreen');
    expect(est.unseenForMs('clock', 5100)).toBe(4100);
    expect(est.areaScores().get('hallway')).toBe(0);
  });
});
