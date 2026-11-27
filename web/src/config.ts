// Every URL is relative (FR-04): the display client knows only API_BASE.
export const API_BASE = 'api/';
// Pyodide is published once at the site root and shared by every preview
// (decision log D-34); the path to it is relative.
export const SHARED_PATH: string = import.meta.env.VITE_SHARED_PATH ?? '../';
export const PYODIDE_PATH = SHARED_PATH + 'pyodide/0.29.5/';
export const PY_ZIP = 'py/barge.zip';
/** The example model offered in an empty slot (FR-36), copied into the build from backend/models/. */
export const EXAMPLE_MODEL = 'py/example_new_model.py';
/** The core models, each in its own worker in the Python back end (FR-33, FR-34). */
export const CORE_MODELS = ['data-cleanse', 'summaries', 'analysis'] as const;
// NFR-10: start-up budget, measured by the e2e test.
export const STARTUP_BUDGET_MS = 30_000;
// Each hop of a captured message takes this long on the flowchart, in real seconds (the drawing clock, D-302).
export const HOP_S = 1.2;
// The handshake's messages travel faster, because the display client sends each handshake
// request only when the reply to the one before has been drawn arriving (decision log D-89).
export const HANDSHAKE_HOP_S = 0.3;
/** The display client's replay rates (FR-86): no model bounds them. */
export const RATES = [0.1, 0.5, 1, 10, 100] as const;
export type Rate = (typeof RATES)[number];
/** FR-99: the display client locks after this long without input; `?idle=<seconds>` shortens it, for tests only (D-305). */
export const IDLE_LOCK_MS = (() => {
  const s = Number(urlParam('idle'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : 5 * 60_000;
})();
/** `?runpace=<ms>`, for tests only (D-355): the stand-in's models wait this long at each 10 % of a run, so a run lasts long
 * enough for a test to see "results being prepared" (in the stand-in a run otherwise takes about a second). */
export const RUN_PACE_MS = (() => {
  const s = Number(urlParam('runpace'));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 5000) : 0;
})();
/**
 * FR-124 (D-360): the adoption merge, in steps. The opening's lines fade and the Data server card appears (intro); the
 * subsystem cards then travel into it one at a time, each shrinking as it goes and ticking its row as it lands (each
 * starts a stagger after the one before and takes a travel); the other cards, the zones and the normal arrows then settle
 * into the normal layout. About six seconds in all (OPENING_MERGE_MS in shell/opening.ts); with reduced motion it is
 * immediate (AT-66).
 */
export const OPENING_MERGE = { intro: 700, stagger: 420, travel: 900, settle: 1500 } as const;
/** FR-63: while playing, the display client polls once a real second. */
export const POLL_MS = 1000;

export function resolve(rel: string): string {
  return new URL(rel, document.baseURI).toString();
}

/** URL parameters (docs/v4-interfaces.md §13.6): ?backend=python|standin, ?sketch=off, ?hand-made, and for tests ?folder=, ?idle= and ?runpace=. */
export function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** The seam relay's version, as public/sw.js answers it; the page waits until a relay of this version controls it (D-354). Change both together. */
export const RELAY_VERSION = '4.7-server-2';
