// Startup and readiness (FR-125a, NFR-10a, docs/v4-interfaces.md §13.7).
//
// The loading progress names each step in turn. A step that has not finished within
// STALL_MS says so, naming the step and what the viewer can do, rather than waiting
// silently with the controls disabled. A disabled control says why: "Starting: <step>".
import { Store } from './store';

export type StepId = 'relay' | 'back end' | 'history' | 'server' | 'models';
export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface Step {
  id: StepId;
  /** What the step does, in words, for the loading progress. */
  what: string;
  state: StepState;
  detail: string;
  /** performance.now() when the step became active. */
  since: number | null;
}

export interface Stall {
  step: StepId;
  /** True when the step failed outright (for example, Service Workers blocked). */
  failed: boolean;
  message: string;
  advice: string[];
}

/** NFR-10a: a step that has not finished within this long says so. */
export const STALL_MS = 10_000;

/** Which step a back-end worker's progress stage belongs to (docs/v4-interfaces.md §13.2). */
export const STAGE_STEP: Record<string, StepId> = {
  seam: 'relay',
  runtime: 'back end',
  packages: 'back end',
  history: 'history',
  pregen: 'history',
  store: 'history',
  index: 'server',
  models: 'models',
};

const ALLOW_SITE = 'Allow this site’s storage and Service Workers (in Brave, turn Shields off for this site; a private window may block Service Workers), then reload.';

export function stepTitle(id: StepId): string {
  return id === 'relay' ? 'relay (the seam relay, a Service Worker)' : id;
}

export class Startup {
  readonly steps: Store<Step[]>;
  readonly stall = new Store<Stall | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(python: boolean) {
    const what: Record<StepId, string> = {
      relay: 'registering the seam relay (Service Worker) and waiting until it controls this page',
      'back end': python ? 'loading the Python back end (Pyodide) in its worker' : 'starting the JavaScript stand-in in its worker',
      history: 'loading the logger store’s pre-calculated history',
      server: 'starting the data server and indexing the store',
      models: 'starting each core model',
    };
    this.steps = new Store<Step[]>((Object.keys(what) as StepId[]).map((id) => ({ id, what: what[id], state: 'pending', detail: '', since: null })));
  }

  /** The step now running, or null once every step is done. */
  current(): Step | null {
    return this.steps.value.find((s) => s.state === 'active' || s.state === 'failed') ?? null;
  }

  /** Make `id` the active step; every step before it is done. */
  enter(id: StepId, detail = '') {
    const at = this.steps.value.findIndex((s) => s.id === id);
    const now = performance.now();
    let changed = false;
    const next = this.steps.value.map((s, i) => {
      if (i < at && s.state !== 'done') { changed = true; return { ...s, state: 'done' as const }; }
      if (i === at) {
        if (s.state === 'active' && s.detail === detail) return s;
        changed = true;
        return { ...s, state: 'active' as const, detail, since: s.state === 'active' ? s.since : now };
      }
      return s;
    });
    if (!changed) return;
    if (this.stall.value && this.stall.value.step !== id) this.stall.set(null);
    this.steps.set(next);
    this.watch();
  }

  /** Every step up to and including `id` is done. */
  finish(id: StepId) {
    const at = this.steps.value.findIndex((s) => s.id === id);
    if (this.steps.value.slice(0, at + 1).every((s) => s.state === 'done')) return;
    this.steps.set(this.steps.value.map((s, i) => (i <= at ? { ...s, state: 'done' } : s)));
    if (this.stall.value && this.steps.value.find((s) => s.id === this.stall.value!.step)?.state === 'done') this.stall.set(null);
    if (!this.current()) this.stop();
  }

  /** A step failed outright: say so at once, naming the step and what to do. */
  fail(id: StepId, reason: string) {
    this.steps.set(this.steps.value.map((s) => (s.id === id ? { ...s, state: 'failed', detail: reason } : s)));
    this.stall.set({ step: id, failed: true, message: `Startup stopped at step “${stepTitle(id)}”: ${reason}`, advice: this.advice(id) });
    this.stop();
  }

  /** "Starting: <step>": why a top-bar control cannot act yet (FR-125a). */
  reason(): string | null {
    const s = this.current();
    if (!s) return null;
    return `Starting: ${s.id}${this.stall.value?.step === s.id ? ' (stalled: see the message on the page)' : ''}`;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private advice(id: StepId): string[] {
    if (id === 'relay') return ['Reload the page.', ALLOW_SITE];
    return ['Wait a little longer: a slow connection can make this step take longer.', 'Reload the page if it does not move on.'];
  }

  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const s = this.current();
      if (!s || s.state !== 'active' || s.since == null || this.stall.value?.step === s.id) return;
      if (performance.now() - s.since < STALL_MS) return;
      const message = s.id === 'relay'
        ? 'Startup has stalled at step “relay”: the seam relay (a Service Worker) has not taken control of this page after 10 seconds. The browser may be blocking Service Workers for this site, or an older relay may be in the way.'
        : `Startup is taking longer than 10 seconds at step “${s.id}” (${s.detail || s.what}).`;
      this.stall.set({ step: s.id, failed: false, message, advice: this.advice(s.id) });
    }, 250);
  }
}
