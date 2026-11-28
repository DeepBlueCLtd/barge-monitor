// The system hold, as the back end keeps it (D-362): the demonstrator's Pause, or slow motion's
// back-pressure, holds the system still. While held, the importer and the core models stop at
// their next step and pushed commands wait in the server; let go, each carries on exactly where
// it stopped. Scaffolding of the demonstrator: a developed system has no such hold. Free of DOM,
// worker and Node globals.
export class Gate {
  private held = false;
  private waiters: Array<() => void> = [];

  get isHeld(): boolean {
    return this.held;
  }

  set(on: boolean): void {
    this.held = on;
    if (!on) for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves at once unless held; else when let go. */
  wait(): Promise<void> {
    if (!this.held) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** Run `f` now, or when let go, in order. */
  after(f: () => void): void {
    if (!this.held) f();
    else this.waiters.push(f);
  }
}
