/// <reference lib="webworker" />
// The analyst's workspace (B-C09): a second, separate Pyodide. Scripts here
// reach the backend only through the seam, as an ordinary EDR client
// (FR-27). Whatever a script does, the backend worker is untouched (FR-28).
import type { PyodideAPI, Progress } from './common';
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;

let py: PyodideAPI | null = null;
let ready: Promise<void> | null = null;

function post(msg: Record<string, unknown>) {
  self.postMessage(msg);
}

async function start(pyodideUrl: string, pyZipUrl: string, apiBase: string) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'pandas'], (p: Progress) => post({ type: 'progress', ...p }));
  py.setStdout({ batched: (s: string) => post({ type: 'stdout', text: s }) });
  py.setStderr({ batched: (s: string) => post({ type: 'stderr', text: s }) });
  py.runPython(`
import sys
sys.path.insert(0, '/home/pyodide/workspace')
import edr
edr.API_BASE = ${JSON.stringify(apiBase)}
`);
  post({ type: 'progress', stage: 'ready', detail: 'workspace ready', pct: 100 });
}

async function run(id: number, code: string) {
  await ready;
  const t0 = performance.now();
  try {
    await py.loadPackagesFromImports(code, { messageCallback: (m: string) => post({ type: 'stdout', text: m }) });
    const ns = py.globals.get('dict')();
    const result = await py.runPythonAsync(code, { globals: ns });
    const text = result === undefined || result === null ? '' : String(result);
    post({ type: 'done', id, ok: true, result: text, ms: performance.now() - t0 });
    ns.destroy();
  } catch (e: any) {
    post({ type: 'done', id, ok: false, error: String(e?.message ?? e), ms: performance.now() - t0 });
  }
}

async function contract(id: number) {
  await ready;
  try {
    await py.loadPackage('jsonschema');
    const out = await py.runPythonAsync(`
import json, edr
from contract_suite import suite
class _C:
    async def get(self, path, params=None):
        return await edr.get_raw(path, params)
    async def put(self, path, body):
        return await edr.put_raw(path, body)
json.dumps(await suite.run(_C()))
`);
    post({ type: 'contract', id, results: JSON.parse(out) });
  } catch (e: any) {
    post({ type: 'contract', id, error: String(e?.message ?? e) });
  }
}

function serve(req: { path: string }, reply: MessagePort) {
  if (!py) {
    reply.postMessage({ status: 503, headers: [['content-type', 'application/json']], body: '{"code":"Unavailable","description":"workspace starting"}' });
    return;
  }
  try {
    const edr = py.pyimport('edr');
    const res = edr.serve(req.path);
    const [status, body] = res.toJs({ dict_converter: Object.fromEntries });
    res.destroy();
    reply.postMessage({ status, headers: [['content-type', 'application/json']], body: JSON.stringify(body) });
  } catch (e) {
    reply.postMessage({ status: 500, headers: [['content-type', 'application/json']], body: JSON.stringify({ code: 'InternalError', description: String(e) }) });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    ready = start(d.pyodideUrl, d.pyZipUrl, d.apiBase).catch((err) => post({ type: 'progress', stage: 'error', detail: String(err), pct: 0 }));
  } else if (d.type === 'run') {
    run(d.id, d.code);
  } else if (d.type === 'contract') {
    contract(d.id);
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  }
};
