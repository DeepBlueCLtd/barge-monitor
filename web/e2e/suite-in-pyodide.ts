import type { Page } from '@playwright/test';

// AT-02's Pyodide half (D-341): the server-neutral contract suite (backend/contract_suite/suite.py), the same
// file CPython runs (tests/test_contract_uvicorn.py), run in Pyodide in the page against the back end running in
// its worker. The suite's client speaks the relay's own port protocol (sw.js, docs/v4-interfaces.md §9.2) to the
// back end, so it reaches the application as the relay does, without the relay's own work (it drops
// WWW-Authenticate, D-226). Pyodide and the packed Python (py/barge.zip) are the site's own (NFR-07).

export interface SuiteResult {
  name: string;
  group: 'need' | 'standin';
  outcome: 'passed' | 'failed' | 'skipped';
  detail: string;
}

/** The suite's client (suite.py's docstring): request() and open_stream(), over the seam's port. */
const CLIENT_PY = `
import json
from urllib.parse import urlencode

import js
from pyodide.ffi import to_js

from contract_suite import suite


class Stream:
    def __init__(self, r):
        self.status = r.status
        self._s = r.stream

    async def next_line(self, timeout=10):
        if self._s is None:
            return None
        line = await self._s.next(timeout * 1000)
        return None if line is None else str(line)

    async def close(self):
        if self._s is not None:
            self._s.close()


class Client:
    async def _call(self, method, path, params, body, headers, internal):
        headers = dict(headers or {})
        data = None
        if body is not None:
            if not any(k.lower() == "content-type" for k in headers):
                headers["Content-Type"] = "application/json"
            data = to_js(json.dumps(body).encode())
        q = urlencode(params or {})
        return await js.bargeSuiteCall(method, "api-internal" if internal else "api", "/" + path.lstrip("/"), q,
                                       to_js([[k, v] for k, v in headers.items()]), data)

    async def request(self, method, path, params=None, body=None, headers=None):
        r = await self._call(method, path, params, body, headers, False)
        hs = {str(k): str(v) for k, v in r.headers.to_py()}
        return r.status, hs, suite.read_body(bytes(r.body.to_py()))

    async def open_stream(self, path, params=None, headers=None, internal=False):
        return Stream(await self._call("GET", path, params, None, headers, internal))

`;

/** Load Pyodide in the page, unpack the site's Python and run the whole suite (both groups). */
export async function runSuiteInPyodide(page: Page): Promise<SuiteResult[]> {
  return JSON.parse(await runWithClient(page, 'json.dumps(await suite.run(Client()))'));
}

/** Python run in Pyodide in the page with the suite's ``Client`` defined; its last expression, as a string. */
export async function runWithClient(page: Page, python: string): Promise<string> {
  const out = await page.evaluate(async (code) => {
    const g = globalThis as any;
    const port: MessagePort | null = g.bargeSeamPort?.();
    if (!port) throw new Error('no back end to reach');
    const base = document.baseURI;
    // One request through the seam's port, as sw.js forwards it: an answer, a stream, or no answer at all.
    g.bargeSuiteCall = (method: string, root: string, path: string, query: string, headers: [string, string][], body: Uint8Array | null) => {
      const rootPath = new URL(root, base).pathname;
      const reply = new MessageChannel();
      return new Promise((resolve, reject) => {
        const lines: string[] = [];
        let pending = '';
        let ended = false;
        let wake: (() => void) | null = null;
        const timer = setTimeout(() => reject(new Error(`${method} ${path}: no answer in 120 s`)), 120_000);
        reply.port1.onmessage = (m) => {
          const d = m.data;
          if (d.chunk || d.end) {
            if (d.chunk) {
              pending += new TextDecoder().decode(d.chunk);
              const parts = pending.split('\n');
              pending = parts.pop() ?? '';
              lines.push(...parts.filter((l) => l.trim()));
            }
            if (d.end) ended = true;
            wake?.();
            return;
          }
          clearTimeout(timer);
          if (d.down) return reject(new Error(`${method} ${path}: no answer (the server is down or starting)`));
          if (d.stream) {
            return resolve({
              status: d.status, headers: d.headers, body: new Uint8Array(0),
              stream: {
                next: (ms: number) => new Promise<string | null>((ok) => {
                  const take = () => {
                    if (lines.length) return ok(lines.shift()!);
                    if (ended) return ok(null);
                    return false;
                  };
                  if (take() !== false) return;
                  const t = setTimeout(() => { wake = null; ok(null); }, ms);
                  wake = () => { if (take() !== false) { clearTimeout(t); wake = null; } };
                }),
                close: () => { reply.port1.postMessage({ cancel: true }); setTimeout(() => reply.port1.close(), 100); },
              },
            });
          }
          // undefined, not null: Pyodide gives Python None for undefined (null is JsNull).
          resolve({ status: d.status, headers: d.headers, body: new Uint8Array(d.body ?? new ArrayBuffer(0)), stream: undefined });
        };
        const buf = body ? body.slice().buffer : null;
        port.postMessage({ method, path, query, headers, body: buf, rootPath, origin: location.origin }, [reply.port2]);
      });
    };
    const pyBase = new URL('../pyodide/0.29.5/', base).toString();
    const mod = await import(/* @vite-ignore */ pyBase + 'pyodide.mjs');
    const py = await mod.loadPyodide({ indexURL: pyBase });
    await py.loadPackage(['jsonschema'], { messageCallback: () => {} });
    const zip = await fetch(new URL('py/barge.zip', base));
    py.unpackArchive(await zip.arrayBuffer(), 'zip', { extractDir: '/suite' });
    py.runPython("import sys\n'/suite' in sys.path or sys.path.insert(0, '/suite')");
    return String(await py.runPythonAsync(code));
  }, CLIENT_PY + '\n' + python);
  return out as string;
}
