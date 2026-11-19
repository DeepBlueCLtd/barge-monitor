// Shared by both Pyodide workers: load the runtime from the site itself
// (NFR-06) and report progress honestly (FR-36).
export type PyodideAPI = any;

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
  ms?: number;
}

export interface SeamRequest {
  method: string;
  path: string;
  query: string;
  body: ArrayBuffer | null;
  headers: [string, string][];
  rootPath: string;
}

export async function loadRuntime(
  pyodideUrl: string,
  pyZipUrl: string,
  packages: string[],
  post: (p: Progress) => void,
): Promise<PyodideAPI> {
  post({ stage: 'runtime', detail: 'loading the Python runtime (Pyodide)', pct: 5 });
  const mod = await import(/* @vite-ignore */ pyodideUrl + 'pyodide.mjs');
  const py = await mod.loadPyodide({ indexURL: pyodideUrl });
  let done = 0;
  for (const p of packages) {
    post({ stage: 'packages', detail: `loading ${p}`, pct: 30 + Math.round((50 * done) / packages.length) });
    await py.loadPackage(p, { messageCallback: () => {} });
    done++;
  }
  post({ stage: 'code', detail: 'unpacking the backend source', pct: 82 });
  const r = await fetch(pyZipUrl);
  if (!r.ok) throw new Error(`could not fetch ${pyZipUrl}: ${r.status}`);
  py.unpackArchive(await r.arrayBuffer(), 'zip', { extractDir: '/home/pyodide' });
  py.runPython(`import sys\nif '/home/pyodide' not in sys.path: sys.path.insert(0, '/home/pyodide')`);
  return py;
}
