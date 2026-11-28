// Where the e2e tests find the assembled site (shared by playwright.config.ts and the specs).
//
// E2E_PORT serves the site at its root (the 4.1 suite). The next port serves the same
// site only under a pull request's published path, as GitHub Pages does, with the shared
// files at the site root above it (NFR-10a: the preview is tested on its published path).
export const PORT = Number(process.env.E2E_PORT ?? 8080);
export const SUB_PORT = PORT + 1;
export const PR_PATH = '/barge-monitor/pr/17/';
export const SUB_PREFIXES = `${PR_PATH},/barge-monitor/`;
export const SUB_ORIGIN = `http://localhost:${SUB_PORT}`;
/** The demonstrator under the sub-path, as in the preview link. */
export const SUB_DEMO = `${SUB_ORIGIN}${PR_PATH}demo/`;

/** The back ends the per-back-end suites run against. E2E_BACKENDS=standin skips the Python in Pyodide
 *  half (pull requests do this; pushes to main run both). hardening.spec.ts always runs both, as the
 *  Pyodide smoke test: cold start and the contract suite in the browser. */
export const BACKENDS = (process.env.E2E_BACKENDS ?? 'standin,python')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is 'standin' | 'python' => s === 'standin' || s === 'python');
