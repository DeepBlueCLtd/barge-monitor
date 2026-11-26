// Which back end the end-to-end tests run against (Phase 10: both back ends).
// E2E_BACKEND=python adds ?backend=python to every page the tests open; the default is
// the stand-in, the page's own default (FR-06b).
export const BACKEND: 'python' | 'standin' = process.env.E2E_BACKEND === 'python' ? 'python' : 'standin';

/** The URL with the back end's parameter added, for the Python back end only. */
export function withBackend(url: string): string {
  if (BACKEND !== 'python') return url;
  return url + (url.includes('?') ? '&' : '?') + 'backend=python';
}
