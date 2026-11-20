/// <reference lib="webworker" />
// Hosts the illustrative TypeScript simulation (decision D-41) when the
// browser has WebAssembly switched off. Same protocol as backend.worker.ts,
// so the relay, the shell and the display client are unchanged.
import { SimBackend } from '../mock/sim';

declare const self: DedicatedWorkerGlobalScope;
let sim: SimBackend | null = null;

self.onmessage = (e: MessageEvent) => {
  const d = e.data;
  if (d.type === 'start') {
    sim = new SimBackend(d.seed);
    self.postMessage({ type: 'state', state: sim.state() });
    setInterval(() => {
      sim!.tick();
      self.postMessage({ type: 'tick', messages: sim!.tap.drain(), clock: sim!.clock.state(), server: sim!.state().server });
    }, 100);
    self.postMessage({ type: 'progress', stage: 'ready', detail: 'illustrative simulation running', pct: 100 });
  } else if (d.type === 'connect') {
    const port: MessagePort = e.ports[0];
    port.onmessage = (m) => {
      const req = m.data;
      const reply: MessagePort = m.ports[0];
      const chain = (req.headers as [string, string][]).find(([k]) => k === 'x-tap-chain')?.[1] ?? null;
      const body = req.body ? new TextDecoder().decode(req.body) : null;
      const r = sim!.handle(req.method, req.path, req.query, body, req.rootPath, req.origin, chain);
      if (!r) {
        self.postMessage({ type: 'relay-failed', chain, path: req.path, method: req.method });
        reply.postMessage({ down: true });
      } else reply.postMessage({ status: r.status, headers: r.headers, body: r.body });
    };
  } else if (d.type === 'control' && sim) {
    self.postMessage({ type: 'state', state: sim.control(d.action, d.arg) });
  }
};
