#!/usr/bin/env node
// The JavaScript stand-in back end in Node, behind a tiny HTTP server, so the
// one contract suite can run against it as it runs against the Python back
// end under uvicorn (PR-04, AT-24). It bundles web/src/standin with esbuild
// (in memory), reads the data folder from a local directory, and
// serves the stand-in's HTTP interface at the root of the given port; the
// server's internal endpoint (§9.2, D-223) is /api-internal beside it.
//
// Usage: node web/scripts/standin-server.mjs [--port N] [--folder DIR] [--hold S]
//   --hold S: how long a command's POST is held, in seconds (§9.1; 5 by default).
//   --folder DIR: the data folder the CSV importer reads (index.json and <file>.gz, as
//   scripts/build_data_folder.py writes it); by default web/public/data/folder, when built.
//   Each file is read when the importer asks for it, so a file changed there is seen on rescan.
//
// When ready it prints one line, `READY <port> <startup ms>`. Control actions
// (docs/v4-interfaces.md §13.3) are read from stdin, one JSON object a line:
// {"action": "restart-server"}; each is answered on stdout with `STATE <json>`.
// While the server is starting or down a request gets no answer: the socket is
// closed, a network failure (§9.1). A push subscription (§9.2) is a chunked
// response that stays open.
import { existsSync, readFileSync } from 'node:fs';
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
const hold = arg('hold', null);
const folderDir = resolve(arg('folder', join(root, 'web', 'public', 'data', 'folder')));
// The folder as a directory: its listing, and each CSV, gzipped or plain (FR-17a: nothing here writes).
const folder = existsSync(join(folderDir, 'index.json')) ? {
  async list() {
    return JSON.parse(readFileSync(join(folderDir, 'index.json'), 'utf8')).files;
  },
  async read(file) {
    const gz = join(folderDir, `${file}.gz`);
    return new Uint8Array(existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(join(folderDir, file)));
  },
} : undefined;

const t0 = performance.now();
const bundle = await build({
  entryPoints: [join(root, 'web', 'src', 'standin', 'index.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'error',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const tBundle = performance.now();

const rt = await mod.createStandin(folder, undefined, hold === null ? undefined : Number(hold));
const tReady = performance.now();

setInterval(() => {
  try {
    rt.tick();
    rt.tap.drain(); // nobody draws them here
  } catch (e) {
    console.error(e);
  }
}, 100);

async function answer(req, res, body) {
  const u = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
  let r;
  try {
    r = await rt.handle({ method: req.method, path: u.pathname, query: u.search.slice(1), body,
      headers: Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
      rootPath: '', origin: u.origin });
  } catch (e) {
    r = { status: 500, headers: [['content-type', 'text/html']], body: new TextEncoder().encode(`<!doctype html><title>500</title><p>${String(e)}</p>`) };
  }
  if (r === null) {
    req.socket.destroy(); // no answer at all: the server is starting or down
    return;
  }
  if (r.stream) { // a push subscription: chunked, open until the server stops or the client goes
    const stream = r.stream;
    res.writeHead(r.status, r.headers.flat());
    res.flushHeaders();
    res.on('close', () => stream.cancel());
    stream.attach({ chunk: (b) => res.write(Buffer.from(b)), end: () => res.end() });
    return;
  }
  res.writeHead(r.status, r.headers.flat());
  res.end(Buffer.from(r.body));
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => void answer(req, res, chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null));
});

server.listen(port, '127.0.0.1', () => {
  console.error(`stand-in: bundle ${(tBundle - t0).toFixed(0)} ms, import and models ${(tReady - tBundle).toFixed(0)} ms`);
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
