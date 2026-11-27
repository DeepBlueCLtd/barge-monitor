// Declared budgets (NFR-10, decision log D-340), measured by e2e/hardening.spec.ts in each back end.
// Kept apart from config.ts so that the end-to-end tests, which run in Node, can import them.

/**
 * NFR-10 (and NFR-05): from navigation until every startup step is done, the models included, from a cold cache.
 * In this build the step "models" is done when each core model is live, Mission A processed (D-340).
 */
export const STARTUP_BUDGET_MS = 30_000;
/**
 * NFR-10: what a cold start downloads, every file of the page and its workers, in each back end. The Python back
 * end loads Pyodide, numpy, FastAPI and, for Analysis, scikit-learn and SciPy, in four workers (D-340).
 */
export const DOWNLOAD_BUDGET_BYTES = { standin: 5_000_000, python: 100_000_000 } as const;
/**
 * NFR-10 ("the data folder's files are part of the build"): the data folder the site ships (FR-15), its four CSV
 * files gzipped, with the index and the manifest. It replaces the 4.6 history files (about 39 MB a seed, D-34).
 */
export const DATA_FOLDER_BUDGET_BYTES = 8_000_000;
