/**
 * Session clock. All simulation timestamps are session-relative milliseconds
 * of *active* play: the clock does not advance while the tab is hidden or the
 * pause menu is open, so no event progression happens in the background.
 */
export class SessionClock {
  private t = 0;
  private paused = false;
  private pauseReasons = new Set<string>();
  /** Multiplier applied to real frame time (test mode can accelerate pacing). */
  timeScale = 1;

  get now(): number {
    return this.t;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Advance by a real-time delta (ms). Returns the scaled simulation delta. */
  tick(realDeltaMs: number): number {
    if (this.paused) return 0;
    // Clamp long frames (tab switches, debugger pauses) so nothing jumps.
    const dt = Math.min(Math.max(realDeltaMs, 0), 100) * this.timeScale;
    this.t += dt;
    return dt;
  }

  /** Deterministic advance used by tests and test mode; ignores pause. */
  advance(ms: number): void {
    this.t += Math.max(0, ms);
  }

  pause(reason: string): void {
    this.pauseReasons.add(reason);
    this.paused = true;
  }

  resume(reason: string): void {
    this.pauseReasons.delete(reason);
    this.paused = this.pauseReasons.size > 0;
  }

  restore(t: number): void {
    this.t = t;
  }
}
