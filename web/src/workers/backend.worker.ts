/// <reference lib="webworker" />
// The back-end worker (Python): Pyodide running the data server on FastAPI and
// its CSV importer. It answers requests the relay forwards, from the display client and
// from each model worker alike (docs/v4-interfaces.md §13), and ticks the system.
// The importer reads the data folder through two functions this worker gives
// it: the folder's listing (index.json) and each file (<file>.gz, decompressed).
import { loadRuntime, Progress } from './common';

declare const self: DedicatedWorkerGlobalScope;
let bridge: any = null;
let py: any = null;
const queue: Array<() => void> = [];
/** The demonstrator's system hold (D-362), kept from before the server starts: the page may pause during startup. */
let held = false;

const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

/** The data folder, read for the importer (FR-15, FR-17a): its listing, and each CSV, decompressed here. */
function folderReaders(folderUrl: string) {
  const root = folderUrl.endsWith('/') ? folderUrl : folderUrl + '/';
  return {
    index: async () => {
      const r = await fetch(root + 'index.json', { cache: 'no-cache', signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`the data folder has no listing (HTTP ${r.status})`);
      return r.text();
    },
    file: async (name: string) => {
      const r = await fetch(root + encodeURIComponent(name) + '.gz', { cache: 'no-cache', signal: AbortSignal.timeout(120_000) });
      if (!r.ok || !r.body) throw new Error(`${name}: HTTP ${r.status}`);
      return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    },
  };
}

async function start(pyodideUrl: string, pyZipUrl: string, folderUrl: string | null) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'fastapi', 'jsonschema'], post);
  post({ stage: 'server', detail: 'the data server: starting', pct: 90 });
  const folder = folderUrl ? folderReaders(folderUrl) : null;
  py.globals.set('_fetch_index', folder ? folder.index : null);
  py.globals.set('_fetch_file', folder ? folder.file : null);
  py.runPython(`
from barge.bridge import Bridge
bridge = Bridge(fetch_index=_fetch_index, fetch_file=_fetch_file)
`);
  bridge = py.globals.get('bridge');
  bridge.set_held(held);
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
  // The server answers once the importer has started: Mission A is imported silently first, at this first start
  // only (FR-15). The steps are named while that happens (§13.7).
  for (;;) {
    const phase = String(bridge.startup_phase());
    if (phase === 'ready') break;
    if (phase === 'import') post({ stage: 'import', detail: 'the CSV importer: listing the data folder and importing Mission A', pct: 95 });
    await new Promise((r) => setTimeout(r, 100));
  }
  post({ stage: 'ready', detail: 'running', pct: 100 });
  queue.splice(0).forEach((f) => f());
}

/**
 * One request through the seam. While the server is starting or down the bridge answers nothing, and the
 * relay reports a network failure (§9.1). A push subscription (§9.2) is streamed: {status, headers, stream: true},
 * then {chunk} per command and {end: true}; the relay's {cancel: true} ends it.
 */
let requestSeq = 0;

async function serve(req: any, reply: MessagePort) {
  if (!bridge) await new Promise<void>((r) => queue.push(r));
  const header = (name: string) => (req.headers as [string, string][]).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  let streaming = false;
  const onStream = (kind: string, a?: any, b?: any) => {
    if (kind === 'start') {
      streaming = true;
      reply.postMessage({ status: a, headers: Array.from(b ?? [], (h: any) => [String(h[0]), String(h[1])]), stream: true });
    } else if (kind === 'chunk') {
      const bytes = new Uint8Array(a).slice();
      reply.postMessage({ chunk: bytes.buffer }, [bytes.buffer]);
    } else {
      reply.postMessage({ end: true });
    }
  };
  const rid = ++requestSeq;
  try {
    // A task the bridge knows by this request's id, so that the relay's {cancel: true} ends a push subscription
    // (D-343). A PyProxy of the task cannot be cancelled from here: awaiting it destroys it.
    const call = bridge.start(rid, req.method, req.path, req.query, req.body ? new Uint8Array(req.body) : undefined, // undefined is None; null is JsNull
      req.rootPath, req.headers, req.origin, onStream);
    reply.onmessage = (m) => {
      if (m.data?.cancel) bridge.cancel(rid); // the page dropped the stream: the subscription ends
    };
    const res = await call;
    if (res === undefined || res === null) {
      if (header('x-tap-quiet') !== '1') {
        self.postMessage({ type: 'relay-failed', chain: header('x-tap-chain'), path: req.path, method: req.method, model: header('x-tap-model') });
      }
      if (streaming) reply.postMessage({ end: true });
      else reply.postMessage({ down: true });
      return;
    }
    if (res === 'stream') return; // its chunks and its end have been sent
    const [status, headers, body] = res.toJs ? res.toJs() : res;
    res.destroy?.();
    const bytes = new Uint8Array(body).slice();
    reply.postMessage({ status, headers, body: bytes.buffer }, [bytes.buffer]);
  } catch (e) {
    const msg = new TextEncoder().encode(`<!doctype html><title>500 Internal Server Error</title><p>${String(e)}</p>`);
    if (streaming) reply.postMessage({ end: true });
    else reply.postMessage({ status: 500, headers: [['content-type', 'text/html']], body: msg.buffer }, [msg.buffer]);
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') start(d.pyodideUrl, d.pyZipUrl, d.folderUrl ?? null).catch((err) => post({ stage: 'error', detail: String(err), pct: 0 }));
  else if (d.type === 'hold') {
    held = !!d.on; // D-362: the importer and pushed commands wait in the server while held
    bridge?.set_held(held);
  } else if (d.type === 'connect') {
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
      self.postMessage({ type: 'state', state: JSON.parse(bridge.control(d.action, py.toPy(d.arg ?? null))), id: d.id ?? null });
    } catch (err) {
      self.postMessage({ type: 'control-error', error: String(err), id: d.id ?? null });
    }
  }
};
