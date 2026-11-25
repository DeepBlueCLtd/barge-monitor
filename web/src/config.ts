// Every URL is relative (FR-04): the display client knows only API_BASE.
export const API_BASE = 'api/';
// Pyodide is published once at the site root and shared by every preview (decision log
// D-34); the path to it is relative.
export const SHARED_PATH: string = import.meta.env.VITE_SHARED_PATH ?? '../';
export const PYODIDE_PATH = SHARED_PATH + 'pyodide/0.29.5/';
/** The data folder the build ships (FR-15, NFR-06): `index.json` and one `<file>.gz` per CSV file. */
export const DATA_FOLDER = 'data/folder/';
export const PY_ZIP = 'py/barge.zip';
/** The example model offered in an empty slot (FR-36), copied into the build from backend/models/. */
export const EXAMPLE_MODEL = 'py/example_new_model.py';
/** The core models, each in its own worker in the Python back end (FR-33, FR-34). */
export const CORE_MODELS = ['data-cleanse', 'summaries', 'analysis'] as const;
// NFR-10: start-up budget, measured by the e2e test.
export const STARTUP_BUDGET_MS = 30_000;
/** One hop of a captured message on the flowchart, in real milliseconds (FR-78; docs/v4-interfaces.md §4). */
export const HOP_MS = 900;
/**
 * A handshake hop: the display client sends each handshake request only when the reply to
 * the one before has been drawn arriving (decision log D-107), so its hops travel faster.
 */
export const HANDSHAKE_HOP_MS = 350;
/** FR-86: the replay rates offered. Each is capped by the slowest model's bound, which the replay controller enforces. */
export const RATES = [0.1, 0.5, 1, 10, 100];
/** FR-63: the display client polls once per real second while playing. */
export const POLL_MS = 1000;
/** FR-99: the display client locks after this long without input (5 minutes; to be confirmed, SRD §15). */
export const IDLE_LOCK_MS = 5 * 60_000;
/** FR-124: how long the adoption opening's merge takes (about 1.5 s; immediate with reduced motion). */
export const OPENING_MERGE_MS = 1500;

export function resolve(rel: string): string {
  return new URL(rel, document.baseURI).toString();
}

/** URL parameters (docs/v4-interfaces.md §13.6): ?backend=python|standin, ?sketch=off, ?hand-made. */
export function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
