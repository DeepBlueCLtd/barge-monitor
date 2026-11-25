#!/usr/bin/env node
// The JavaScript stand-in back end in Node, behind a small HTTP server, so the
// server-neutral contract suite and standin-check.mjs can run against it as
// they run against the Python back end (PR-04, AT-24). It bundles
// web/src/standin with esbuild (in memory), reads the data folder from a local
// directory (read-only), and serves the stand-in's API at the root of the port,
// through the access gateway, exactly as the relay hands it requests.
// Push subscriptions stream over chunked HTTP.
//
// Usage: node web/scripts/standin-server.mjs [--port N] [--folder DIR] [--no-silent-import]
//   DIR holds the CSV files (*.csv or *.csv.gz) and optionally index.json; by default
//   web/public/data/folder, as scripts/build_data_folder.py writes it.
//
// Harness only (not part of the API): GET /demonstrator/harness -> {"version":"4.6"}.
// When ready it prints one line, `READY <port> <startup ms>`. Control actions
// (docs/v4-interfaces.md §13.3) are read from stdin, one JSON object a line,
// {"action": "restart-server", "arg": …}; each is answered on stdout with
// `STATE <json>`. Also POST /demonstrator/control with the same JSON (harness only).
// While the server is down or starting, a request gets no answer: the socket is
// closed, a network failure.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
const folderDir = resolve(arg('folder', join(root, 'web', 'public', 'data', 'folder')));
const silentImport = !process.argv.includes('--no-silent-import');

/** The data folder as a local directory: listed and read, never written (FR-17a). */
function localFolder(dir) {
  const cache = new Map(); // name -> {key, entry}
  const bytesOf = (name) => {
    const p = join(dir, name);
    if (existsSync(p)) return readFileSync(p);
    return gunzipSync(readFileSync(p + '.gz'));
  };
  return {
    async list() {
      let index = {};
      try {
        for (const e of JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).files ?? []) index[e.file] = e;
      } catch { /* no listing: every file is described from the directory */ }
      const names = new Set();
      for (const f of readdirSync(dir)) {
        if (/\.csv$/i.test(f)) names.add(f);
        else if (/\.csv\.gz$/i.test(f)) names.add(f.slice(0, -3));
      }
      const out = [];
      for (const name of [...names].sort()) {
        const p = existsSync(join(dir, name)) ? join(dir, name) : join(dir, name + '.gz');
        const st = statSync(p);
        const key = `${st.size}:${st.mtimeMs}`;
        let c = cache.get(name);
        if (!c || c.key !== key) {
          const b = bytesOf(name);
          const sha256 = createHash('sha256').update(b).digest('hex');
          const ix = index[name];
          const modified = ix && ix.sha256 === sha256 ? ix.modified : new Date(Math.floor(st.mtimeMs / 1000) * 1000).toISOString().replace('.000Z', 'Z');
          c = { key, entry: { file: name, size: b.length, modified, sha256 } };
          cache.set(name, c);
        }
        out.push(c.entry);
      }
      return out;
    },
    async read(name) {
      return new Uint8Array(bytesOf(name));
    },
  };
}

const t0 = performance.now();
const bundle = await build({
  entryPoints: [join(root, 'web', 'src', 'standin', 'index.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'error',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tBundle = performance.now();
const rt = await mod.createStandin(localFolder(folderDir), (p) => console.error(`stand-in: ${p.stage}: ${p.detail}`), silentImport);
const tReady = performance.now();

let last = performance.now();
setInterval(() => {
  try {
    const now = performance.now();
    rt.tick((now - last) / 1000);
    last = now;
    rt.tap.drain(); // nobody draws them here
  } catch (e) {
    console.error(e);
  }
}, 100);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const u = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    if (u.pathname === '/demonstrator/harness') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '4.6' }));
      return;
    }
    if (u.pathname === '/demonstrator/control' && req.method === 'POST') {
      try {
        const { action, arg: a } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const state = await rt.control(action, a);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(String(e));
      }
      return;
    }
    const body = chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null;
    let r;
    try {
      r = await rt.handle({ method: req.method, path: u.pathname, query: u.search.slice(1), body,
        headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
        rootPath: '', origin: u.origin });
    } catch (e) {
      r = { status: 500, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode(String(e)) };
    }
    if (r === null) {
      req.socket.destroy(); // no answer at all: the server is down or starting
      return;
    }
    if (r.stream) {
      res.writeHead(r.status, r.headers.flat());
      res.flushHeaders();
      const stream = r.stream;
      res.on('close', () => stream.cancel());
      stream.attach({ chunk: (b) => res.write(Buffer.from(b)), end: () => res.end() });
      return;
    }
    res.writeHead(r.status, r.headers.flat());
    res.end(Buffer.from(r.body));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.error(`stand-in: bundle ${(tBundle - t0).toFixed(0)} ms, start with the silent import ${(tReady - tBundle).toFixed(0)} ms; folder ${folderDir}`);
  console.log(`READY ${port} ${(tReady - t0).toFixed(0)}`);
});

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const { action, arg: a } = JSON.parse(line);
    console.log(`STATE ${JSON.stringify(await rt.control(action, a))}`);
  } catch (e) {
    console.log(`ERROR ${String(e)}`);
  }
});
