/*
 * Seam relay (B-C11, FR-02). No application logic: it forwards every request
 * under api/ to the backend worker over a MessagePort and returns what the
 * worker answers. When the server is down the worker answers nothing, and the
 * relay returns a network failure, as an unreachable server would (FR-46a).
 * Everything else goes to the network.
 *
 * Startup (docs/v4-interfaces.md §13.7, NFR-10a): a new relay takes over at once
 * (skipWaiting, then clients.claim). A page that loaded without a controller (a hard
 * reload, or a relay that was already active and so never activates again) asks with
 * a `claim` message, and the relay claims it.
 */
const RELAY_VERSION = '4.7-startup-1';
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
  if (!url.startsWith(scope + 'api/') && url !== scope + 'api') return;
  event.respondWith(forward(event.request, new URL(scope + 'api', scope).pathname));
});

async function forward(request, rootPath) {
  const p = await backendPort();
  if (!p) return Response.error();
  const u = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers = [];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const reply = new MessageChannel();
  const answer = new Promise((resolve) => {
    reply.port1.onmessage = (m) => {
      if (m.data.down) resolve(Response.error());
      else resolve(new Response(m.data.status === 204 ? null : m.data.body, { status: m.data.status, headers: m.data.headers }));
    };
  });
  p.postMessage({ method: request.method, path: u.pathname.slice(rootPath.length) || '/', query: u.search.slice(1),
    body, headers, rootPath, origin: u.origin }, [reply.port2]);
  return Promise.race([answer, new Promise((r) => setTimeout(() => r(Response.error()), TIMEOUT_MS))]);
}
