/// <reference lib="webworker" />
// The stand-in back-end worker (SRD §2.3, FR-06a): the JavaScript stand-in's
// world continuation, logger store, store adapter, data server and core
// models in one worker, for sites without WebAssembly or with
// ?backend=standin. It speaks the same protocol with the page as the Python
// back-end worker (docs/v4-interfaces.md §8): `start`, `connect` (a port from
// the relay), `control`; it posts `progress`, `tick` every 100 ms, `state`
// once a second and after each control, and `relay-failed`.
// The stand-in runs its own models: `model-connect` is not used (FR-06f).
import { createStandin, HttpRequest, loadHistory, Progress, Runtime } from '../standin';

declare const self: DedicatedWorkerGlobalScope;

let rt: Runtime | null = null;
const queue: Array<() => void> = [];
const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

/** The host's monotonic time, in seconds: it only paces the simulation clock (FR-13). */
const hostSeconds = () => performance.now() / 1000;

async function gunzip(res: Response): Promise<Uint8Array> {
  if (!res.body) throw new Error('empty response');
  return new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function start(seed: number, historyUrl: string | null) {
  // FR-06d: the stand-in reads the same pre-calculated history as the Python back end.
  if (!historyUrl) throw new Error('no pre-calculated history: the stand-in cannot generate one (the world generator is Python)');
  const base = `${historyUrl}seed-${seed}/`;
  post({ stage: 'history', detail: 'loading the pre-calculated history', pct: 5 });
  // A stalled download fails with a message rather than hanging the loading screen.
  const r = await fetch(base + 'manifest.json', { cache: 'no-cache', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`no pre-calculated history for seed ${seed} (HTTP ${r.status})`);
  const manifest = await r.json();
  const history = await loadHistory(manifest, async (name) => {
    const res = await fetch(`${base}${name}.gz`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`history file ${name}: HTTP ${res.status}`);
    return gunzip(res);
  }, post);
  rt = createStandin(seed, history, hostSeconds, post);
  const runtime = rt;
  self.postMessage({ type: 'state', state: runtime.controlState() });
  let n = 0;
  setInterval(() => {
    try {
      runtime.tick();
      self.postMessage({ type: 'tick', ...runtime.tickMessage() });
      if (++n % 10 === 0) self.postMessage({ type: 'state', state: runtime.controlState() });
    } catch (e) {
      console.error(e);
    }
  }, 100);
  post({ stage: 'ready', detail: 'running', pct: 100 });
  queue.splice(0).forEach((f) => f());
}

async function serve(req: HttpRequest & { body: ArrayBuffer | Uint8Array | null }, reply: MessagePort) {
  if (!rt) await new Promise<void>((r) => queue.push(r));
  try {
    const res = rt!.handle({ ...req, body: req.body ? new Uint8Array(req.body) : null });
    if (res === null) {
      // The server is down: no answer at all, so the relay reports a network failure (FR-49).
      const chain = req.headers.find(([k]) => k.toLowerCase() === 'x-tap-chain')?.[1] ?? null;
      self.postMessage({ type: 'relay-failed', chain, path: req.path, method: req.method });
      reply.postMessage({ down: true });
      return;
    }
    const body = res.body.slice().buffer;
    reply.postMessage({ status: res.status, headers: res.headers, body }, [body]);
  } catch (e) {
    reply.postMessage({ status: 500, headers: [['content-type', 'application/json']], body: JSON.stringify({ code: 'InternalError', description: String(e) }) });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    start(Number(d.seed), d.historyUrl ?? null).catch((err) => post({ stage: 'error', detail: String(err?.message ?? err), pct: 0 }));
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  } else if (d.type === 'control') {
    if (!rt) return;
    try {
      self.postMessage({ type: 'state', state: rt.control(d.action, d.arg ?? null) });
    } catch (err) {
      self.postMessage({ type: 'control-error', error: String(err) });
    }
  }
};
