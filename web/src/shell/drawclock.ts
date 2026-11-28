// The drawing's clock (4.7, D-302; D-362): seconds on which messages are drawn as they arrive.
// It runs in real time at 1×, slower in slow motion (½×, ¼×), and stops while the system is
// paused, so every icon holds where it is. There is no simulation clock anywhere: replay time
// belongs to each display client (docs/v4-interfaces.md §8), and the 4.1 back end's
// simulation clock is retired (D-320).
class DrawClock {
  private base = performance.now() / 1000; // real seconds at the last change
  private at = this.base; // drawing seconds then
  private rate = 1;
  private stopped = false;

  /** Seconds on the drawing clock: real seconds since the page loaded at 1×, less any time paused, slower in slow motion. */
  now(): number {
    if (this.stopped) return this.at;
    return this.at + (performance.now() / 1000 - this.base) * this.rate;
  }

  /** Stop or run the clock, at `rate` drawing seconds per real second (D-362). */
  set(stopped: boolean, rate: number) {
    this.at = this.now();
    this.base = performance.now() / 1000;
    this.stopped = stopped;
    this.rate = rate;
  }
}

export const drawClock = new DrawClock();
