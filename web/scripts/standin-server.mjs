#!/usr/bin/env node
// The JavaScript stand-in back end in Node, behind a tiny HTTP server, so the
// one contract suite can run against it as it runs against the Python back
// end under uvicorn (PR-04, AT-24). It bundles web/src/standin with esbuild
// (in memory), loads the pre-calculated history from a local directory, and
// serves the stand-in's HTTP interface at the root of the given port.
//
// Usage: node web/scripts/standin-server.mjs [--port N] [--seed N] [--history DIR] [--play]
//   DIR holds seed-<n>/manifest.json and the gzipped logger files, as
//   scripts/build_history.py writes them; by default
//   .cache/history/<code hash>/days-<d>/ from web/public/py/history.json.
//
// When ready it prints one line, `READY <port> <startup ms>`. Control actions
// (docs/v4-interfaces.md §8) are read from stdin, one JSON object a line:
// {"action": "restart-server"}; each is answered on stdout with `STATE <json>`.
// While the server is down a request gets no answer: the socket is closed,
// a network failure (FR-49).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
}

const port = Number(arg('port', '8765'));
const seed = Number(arg('seed', '1'));
let historyDir = arg('history', null);
if (!historyDir) {
  const h = JSON.parse(readFileSync(join(root, 'web', 'public', 'py', 'history.json'), 'utf8'));
  historyDir = join(root, '.cache', 'history', h.code_hash, `days-${h.days}`);
}
const seedDir = join(resolve(historyDir), `seed-${seed}`);

const t0 = performance.now();
const bundle = await build({
  entryPoints: [join(root, 'web', 'src', 'standin', 'index.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'error',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tBundle = performance.now();

const manifest = JSON.parse(readFileSync(join(seedDir, 'manifest.json'), 'utf8'));
const history = await mod.loadHistory(manifest, async (name) => new Uint8Array(gunzipSync(readFileSync(join(seedDir, `${name}.gz`)))));
const tLoad = performance.now();
const rt = mod.createStandin(seed, history, () => performance.now() / 1000);
const tReady = performance.now();
if (process.argv.includes('--play')) rt.control('play');

setInterval(() => {
  try {
    rt.tick();
    rt.tap.drain(); // nobody draws them here
  } catch (e) {
    console.error(e);
  }
}, 100);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
    let r;
    try {
      r = rt.handle({ method: req.method, path: u.pathname, query: u.search.slice(1), body,
        headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
        rootPath: '', origin: u.origin });
    } catch (e) {
      r = { status: 500, headers: [['content-type', 'application/json']], body: new TextEncoder().encode(JSON.stringify({ code: 'InternalError', description: String(e) })) };
    }
    if (r === null) {
      req.socket.destroy(); // no answer at all: the server is down
      return;
    }
    res.writeHead(r.status, r.headers.flat());
    res.end(Buffer.from(r.body));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.error(`stand-in: bundle ${(tBundle - t0).toFixed(0)} ms, history ${(tLoad - tBundle).toFixed(0)} ms, `
    + `index and model catch-up ${(tReady - tLoad).toFixed(0)} ms (${manifest.days} days, seed ${seed})`);
  console.log(`READY ${port} ${(tReady - t0).toFixed(0)}`);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    const { action, arg: a } = JSON.parse(line);
    console.log(`STATE ${JSON.stringify(rt.control(action, a))}`);
  } catch (e) {
    console.log(`ERROR ${String(e)}`);
  }
});
