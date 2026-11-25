/// <reference lib="webworker" />
// The stand-in back-end worker (SRD §2.3, FR-06a; docs/v4-interfaces.md §13):
// the data folder, CSV importer, replay controller, data server stand-in,
// access gateway and core models in one worker. It speaks the same protocol
// with the page as the Python back-end worker:
//   page -> worker: `start {folderUrl}`, `connect` (a port from the relay), `control {action, arg}`;
//   worker -> page: `progress`, `tick {messages, server, replay}` every 100 ms,
//                   `state` once a second and after each control, `relay-failed`.
// Requests from the relay arrive on the port, each with a reply port. The answer is
//   {status, headers, body}, or {down: true} for no answer at all, or, for a push
//   subscription, {status, headers, stream: true} then {chunk} per command and {end: true}.
// While a request is held by Freeze, {held: true} is sent every 2 s (§4). The relay may
// send {cancel: true} on the reply port when the page drops a stream.
// The stand-in runs its own models: `model-connect` is not used (FR-06f).
import { createStandin, fetchFolder, HttpRequest, Progress, Runtime } from '../standin';

declare const self: DedicatedWorkerGlobalScope;

let rt: Runtime | null = null;
const queue: Array<() => void> = [];
const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

async function start(folderUrl: string) {
  post({ stage: 'folder', detail: 'reading the data folder', pct: 5 });
  const runtime = await createStandin(fetchFolder(folderUrl), post);
  rt = runtime;
  self.postMessage({ type: 'state', state: runtime.controlState() });
  let n = 0;
  let last = performance.now();
  setInterval(() => {
    try {
      const now = performance.now();
      runtime.tick((now - last) / 1000);
      last = now;
      self.postMessage({ type: 'tick', ...runtime.tickMessage() });
      if (++n % 10 === 0) self.postMessage({ type: 'state', state: runtime.controlState() });
    } catch (e) {
      console.error(e);
    }
  }, 100);
  queue.splice(0).forEach((f) => f());
}

async function serve(req: HttpRequest & { body: ArrayBuffer | Uint8Array | null }, reply: MessagePort) {
  if (!rt) await new Promise<void>((r) => queue.push(r));
  const runtime = rt!;
  const holdOk = req.headers.some(([k, v]) => k.toLowerCase() === 'x-relay-hold-ok' && v === '1');
  const keepAlive = holdOk ? setInterval(() => runtime.frozen && reply.postMessage({ held: true }), 2000) : null;
  try {
    const res = await runtime.handle({ ...req, body: req.body ? new Uint8Array(req.body) : null });
    if (keepAlive) clearInterval(keepAlive);
    if (res === null) {
      // Down or starting: no answer at all, so the relay reports a network failure (§9.1).
      const h = (name: string) => req.headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
      self.postMessage({ type: 'relay-failed', chain: h('x-tap-chain'), model: h('x-tap-model'), path: req.path, method: req.method });
      reply.postMessage({ down: true });
      return;
    }
    if (res.stream) {
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
    if (keepAlive) clearInterval(keepAlive);
    reply.postMessage({ status: 500, headers: [['content-type', 'text/html']], body: `<html><head><title>500 Internal Server Error</title></head><body>${String(e)}</body></html>` });
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    start(String(d.folderUrl ?? 'data/folder/')).catch((err) => post({ stage: 'error', detail: String(err?.message ?? err), pct: 0 }));
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => void serve(m.data, m.ports[0]);
  } else if (d.type === 'control') {
    if (!rt) return;
    rt.control(d.action, d.arg ?? null)
      .then((state) => self.postMessage({ type: 'state', state }))
      .catch((err) => self.postMessage({ type: 'control-error', error: String(err) }));
  }
};
