// The JavaScript stand-in back end (SRD §2.3, FR-06a..FR-06h): the CSV
// importer, replay controller, data server stand-in, access gateway and core
// models, behind the same seam as the Python back end. Demonstrator
// scaffolding only. Entry points shared by the stand-in worker
// (web/src/workers/standin.worker.ts) and the Node harness
// (web/scripts/standin-server.mjs).
import type { Folder } from './folder';
import { Progress, Runtime } from './runtime';

export type { HttpRequest, HttpResponse } from './api';
export type { Captured } from './tap';
export type { Folder, FolderEntry } from './folder';
export { fetchFolder } from './folder';
export { Runtime } from './runtime';
export type { Progress } from './runtime';

/** Start the stand-in over a data folder: the server, the importer, Mission A imported silently, the replay at its start. */
export async function createStandin(folder: Folder, progress?: (p: Progress) => void, silentImport = true): Promise<Runtime> {
  const rt = new Runtime(folder);
  await rt.boot(progress, silentImport);
  rt.tap.drain(); // nothing drawn from before the flowchart appears
  return rt;
}
