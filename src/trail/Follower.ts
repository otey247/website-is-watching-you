export type V3m = [number, number, number];

export interface TrailPoint {
  t: number;
  p: V3m;
  n: V3m;
  /** Surface identifier (mesh name); marks never bridge different surfaces. */
  surface: string;
}

/** Bounded history of pointer positions projected into the room. */
export class PointerHistory {
  readonly points: TrailPoint[] = [];
  constructor(
    readonly capacity = 900,
    readonly minSpacing = 0.035,
  ) {}

  /** Returns the point if it was recorded (far enough from the previous one). */
  push(pt: TrailPoint): TrailPoint | null {
    const last = this.points[this.points.length - 1];
    if (last && last.surface === pt.surface && dist(last.p, pt.p) < this.minSpacing) return null;
    this.points.push(pt);
    if (this.points.length > this.capacity) this.points.shift();
    return pt;
  }

  get lastTime(): number {
    return this.points.length ? this.points[this.points.length - 1].t : -Infinity;
  }

  /** Index of the last point recorded at or before time t (binary search). */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.points.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  clear(): void {
    this.points.length = 0;
  }
}

export const dist = (a: V3m, b: V3m): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Delay (ms) the follower trails the player by, per stage. */
export const FOLLOWER_DELAY = { 2: 6500, 3: 2600, 4: 1400 } as const;
const MIN_DELAY = 1100;

export interface FollowerMark {
  p: V3m;
  n: V3m;
  surface: string;
  t: number;
  shortcut: boolean;
}

/**
 * Simulation of the invisible follower that retraces the player's pointer path.
 *
 * Stage 0: off. Stage 1: only the player's own faint marks.
 * Stage 2: a second sequence follows far behind (≈6.5 s).
 * Stage 3: the delay shrinks as the player keeps interacting; the follower
 *          stops when the player stops.
 * Stage 4: occasionally takes a shortcut across the same surface instead of
 *          replaying the exact path, or heads toward the predicted next object.
 */
export class FollowerSim {
  stage = 0;
  delayMs: number = FOLLOWER_DELAY[2];
  /** Index of the last history point the follower has reached. */
  cursor = -1;
  position: V3m | null = null;
  surface: string | null = null;
  private lastMarkPos: V3m | null = null;
  private shortcutTarget: { p: V3m; n: V3m; surface: string; resumeIndex: number } | null = null;
  private stoppedSince = -Infinity;
  shortcuts = 0;
  readonly emitted: FollowerMark[] = [];

  constructor(private readonly rng: () => number = Math.random) {}

  setStage(stage: number): void {
    if (stage <= this.stage) return;
    this.stage = stage;
    if (stage >= 2) this.delayMs = Math.min(this.delayMs, FOLLOWER_DELAY[Math.min(4, stage) as 2 | 3 | 4]);
  }

  /** Each deliberate interaction tightens the delay at stage ≥ 3. */
  onInteraction(): void {
    if (this.stage >= 3) this.delayMs = Math.max(MIN_DELAY, this.delayMs * 0.88);
  }

  /**
   * Advance the follower. Returns new marks to render.
   * @param playerStill true when the pointer has not moved recently
   * @param predicted optional point on a surface the player will likely visit next
   */
  update(now: number, history: PointerHistory, playerStill: boolean, predicted: TrailPoint | null = null): FollowerMark[] {
    const out: FollowerMark[] = [];
    if (this.stage < 2 || history.points.length === 0) return out;

    // At stage ≥ 3 the follower stops when the player stops.
    if (this.stage >= 3 && playerStill) {
      if (!Number.isFinite(this.stoppedSince)) this.stoppedSince = now;
      return out;
    }
    if (Number.isFinite(this.stoppedSince)) {
      // When the player starts again the follower resumes after a short beat.
      if (now - this.stoppedSince < 0) return out;
      this.stoppedSince = -Infinity;
    }

    // Shortcut in progress: walk straight toward its target.
    if (this.shortcutTarget && this.position) {
      const tgt = this.shortcutTarget;
      const step = 0.06;
      const d = dist(this.position, tgt.p);
      if (d <= step) {
        this.position = [...tgt.p];
        this.cursor = Math.max(this.cursor, tgt.resumeIndex);
        this.shortcutTarget = null;
      } else {
        const k = step / d;
        this.position = [
          this.position[0] + (tgt.p[0] - this.position[0]) * k,
          this.position[1] + (tgt.p[1] - this.position[1]) * k,
          this.position[2] + (tgt.p[2] - this.position[2]) * k,
        ];
      }
      this.maybeMark(out, tgt.n, tgt.surface, now, true);
      return out;
    }

    const targetIndex = history.indexAt(now - this.delayMs);
    if (targetIndex < 0) return out;
    if (this.cursor < 0) this.cursor = Math.max(0, targetIndex - 1);

    while (this.cursor < targetIndex) {
      this.cursor++;
      const pt = history.points[this.cursor];
      if (!pt) break;
      this.position = [...pt.p];
      this.surface = pt.surface;
      this.maybeMark(out, pt.n, pt.surface, now, false);

      if (this.stage >= 4 && this.rng() < 0.02) {
        const sc = this.findShortcut(history, targetIndex, predicted);
        if (sc) {
          this.shortcutTarget = sc;
          this.shortcuts++;
          break;
        }
      }
    }
    return out;
  }

  private maybeMark(out: FollowerMark[], n: V3m, surface: string, now: number, shortcut: boolean): void {
    if (!this.position) return;
    if (this.lastMarkPos && dist(this.lastMarkPos, this.position) < 0.055) return;
    this.lastMarkPos = [...this.position];
    const m: FollowerMark = { p: [...this.position], n: [...n], surface, t: now, shortcut };
    out.push(m);
    this.emitted.push(m);
    if (this.emitted.length > 300) this.emitted.shift();
  }

  /**
   * A shortcut skips a loop in the recorded path (a later point on the same
   * surface that is spatially close but far along the path), or heads to the
   * predicted target when it lies on the same surface.
   */
  private findShortcut(history: PointerHistory, limit: number, predicted: TrailPoint | null): ShortcutTarget | null {
    const here = history.points[this.cursor];
    if (!here) return null;
    if (predicted && predicted.surface === here.surface && dist(predicted.p, here.p) < 1.6) {
      return { p: predicted.p, n: predicted.n, surface: predicted.surface, resumeIndex: limit };
    }
    let along = 0;
    for (let j = this.cursor + 1; j <= limit; j++) {
      const a = history.points[j - 1];
      const b = history.points[j];
      if (b.surface !== here.surface) return null;
      along += dist(a.p, b.p);
      const direct = dist(here.p, b.p);
      if (along > 0.6 && direct < along * 0.35) return { p: b.p, n: b.n, surface: b.surface, resumeIndex: j };
    }
    return null;
  }

  reset(): void {
    this.stage = 0;
    this.delayMs = FOLLOWER_DELAY[2];
    this.cursor = -1;
    this.position = null;
    this.lastMarkPos = null;
    this.shortcutTarget = null;
    this.shortcuts = 0;
    this.emitted.length = 0;
  }
}

type ShortcutTarget = { p: V3m; n: V3m; surface: string; resumeIndex: number };
