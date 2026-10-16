export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. `rate` is 1/seconds. */
export const damp = (current: number, target: number, rate: number, dtSec: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dtSec));

export const wrapAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

export const dampAngle = (current: number, target: number, rate: number, dtSec: number): number =>
  current + wrapAngle(target - current) * (1 - Math.exp(-rate * dtSec));

export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Exponential decay of a value with given half-life. */
export const decay = (value: number, dtMs: number, halfLifeMs: number): number =>
  value * Math.pow(0.5, dtMs / halfLifeMs);

export interface Vec2 {
  x: number;
  z: number;
}

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Critically damped spring step (semi-implicit). Used for drawers, the door,
 * held objects and chair inertia so every motion has believable mass.
 */
export function springStep(
  pos: number,
  vel: number,
  target: number,
  stiffness: number,
  damping: number,
  dtSec: number,
): [number, number] {
  const steps = Math.max(1, Math.ceil(dtSec / (1 / 120)));
  const h = dtSec / steps;
  let p = pos;
  let v = vel;
  for (let i = 0; i < steps; i++) {
    const a = -stiffness * (p - target) - damping * v;
    v += a * h;
    p += v * h;
  }
  return [p, v];
}
