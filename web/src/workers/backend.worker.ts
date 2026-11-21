/// <reference lib="webworker" />
// The back-end worker (Python): Pyodide running the collection platform, the
// logger store, the store adapter and the data server on FastAPI. It answers
// requests the relay forwards, from the display client and from each model
// worker alike (docs/v4-interfaces.md §7), and ticks the system.
import { loadRuntime, Progress } from './common';

declare const self: DedicatedWorkerGlobalScope;
let bridge: any = null;
let py: any = null;
let historyDays: number | null = null;
const queue: Array<() => void> = [];

const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

/** Fetch the pre-built history for this seed, if there is one (SRD §13). Files arrive in parallel. */
async function loadHistory(historyUrl: string | null, seed: number): Promise<boolean> {
  if (!historyUrl) return false;
  const base = `${historyUrl}seed-${seed}/`; // historyUrl names the code hash and the length
  const r = await fetch(base + 'manifest.json');
  if (!r.ok) return false;
  const manifest = await r.json();
  const total = manifest.files.reduce((a: number, f: any) => a + f.gz, 0);
  let got = 0;
  py.runPython('_hist = {}\ndef _add(name, buf):\n    _hist[name] = bytearray(buf.to_bytes())');
  const add = py.globals.get('_add');
  const queue = [...manifest.files];
  const workers = Array.from({ length: 8 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const res = await fetch(base + f.name + '.gz');
      if (!res.ok || !res.body) throw new Error(`history file ${f.name}: HTTP ${res.status}`);
      const raw = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      add(f.name, raw);
      got += f.gz;
      post({ stage: 'history', detail: `loading pre-built history: ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`, pct: 10 + Math.round((80 * got) / total) });
    }
  });
  await Promise.all(workers);
  py.globals.set('_manifest_json', JSON.stringify(manifest));
  historyDays = manifest.days;
  add.destroy();
  return true;
}

async function start(pyodideUrl: string, pyZipUrl: string, seed: number, pregenDays: number | null, historyUrl: string | null) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'fastapi', 'jsonschema'], post);
  const prebuilt = await loadHistory(historyUrl, seed).catch((e) => { console.warn(e); return false; });
  if (prebuilt) pregenDays = historyDays;
  if (!prebuilt) post({ stage: 'pregen', detail: 'no pre-built history for this seed: generating its history here', pct: 10 });
  py.globals.set('_progress', (f: number) => post({ stage: 'pregen', detail: `generating history: ${Math.round(f * 100)}%`, pct: 10 + Math.round(85 * f) }));
  py.runPython(`
from barge.bridge import Bridge
import json
_h = {"manifest": json.loads(_manifest_json), "files": _hist} if ${prebuilt ? 'True' : 'False'} else None
bridge = Bridge(${seed}, progress=_progress${pregenDays == null ? '' : `, pregen_days=${pregenDays}`}, history=_h)
del _h
_hist = None
`);
  bridge = py.globals.get('bridge');
  self.postMessage({ type: 'state', state: JSON.parse(bridge.control('state')) });
  let n = 0;
  setInterval(() => {
    try {
      self.postMessage({ type: 'tick', ...JSON.parse(bridge.tick()) });
      // The control state, including each model's phase, once a second (docs/v4-interfaces.md §8).
      if (++n % 10 === 0) self.postMessage({ type: 'state', state: JSON.parse(bridge.control('state')) });
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
      const header = (name: string) => (req.headers as [string, string][]).find(([k]) => k === name)?.[1] ?? null;
      if (header('x-tap-quiet') !== '1') {
        self.postMessage({ type: 'relay-failed', chain: header('x-tap-chain'), path: req.path, method: req.method, model: header('x-tap-model') });
      }
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
  if (d.type === 'start') start(d.pyodideUrl, d.pyZipUrl, d.seed, d.pregenDays ?? null, d.historyUrl ?? null).catch((err) => post({ stage: 'error', detail: String(err), pct: 0 }));
  else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  } else if (d.type === 'model-connect') {
    const port: MessagePort = e.ports[0];
    const model: string = d.model;
    // For the shell only: each model says which phase it is in. Its requests come through the relay.
    const attach = () => {
      port.onmessage = (m) => m.data?.type === 'phase' && bridge.set_model_phase(model, m.data.phase, m.data.detail ?? '', m.data.label ?? model);
    };
    if (bridge) attach();
    else queue.push(attach);
  } else if (d.type === 'control' && bridge) {
    try {
      self.postMessage({ type: 'state', state: JSON.parse(bridge.control(d.action, py.toPy(d.arg ?? null))) });
    } catch (err) {
      self.postMessage({ type: 'control-error', error: String(err) });
    }
  }
};
