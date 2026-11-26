// A mirror of the simulation clock, which lives in the back-end worker. Everything
// on the page that needs time, including the display client's polling, reads it
// from here (FR-13). No host clock sets simulated time; the host's timer only
// interpolates between the back end's reports, and only while the clock runs.
import { DEFAULT_RATE, RATES } from '../config';
import { Store } from './store';

export interface ClockState {
  t: number;
  rate: number;
  playing: boolean;
  rates?: number[];
  default_rate?: number;
}

/** Simulated seconds count from this Unix time (the simulation epoch). */
export const SIM_EPOCH_UNIX = 1933286400;

const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

class SimClockMirror {
  state = new Store<ClockState | null>(null);
  private at = 0;
  private shown = { t: 0, at: 0 };

  update(s: ClockState | null | undefined) {
    if (!s || typeof s.t !== 'number') return;
    this.at = performance.now();
    const old = this.state.value;
    // Only notify subscribers when something they show changes (ticks arrive every 100 ms).
    if (!old || old.playing !== s.playing || old.rate !== s.rate || Math.floor(old.t) !== Math.floor(s.t)) this.state.set(s);
    else this.state.value = s;
  }

  get playing(): boolean {
    return !!this.state.value?.playing;
  }

  get rate(): number {
    return this.state.value?.rate ?? DEFAULT_RATE;
  }

  get rates(): number[] {
    return this.state.value?.rates ?? RATES;
  }

  now(): number {
    const s = this.state.value;
    if (!s) return 0;
    return s.t + (s.playing ? ((performance.now() - this.at) / 1000) * s.rate : 0);
  }

  /**
   * Time for drawing icons. While playing it never runs backwards and eases
   * toward the back end's time over about half a second, so a late report
   * from a busy worker does not make icons jump. Paused, it stands still.
   */
  displayNow(): number {
    const target = this.now();
    const s = this.state.value;
    const wall = performance.now();
    // VS-23: under reduced motion, messages move without easing.
    if (reducedMotion) return (this.shown.t = target);
    const dt = Math.min((wall - this.shown.at) / 1000, 0.25);
    if (!s?.playing || Math.abs(target - this.shown.t) > 5) {
      this.shown.at = wall;
      return (this.shown.t = target);
    }
    if (dt < 0.001) return this.shown.t;
    this.shown.at = wall;
    const free = this.shown.t + dt * s.rate;
    const eased = free + (target - free) * Math.min(1, dt / 0.5);
    return (this.shown.t = Math.max(this.shown.t, eased));
  }

  iso(t = this.now()): string {
    return new Date(Math.round(SIM_EPOCH_UNIX + t) * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** hh:mm:ss of simulated time, for the collection platform card. */
  hms(t = this.now()): string {
    return new Date(Math.floor(SIM_EPOCH_UNIX + t) * 1000).toISOString().slice(11, 19);
  }
}

export const simClock = new SimClockMirror();

/** Resolves after `s` simulated seconds; while the clock stands still, it waits (FR-13, AT-19). */
export function simSleep(s: number, cancelled: () => boolean = () => false): Promise<void> {
  const until = simClock.now() + s;
  return new Promise((resolve) => {
    const h = setInterval(() => {
      if (cancelled() || simClock.now() >= until) {
        clearInterval(h);
        resolve();
      }
    }, 50);
  });
}

/** Resolves at the next whole simulated second, which only comes while the clock runs (FR-63). */
export function nextSimSecond(cancelled: () => boolean = () => false): Promise<void> {
  const from = Math.floor(simClock.now());
  return new Promise((resolve) => {
    const h = setInterval(() => {
      if (cancelled() || (simClock.playing && Math.floor(simClock.now()) > from)) {
        clearInterval(h);
        resolve();
      }
    }, 40);
  });
}
