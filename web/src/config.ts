// Client configuration. Every URL is relative (FR-04): pointing the display
// at a real EDR server is a change of API_BASE alone.
export const API_BASE = 'api/';
export const WORKSPACE_BASE = 'ws/';
export const PYODIDE_PATH: string = import.meta.env.VITE_PYODIDE_PATH ?? '../pyodide/0.29.5/';
export const PY_ZIP = 'py/barge.zip';
export const POLL_MS = 1000; // FR-35: polling at 1 Hz, a recorded placeholder for live delivery
// Startup budget (NFR-08): measured by the end-to-end test and shown on the page.
export const STARTUP_BUDGET_MS = 60000;

export function resolve(rel: string): string {
  return new URL(rel, document.baseURI).toString();
}
