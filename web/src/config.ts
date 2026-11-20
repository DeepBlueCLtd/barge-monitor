// Every URL is relative (FR-04): the display client knows only API_BASE.
export const API_BASE = 'api/';
// Pyodide and the pre-built history are published once at the site root and
// shared by every preview (decision log D-34); the path to them is relative.
export const SHARED_PATH: string = import.meta.env.VITE_SHARED_PATH ?? '../';
export const PYODIDE_PATH = SHARED_PATH + 'pyodide/0.29.5/';
export const HISTORY_PATH = SHARED_PATH + 'history/';
export const PY_ZIP = 'py/barge.zip';
/** The example model offered in an empty slot (FR-36), copied into the build from backend/models/. */
export const EXAMPLE_MODEL = 'py/example_model_c.py';
/** The core models, each in its own worker in the Python back end (FR-33, FR-34). */
export const CORE_MODELS = ['data-cleanse', 'model-a', 'model-b'] as const;
// NFR-10: start-up budget, measured by the e2e test.
export const STARTUP_BUDGET_MS = 30_000;
// Each hop of a captured message takes this long on the flowchart, in simulated seconds.
export const HOP_S = 0.8;
/** Speeds offered (FR-78): ½× is the default; there is no faster mode than 1×. */
export const RATES = [0.25, 0.5, 1];
export const DEFAULT_RATE = 0.5;

export function resolve(rel: string): string {
  return new URL(rel, document.baseURI).toString();
}

/** URL parameters (docs/v4-interfaces.md §8): ?backend=python|standin, ?seed=N, ?sketch=off. */
export function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
