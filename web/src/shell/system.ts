// The system-level Pause and slow motion (D-362; revises the 4.7 removal of Freeze, D-229).
// They belong to the demonstrator shell, not to the system: the display client keeps its own
// replay bar (§8.6), and this is the "parent" control above it.
//
// Pause freezes everything. The drawing clock stops, so every icon holds where it is and can
// be clicked. The system is held: no request enters the relay (the display client's, each
// model's and the importer's wait at the relay's entrances, and an answer already on its way
// waits before it is read), the back end's importer and models stop stepping, pushed commands
// wait in the server, and the display client's replay clock, polling and idle lock stand
// still. Messages captured in the moment of pausing are kept by the page and drawn on Resume,
// so nothing is missed, and Resume continues exactly where Pause left off.
//
// Slow motion (½×, ¼×) runs the drawing clock slower and back-pressures the system: whenever
// the drawing falls LAG_HOLD_S behind (an icon queued that long before it can set off), the
// workers are held, as by Pause, until it has caught up to LAG_RELEASE_S; and the display
// client's requests are let into the relay one at a time, each only while the drawing keeps
// up. So every message is still drawn and clickable, and no backlog builds. At 1× nothing is
// held.
import { HOP_S } from '../config';
import { drawClock } from './drawclock';
import { bus } from './messages';
import { Store } from './store';

export const DRAW_SPEEDS = [1, 0.5, 0.25] as const;
export type DrawSpeed = (typeof DRAW_SPEEDS)[number];

/** Slow motion holds the system once an icon waits this long, in drawing seconds, before it can set off... */
export const LAG_HOLD_S = HOP_S;
/** ...and lets it go on once the drawing has caught up to this. */
export const LAG_RELEASE_S = HOP_S / 4;

class SystemControl {
  /** The viewer's Pause. */
  readonly paused = new Store(false);
  /** The drawing speed: 1×, or slow motion. */
  readonly speed = new Store<DrawSpeed>(1);
  /** The workers' hold: paused, or back-pressured in slow motion (the drawing LAG_HOLD_S behind, until LAG_RELEASE_S). */
  readonly held = new Store(false);
  private pressure = false;
  private waiters: Array<() => void> = [];
  private answers: Array<() => void> = [];
  private watching: ReturnType<typeof setInterval> | null = null;

  pause() {
    if (this.paused.value) return;
    this.paused.set(true);
    this.update();
  }

  resume() {
    if (!this.paused.value) return;
    this.paused.set(false);
    this.update();
  }

  setSpeed(s: DrawSpeed) {
    if (!(DRAW_SPEEDS as readonly number[]).includes(s) || s === this.speed.value) return;
    this.speed.set(s);
    if (s < 1 && !this.watching) this.watching = setInterval(() => this.checkLag(), 50);
    if (s === 1 && this.watching) {
      clearInterval(this.watching);
      this.watching = null;
      this.pressure = false;
    }
    this.update();
  }

  /**
   * Before a request enters the relay from the page (the display client's): at once at 1×; while paused, on Resume; in
   * slow motion, one at a time, each only while the drawing is less than LAG_HOLD_S behind, so a burst of requests sent
   * together (a dataset's reads) is drawn spaced out rather than queued far ahead.
   */
  wait(): Promise<void> {
    if (!this.paused.value && this.speed.value === 1) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** Before an answer already on its way is read: at once, unless paused; then on Resume. */
  waitPaused(): Promise<void> {
    if (!this.paused.value) return Promise.resolve();
    return new Promise((r) => this.answers.push(r));
  }

  /** How far behind the drawing is, in drawing seconds: how long the last icon queued must wait before it sets off. */
  lag(): number {
    return bus.lag();
  }

  private checkLag() {
    if (this.paused.value) return;
    const lag = this.lag();
    const on = this.speed.value < 1 && (this.pressure ? lag > LAG_RELEASE_S : lag >= LAG_HOLD_S);
    if (on !== this.pressure) {
      this.pressure = on;
      this.update();
    }
    // Slow motion: the page's requests are let in one at a time while the drawing keeps up.
    if (lag < LAG_HOLD_S) this.waiters.shift()?.();
  }

  private update() {
    drawClock.set(this.paused.value, this.speed.value);
    const held = this.paused.value || this.pressure;
    if (held !== this.held.value) this.held.set(held);
    if (!this.paused.value) for (const w of this.answers.splice(0)) w();
    if (!this.paused.value && this.speed.value === 1) for (const w of this.waiters.splice(0)) w();
  }
}

export const system = new SystemControl();

// Read-only, for the end-to-end tests (beside D-273's bargeCaptured; D-362): the system control and the drawing's lag.
(globalThis as { bargeSystem?: () => unknown }).bargeSystem = () => ({
  paused: system.paused.value, speed: system.speed.value, held: system.held.value, lag: system.lag(), draw: drawClock.now(),
  live: bus.live.value.length,
});
