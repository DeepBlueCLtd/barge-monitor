/// <reference lib="webworker" />
// The backend worker: Pyodide running the Python backend (simulation, logger,
// adapter, EDR server, analysis). It answers requests the Service Worker
// forwards over MessagePorts, and ticks the simulation.
import type { PyodideAPI, Progress, SeamRequest } from './common';
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;

let py: PyodideAPI | null = null;
let bridge: any = null;
const queue: Array<() => void> = [];

function post(p: Progress) {
  self.postMessage({ type: 'progress', ...p });
}

async function start(pyodideUrl: string, pyZipUrl: string, seed: number) {
  const t0 = performance.now();
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy'], post);
  post({ stage: 'simulation', detail: 'generating the world and a warm start of the logger', pct: 90 });
  py.runPython(`
from barge.bridge import Bridge
bridge = Bridge(${seed})
`);
  bridge = py.globals.get('bridge');
  setInterval(() => {
    try {
      bridge.tick();
    } catch (e) {
      console.error(e);
    }
  }, 250);
  post({ stage: 'ready', detail: 'backend running', pct: 100, ms: performance.now() - t0 });
  queue.splice(0).forEach((f) => f());
}

async function serve(req: SeamRequest, reply: MessagePort) {
  if (!bridge) await new Promise<void>((r) => queue.push(r));
  try {
    const body = req.body ? new Uint8Array(req.body) : null;
    const res = await bridge.handle(req.method, req.path, req.query, body, req.rootPath, req.headers);
    const [status, headers, payload] = res.toJs();
    res.destroy();
    const bytes: Uint8Array = payload;
    reply.postMessage({ status, headers, body: bytes.buffer }, [bytes.buffer]);
  } catch (e) {
    const msg = JSON.stringify({ code: 'InternalError', description: String(e) });
    reply.postMessage({ status: 500, headers: [['content-type', 'application/json']], body: msg });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    start(d.pyodideUrl, d.pyZipUrl, d.seed).catch((err) => post({ stage: 'error', detail: String(err), pct: 0 }));
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  }
};
