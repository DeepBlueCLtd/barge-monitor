// Every URL is relative (FR-04): the display client knows only API_BASE.
export const API_BASE = 'api/';
// Pyodide and the pre-built history are published once at the site root and
// shared by every preview (decision log D-34); the path to them is relative.
export const SHARED_PATH: string = import.meta.env.VITE_SHARED_PATH ?? '../';
export const PYODIDE_PATH = SHARED_PATH + 'pyodide/0.29.5/';
export const HISTORY_PATH = SHARED_PATH + 'history/';
export const PY_ZIP = 'py/barge.zip';
// NFR-09: start-up budget including four-week pre-generation, measured by the e2e test.
export const STARTUP_BUDGET_MS = 20_000;
// Each hop of a captured message takes this long on the flowchart, in simulated seconds.
export const HOP_S = 0.35;
// The live charts keep this much history, in simulated seconds.
export const LIVE_WINDOW_S = 2 * 3600;

export function resolve(rel: string): string {
  return new URL(rel, document.baseURI).toString();
}
