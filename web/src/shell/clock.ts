// A mirror of the simulation clock, which lives in the backend worker (B-C01).
// Everything on the page that needs time, including the display client's
// polling, reads it from here (FR-14). No host clock sets simulated time;
// the host's timer only interpolates between the backend's reports.
import { Store } from './store';

export interface ClockState {
  t: number;
  rate: number;
  playing: boolean;
  rates: number[];
  default_rate: number;
}

export const SIM_EPOCH_UNIX = 1933286400;

class SimClockMirror {
  state = new Store<ClockState | null>(null);
  private at = 0;
  /** Extra display time while paused, from the Step button (flowchart only). */
  step = 0;

  update(s: ClockState) {
    this.at = performance.now();
    this.state.set(s);
  }

  now(): number {
    const s = this.state.value;
    if (!s) return 0;
    return s.t + (s.playing ? ((performance.now() - this.at) / 1000) * s.rate : 0);
  }

  private shown = { t: 0, at: 0 };

  /**
   * Time for drawing (icons on the flowchart). While playing it never runs
   * backwards and eases toward the backend's time over about half a second,
   * so a late report from a busy backend worker does not make icons jump
   * (D-54). Paused, or far out (a restart, Step), it follows exactly.
   */
  displayNow(): number {
    const target = this.now() + this.step;
    const s = this.state.value;
    const wall = performance.now();
    const dt = Math.min((wall - this.shown.at) / 1000, 0.25);
    if (!s?.playing || Math.abs(target - this.shown.t) > 5) { this.shown.at = wall; return (this.shown.t = target); }
    if (dt < 0.001) return this.shown.t; // called again in the same frame
    this.shown.at = wall;
    const free = this.shown.t + dt * s.rate;
    const eased = free + (target - free) * Math.min(1, dt / 0.5);
    return (this.shown.t = Math.max(this.shown.t, eased));
  }

  iso(t = this.now()): string {
    return new Date(Math.round(SIM_EPOCH_UNIX + t) * 1000).toISOString().replace('.000Z', 'Z');
  }
}

export const simClock = new SimClockMirror();
