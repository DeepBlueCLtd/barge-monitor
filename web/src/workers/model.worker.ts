/// <reference lib="webworker" />
// One model in its own worker (FR-33): its own Pyodide, the scientific
// libraries it needs, and one MessagePort to the back-end worker, over which
// it calls the data server's internal interface (docs/v4-interfaces.md §7).
// A model that raises errors, or never returns, stops only itself: the data
// server, the other models and the display client carry on (AT-14).
import { loadRuntime } from './common';

declare const self: DedicatedWorkerGlobalScope;

let py: any = null;
let port: MessagePort | null = null;
let modelId = '';
let clock = { t: 0, playing: false };
let busy = false;
let seq = 0;
const pending = new Map<number, (reply: any) => void>();
let taps: any[] = [];
let tapSeq = 0;

const post = (m: any) => self.postMessage(m);

/** A call to the data server: resolves with its reply ({ok, result} or {ok: false, status, error}). */
function rpc(op: string, args: any, quiet: boolean): Promise<any> {
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, status: 'down', error: 'no answer from the data server' });
    }, 30_000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    const a = args?.toJs ? args.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false }) : args;
    args?.destroy?.();
    port!.postMessage({ id, op, args: a, quiet });
  });
}

/** Messages between the model and the scientific libraries: captured here, drawn by the page. */
function postTap(src: string, dst: string, summary: string, content: string, quiet: boolean) {
  if (quiet) return; // catching up on history at startup: not drawn
  taps.push({ id: `${modelId}-${++tapSeq}`, t: clock.t, src, dst, letter: 'I', summary, content, model: modelId, chain: null, hop: 0 });
}

async function start(pyodideUrl: string, pyZipUrl: string, model: string, code: string | null) {
  modelId = model;
  const packages = model === 'model-b' ? ['numpy', 'scikit-learn'] : ['numpy'];
  py = await loadRuntime(pyodideUrl, pyZipUrl, packages, (p) => post({ type: 'progress', model, ...p }));
  py.setStdout({ batched: (s: string) => post({ type: 'stdout', model, text: s }) });
  py.setStderr({ batched: (s: string) => post({ type: 'stderr', model, text: s }) });
  const module = { 'data-cleanse': 'data_cleanse', 'model-a': 'model_a', 'model-b': 'model_b' }[model] ?? `user_${model.replace(/-/g, '_')}`;
  if (code != null) {
    await py.loadPackagesFromImports(code);
    py.FS.writeFile(`/home/pyodide/models/${module}.py`, code);
  }
  py.globals.set('_rpc', rpc);
  py.globals.set('_post_tap', postTap);
  py.runPython(`
import importlib, csmodel
_mod = importlib.import_module(${JSON.stringify(module)})
model = _mod.MODEL()
api = csmodel.PortApi(model.id, _rpc, _post_tap)
runner = csmodel.Runner(model, api)

async def tick(t, playing):
    api.clock = {"t": t, "playing": playing}
    await runner.tick(playing)
    return [runner.phase, runner.detail, model.label]

def notify(js):
    runner.notify(js.to_py())
`);
  post({ type: 'progress', model, stage: 'ready', detail: 'model loaded', pct: 100 });
  void loop();
}

/** Step the model: every 250 ms when live, back to back while it catches up on history. */
function schedule(phase: string) {
  setTimeout(loop, phase === 'catching up' ? 0 : 250);
}

async function loop() {
  if (!py || busy) return;
  busy = true;
  let phase = 'live';
  try {
    const r = await py.globals.get('tick')(clock.t, clock.playing);
    const [ph, detail, label] = r.toJs();
    r.destroy();
    phase = ph;
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
  schedule(phase);
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    port = e.ports[0];
    port.onmessage = (m) => {
      if (m.data.notify) py?.globals.get('notify')(m.data.notify);
      else pending.get(m.data.id)?.(m.data.reply);
      pending.delete(m.data.id);
    };
    start(d.pyodideUrl, d.pyZipUrl, d.model, d.code ?? null).catch((err) =>
      post({ type: 'progress', model: d.model, stage: 'error', detail: String(err), pct: 0 }));
  } else if (d.type === 'clock') {
    clock = { t: d.state.t, playing: d.state.playing };
  }
};
