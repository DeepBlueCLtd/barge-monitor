// A static file server for the assembled site (no application logic).
//
// Usage: node scripts/serve.mjs [root]   (PORT, default 8080)
// With PREFIXES, a comma-separated list of path prefixes such as
// "/barge-monitor/pr/17/,/barge-monitor/", the site is served under each of them
// and nowhere else, as GitHub Pages serves a pull request's preview and the shared
// files at the site root (NFR-10a: the preview is tested on its published path).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '../dist-site');
const port = Number(process.env.PORT ?? 8080);
const prefixes = (process.env.PREFIXES ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  .map((p) => (p.endsWith('/') ? p : p + '/')).sort((a, b) => b.length - a.length);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip', '.whl': 'application/zip',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.tar': 'application/x-tar', '.gz': 'application/gzip',
};
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = normalize(decodeURIComponent(url.pathname));
  if (prefixes.length) {
    const hit = prefixes.find((x) => p.startsWith(x));
    if (!hit) { res.writeHead(404).end('not found'); return; }
    p = '/' + p.slice(hit.length);
  }
  let f = join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403).end(); return; }
  if (existsSync(f) && statSync(f).isDirectory()) {
    // As GitHub Pages does: a folder without its slash is redirected, so relative URLs resolve.
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { location: url.pathname + '/' + url.search }).end(); return; }
    f = join(f, 'index.html');
  }
  if (!existsSync(f)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
  createReadStream(f).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}${prefixes[prefixes.length - 1] ?? '/'}`));
