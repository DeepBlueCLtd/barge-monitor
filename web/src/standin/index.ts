// The JavaScript stand-in back end (SRD §2.3, FR-06a..FR-06h): a TypeScript
// implementation of the store adapter, data server and core models, behind
// the same seam as the Python back end. Demonstrator scaffolding only: it has
// no counterpart in a developed system. Entry points shared by the stand-in
// worker (web/src/workers/standin.worker.ts) and the Node harness that runs
// the contract suite against it (web/scripts/standin-server.mjs, AT-24).
import { History, HistoryManifest, Progress, Runtime } from './runtime';

export type { HttpRequest, HttpResponse } from './api';
export type { Captured } from './tap';
export { DEMO_PASSWORDS } from './accounts';
export { Runtime } from './runtime';
export type { History, HistoryManifest, Progress } from './runtime';

/**
 * Load the pre-calculated history (FR-15, FR-06d): the same files the Python
 * back end loads, in the store's own format. `readFile` returns one file's
 * decompressed bytes; files are read `parallel` at a time.
 */
export async function loadHistory(manifest: HistoryManifest, readFile: (name: string) => Promise<Uint8Array>,
  progress?: (p: Progress) => void, parallel = 8): Promise<History> {
  const files = new Map<string, Uint8Array>();
  const total = manifest.files.reduce((a, f) => a + f.gz, 0) || 1;
  let got = 0;
  const queue = [...manifest.files];
  const workers = Array.from({ length: parallel }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      files.set(f.name, await readFile(f.name));
      got += f.gz;
      progress?.({ stage: 'history', detail: `loading pre-calculated history: ${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`,
        pct: 10 + Math.round((80 * got) / total) });
    }
  });
  await Promise.all(workers);
  return { manifest, files };
}

/** Start the stand-in over a loaded history: build the index, catch the models up, ready to serve. */
export async function createStandin(seed: number, history: History, hostSeconds: () => number, progress?: (p: Progress) => void,
  holdS?: number): Promise<Runtime> {
  progress?.({ stage: 'store', detail: 'loading the history into the logger store', pct: 90 });
  const rt = new Runtime(seed, history, hostSeconds);
  if (holdS !== undefined) rt.holdS = holdS;
  await rt.catchUp(progress);
  return rt;
}
