/// <reference lib="webworker" />
// The analyst's workspace (B-C12): a second, separate Pyodide. Scripts reach
// the backend only through the relay, as an ordinary Connected Systems
// client (FR-35). A broken or runaway script never touches the backend.
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;
let py: any = null;
let ready: Promise<void> | null = null;

async function start(pyodideUrl: string, pyZipUrl: string, apiBase: string) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'pandas', 'jsonschema'], (p) => self.postMessage({ type: 'progress', ...p }));
  py.setStdout({ batched: (s: string) => self.postMessage({ type: 'stdout', text: s }) });
  py.setStderr({ batched: (s: string) => self.postMessage({ type: 'stderr', text: s }) });
  py.globals.set('_tap', (m: any) => self.postMessage({ type: 'tap', message: m.toJs({ dict_converter: Object.fromEntries }) }));
  py.runPython(`import csapi\ncsapi.API_BASE = ${JSON.stringify(apiBase)}\ncsapi.TAP = _tap`);
  self.postMessage({ type: 'progress', stage: 'ready', detail: 'workspace ready', pct: 100 });
}

async function run(id: number, code: string) {
  await ready;
  const t0 = performance.now();
  try {
    await py.loadPackagesFromImports(code);
    const ns = py.globals.get('dict')();
    py.runPython('import csapi; csapi.tap("workspace", "products", "I", "script run", "")');
    const result = await py.runPythonAsync(code, { globals: ns });
    self.postMessage({ type: 'done', id, ok: true, result: result == null ? '' : String(result), ms: performance.now() - t0 });
    ns.destroy();
  } catch (e: any) {
    self.postMessage({ type: 'done', id, ok: false, error: String(e?.message ?? e), ms: performance.now() - t0 });
  }
}

async function contract(id: number) {
  await ready;
  try {
    const out = await py.runPythonAsync(`
import json, csapi
from contract_suite import suite
json.dumps(await suite.run(csapi.SuiteClient()))
`);
    self.postMessage({ type: 'contract', id, results: JSON.parse(out) });
  } catch (e: any) {
    self.postMessage({ type: 'contract', id, error: String(e?.message ?? e) });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') ready = start(d.pyodideUrl, d.pyZipUrl, d.apiBase).catch((err) => { self.postMessage({ type: 'progress', stage: 'error', detail: String(err), pct: 0 }); });
  else if (d.type === 'run') run(d.id, d.code);
  else if (d.type === 'contract') contract(d.id);
};
