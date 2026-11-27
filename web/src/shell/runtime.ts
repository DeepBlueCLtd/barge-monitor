// The page's runtime (SRD §2, docs/v4-interfaces.md §8): registers the relay,
// chooses and starts a back end (FR-06a, FR-06b), connects the relay to it,
// and in the Python back end starts one worker per model (FR-33). A model's
// requests go through the relay, like the display client's. The shell's controls (play, restart
// server, control panel) reach the back-end worker directly: they belong to
// the demonstrator, not the system.
import { CORE_MODELS, PY_ZIP, PYODIDE_PATH, resolve, urlParam } from '../config';
import type { ComponentId } from './components';
import { bus, Captured } from './messages';
import { STAGE_STEP, Startup } from './startup';
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
  /** Its runs (FR-35b), god's-eye: the latest entry of each (interfaces §13.4). */
  runs?: { dataset: string; run_id: string; status: string; pct: number | null }[];
}

/** A file of the data folder, as the importer's catalogue has it now (§13.4). */
export interface FolderFile {
  file: string;
  size: number;
  modified: string;
  status: 'not-imported' | 'importing' | 'imported' | 'changed' | 'superseded';
  dataset: string;
  pct: number;
}

export interface DatasetState {
  id: string;
  file: string;
  start: string;
  end: string;
  records: number;
  superseded: boolean;
}

/** Control state (docs/v4-interfaces.md §13.4). */
export interface ControlState {
  server: 'running' | 'waiting' | 'down';
  /** The shell's own count of server starts (D-260): the server serves no instance identifier. */
  instance: string | null;
  fields: FieldControl[];
  pending: boolean;
  lie_about_profile: boolean;
  models?: ModelState[];
  capture_counts?: Record<string, number>;
  /** Capture on or off (AT-18). */
  capture?: boolean;
  backend?: BackendKind;
  folder?: FolderFile[];
  datasets?: DatasetState[];
  /** The last import's speed, for the importer's panel (FR-110). */
  import_rate?: { file: string; rows: number; seconds: number; rows_per_s: number; silent: boolean } | null;
  importer?: { subscribed: boolean; silent_done: boolean };
  resets?: number;
  /** The user-to-role assignment (§13.4), changed by the admin stub (§13.5). */
  accounts?: { user: string; role: string; kind: string; label: string }[];
}

/**
 * Where the data folder is (FR-15): `data/folder/` in the site. A test may point the importer at another
 * folder of the same site with `?folder=<relative path>` (decision D-272); nothing else is accepted.
 */
function folderPath(): string {
  const asked = urlParam('folder');
  if (asked && /^[A-Za-z0-9_\-./]+\/$/.test(asked) && !asked.startsWith('/') && !asked.includes('..')) return asked;
  return 'data/folder/';
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
  /** The named startup steps and any stall (docs/v4-interfaces.md §13.7). */
  readonly startup = new Startup(this.kind === 'python');
  control = new Store<ControlState | null>(null);
  server = new Store<'running' | 'waiting' | 'down'>('waiting');
  /** Per model worker: its phase and loading progress (Python back end only). */
  modelWorkers = new Store<Record<string, ModelWorkerStatus>>({});
  /** Output of model workers (stdout, stderr), for the empty-slot editor. */
  modelOutput = new Store<{ model: string; stream: 'stdout' | 'stderr'; text: string }[]>([]);
  startedAt = performance.now();
  readyMs: number | null = null;

  private backend: Worker | null = null;
  private models = new Map<string, Worker>();
  /** Control actions awaiting the worker's answer, by request id (§13.3, D-167). */
  private waiting = new Map<number, { ok: (s: ControlState | null) => void; fail: (e: Error) => void }>();
  private controlSeq = 0;

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
    // The relay first: every request of the system goes through it (FR-02).
    this.progress.set({ stage: 'seam', detail: 'registering the seam relay (Service Worker)', pct: 1 });
    this.startup.enter('relay', 'registering the seam relay (Service Worker)');
    try {
      await this.startRelay();
    } catch (e: any) {
      const why = `the seam relay (Service Worker) could not be registered: ${String(e?.message ?? e)}`;
      this.startup.fail('relay', why);
      throw new Error(why);
    }
    this.startup.enter('back end');
    this.progress.set({ stage: 'backend', detail: this.startup.steps.value[1].what, pct: 2 });
    this.backend = this.kind === 'standin'
      ? new Worker(new URL('../workers/standin.worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('../workers/backend.worker.ts', import.meta.url), { type: 'module' });
    this.backend.onmessage = (e) => this.onBackend(e.data);
    this.backend.onerror = (e) => {
      const why = `the back-end worker failed: ${e.message ?? e}`;
      this.progress.set({ stage: 'error', detail: why, pct: 0 });
      this.startup.fail(this.startup.current()?.id ?? 'back end', why);
    };
    this.backend.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), folderUrl: resolve(folderPath()) });
    this.connect();
  }

  /**
   * Start the seam relay (§13.7): resolve once a Service Worker controls this page.
   * A relay already in control is used at once (an update is still looked for, and a
   * newer relay that takes over is given its own port). A page loaded without a
   * controller, such as after a hard reload, asks the active relay to claim it: it would
   * otherwise never see a `controllerchange`, because that relay never activates again.
   * `register` with an unchanged URL does not look for a newer sw.js, and an uncontrolled
   * page triggers no update either, so an older relay that cannot be asked to claim would
   * stay for ever: the page asks for an update itself, and the newer relay claims the page
   * when it activates.
   */
  private async startRelay(): Promise<void> {
    if (!('serviceWorker' in navigator)) throw new Error('this browser offers no Service Workers here (some turn them off in private windows)');
    const sws = navigator.serviceWorker;
    sws.addEventListener('message', (e) => e.data?.type === 'need-port' && this.connect());
    // A newer relay that takes over needs its own port to the back end.
    sws.addEventListener('controllerchange', () => this.connect());
    const url = resolve('sw.js');
    const update = (reg: ServiceWorkerRegistration) => reg.update().catch((e) => console.warn('seam relay: update check failed', e));
    if (sws.controller) {
      sws.register(url, { scope: './' }).then(update, (e) => console.warn('seam relay: registration failed', e));
      return;
    }
    const reg = await sws.register(url, { scope: './' });
    void update(reg);
    await new Promise<void>((done) => {
      let asked = -Infinity;
      const check = () => {
        if (sws.controller) {
          clearInterval(poll);
          sws.removeEventListener('controllerchange', check);
          done();
          return;
        }
        const now = performance.now();
        if (reg.active && now - asked > 1000) {
          asked = now;
          reg.active.postMessage({ type: 'claim' });
        }
      };
      sws.addEventListener('controllerchange', check);
      const poll = setInterval(check, 200);
      check();
    });
  }

  private onBackend(d: any) {
    switch (d?.type) {
      case 'progress':
        this.progress.set(d);
        if (d.stage === 'error') this.startup.fail(this.startup.current()?.id ?? 'back end', String(d.detail));
        else if (STAGE_STEP[d.stage]) this.startup.enter(STAGE_STEP[d.stage], d.detail);
        if (d.stage === 'ready' && this.readyMs == null) {
          this.startup.finish('import');
          this.readyMs = performance.now() - this.startedAt;
          // The model workers load once the back end can take their ports.
          if (this.kind === 'python') CORE_MODELS.forEach((m) => this.startModel(m));
          this.checkModels();
        }
        break;
      case 'tick':
        if (d.server && d.server !== this.server.value) this.server.set(d.server);
        bus.add(d.messages ?? []);
        break;
      case 'state':
        this.control.set(d.state);
        if (d.id != null) {
          this.waiting.get(d.id)?.ok(d.state);
          this.waiting.delete(d.id);
        }
        this.checkModels();
        if (d.state?.server) this.server.set(d.state.server);
        break;
      case 'relay-failed': {
        // A request that got no answer (server down) is drawn stopped at the boundary (VS-14).
        const kOrQ = d.method === 'POST' && String(d.path).endsWith('/commands') ? 'K' : 'Q';
        bus.add([{ t: 0, src: d.model ? 'models' : 'client', dst: 'server', letter: kOrQ, ...(d.model ? { model: d.model } : {}), summary: `${d.method} ${d.path}: no answer, the server is down`,
          content: `${d.method} ${d.path}\n\nnetwork failure: the relay found no server to answer`, failed: true, chain: d.chain ?? null, hop: 0 }]);
        break;
      }
      case 'control-error':
        console.warn('control action refused by the back end:', d.error);
        if (d.id != null) {
          this.waiting.get(d.id)?.fail(new Error(String(d.error)));
          this.waiting.delete(d.id);
        }
        break;
    }
  }

  /** The last step, models, is done once every core model is live (after the server is). */
  private checkModels() {
    if (this.readyMs == null || this.startup.steps.value.find((s) => s.id === 'models')?.state === 'done') return;
    if (this.coreModelsLive()) this.startup.finish('models');
    else this.startup.enter('models', 'starting each core model');
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
   * A second port to the back-end worker, speaking the relay's protocol (FR-02): for the end-to-end tests only, where
   * the contract suite runs in Pyodide against the back end in the page (AT-02, D-341). The application is reached as
   * the relay reaches it, without the relay's own work (it drops WWW-Authenticate, D-226).
   */
  seamPort(): MessagePort | null {
    if (!this.backend) return null;
    const ch = new MessageChannel();
    this.backend.postMessage({ type: 'connect' }, [ch.port1]);
    return ch.port2;
  }

  /**
   * A control action (docs/v4-interfaces.md §13.3): restart-server, down, up, field, profile-lie, capture, reset-instance,
   * set-role, state. There is no play, pause or rate: replay is the display client's own (§8, D-302).
   */
  send(action: string, arg?: unknown) {
    void this.act(action, arg).catch(() => undefined);
  }

  /** A control action whose answer is awaited: the control state after it (§13.3; each carries a request id, D-167). */
  act(action: string, arg?: unknown): Promise<ControlState | null> {
    if (!this.backend) return Promise.resolve(this.control.value);
    const id = ++this.controlSeq;
    const answer = new Promise<ControlState | null>((ok, fail) => this.waiting.set(id, { ok, fail }));
    this.backend.postMessage({ type: 'control', action, arg, id });
    return answer;
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
// Read-only, for the end-to-end tests (beside D-273's bargeCaptured; D-323): the back end's control state as the shell holds it.
(globalThis as { bargeControlState?: () => ControlState | null }).bargeControlState = () => runtime.control.value;
// For the end-to-end tests only (AT-02's Pyodide half, D-341): a port to the back end, as the relay is given one.
(globalThis as { bargeSeamPort?: () => MessagePort | null }).bargeSeamPort = () => runtime.seamPort();
