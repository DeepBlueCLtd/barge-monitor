// The seam, shown working: the contract suite run from the workspace worker
// through the Service Worker (the browser half of AT-02), and the facade's
// index dropped and rebuilt from the store (AT-07).
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Seam } from '../seam';

let id = 1000;

export function SeamPanel({ seam, startupMs }: { seam: Seam; startupMs: number | null }) {
  const [results, setResults] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState<string | null>(null);

  useEffect(() => seam.onWorkspace((m) => {
    if (m.type === 'contract') {
      setBusy(false);
      if (m.error) setErr(m.error);
      else setResults(m.results);
    }
  }), [seam]);

  function runSuite() {
    seam.startWorkspace();
    setBusy(true);
    setErr(null);
    setResults(null);
    seam.workspace?.postMessage({ type: 'contract', id: ++id });
  }

  async function rebuild() {
    const route = (await api.get<any>('sim/canal')).centreline;
    const coords = `LINESTRING(${route.lon.map((x: number, i: number) => `${x} ${route.lat[i]}`).join(',')})`;
    const clock = await api.get<any>('sim/clock');
    const from = new Date(Date.parse(clock.now) - 6 * 3600 * 1000).toISOString().replace('.000Z', 'Z');
    const q = { coords, datetime: `${from}/${clock.now}`, 'parameter-name': 'air_temperature' };
    const t0 = performance.now();
    const before = JSON.stringify(await api.get('collections/stern/trajectory', q).catch((e) => String(e)));
    const t1 = performance.now();
    await fetch('api/sim/index', { method: 'DELETE' });
    const t2 = performance.now();
    const after = JSON.stringify(await api.get('collections/stern/trajectory', q).catch((e) => String(e)));
    const t3 = performance.now();
    setIndex(`${before === after ? 'Identical' : 'DIFFERENT'} results. Query with the index: ${(t1 - t0).toFixed(0)} ms; after dropping it, rebuilt from the store: ${(t3 - t2).toFixed(0)} ms.`);
  }

  const counts = results && ['passed', 'failed', 'skipped'].map((k) => `${results.filter((r) => r.outcome === k).length} ${k}`).join(', ');
  return (
    <div className="seam">
      <h2>The seam</h2>
      <p>Every request from the display and from the workspace is HTTP to a relative URL. The Service Worker hands it to the
        backend worker, which calls the ASGI application exactly as an ordinary ASGI server would. The same application and the same
        contract suite run under uvicorn in CPython in continuous integration.</p>
      <p><a href="api/" target="_blank" rel="noreferrer">Open the EDR landing page</a> · <a href="api/collections" target="_blank" rel="noreferrer">collections</a> · <a href="api/conformance" target="_blank" rel="noreferrer">conformance</a> · <a href="api/api" target="_blank" rel="noreferrer">OpenAPI</a></p>
      <button onClick={runSuite} disabled={busy}>{busy ? 'Running the contract suite in the workspace…' : 'Run the contract suite here (AT-02)'}</button>
      {err && <p className="error">{err}</p>}
      {results && (
        <>
          <p data-testid="contract-summary">{counts}</p>
          <table className="results">
            <tbody>
              {results.map((r) => (
                <tr key={r.test} className={r.outcome}><td>{r.outcome}</td><th>{r.test}</th><td>{r.detail ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3>The facade's index</h3>
      <p>The facade builds its own index over the logger's files; the store itself is never altered. Drop the index and it is rebuilt from the store.</p>
      <button onClick={rebuild}>Drop the index and query again (AT-07)</button>
      {index && <p data-testid="index-result">{index}</p>}
      <h3>Start-up</h3>
      <p>{startupMs != null ? `This visit: the backend was ready ${(startupMs / 1000).toFixed(1)} s after the page started loading.` : 'Measuring…'}</p>
    </div>
  );
}
