/*
 * Seam relay (FR-02, FR-02a). No application logic: it forwards every request
 * under api/ and api-internal/ (the server's internal endpoint, §9.2, D-223) to
 * the back-end worker over a MessagePort and returns what the worker answers.
 * The worker answers, on a reply port, one of:
 *   {status, headers, body}             an ordinary response
 *   {down: true}                        no answer: a network failure, as an unreachable or starting server (§9.1)
 *   {status, headers, stream: true}, then {chunk: ArrayBuffer}... and {end: true}
 *                                       a push subscription: a streaming response (§9.2)
 * When the page drops a stream, the relay sends {cancel: true} on the reply port.
 * Everything else goes to the network.
 *
 * The browser's own login dialog must never appear (FR-97): the relay drops the
 * server's WWW-Authenticate header on the way back (D-226). In a developed system
 * OpenSensorHub or its web server is configured to (docs/v4-interfaces.md §14).
 *
 * Startup (docs/v4-interfaces.md §13.7, NFR-10a): a new relay takes over at once
 * (skipWaiting, then clients.claim). A page that loaded without a controller (a hard
 * reload, or a relay that was already active and so never activates again) asks with
 * a `claim` message, and the relay claims it.
 */
const RELAY_VERSION = '4.7-server-1';
const TIMEOUT_MS = 120000;
let port = null;
let waiting = [];

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'claim') {
    e.waitUntil(self.clients.claim());
  } else if (e.data && e.data.type === 'version') {
    if (e.source) e.source.postMessage({ type: 'relay-version', version: RELAY_VERSION });
  } else if (e.data && e.data.type === 'port') {
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
  for (const base of ['api-internal', 'api']) {
    if (url.startsWith(scope + base + '/') || url === scope + base || url.startsWith(scope + base + '?')) {
      event.respondWith(forward(event.request, new URL(scope + base, scope).pathname));
      return;
    }
  }
});

/** The worker's headers, without WWW-Authenticate (D-226). */
function headersOf(list) {
  return (list || []).filter(([k]) => String(k).toLowerCase() !== 'www-authenticate');
}

async function forward(request, rootPath) {
  const p = await backendPort();
  if (!p) return Response.error();
  const u = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers = [];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const reply = new MessageChannel();
  return new Promise((resolve) => {
    let controller = null;
    const timer = setTimeout(() => resolve(Response.error()), TIMEOUT_MS);
    reply.port1.onmessage = (m) => {
      const d = m.data;
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
        return resolve(new Response(stream, { status: d.status, headers: headersOf(d.headers) }));
      }
      resolve(new Response([101, 204, 205, 304].includes(d.status) ? null : d.body, { status: d.status, headers: headersOf(d.headers) }));
    };
    p.postMessage({ method: request.method, path: u.pathname.slice(rootPath.length) || '/', query: u.search.slice(1),
      body, headers, rootPath, origin: u.origin }, [reply.port2]);
  });
}
