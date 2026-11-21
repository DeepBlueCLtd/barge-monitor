// Shared by the Pyodide workers (back end and models): load the runtime from the site itself (NFR-07).
export type PyodideAPI = any;

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

export async function loadRuntime(pyodideUrl: string, pyZipUrl: string, packages: string[], post: (p: Progress) => void): Promise<PyodideAPI> {
  post({ stage: 'runtime', detail: 'loading the Python runtime (Pyodide)', pct: 2 });
  const mod = await import(/* @vite-ignore */ pyodideUrl + 'pyodide.mjs');
  const py = await mod.loadPyodide({ indexURL: pyodideUrl });
  post({ stage: 'packages', detail: `loading ${packages.join(', ')}`, pct: 8 });
  await py.loadPackage(packages, { messageCallback: () => {} });
  const r = await fetch(pyZipUrl);
  if (!r.ok) throw new Error(`could not fetch ${pyZipUrl}: ${r.status}`);
  py.unpackArchive(await r.arrayBuffer(), 'zip', { extractDir: '/home/pyodide' });
  py.runPython(`import sys\nfor p in ('/home/pyodide', '/home/pyodide/models'):\n    p in sys.path or sys.path.insert(0, p)`);
  return py;
}
