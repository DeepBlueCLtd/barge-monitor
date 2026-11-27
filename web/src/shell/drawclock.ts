// The drawing's clock (4.7, D-302): real time, in seconds. Messages are drawn on it as
// they arrive. There is no simulation clock anywhere: replay time belongs to each
// display client (docs/v4-interfaces.md §8), and the 4.1 back end's simulation clock is
// retired (D-320).
class DrawClock {
  /** Seconds of real time since the page loaded. */
  now(): number {
    return performance.now() / 1000;
  }
}

export const drawClock = new DrawClock();
