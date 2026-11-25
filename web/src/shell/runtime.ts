// The page's runtime (SRD §2, docs/v4-interfaces.md §13): registers the relay,
// chooses and starts a back end (FR-06a, FR-06b) over the data folder, connects the
// relay to it, and in the Python back end starts one worker per model (FR-33). A
// model's requests go through the relay, like the display client's. The shell's
// controls (restart server, Freeze, the control panel) reach the back-end worker
// directly: they belong to the demonstrator, not the system. Replay is not among
// them: it is controlled only by commands, through the display client (C4, §13.3).
import { CORE_MODELS, DATA_FOLDER, PY_ZIP, PYODIDE_PATH, resolve, urlParam } from '../config';
import type { ComponentId } from './components';
import { drawClock } from './drawclock';
import { bus, Captured } from './messages';
import { Store } from './store';

export type BackendKind = 'python' | 'standin';
export type ServerStatus = 'running' | 'starting' | 'down';

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
  phase: string;
  detail?: string;
  max_rate?: number;
  datastreams?: number | string[];
}

/** The replay state in the tick (§13.2): for the shell's status only. Times are Unix seconds. */
export interface ReplayView {
  time: number;
  dataset: string;
  start: number;
  end: number;
  position: number;
  rate: number;
  max_rate: number;
  max_rate_model: string;
  playing: boolean;
  at_end: boolean;
  run: string;
  models_ready: boolean;
}

export interface FolderFile {
  file: string;
  size: number;
  modified: string;
  status: string;
  dataset: string | null;
  pct: number | null;
}

/** Control state (docs/v4-interfaces.md §13.4). */
export interface ControlState {
  server: ServerStatus;
  fields: FieldControl[];
  pending: boolean;
  lie_about_profile: boolean;
  folder?: FolderFile[];
  datasets?: { id: string; file: string; start: number; end: number; superseded: boolean }[];
  replay?: ReplayView | null;
  models?: ModelState[];
  accounts?: { user: string; role: string }[];
  capture_counts?: Record<string, number>;
  backend?: BackendKind;
  frozen?: boolean;
  import_rate?: number | null;
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
  return typeof WebAssembly === 'undefined' ? 'standin' : 'python';
}

class Runtime {
  readonly kind: BackendKind = chooseBackend();
  progress = new Store<Progress>({ stage: 'page', detail: 'starting', pct: 0 });
  control = new Store<ControlState | null>(null);
  server = new Store<ServerStatus>('starting');
  /** The latest replay state from the tick (§13.2): the shell's status only; the display client reads it over HTTP. */
  replay = new Store<ReplayView | null>(null);
  /** Per model worker: its phase and loading progress (Python back end only). */
  modelWorkers = new Store<Record<string, ModelWorkerStatus>>({});
  /** Output of model workers (stdout, stderr), for the empty-slot editor. */
  modelOutput = new Store<{ model: string; stream: 'stdout' | 'stderr'; text: string }[]>([]);
  startedAt = performance.now();
  readyMs: number | null = null;

  private backend: Worker | null = null;
  private models = new Map<string, Worker>();
  private started = false;
  /** Control actions awaiting the worker's answer, in the order sent (§13.3). */
  private waiting: { resolve: (s: ControlState) => void; reject: (e: Error) => void }[] = [];

  async start() {
    if (this.started) return; // React's development double-invoke must not start two back ends
    this.started = true;
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
    // §13.2: the worker reads the data folder the build ships (FR-15), at an absolute URL (D-148).
    this.backend.postMessage({ type: 'start', folderUrl: resolve(DATA_FOLDER), pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP) });
    this.connect();
  }

  private onBackend(d: any) {
    switch (d?.type) {
      case 'progress':
        this.progress.set(d);
        if (d.stage === 'ready' && this.readyMs == null) {
          this.readyMs = performance.now() - this.startedAt;
          if (this.kind === 'python') CORE_MODELS.forEach((m) => this.startModel(m));
        }
        break;
      case 'tick': {
        const server = d.server === 'waiting' ? 'starting' : d.server;
        if (server && server !== this.server.value) this.server.set(server);
        const r: ReplayView | null = d.replay ?? null;
        const old = this.replay.value;
        if (!old || !r || old.playing !== r.playing || old.rate !== r.rate || old.dataset !== r.dataset || Math.floor(old.time) !== Math.floor(r.time)
          || old.models_ready !== r.models_ready) this.replay.set(r);
        bus.add(d.messages ?? []);
        break;
      }
      case 'state':
        this.control.set(d.state);
        if (d.state?.server) this.server.set(d.state.server === 'waiting' ? 'starting' : d.state.server);
        this.waiting.shift()?.resolve(d.state);
        break;
      case 'control-error':
        this.waiting.shift()?.reject(new Error(String(d.error)));
        console.warn('control action refused by the back end:', d.error);
        break;
      case 'relay-failed': {
        // A request that got no answer (server down or starting) is drawn stopped at the boundary (VS-14).
        const kOrQ = d.method === 'POST' && String(d.path).endsWith('/commands') ? 'K' : 'Q';
        bus.add([{ t: Date.now() / 1000, src: (d.model ? 'models' : 'client') as ComponentId, dst: 'gateway', letter: kOrQ, ...(d.model ? { model: d.model } : {}),
          summary: `${d.method} ${d.path}: no answer, the server is not running`,
          content: `${d.method} ${d.path}\n\nnetwork failure: the relay found no server to answer`, failed: true, chain: d.chain ?? null, hop: 0 }]);
        break;
      }
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

  /**
   * A control action (§13.3): restart-server, down, up, field {name, on}, profile-lie, capture,
   * freeze {on}, reset-instance, set-role {user, role}, state. Resolves with the control state
   * the worker answers with.
   */
  control(action: string, arg?: unknown): Promise<ControlState> {
    if (!this.backend) return Promise.reject(new Error('the back end has not started'));
    const p = new Promise<ControlState>((resolve, reject) => this.waiting.push({ resolve, reject }));
    this.backend.postMessage({ type: 'control', action, arg });
    return p;
  }

  /** FR-92: Freeze holds the back end (requests, pushes and the replay clock) and the drawing. */
  freeze(on: boolean): Promise<ControlState> {
    drawClock.hold(on);
    return this.control('freeze', { on });
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
