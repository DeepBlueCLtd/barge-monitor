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

  displayNow(): number {
    return this.now() + this.step;
  }

  iso(t = this.now()): string {
    return new Date(Math.round(SIM_EPOCH_UNIX + t) * 1000).toISOString().replace('.000Z', 'Z');
  }
}

export const simClock = new SimClockMirror();
