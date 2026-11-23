// The page's runtime (SRD §2, docs/v4-interfaces.md §8): registers the relay,
// chooses and starts a back end (FR-06a, FR-06b), connects the relay to it,
// and in the Python back end starts one worker per model (FR-33). A model's
// requests go through the relay, like the display client's. The shell's controls (play, restart
// server, control panel) reach the back-end worker directly: they belong to
// the demonstrator, not the system.
import { CORE_MODELS, HISTORY_PATH, PY_ZIP, PYODIDE_PATH, resolve, urlParam } from '../config';
import { simClock } from './clock';
import type { ComponentId } from './components';
import { bus, Captured } from './messages';
import { Store } from './store';

export type BackendKind = 'python' | 'standin';

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

export interface FieldControl {
  name: string;
  label: string;
  kind: string;
  inputs: string[];
  extra: boolean;
  essential: boolean;
  type: string;
  on_next_start: boolean;
  published_next_start: boolean;
  published_now: boolean;
}

export interface ModelState {
  id: string;
  label: string;
  phase: string; // starting | catching up | live | failed
  detail?: string;
  datastreams?: number | string[];
}

/** Control state (docs/v4-interfaces.md §8). */
export interface ControlState {
  server: 'running' | 'waiting' | 'down';
  instance: string | null;
  progress?: unknown;
  fields: FieldControl[];
  pending: boolean;
  lie_about_profile: boolean;
  clock?: unknown;
  store?: { bytes: number; files: number; records: number };
  models?: ModelState[];
  capture_counts?: Record<string, number>;
  backend?: BackendKind;
}

export interface ModelWorkerStatus {
  phase: string;
  detail: string;
  progress?: Progress;
}

// FR-06b: the stand-in is the default because it starts in seconds; `?backend=python` runs
// Pyodide. Set this to true to make Python the default wherever WebAssembly runs.
const PYTHON_BY_DEFAULT = false;

function chooseBackend(): BackendKind {
  const asked = urlParam('backend');
  if (asked === 'python' || asked === 'standin') return asked;
  if (!PYTHON_BY_DEFAULT) return 'standin';
  // FR-06b: the Python back end needs WebAssembly; without it, the stand-in.
  return typeof WebAssembly === 'undefined' ? 'standin' : 'python';
}

class Runtime {
  readonly kind: BackendKind = chooseBackend();
  progress = new Store<Progress>({ stage: 'page', detail: 'starting', pct: 0 });
  control = new Store<ControlState | null>(null);
  server = new Store<'running' | 'waiting' | 'down'>('waiting');
  /** Per model worker: its phase and loading progress (Python back end only). */
  modelWorkers = new Store<Record<string, ModelWorkerStatus>>({});
  /** Output of model workers (stdout, stderr), for the empty-slot editor. */
  modelOutput = new Store<{ model: string; stream: 'stdout' | 'stderr'; text: string }[]>([]);
  history = { days: null as number | null, source: '' };
  seed = 0;
  startedAt = performance.now();
  readyMs: number | null = null;

  private backend: Worker | null = null;
  private models = new Map<string, Worker>();

  private started = false;

  /** True once every core model reports itself live (the display client waits for this before its handshake). */
  coreModelsLive(): boolean {
    const models = this.control.value?.models;
    if (!models) return this.control.value != null; // a back end that does not report its models
    return CORE_MODELS.every((id) => models.find((m) => m.id === id)?.phase === 'live');
  }

  async start() {
    if (this.started) return; // React's development double-invoke must not start two back ends
    this.started = true;
    const seedParam = urlParam('seed');
    const requested = seedParam && /^\d+$/.test(seedParam) ? Number(seedParam) : null;
    // Pre-calculated history (FR-15): the build says where it is and which seeds it holds.
    let historyUrl: string | null = null;
    let seed = requested ?? 0;
    try {
      const h = await (await fetch(resolve('py/history.json'), { cache: 'no-cache' })).json();
      historyUrl = resolve(`${HISTORY_PATH}${h.code_hash}/days-${h.days}/`);
      if (requested == null) seed = h.seeds[Math.floor(Math.random() * h.seeds.length)];
      this.history = { days: h.days, source: 'pre-calculated' };
    } catch {
      this.history = { days: null, source: 'none found' };
    }
    this.seed = seed;
    if (!('serviceWorker' in navigator)) throw new Error('this browser has no Service Worker support, so the seam relay cannot run');
    this.progress.set({ stage: 'seam', detail: 'registering the seam relay (Service Worker)', pct: 1 });
    await navigator.serviceWorker.register(resolve('sw.js'), { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
    navigator.serviceWorker.addEventListener('message', (e) => e.data?.type === 'need-port' && this.connect());
    this.backend = this.kind === 'standin'
      ? new Worker(new URL('../workers/standin.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('../workers/backend.worker.ts', import.meta.url), { type: 'module' });
    this.backend.onmessage = (e) => this.onBackend(e.data);
    this.backend.onerror = (e) => this.progress.set({ stage: 'error', detail: `the back-end worker failed: ${e.message ?? e}`, pct: 0 });
    this.backend.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), seed, historyUrl });
    this.connect();
  }

  private onBackend(d: any) {
    switch (d?.type) {
      case 'progress':
        this.progress.set(d);
        if (d.stage === 'ready' && this.readyMs == null) {
          this.readyMs = performance.now() - this.startedAt;
          // The model workers load once the back end can take their ports.
          if (this.kind === 'python') CORE_MODELS.forEach((m) => this.startModel(m));
        }
        break;
      case 'tick':
        simClock.update(d.clock);
        if (d.server && d.server !== this.server.value) this.server.set(d.server);
        bus.add(d.messages ?? []);
        // Every model reads time from the simulation clock (FR-13).
        for (const w of this.models.values()) w.postMessage({ type: 'clock', state: d.clock, pending: d.pending_commands ?? {} });
        break;
      case 'state':
        this.control.set(d.state);
        if (d.state?.clock) simClock.update(d.state.clock);
        if (d.state?.server) this.server.set(d.state.server);
        break;
      case 'relay-failed': {
        // A request that got no answer (server down) is drawn stopped at the boundary (VS-14).
        const kOrQ = d.method === 'POST' && String(d.path).endsWith('/commands') ? 'K' : 'Q';
        bus.add([{ t: simClock.now(), src: d.model ? 'models' : 'client', dst: 'server', letter: kOrQ, ...(d.model ? { model: d.model } : {}), summary: `${d.method} ${d.path}: no answer, the server is down`,
          content: `${d.method} ${d.path}\n\nnetwork failure: the relay found no server to answer`, failed: true, chain: d.chain ?? null, hop: 0 }]);
        break;
      }
      case 'control-error':
        console.warn('control action refused by the back end:', d.error);
        break;
    }
  }

  /** Give the relay a port to the back-end worker (FR-02). */
  connect() {
    const sw = navigator.serviceWorker.controller;
    if (!sw || !this.backend) return;
    const ch = new MessageChannel();
    this.backend.postMessage({ type: 'connect' }, [ch.port1]);
    sw.postMessage({ type: 'port' }, [ch.port2]);
  }

  /** A control action (docs/v4-interfaces.md §8): play, pause, rate, restart-server, down, up, field, profile-lie, capture, state. */
  send(action: string, arg?: unknown) {
    this.backend?.postMessage({ type: 'control', action, arg });
  }

  /**
   * Start one model in its own worker (FR-33), joined to the back end by its own
   * port. `code` is a new model written in an empty slot (FR-36). Python only:
   * the stand-in runs its models itself (FR-06f).
   */
  startModel(model: string, code?: string) {
    if (this.kind !== 'python' || !this.backend) return false;
    this.models.get(model)?.terminate();
    const w = new Worker(new URL('../workers/model.worker.ts', import.meta.url), { type: 'module' });
    this.models.set(model, w);
    this.setModel(model, { phase: 'loading', detail: 'starting its worker' });
    w.onmessage = (e) => this.onModel(model, e.data);
    w.onerror = (e) => this.setModel(model, { phase: 'failed', detail: String(e.message ?? e) });
    const ch = new MessageChannel();
    this.backend.postMessage({ type: 'model-connect', model }, [ch.port1]);
    w.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), model, apiUrl: resolve('api'), ...(code ? { code } : {}) }, [ch.port2]);
    const clock = simClock.state.value;
    if (clock) w.postMessage({ type: 'clock', state: clock });
    return true;
  }

  private setModel(model: string, s: Partial<ModelWorkerStatus>) {
    const old = this.modelWorkers.value[model] ?? { phase: '', detail: '' };
    this.modelWorkers.set({ ...this.modelWorkers.value, [model]: { ...old, ...s } });
  }

  private onModel(model: string, d: any) {
    switch (d?.type) {
      case 'tap':
        bus.add((d.messages ?? []).map((m: Captured) => ({ ...m, model: m.model ?? model, src: m.src as ComponentId, dst: m.dst as ComponentId })));
        break;
      case 'progress':
        this.setModel(model, { progress: d, detail: d.detail });
        break;
      case 'status':
        this.setModel(d.model ?? model, { phase: d.phase, detail: d.detail ?? '' });
        break;
      case 'stdout':
      case 'stderr':
        this.modelOutput.set([...this.modelOutput.value.slice(-300), { model, stream: d.type, text: String(d.text ?? d.data ?? '') }]);
        break;
    }
  }
}

export const runtime = new Runtime();
