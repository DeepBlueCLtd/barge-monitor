// The drawing's clock (4.7, D-302): real time, in seconds. Messages are drawn on it as
// they arrive. There is no simulation clock in the page any more: replay time belongs
// to each display client (docs/v4-interfaces.md §8), and the 4.1 back end's clock,
// which still steps the 4.1 world for the shell's platform card until Phase 8, is
// never played (§13.3: there is no play, pause or rate control action).
class DrawClock {
  /** Seconds of real time since the page loaded. */
  now(): number {
    return performance.now() / 1000;
  }
}

export const drawClock = new DrawClock();
