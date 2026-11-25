/// <reference lib="webworker" />
// The back-end worker (Python): Pyodide running the data folder's reader, the CSV importer, the
// replay controller, the access gateway and the data server's stand-in on FastAPI
// (docs/v4-interfaces.md §13.1). It answers the requests the relay forwards, from the display
// client and from each model worker alike, and ticks the replay clock in real time.
//
// Port protocol with the relay (sw.js), per request (§9.2, §4):
//   relay -> worker   {method, path, query, body, headers, rootPath, origin} with a reply port
//   worker -> relay   {status, headers, body}                       an ordinary answer
//                     {down: true}                                  no answer (starting, down)
//                     {status, headers, stream: true}, then {chunk}, ..., then {end: true}
//                                                                   a push subscription (streamed)
//                     {held: true}                                  while Freeze holds a request that
//                                                                   asked with x-relay-hold-ok: 1
import { loadRuntime, Progress } from './common';

declare const self: DedicatedWorkerGlobalScope;
let bridge: any = null;
let py: any = null;
const queue: Array<() => void> = [];
const HELD_EVERY_MS = 2000;

const post = (p: Progress) => self.postMessage({ type: 'progress', ...p });

async function gunzip(res: Response): Promise<Uint8Array> {
  if (!res.ok || !res.body) throw new Error(`${res.url}: HTTP ${res.status}`);
  return new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** The data folder, read only (FR-17a): its listing and each file, fetched when the importer asks. */
function folderPort(folderUrl: string) {
  return {
    index: async () => (await fetch(folderUrl + 'index.json', { cache: 'no-store' })).text(),
    file: async (name: string) => gunzip(await fetch(folderUrl + name + '.gz', { cache: 'no-store' })),
    manifest: async () => new TextDecoder().decode(await gunzip(await fetch(folderUrl + 'manifest.json.gz'))),
  };
}

async function start(pyodideUrl: string, pyZipUrl: string, folderUrl: string) {
  py = await loadRuntime(pyodideUrl, pyZipUrl, ['numpy', 'fastapi', 'jsonschema'], post);
  post({ stage: 'server', detail: 'starting the data server and importing Mission A', pct: 60 });
  const folder = folderPort(folderUrl);
  py.globals.set('_folder_index', folder.index);
  py.globals.set('_folder_file', folder.file);
  py.globals.set('_folder_manifest', folder.manifest);
  await py.runPythonAsync(`
from barge.bridge import Bridge
bridge = Bridge(_folder_index, _folder_file, _folder_manifest)
await bridge.start()
`);
  bridge = py.globals.get('bridge');
  self.postMessage({ type: 'state', state: JSON.parse(bridge.control('state')) });
  let n = 0;
  setInterval(() => {
    try {
      self.postMessage({ type: 'tick', ...JSON.parse(bridge.tick()) });
      // The control state, including each model's phase, once a second (§13.2).
      if (++n % 10 === 0) self.postMessage({ type: 'state', state: JSON.parse(bridge.control('state')) });
    } catch (e) {
      console.error(e);
    }
  }, 100);
  post({ stage: 'ready', detail: 'running', pct: 100 });
  queue.splice(0).forEach((f) => f());
}

async function serve(req: any, reply: MessagePort) {
  if (!bridge) await new Promise<void>((r) => queue.push(r));
  const header = (name: string) => (req.headers as [string, string][]).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
  // Freeze holds a request unanswered; say so, so that the relay's timeout does not fire (§4).
  const held = header('x-relay-hold-ok') === '1'
    ? setInterval(() => { if (bridge?.frozen) reply.postMessage({ held: true }); }, HELD_EVERY_MS)
    : null;
  let streaming = false;
  const onStream = (kind: string, a?: any, b?: any) => {
    if (kind === 'start') {
      streaming = true;
      if (held) clearInterval(held);
      reply.postMessage({ status: a, headers: Array.from(b ?? [], (h: any) => [String(h[0]), String(h[1])]), stream: true });
    } else if (kind === 'chunk') {
      const bytes = new Uint8Array(a).slice();
      reply.postMessage({ chunk: bytes.buffer }, [bytes.buffer]);
    } else {
      reply.postMessage({ end: true });
    }
  };
  try {
    const res = await bridge.handle(req.method, req.path, req.query, req.body ? new Uint8Array(req.body) : null,
      req.rootPath, req.headers, req.origin, onStream);
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
  } finally {
    if (held) clearInterval(held);
  }
}

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    start(d.pyodideUrl, d.pyZipUrl, d.folderUrl).catch((err) => post({ stage: 'error', detail: String(err), pct: 0 }));
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
      self.postMessage({ type: 'state', id: d.id, state: JSON.parse(bridge.control(d.action, py.toPy(d.arg ?? null))) });
    } catch (err) {
      self.postMessage({ type: 'control-error', id: d.id, error: String(err) });
    }
  }
};
