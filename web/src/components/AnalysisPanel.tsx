// Analysis outputs (FR-33) with controls drawn from the service's own
// statement of what it accepts (FR-34). The display holds no bounds.
import { useEffect, useState } from 'react';
import { api, Collection, Coverage, HttpError, times } from '../api';
import { CoverageView } from './CoverageView';
import { Scatter } from './Scatter';

export const ANALYSES = [
  ['analysis-derived', 'Derived values'],
  ['analysis-changes', 'Detected changes'],
  ['analysis-clusters', 'Clusters'],
  ['analysis-correlation', 'Correlation matrix'],
  ['analysis-reach-offsets', 'Reach offsets from revisits'],
] as const;

type Schema = { properties: Record<string, any> };

interface Props {
  route: string;
  results: Record<string, Coverage | string>;
  setResults: (r: Record<string, Coverage | string>) => void;
}

export function AnalysisPanel({ route, results, setResults }: Props) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Collection>('collections/analysis-derived').then((c) => {
      const s = (c as any)['barge:analysis_parameters'] as Schema;
      setSchema(s);
      const v: Record<string, any> = {};
      Object.entries(s.properties).forEach(([k, d]) => {
        if (d.default !== undefined) v[k] = d.default;
      });
      v['parameter-name'] = [];
      setValues(v);
    });
  }, []);

  async function run() {
    setError(null);
    const out: Record<string, Coverage | string> = {};
    for (const [cid, title] of ANALYSES) {
      setBusy(title);
      const params: Record<string, string> = { coords: route };
      Object.entries(values).forEach(([k, v]) => {
        if (Array.isArray(v)) {
          if (v.length && (cid === 'analysis-correlation' || cid === 'analysis-clusters')) params[k] = v.join(',');
        } else if (v !== '' && v !== undefined) params[k] = String(v);
      });
      try {
        out[cid] = await api.get<Coverage>(`collections/${cid}/trajectory`, params);
      } catch (e) {
        out[cid] = e instanceof HttpError ? `${e.status}: ${e.body.description}` : String(e);
        if (e instanceof HttpError && e.status === 400) setError(e.body.description);
      }
      setResults({ ...results, ...out });
    }
    setBusy(null);
  }

  const derived = results['analysis-derived'];
  return (
    <div className="analysis">
      <form className="controls" onSubmit={(e) => { e.preventDefault(); run(); }}>
        {schema ? (
          Object.entries(schema.properties).map(([k, d]) => (
            <label key={k}>
              <span>{k}</span>
              {d.enum ? (
                <select value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                  {d.enum.map((o: string) => <option key={o}>{o}</option>)}
                </select>
              ) : d.type === 'array' ? (
                <span className="checks">
                  {d.items.enum.map((o: string) => (
                    <label key={o} className="check">
                      <input type="checkbox" checked={values[k]?.includes(o)}
                        onChange={(e) => setValues({ ...values, [k]: e.target.checked ? [...(values[k] ?? []), o] : values[k].filter((x: string) => x !== o) })} />
                      {o}
                    </label>
                  ))}
                  <small>(none ticked: the service's default set)</small>
                </span>
              ) : (
                <input type="number" value={values[k] ?? ''} step={d.type === 'integer' ? 1 : 'any'}
                  onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
              )}
              {d.minimum !== undefined && <small>{d.minimum} – {d.maximum}</small>}
            </label>
          ))
        ) : (
          <p>Reading what the analysis service accepts…</p>
        )}
        <button type="submit" disabled={!!busy || !schema}>{busy ? `Computing: ${busy}…` : 'Run analysis'}</button>
        <small className="hint">Bounds come from the service. Try an out-of-range value: the service refuses it and names the bound.</small>
      </form>
      {error && <p className="error" role="alert">Refused by the service: {error}</p>}
      {ANALYSES.map(([cid, title]) => {
        const r = results[cid];
        if (!r) return null;
        if (typeof r === 'string') return <p key={cid} className="error">{title}: {r}</p>;
        return (
          <div key={cid}>
            <CoverageView cov={r} title={title} syncKey="analysis" />
            {cid === 'analysis-derived' && typeof derived !== 'string' && derived && times(derived).length > 0 && <Scatter cov={derived} />}
          </div>
        );
      })}
    </div>
  );
}
