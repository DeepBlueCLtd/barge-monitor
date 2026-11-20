/// <reference lib="webworker" />
// The backend worker: Pyodide running the simulated world, the logger store,
// the store adapter, the Connected Systems server (FastAPI) and the analysis
// service. It answers requests the relay forwards, and ticks the system.
import { loadRuntime, Progress } from './common';

declare const self: DedicatedWorkerGlobalScope;
let bridge: any = null;
let py: any = null;
const queue: Array<() => void> = [];

const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

async function start(pyodideUrl: string, pyZipUrl: string, seed: number, pregenDays: number | null) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'fastapi', 'jsonschema'], post);
  post({ stage: 'pregen', detail: 'pre-generating four weeks of history', pct: 10 });
  self.postMessage({ type: 'progress', stage: 'pregen', detail: 'pre-generating four weeks of history', pct: 10 });
  py.globals.set('_progress', (f: number) => post({ stage: 'pregen', detail: `pre-generating history: day ${Math.round(f * 28)} of 28`, pct: 10 + Math.round(85 * f) }));
  py.runPython(`
from barge.bridge import Bridge
bridge = Bridge(${seed}, progress=_progress${pregenDays == null ? '' : `, pregen_days=${pregenDays}`})
`);
  bridge = py.globals.get('bridge');
  self.postMessage({ type: 'state', state: JSON.parse(bridge.control('state')) });
  setInterval(() => {
    try {
      self.postMessage({ type: 'tick', ...JSON.parse(bridge.tick()) });
    } catch (e) {
      console.error(e);
    }
  }, 100);
  post({ stage: 'ready', detail: 'running', pct: 100 });
  queue.splice(0).forEach((f) => f());
}

async function serve(req: any, reply: MessagePort) {
  if (!bridge) await new Promise<void>((r) => queue.push(r));
  try {
    const res = await bridge.handle(req.method, req.path, req.query, req.body ? new Uint8Array(req.body) : null,
      req.rootPath, req.headers, req.origin);
    if (res === undefined || res === null) {
      const chain = (req.headers as [string, string][]).find(([k]) => k === 'x-tap-chain')?.[1] ?? null;
      self.postMessage({ type: 'relay-failed', chain, path: req.path, method: req.method });
      reply.postMessage({ down: true });
      return;
    }
    const [status, headers, body] = res.toJs();
    res.destroy();
    const bytes: Uint8Array = body;
    reply.postMessage({ status, headers, body: bytes.buffer }, [bytes.buffer]);
  } catch (e) {
    reply.postMessage({ status: 500, headers: [['content-type', 'application/json']], body: JSON.stringify({ code: 'InternalError', description: String(e) }) });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') start(d.pyodideUrl, d.pyZipUrl, d.seed, d.pregenDays ?? null).catch((err) => post({ stage: 'error', detail: String(err), pct: 0 }));
  else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  } else if (d.type === 'control' && bridge) {
    try {
      self.postMessage({ type: 'state', state: JSON.parse(bridge.control(d.action, py.toPy(d.arg ?? null))) });
    } catch (err) {
      self.postMessage({ type: 'control-error', error: String(err) });
    }
  }
};
