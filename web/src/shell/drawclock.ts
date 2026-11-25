// The drawing's clock (FR-78, FR-92): real time, in seconds, standing still while the
// demonstrator is frozen. Messages are drawn on it, so Freeze holds every icon where it is.
// There is no simulation clock: replay time belongs to the replay controller (§4).
import { Store } from './store';

class DrawClock {
  /** True while Freeze holds the demonstrator (FR-92). */
  frozen = new Store(false);
  private heldAt: number | null = null;
  private held = 0; // seconds spent frozen so far

  /** Seconds of real time, less the time spent frozen. */
  now(): number {
    const real = performance.now() / 1000;
    return (this.heldAt ?? real) - this.held;
  }

  hold(on: boolean) {
    const real = performance.now() / 1000;
    if (on && this.heldAt === null) this.heldAt = real;
    if (!on && this.heldAt !== null) {
      this.held += real - this.heldAt;
      this.heldAt = null;
    }
    if (this.frozen.value !== on) this.frozen.set(on);
  }
}

export const drawClock = new DrawClock();

/** Replay time (Unix seconds) as ISO 8601, to the second. */
export function isoSecond(t: number): string {
  return new Date(Math.round(t) * 1000).toISOString().replace('.000Z', 'Z');
}
