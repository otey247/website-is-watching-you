import { FLOOR_OBSTACLES, ROOM, type Box2 } from '../core/layout';
import type { Vec2 } from '../core/math';

const WALL_MARGIN = 0.02;

/** Signed penetration of a circle into a box; returns push-out vector or null. */
function circleBoxPush(c: Vec2, r: number, b: Box2): Vec2 | null {
  const cx = Math.max(b.minX, Math.min(c.x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(c.z, b.maxZ));
  const dx = c.x - cx;
  const dz = c.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-10) {
    const d = Math.sqrt(d2);
    const k = (r - d) / d;
    return { x: dx * k, z: dz * k };
  }
  // Center inside the box: push out along the axis of least penetration.
  const left = c.x - b.minX + r;
  const right = b.maxX - c.x + r;
  const up = c.z - b.minZ + r;
  const down = b.maxZ - c.z + r;
  const m = Math.min(left, right, up, down);
  if (m === left) return { x: -left, z: 0 };
  if (m === right) return { x: right, z: 0 };
  if (m === up) return { x: 0, z: -up };
  return { x: 0, z: down };
}

export function collides(p: Vec2, radius: number, obstacles: Box2[] = FLOOR_OBSTACLES): boolean {
  if (p.x - radius < ROOM.minX + WALL_MARGIN || p.x + radius > ROOM.maxX - WALL_MARGIN) return true;
  if (p.z - radius < ROOM.minZ + WALL_MARGIN || p.z + radius > ROOM.maxZ - WALL_MARGIN) return true;
  return obstacles.some((b) => circleBoxPush(p, radius, b) !== null);
}

/**
 * Resolve a desired chair position against the room bounds and furniture.
 * Iterative push-out keeps the chair sliding along obstacles instead of
 * stopping dead, which reads as physical contact.
 */
export function resolvePosition(desired: Vec2, radius: number, obstacles: Box2[] = FLOOR_OBSTACLES): Vec2 {
  const p = { x: desired.x, z: desired.z };
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (const b of obstacles) {
      const push = circleBoxPush(p, radius, b);
      if (push) {
        p.x += push.x;
        p.z += push.z;
        moved = true;
      }
    }
    const minX = ROOM.minX + radius + WALL_MARGIN;
    const maxX = ROOM.maxX - radius - WALL_MARGIN;
    const minZ = ROOM.minZ + radius + WALL_MARGIN;
    const maxZ = ROOM.maxZ - radius - WALL_MARGIN;
    if (p.x < minX) ((p.x = minX), (moved = true));
    if (p.x > maxX) ((p.x = maxX), (moved = true));
    if (p.z < minZ) ((p.z = minZ), (moved = true));
    if (p.z > maxZ) ((p.z = maxZ), (moved = true));
    if (!moved) break;
  }
  if (!collides(p, radius, obstacles)) return p;
  // Push-out can oscillate in pockets narrower than the chair (between an
  // obstacle and a wall). Fall back to the nearest free point around the
  // desired position so the result is always collision free.
  for (let r = 0.02; r <= 6; r += 0.02) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.02));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = { x: desired.x + Math.cos(a) * r, z: desired.z + Math.sin(a) * r };
      if (!collides(c, radius, obstacles)) return c;
    }
  }
  return p;
}

/**
 * Sweep from `from` toward `to` and return the furthest collision-free point.
 * Used by director-driven chair movement so it never passes through furniture.
 */
export function sweep(from: Vec2, to: Vec2, radius: number, obstacles: Box2[] = FLOOR_OBSTACLES): Vec2 {
  const steps = Math.max(2, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / 0.02));
  let last = { ...from };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    if (collides(p, radius, obstacles)) return last;
    last = p;
  }
  return last;
}
