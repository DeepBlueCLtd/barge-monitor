/// <reference lib="webworker" />
// One model in its own worker (FR-33): its own Pyodide and the scientific
// libraries it needs. It reaches the data server as any client does: HTTP
// requests to the Connected Systems interface, carried by the relay, with its
// service account's credentials (docs/v4-interfaces.md §9.3, §10.1). Its
// commands are pushed to it on a subscription held on the server's internal
// endpoint, a streaming response through the relay (§9.2). There is no other way in.
// A model that raises errors, or never returns, stops only itself: the data
// server, the other models and the display client carry on (AT-14).
//
// 4.7 (§10.2): a model follows no clock. Its runner finds datasets in the
// importer's catalogue and processes each whole dataset, a few windows a step,
// back to back while there is work.
import { passwordOf } from '../standin/accounts';
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;

let py: any = null;
let port: MessagePort | null = null;
let modelId = '';
let apiUrl = '';

let busy = false;
/**
 * The demonstrator's system hold (D-362): while held, the model takes no step, a request waits before it enters the
 * relay, and an answer already on its way waits before the model reads it. Let go, it carries on where it stopped.
 */
let held = false;
const waiters: Array<() => void> = [];
/** The calls into the scientific libraries so far, to the page: at each request, so that slow motion's back-pressure
 * sees them before the model goes on to its next window (D-362), and at the end of each step. */
function flushTaps() {
  if (!taps.length) return;
  post({ type: 'tap', messages: taps });
  taps = [];
}
const released = () => (held ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve());
let taps: any[] = [];
let tapSeq = 0;

const post = (m: any) => self.postMessage(m);

/**
 * One HTTP request to the data server, through the relay like the display client's (FR-02).
 * Resolves with [status, headers, body], or null when there is no answer (the server is down).
 */
async function http(method: string, path: string, headers: any, body: any): Promise<[number, Record<string, string>, Uint8Array] | null> {
  const h = headers?.toJs ? headers.toJs({ dict_converter: Object.fromEntries }) : headers;
  const b: Uint8Array | null = body?.toJs ? body.toJs() : body ?? null;
  headers?.destroy?.();
  body?.destroy?.();
  let res: Response;
  let bytes: Uint8Array;
  flushTaps();
  await released();
  try {
    res = await fetch(apiUrl + path, { method, headers: h, body: b, cache: 'no-store' });
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    await released();
    return null;
  }
  await released();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k.toLowerCase()] = v));
  return [res.status, out, bytes];
}

/** A push subscription (§9.2): a streamed answer through the relay, read chunk by chunk. Null when there is no answer. */
async function openStream(path: string, headers: any, internal: boolean): Promise<{ status: number; next: () => Promise<Uint8Array | null> } | null> {
  const h = headers?.toJs ? headers.toJs({ dict_converter: Object.fromEntries }) : headers;
  headers?.destroy?.();
  let res: Response;
  await released();
  try {
    res = await fetch((internal ? apiUrl + '-internal' : apiUrl) + path, { method: 'GET', headers: h, cache: 'no-store' });
  } catch {
    return null;
  }
  await released();
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
  if (quiet) return; // counted, not drawn
  taps.push({ id: `${modelId}-${++tapSeq}`, t: Date.now() / 1000, src, dst, letter: 'I', summary, content, model: modelId, chain: null, hop: 0 });
}

async function start(pyodideUrl: string, pyZipUrl: string, model: string, code: string | null, api: string) {
  modelId = model;
  apiUrl = api;
  const packages = model === 'analysis' ? ['numpy', 'scikit-learn'] : ['numpy'];
  py = await loadRuntime(pyodideUrl, pyZipUrl, packages, (p) => post({ type: 'progress', model, ...p }));
  py.setStdout({ batched: (s: string) => post({ type: 'stdout', model, text: s }) });
  py.setStderr({ batched: (s: string) => post({ type: 'stderr', model, text: s }) });
  const module = { 'data-cleanse': 'data_cleanse', 'summaries': 'summaries', 'analysis': 'analysis' }[model] ?? `user_${model.replace(/-/g, '_')}`;
  if (code != null) {
    await py.loadPackagesFromImports(code);
    py.FS.writeFile(`/home/pyodide/models/${module}.py`, code);
  }
  py.globals.set('_http', http);
  py.globals.set('_open_stream', openStream);
  py.globals.set('_post_tap', postTap);
  py.globals.set('_user', `svc-${model}`);
  py.globals.set('_password', passwordOf(`svc-${model}`)); // labelled demo credentials (PR-07)
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

async def _stream(path, headers, internal=False):
    s = await _open_stream(path, to_js(headers, dict_converter=Object.fromEntries), bool(internal))
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
    _post_tap(src, to, f"{model.id}: {summary}", json.dumps(content, default=str)[:4000], False)  # drawn, processing included (D-321)
api.tap = _tap
runner = csmodel.Runner(model, api)

async def tick():
    await runner.step()
    # Whether a run is in hand: a model only waiting for its inputs steps at the idle pace (D-342).
    return [runner.phase, runner.detail, model.label, runner.current is not None]
`);
  post({ type: 'progress', model, stage: 'ready', detail: 'model loaded', pct: 100 });
  void loop();
}

/** Step the model: back to back while it processes a dataset, every 250 ms otherwise. */
/**
 * The next step: at once while a run is in hand, else after 250 ms. A model waiting for its inputs (Summaries and
 * Analysis while Data cleanse processes) reports "processing" too, but stepping it at once only re-reads Data
 * cleanse's runs log, taking the back end's single thread from the run that is processing (D-342).
 */
function schedule(working: boolean) {
  setTimeout(loop, working ? 0 : 250);
}

async function loop() {
  if (!py || busy) return;
  if (held) return void setTimeout(loop, 100); // held (D-362): no new step
  busy = true;
  let phase = 'live';
  let working = false;
  try {
    const r = await py.globals.get('tick')();
    const [ph, detail, label, inHand] = r.toJs();
    r.destroy();
    phase = ph;
    working = ph === 'processing' && inHand === true;
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
  flushTaps();
  schedule(working);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'hold') {
    held = !!d.on;
    if (!held) for (const w of waiters.splice(0)) w();
  } else if (d.type === 'start') {
    port = e.ports[0]; // to the back-end worker, for the shell only: the model says which phase it is in
    start(d.pyodideUrl, d.pyZipUrl, d.model, d.code ?? null, d.apiUrl).catch((err) =>
      post({ type: 'progress', model: d.model, stage: 'error', detail: String(err), pct: 0 }));
  }
};
