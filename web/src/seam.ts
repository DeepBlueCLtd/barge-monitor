// Bring up the seam: register the Service Worker, start the backend worker,
// and hand the Service Worker a MessagePort to each worker that answers
// requests. The page itself never calls the backend except over HTTP.
import { PY_ZIP, PYODIDE_PATH, API_BASE, resolve } from './config';
import type { Progress } from './workers/common';

type Listener = (p: Progress) => void;

export class Seam {
  backend: Worker | null = null;
  workspace: Worker | null = null;
  private progress: Listener;
  private wsListeners = new Set<(m: any) => void>();
  wsProgress: Progress | null = null;

  constructor(progress: Listener) {
    this.progress = progress;
  }

  async start(seed: number) {
    if (!('serviceWorker' in navigator)) throw new Error('this browser has no Service Worker support');
    this.progress({ stage: 'seam', detail: 'registering the Service Worker', pct: 1 });
    const reg = await navigator.serviceWorker.register(resolve('sw.js'), { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
    }
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'need-port') this.connect(e.data.name);
    });
    void reg;
    this.backend = new Worker(new URL('./workers/backend.worker.ts', import.meta.url), { type: 'module' });
    this.backend.onmessage = (e) => {
      if (e.data.type === 'progress') this.progress(e.data);
    };
    this.backend.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), seed });
    this.connect('api');
  }

  /** Give the Service Worker a fresh port to the worker serving `name`. */
  connect(name: string) {
    const worker = name === 'api' ? this.backend : this.workspace;
    const sw = navigator.serviceWorker.controller;
    if (!sw) return;
    if (!worker) {
      sw.postMessage({ type: 'port', name }, []);
      return;
    }
    const ch = new MessageChannel();
    worker.postMessage({ type: 'connect' }, [ch.port1]);
    sw.postMessage({ type: 'port', name }, [ch.port2]);
  }

  /** The workspace loads lazily, on first use. */
  startWorkspace() {
    if (this.workspace) return;
    this.workspace = new Worker(new URL('./workers/workspace.worker.ts', import.meta.url), { type: 'module' });
    this.workspace.onmessage = (e) => {
      if (e.data.type === 'progress') this.wsProgress = e.data;
      this.wsListeners.forEach((l) => l(e.data));
    };
    this.workspace.postMessage({ type: 'start', pyodideUrl: resolve(PYODIDE_PATH), pyZipUrl: resolve(PY_ZIP), apiBase: resolve(API_BASE) });
    this.connect('ws');
  }

  /** Stop a runaway script: the workspace worker is discarded, the backend is not touched. */
  restartWorkspace() {
    this.workspace?.terminate();
    this.workspace = null;
    this.wsProgress = null;
    this.startWorkspace();
  }

  onWorkspace(l: (m: any) => void) {
    this.wsListeners.add(l);
    return () => {
      this.wsListeners.delete(l);
    };
  }
}
