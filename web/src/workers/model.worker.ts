/// <reference lib="webworker" />
// One model in its own worker (FR-33): its own Pyodide and the scientific libraries it needs. It
// reaches the data server as any client does, through the relay and the access gateway, with its
// own service credentials (docs/v4-interfaces.md §10, §13): HTTP requests, and its push
// subscription as one long streaming response (§9.2). There is no other way in.
// Once a real second the runner reads the replay state and processes whole windows up to it.
// A model that raises errors, or never returns, stops only itself (AT-14).
//
// Page -> worker: start {pyodideUrl, pyZipUrl, model, apiUrl, code?, user, password}, with a port
// to the back-end worker (for the shell only: the model's phase).
// Worker -> page: progress, status {model, phase, detail}, tap {messages}, stdout, stderr.
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;

let py: any = null;
let port: MessagePort | null = null;
let modelId = '';
let apiUrl = '';
let busy = false;
let taps: any[] = [];
let tapSeq = 0;
const STEP_MS = 1000;

const post = (m: any) => self.postMessage(m);

function plain(x: any): any {
  const v = x?.toJs ? x.toJs({ dict_converter: Object.fromEntries }) : x;
  x?.destroy?.();
  return v;
}

/** One HTTP request, through the relay (FR-02). Resolves with [status, headers, body], or null when there is no answer. */
async function http(method: string, path: string, headers: any, body: any): Promise<[number, Record<string, string>, Uint8Array] | null> {
  const h = plain(headers);
  const b: Uint8Array | null = body?.toJs ? body.toJs() : body ?? null;
  body?.destroy?.();
  let res: Response;
  try {
    res = await fetch(apiUrl + path, { method, headers: h, body: b, cache: 'no-store' });
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return [res.status, out, new Uint8Array(await res.arrayBuffer())];
}

/** A push subscription (§9.2): a streamed answer through the relay, read chunk by chunk. Null when there is no answer. */
async function openStream(path: string, headers: any): Promise<{ status: number; next: () => Promise<Uint8Array | null> } | null> {
  const h = plain(headers);
  let res: Response;
  try {
    res = await fetch(apiUrl + path, { method: 'GET', headers: h, cache: 'no-store' });
  } catch {
    return null;
  }
  const reader = res.body?.getReader();
  return {
    status: res.status,
    next: async () => {
      if (!reader) return null;
      try {
        const { done, value } = await reader.read();
        return done ? null : value ?? new Uint8Array();
      } catch {
        return null; // the server went away: the receiver resubscribes (FR-48)
      }
    },
  };
}

/** Messages between the model and the scientific libraries: captured here, drawn by the page. */
function postTap(src: string, dst: string, summary: string, content: string, quiet: boolean) {
  if (quiet) return; // registering at startup: not drawn
  taps.push({ id: `${modelId}-${++tapSeq}`, t: Date.now() / 1000, src, dst, letter: 'I', summary, content, model: modelId, chain: null, hop: 0 });
}

async function start(d: any) {
  modelId = d.model;
  apiUrl = d.apiUrl;
  const packages = d.model === 'analysis' ? ['numpy', 'scikit-learn'] : ['numpy'];
  py = await loadRuntime(d.pyodideUrl, d.pyZipUrl, packages, (p) => post({ type: 'progress', model: d.model, ...p }));
  py.setStdout({ batched: (s: string) => post({ type: 'stdout', model: d.model, text: s }) });
  py.setStderr({ batched: (s: string) => post({ type: 'stderr', model: d.model, text: s }) });
  const module = ({ 'data-cleanse': 'data_cleanse', summaries: 'summaries', analysis: 'analysis' } as Record<string, string>)[d.model]
    ?? `user_${d.model.replace(/-/g, '_')}`;
  if (d.code != null) {
    await py.loadPackagesFromImports(d.code);
    py.FS.writeFile(`/home/pyodide/models/${module}.py`, d.code);
  }
  py.globals.set('_http', http);
  py.globals.set('_open_stream', openStream);
  py.globals.set('_post_tap', postTap);
  py.globals.set('_user', d.user ?? `svc-${d.model}`);
  py.globals.set('_password', d.password ?? '');
  py.runPython(`
import importlib, json, csmodel
from js import Object
from pyodide.ffi import to_js

def _absent(x):  # JavaScript's null arrives as JsNull, not None
    return x is None or type(x).__name__ == "JsNull"

async def _transport(method, path, headers, body):
    r = await _http(method, path, to_js(headers, dict_converter=Object.fromEntries), to_js(body) if body else None)
    if _absent(r):
        raise csmodel.Unavailable("the data server does not answer")
    return int(r[0]), r[1].to_py(), r[2].to_bytes()

async def _stream(path, headers):
    s = await _open_stream(path, to_js(headers, dict_converter=Object.fromEntries))
    if _absent(s):
        raise csmodel.Unavailable("the data server does not answer")
    async def chunks():
        while True:
            c = await s.next()
            if _absent(c):
                return
            yield c.to_bytes()
    return int(s.status), chunks()

_mod = importlib.import_module(${JSON.stringify(module)})
model = _mod.MODEL()
api = csmodel.Api(model.id, _transport, _user, _password, stream=_stream)
def _tap(dst, summary, content=None):
    src, to = ("models", "scilibs") if dst == "scilibs" else ("scilibs", "models")
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], api.quiet)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def step():
    await runner.step()
    return [runner.phase, runner.detail, model.label]
`);
  post({ type: 'progress', model: d.model, stage: 'ready', detail: 'model loaded', pct: 100 });
  void loop();
}

async function loop() {
  if (!py || busy) return;
  busy = true;
  try {
    const r = await py.globals.get('step')();
    const [phase, detail, label] = r.toJs();
    r.destroy();
    port!.postMessage({ type: 'phase', phase, detail, label });
    post({ type: 'status', model: modelId, phase, detail });
  } catch (err) {
    // A failing model reports itself and tries again on its next step (FR-33).
    const detail = String((err as Error)?.message ?? err).split('\n').slice(-2).join(' ');
    port!.postMessage({ type: 'phase', phase: 'failed', detail, label: modelId });
    post({ type: 'status', model: modelId, phase: 'failed', detail });
  } finally {
    busy = false;
  }
  if (taps.length) {
    post({ type: 'tap', messages: taps });
    taps = [];
  }
  setTimeout(loop, STEP_MS);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    port = e.ports[0];
    start(d).catch((err) => post({ type: 'progress', model: d.model, stage: 'error', detail: String(err), pct: 0 }));
  }
};
