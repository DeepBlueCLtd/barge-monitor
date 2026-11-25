/*
 * Seam relay (FR-02, FR-02a). No application logic: it forwards every request
 * under api/ to the back-end worker over a MessagePort and returns what the
 * worker answers. The worker answers, on a reply port, one of:
 *   {status, headers, body}                      an ordinary response
 *   {down: true}                                 no answer: a network failure, as an unreachable server
 *   {status, headers, stream: true}, then {chunk: ArrayBuffer}… and {end: true}
 *                                                a push subscription: a streaming response (FR-02a)
 *   {held: true}                                 a keep-alive while Freeze holds the request: resets the timeout
 * When the page drops a stream, the relay sends {cancel: true} on the reply port.
 * Everything else goes to the network.
 */
const TIMEOUT_MS = 120000;
let port = null;
let waiting = [];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'port') {
    port = e.ports[0] || null;
    waiting.splice(0).forEach((resolve) => resolve(port));
  }
});

async function backendPort() {
  if (port) return port;
  const p = new Promise((resolve) => waiting.push(resolve));
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach((c) => c.postMessage({ type: 'need-port' }));
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), 10000))]);
}

self.addEventListener('fetch', (event) => {
  const scope = self.registration.scope;
  const url = event.request.url;
  if (!url.startsWith(scope + 'api/') && url !== scope + 'api') return;
  event.respondWith(forward(event.request, new URL(scope + 'api', scope).pathname));
});

async function forward(request, rootPath) {
  const p = await backendPort();
  if (!p) return Response.error();
  const u = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers = [['x-relay-hold-ok', '1']];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const reply = new MessageChannel();
  return new Promise((resolve) => {
    let timer = null;
    let controller = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => resolve(Response.error()), TIMEOUT_MS);
    };
    arm();
    reply.port1.onmessage = (m) => {
      const d = m.data;
      if (d.held) return arm();
      if (controller) {
        if (d.chunk) controller.enqueue(new Uint8Array(d.chunk));
        if (d.end) {
          try { controller.close(); } catch (e) { /* already closed */ }
          reply.port1.close();
        }
        return;
      }
      clearTimeout(timer);
      if (d.down) return resolve(Response.error());
      if (d.stream) {
        const stream = new ReadableStream({
          start(c) { controller = c; },
          cancel() { reply.port1.postMessage({ cancel: true }); },
        });
        return resolve(new Response(stream, { status: d.status, headers: d.headers }));
      }
      resolve(new Response(d.status === 204 ? null : d.body, { status: d.status, headers: d.headers }));
    };
    p.postMessage({ method: request.method, path: u.pathname.slice(rootPath.length) || '/', query: u.search.slice(1),
      body, headers, rootPath, origin: u.origin }, [reply.port2]);
  });
}
