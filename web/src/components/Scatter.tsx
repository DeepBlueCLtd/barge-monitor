// A scatter of any two parameters of a trajectory coverage (FR-33).
import { useState } from 'react';
import { Coverage, label } from '../api';

export function Scatter({ cov }: { cov: Coverage }) {
  const names = Object.keys(cov.ranges);
  const [x, setX] = useState(names.includes('air_minus_water') ? 'air_minus_water' : names[0]);
  const [y, setY] = useState(names.includes('dew_point') ? 'dew_point' : names[1] ?? names[0]);
  const xs = cov.ranges[x]?.values as (number | null)[];
  const ys = cov.ranges[y]?.values as (number | null)[];
  const pts: [number, number][] = [];
  const step = Math.max(1, Math.floor(xs.length / 4000));
  for (let i = 0; i < xs.length; i += step) if (xs[i] != null && ys[i] != null) pts.push([xs[i] as number, ys[i] as number]);
  const W = 420, H = 300, pad = 40;
  const [x0, x1] = ext(pts.map((p) => p[0]));
  const [y0, y1] = ext(pts.map((p) => p[1]));
  const sx = (v: number) => pad + ((v - x0) / (x1 - x0 || 1)) * (W - pad - 10);
  const sy = (v: number) => H - pad - ((v - y0) / (y1 - y0 || 1)) * (H - pad - 10);
  return (
    <section className="coverage">
      <h3>Scatter</h3>
      <div className="row">
        <label>x <select value={x} onChange={(e) => setX(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select></label>
        <label>y <select value={y} onChange={(e) => setY(e.target.value)}>{names.map((n) => <option key={n}>{n}</option>)}</select></label>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img" aria-label={`Scatter of ${y} against ${x}`}>
        <line x1={pad} y1={H - pad} x2={W - 10} y2={H - pad} stroke="var(--muted)" />
        <line x1={pad} y1={10} x2={pad} y2={H - pad} stroke="var(--muted)" />
        {pts.map((p, i) => <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={1.6} fill="#4e79a7" opacity={0.5} />)}
        <text x={W / 2} y={H - 8} className="axis-label">{label(cov, x)}: {x0.toFixed(1)} … {x1.toFixed(1)}</text>
        <text x={12} y={H / 2} className="axis-label" transform={`rotate(-90 12 ${H / 2})`}>{label(cov, y)}: {y0.toFixed(1)} … {y1.toFixed(1)}</text>
      </svg>
    </section>
  );
}

function ext(v: number[]): [number, number] {
  if (!v.length) return [0, 1];
  let lo = Infinity, hi = -Infinity;
  v.forEach((x) => { lo = Math.min(lo, x); hi = Math.max(hi, x); });
  return [lo, hi];
}
