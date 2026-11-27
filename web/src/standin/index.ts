// The JavaScript stand-in back end (SRD §2.3, FR-06a..FR-06h): a TypeScript
// implementation of the CSV importer, data server and core models, behind
// the same seam as the Python back end. Demonstrator scaffolding only: it has
// no counterpart in a developed system. Entry points shared by the stand-in
// worker (web/src/workers/standin.worker.ts) and the Node harness that runs
// the contract suite against it (web/scripts/standin-server.mjs, AT-24).
import type { Folder } from './folder';
import { Progress, Runtime } from './runtime';

export type { HttpRequest, HttpResponse } from './api';
export type { Captured } from './tap';
export { DEMO_PASSWORDS } from './accounts';
export { Runtime } from './runtime';
export type { Progress } from './runtime';
export type { Folder, FolderEntry } from './folder';
export { fetchFolder } from './folder';

/**
 * Start the stand-in over a data folder: start the CSV importer (which imports Mission A silently, FR-15), let the
 * models register and subscribe, ready to serve. The 4.1 pre-calculated history is retired (D-320).
 */
export async function createStandin(folder?: Folder, progress?: (p: Progress) => void, holdS?: number): Promise<Runtime> {
  const rt = new Runtime(folder);
  if (holdS !== undefined) rt.holdS = holdS;
  await rt.catchUp(progress);
  return rt;
}
