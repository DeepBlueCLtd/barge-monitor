/// <reference lib="webworker" />
// The stand-in back-end worker (SRD §2.3, FR-06a): the JavaScript stand-in's
// CSV importer, data server and core models in one worker, for sites without WebAssembly or with
// ?backend=standin. It speaks the same protocol with the page as the Python
// back-end worker (docs/v4-interfaces.md §8): `start`, `connect` (a port from
// the relay), `control`; it posts `progress`, `tick` every 100 ms, `state`
// once a second and after each control, and `relay-failed`. `hold {on}` holds the system (D-362).
// The stand-in runs its own models: `model-connect` is not used (FR-06f).
import { createStandin, fetchFolder, Gate, HttpRequest, Progress, Runtime } from '../standin';
import { Runner } from '../standin/models/csmodel';

declare const self: DedicatedWorkerGlobalScope;

let rt: Runtime | null = null;
/** The demonstrator's system hold (D-362), kept from before the server starts: the page may pause during startup. */
const gate = new Gate();
const queue: Array<() => void> = [];
const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

async function start(folderUrl: string | null, missionA: boolean) {
  // The data folder (FR-15): read by the CSV importer only, through its listing and each file (FR-20, FR-17a).
  rt = await createStandin(folderUrl ? fetchFolder(folderUrl) : undefined, post, undefined, gate, missionA);
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
    const res = await rt!.handle({ ...req, body: req.body ? new Uint8Array(req.body) : null });
    if (res === null) {
      // Starting or down: no answer at all, so the relay reports a network failure (§9.1).
      const h = (name: string) => req.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
      if (h('x-tap-quiet') !== '1') self.postMessage({ type: 'relay-failed', chain: h('x-tap-chain'), model: h('x-tap-model'), path: req.path, method: req.method });
      reply.postMessage({ down: true });
      return;
    }
    if (res.stream) { // a push subscription (§9.2): its headers at once, its lines as they come
      const stream = res.stream;
      reply.postMessage({ status: res.status, headers: res.headers, stream: true });
      reply.onmessage = (m) => m.data?.cancel && stream.cancel();
      stream.attach({
        chunk: (b) => {
          const buf = b.slice().buffer;
          reply.postMessage({ chunk: buf }, [buf]);
        },
        end: () => reply.postMessage({ end: true }),
      });
      return;
    }
    const body = res.body.slice().buffer;
    reply.postMessage({ status: res.status, headers: res.headers, body }, [body]);
  } catch (e) {
    reply.postMessage({ status: 500, headers: [['content-type', 'text/html']], body: `<!doctype html><title>500 Internal Server Error</title><p>${String(e)}</p>` });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    Runner.paceMs = Number(d.runPaceMs) || 0;
    start(d.folderUrl ?? null, !!d.missionA).catch((err) => post({ stage: 'error', detail: String(err?.message ?? err), pct: 0 }));
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => serve(m.data, m.ports[0]);
  } else if (d.type === 'hold') {
    gate.set(!!d.on); // D-362: the page holds the system (Pause, or slow motion's back-pressure)
  } else if (d.type === 'control') {
    if (!rt) return;
    try {
      self.postMessage({ type: 'state', state: rt.control(d.action, d.arg ?? null), id: d.id ?? null });
    } catch (err) {
      self.postMessage({ type: 'control-error', error: String(err), id: d.id ?? null });
    }
  }
};
