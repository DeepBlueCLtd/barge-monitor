// Generic rendering of any coverage in the promotion contract's shape
// (FR-25, FR-29). Nothing here knows which analysis produced a coverage.
import { categories, Coverage, isCategorical, label, times, unit } from '../api';
import { CATEGORY_COLOURS, ramp } from './CanalMap';
import { TimeChart } from './TimeChart';

export function flatten(obj: unknown, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix} › ${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
      else if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) {
        v.forEach((x, i) => out.push(...flatten(x, `${key} › ${(x as any)?.reach ?? (x as any)?.id ?? i}`)));
      } else out.push([key, fmt(v)]);
    }
  }
  return out;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toPrecision(3);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function MetaTable({ meta }: { meta: any }) {
  if (!meta) return null;
  const rows = flatten({ parameters: meta.parameters, data: meta.data_range, scores: meta.scores });
  return (
    <details className="meta" open={!!meta.scores && rows.length < 40}>
      <summary>Parameters, data range and scores against the manifest</summary>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {meta.method && <p className="method">{meta.method}</p>}
    </details>
  );
}

export function CoverageView({ cov, title, syncKey, xRange, onZoom, onCursor }: {
  cov: Coverage;
  title: string;
  syncKey?: string;
  xRange?: [number, number] | null;
  onZoom?: (r: [number, number] | null) => void;
  onCursor?: (t: number | null) => void;
}) {
  const meta = (cov as any)['barge:analysis'];
  const axes = cov.domain.axes as Record<string, { values: unknown[] }>;
  let body: JSX.Element;
  if (cov.domain.domainType === 'Trajectory') {
    const t = times(cov);
    body = (
      <>
        {Object.keys(cov.ranges).map((name) => {
          const vals = cov.ranges[name].values as (number | null)[];
          if (isCategorical(cov, name)) {
            const cats = categories(cov, name);
            const used = Array.from(new Set(vals.filter((v): v is number => v != null))).sort((a, b) => a - b);
            return (
              <TimeChart key={name} title={`${label(cov, name)}`} t={t} height={90} syncKey={syncKey} xRange={xRange} onZoom={onZoom} onCursor={onCursor}
                series={used.map((c) => ({ label: cats[c] ?? `c${c}`, color: CATEGORY_COLOURS[c % CATEGORY_COLOURS.length], points: true, values: vals.map((v) => (v === c ? c : null)) }))} />
            );
          }
          return (
            <TimeChart key={name} title={label(cov, name)} unit={unit(cov, name)} t={t} height={110} syncKey={syncKey} xRange={xRange} onZoom={onZoom} onCursor={onCursor}
              series={[{ label: name, values: vals, color: '#4e79a7', points: /direction|heading/.test(name) }]} />
          );
        })}
      </>
    );
  } else {
    const names = Object.keys(axes);
    if (names.length === 2) {
      const [rn, cn] = names;
      const rows = axes[rn].values as string[], cols = axes[cn].values as string[];
      body = (
        <>
          {Object.keys(cov.ranges).map((p) => {
            const v = cov.ranges[p].values as (number | null)[];
            return (
              <table key={p} className="heat">
                <caption>{label(cov, p)}</caption>
                <thead><tr><th />{cols.map((c) => <th key={c} className="rot"><span>{c}</span></th>)}</tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r}>
                      <th>{r}</th>
                      {cols.map((c, j) => {
                        const x = v[i * cols.length + j];
                        return <td key={c} style={{ background: x == null ? 'transparent' : ramp((x + 1) / 2), color: x != null && Math.abs(x) > 0.3 ? '#fff' : 'inherit' }}>{x == null ? '—' : x.toFixed(2)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })}
        </>
      );
    } else {
      const ax = names[0];
      const keys = axes[ax].values as string[];
      body = (
        <table className="grid1">
          <thead><tr><th>{ax}</th>{Object.keys(cov.ranges).map((p) => <th key={p}>{label(cov, p)}{unit(cov, p) ? ` (${unit(cov, p)})` : ''}</th>)}</tr></thead>
          <tbody>
            {keys.map((k, i) => (
              <tr key={k}><th>{k}</th>{Object.keys(cov.ranges).map((p) => <td key={p}>{fmt((cov.ranges[p].values as unknown[])[i])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
    }
  }
  return (
    <section className="coverage">
      <h3>{title}</h3>
      {body}
      <MetaTable meta={meta} />
    </section>
  );
}
