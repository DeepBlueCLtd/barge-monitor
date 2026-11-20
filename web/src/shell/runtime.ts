// The browser and Pyodide runtime (B-C16): registers the relay, starts the
// backend and workspace workers, and hands the relay a port to the backend.
// The shell's controls (play, restart server, control panel) reach the
// backend worker directly: they belong to the demonstrator, not the system.
import { API_BASE, HISTORY_PATH, PY_ZIP, PYODIDE_PATH, resolve } from '../config';
import type { Progress } from '../workers/common';
import { simClock } from './clock';
import { bus } from './messages';
import { Store } from './store';

export interface ControlState {
  server: 'running' | 'waiting' | 'down';
  instance: string | null;
  progress: { indexed: number; stored: number } | null;
  fields: { name: string; label: string; kind: string; inputs: string[]; extra: boolean; essential: boolean; type: string;
    on_next_start: boolean; published_next_start: boolean; published_now: boolean }[];
  pending: boolean;
  lie_about_profile: boolean;
  store: { bytes: number; files: number; records: number };
  capture_counts: Record<string, number>;
}

class Runtime {
  progress = new Store<Progress>({ stage: 'page', detail: 'starting', pct: 0 });
  control = new Store<ControlState | null>(null);
  server = new Store<'running' | 'waiting' | 'down'>('waiting');
  wsProgress = new Store<Progress | null>(null);
  backend: Worker | null = null;
  workspace: Worker | null = null;
  private wsListeners = new Set<(m: any) => void>();
  startedAt = performance.now();
  readyMs: number | null = null;

  seed = 0;
  historySource = 'generated';

  async start(requested: number | null, pregenDays: number | null) {
    // A seed with pre-built history starts in seconds; any other seed generates its own (SRD §13).
    let historyUrl: string | null = null;
    let seed = requested ?? 0;
    try {
      const h = await (await fetch(resolve('py/history.json'))).json();
      if (pregenDays == null) historyUrl = resolve(`${HISTORY_PATH}${h.code_hash}/days-${h.days}/`);
      if (requested == null) seed = h.seeds[Math.floor(Math.random() * h.seeds.length)];
      this.historySource = h.seeds.includes(seed) && pregenDays == null ? `pre-built, ${h.days} days` : 'generated';
    } catch {
      if (requested == null) seed = Math.floor(Math.random() * 1e6);
    }
    this.seed = seed;
    if (typeof WebAssembly === 'undefined') {
      throw new Error('this browser has WebAssembly switched off, and the demonstrator\'s Python (Pyodide) needs it. '
        + 'In Microsoft Edge, "Enhance your security on the web" set to Strict disables it: add an exception for this site '
        + 'or choose Balanced (Settings → Privacy, search and services → Security). On a managed PC an organisation policy '
        + 'may disable it; try another browser or ask for this site to be allowed.');
    }
    if (!('serviceWorker' in navigator)) throw new Error('this browser has no Service Worker support');
    this.progress.set({ stage: 'seam', detail: 'registering the seam relay (Service Worker)', pct: 1 });
    await navigator.serviceWorker.register(resolve('sw.js'), { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
    navigator.serviceWorker.addEventListener('message', (e) => e.data?.type === 'need-port' && this.connect());
    this.backend = new Worker(new URL('../workers/backend.worker.ts', import.meta.url), { type: 'module' });
    this.backend.onmessage = (e) => this.onBackend(e.data);
    this.backend.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), seed, pregenDays, historyUrl });
    this.connect();
  }

  private onBackend(d: any) {
    if (d.type === 'progress') {
      this.progress.set(d);
      if (d.stage === 'ready') {
        this.readyMs = performance.now() - this.startedAt;
        this.startWorkspace();
      }
    } else if (d.type === 'tick') {
      simClock.update(d.clock);
      if (d.server !== this.server.value) this.server.set(d.server);
      bus.add(d.messages);
    } else if (d.type === 'state') {
      this.control.set(d.state);
      simClock.update(d.state.clock);
      this.server.set(d.state.server);
    } else if (d.type === 'relay-failed') {
      bus.add([{ t: simClock.now(), src: 'relay', dst: 'fastapi', letter: 'Q', summary: `${d.method} ${d.path}: no answer (server down)`,
        content: 'network failure', failed: true, chain: d.chain, hop: 2 }]);
    }
  }

  connect() {
    const sw = navigator.serviceWorker.controller;
    if (!sw || !this.backend) return;
    const ch = new MessageChannel();
    this.backend.postMessage({ type: 'connect' }, [ch.port1]);
    sw.postMessage({ type: 'port' }, [ch.port2]);
  }

  send(action: string, arg?: unknown) {
    this.backend?.postMessage({ type: 'control', action, arg });
  }

  startWorkspace() {
    if (this.workspace) return;
    this.workspace = new Worker(new URL('../workers/workspace.worker.ts', import.meta.url), { type: 'module' });
    this.workspace.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') this.wsProgress.set(d);
      if (d.type === 'tap') bus.add([{ ...d.message, t: simClock.now(), chain: null, hop: 0 }]);
      this.wsListeners.forEach((l) => l(d));
    };
    this.workspace.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), apiBase: resolve(API_BASE) });
  }

  /** Stop a runaway script: discard the workspace worker; the backend is not touched (FR-35). */
  restartWorkspace() {
    this.workspace?.terminate();
    this.workspace = null;
    this.wsProgress.set(null);
    this.startWorkspace();
  }

  onWorkspace(l: (m: any) => void) {
    this.wsListeners.add(l);
    return () => {
      this.wsListeners.delete(l);
    };
  }
}

export const runtime = new Runtime();
