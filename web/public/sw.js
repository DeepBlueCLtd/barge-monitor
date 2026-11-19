/*
 * The seam's transport (FR-02). This Service Worker holds no application
 * logic: it forwards every request under api/ to the backend worker, and
 * under ws/ to the analyst's workspace worker, over a MessagePort, and
 * returns what they answer. Everything else goes to the network.
 *
 * Ports are handed over by the page. If this worker has been restarted and
 * lost them, it asks the page for new ones.
 */
const ROUTES = ['api', 'ws'];
const TIMEOUT_MS = 120000;
const ports = {};
const waiting = {};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'port' && ROUTES.includes(d.name)) {
    ports[d.name] = e.ports[0] || null;
    (waiting[d.name] || []).forEach((resolve) => resolve(ports[d.name]));
    waiting[d.name] = [];
  }
});

async function portFor(name) {
  if (ports[name]) return ports[name];
  const p = new Promise((resolve) => (waiting[name] = waiting[name] || []).push(resolve));
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach((c) => c.postMessage({ type: 'need-port', name }));
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), 10000))]);
}

self.addEventListener('fetch', (event) => {
  const scope = self.registration.scope;
  const url = event.request.url;
  if (!url.startsWith(scope)) return;
  const name = ROUTES.find((r) => url.startsWith(scope + r + '/') || url === scope + r);
  if (!name) return;
  event.respondWith(forward(name, event.request, new URL(scope + name, scope).pathname));
});

function refusal(status, description) {
  return new Response(JSON.stringify({ code: 'Unavailable', description }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function forward(name, request, rootPath) {
  const port = await portFor(name);
  if (!port) return refusal(503, `${name === 'ws' ? 'the workspace' : 'the backend'} is not running`);
  const u = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const headers = [];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const reply = new MessageChannel();
  const answer = new Promise((resolve) => {
    reply.port1.onmessage = (m) =>
      resolve(new Response(m.data.body, { status: m.data.status, headers: m.data.headers }));
  });
  port.postMessage(
    { method: request.method, path: u.pathname.slice(rootPath.length) || '/', query: u.search.slice(1), body, headers, rootPath },
    [reply.port2],
  );
  return Promise.race([
    answer,
    new Promise((r) => setTimeout(() => r(refusal(504, `no answer from ${name} within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)),
  ]);
}
