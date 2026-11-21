// The display client's views (§8.3, FR-57..FR-62). Each is a framed component
// with a value-add diamond (FR-76). They follow the current field and period
// selection (FR-61). A field the client has no specific knowledge of is drawn
// by its SWE Common type alone (FR-62): a Quantity as a line, an angular
// Quantity as points, a Category as a coloured band, a Count as steps. There is
// no measurement-specific code here.
import { ReactNode, useMemo } from 'react';
import { Diamond } from '../../shell/Diamond';
import { simClock } from '../../shell/clock';
import { periodOf, Property } from '../plan';
import type { ClientSession, Row } from '../session';
import { AXIS, EChart, EChartsOption, ms, SERIES, timeLabel } from './chart';

export const CLUSTER_COLOURS = ['#3653d4', '#e8890c', '#0f766e', '#9b3fd9', '#d43d51', '#3d8c40', '#8d5524', '#5c677d'];
const BAND_COLOURS = ['#7c9cf5', '#f5b36b', '#6cc3b5', '#c39bf0', '#f08a9a', '#9bd37a', '#d1a77a', '#a3abb8'];

export function ViewFrame({ title, sub, children, testid, className = '' }: { title: string; sub: ReactNode; children: ReactNode; testid: string; className?: string }) {
  return (
    <section className={`dc-view ${className}`} data-testid={testid} aria-label={title}>
      <header>
        <h4>{title}</h4>
        <p>{sub}</p>
      </header>
      <Diamond className="view-diamond" size={18} />
      {children}
    </section>
  );
}

/** FR-45, FR-56: a view never appears empty without saying why. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="dc-empty" role="note">{children}</div>;
}

interface Point {
  t: number;
  v: any;
}

function points(session: ClientSession, p: Property): Point[] {
  const s = session.series(p);
  if (!s) return [];
  const out: Point[] = [];
  for (const r of s.rows) out.push({ t: r._t, v: r[s.field.name] });
  return out;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function range(pts: Point[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) if (isNum(p.v)) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

const unit = (p: Property) => (p.uom && p.uom !== '1' ? ` ${p.uom}` : '');
const fmt = (v: unknown) => (isNum(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v ?? '–'));

/** Consecutive equal categories merged into runs, for coloured bands. */
function runs(pts: Point[], t1: number): { a: number; b: number; v: string }[] {
  const out: { a: number; b: number; v: string }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i].v == null ? '' : String(pts[i].v);
    const b = i + 1 < pts.length ? pts[i + 1].t : Math.max(t1, pts[i].t);
    const last = out[out.length - 1];
    if (last && last.v === v) last.b = b;
    else out.push({ a: pts[i].t, b, v });
  }
  return out.filter((r) => r.v !== '');
}

function windowOf(session: ClientSession): [number, number] {
  const t1 = simClock.now();
  return [t1 - periodOf(session.selection.value.period).seconds, t1];
}

/** FR-57: the selected fields overlaid on a normalised scale, real values on hover, changes marked on the time axis. */
export function LinePlot({ session, props, changesNote }: { session: ClientSession; props: Property[]; changesNote: string | null }) {
  const version = session.version.value;
  const option = useMemo<EChartsOption>(() => {
    const [t0, t1] = windowOf(session);
    const span = t1 - t0;
    const bands = props.filter((p) => p.kind === 'band');
    const series: any[] = [];
    props.forEach((p, i) => {
      const pts = points(session, p);
      const colour = SERIES[i % SERIES.length];
      if (p.kind === 'band') {
        const lane = bands.indexOf(p);
        const cats = [...new Set(pts.map((x) => String(x.v ?? '')).filter(Boolean))].sort();
        series.push({
          type: 'custom', name: p.label, renderItem: (_: any, api: any) => {
            const a = api.coord([api.value(0), -lane * 0.16 - 0.03]);
            const b = api.coord([api.value(1), -(lane + 1) * 0.16 + 0.01]);
            return { type: 'rect', shape: { x: a[0], y: a[1], width: Math.max(1, b[0] - a[0]), height: b[1] - a[1] }, style: { fill: BAND_COLOURS[api.value(2) % BAND_COLOURS.length] } };
          },
          encode: { x: [0, 1] }, data: runs(pts, t1).map((r) => [ms(r.a), ms(r.b), cats.indexOf(r.v), r.v]),
          tooltip: { trigger: 'item', formatter: (q: any) => `${p.label}: ${q.value[3]}` },
        });
        return;
      }
      const [lo, hi] = p.kind === 'angle' ? [0, 360] : range(pts);
      const k = hi > lo ? 1 / (hi - lo) : 1;
      const data = pts.map((x) => [ms(x.t), isNum(x.v) ? (x.v - lo) * k : null, x.v]);
      if (p.kind === 'angle') series.push({ type: 'scatter', name: p.label, data, symbolSize: 3, itemStyle: { color: colour } });
      else series.push({ type: 'line', name: p.label, data, showSymbol: false, step: p.kind === 'steps' ? 'end' : undefined, sampling: 'lttb',
        lineStyle: { width: 1.6, color: colour }, itemStyle: { color: colour }, connectNulls: false });
    });
    // Detected changes from the latest run, marked on the time axis (FR-57).
    const marks = changesNote ? [] : session.changes.filter((c) => c._t >= t0 && c._t <= t1).map((c) => ({ xAxis: ms(c._t) }));
    series.push({ type: 'line', name: 'changes', data: [], markLine: { symbol: 'none', silent: true, label: { show: false },
      lineStyle: { type: 'dashed', color: '#6b7280', width: 1 }, data: marks } });
    return {
      grid: { left: 8, right: 10, top: 8, bottom: 22, containLabel: false },
      xAxis: { type: 'time', min: ms(t0), max: ms(t1), axisLabel: { ...AXIS, formatter: (v: number) => timeLabel(v, span), hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', min: -0.16 * bands.length - 0.02, max: 1.04, show: false },
      tooltip: { trigger: 'axis', confine: true, textStyle: { fontSize: 12 }, formatter: (ps: any[]) => {
        if (!ps.length) return '';
        const head = timeLabel(ps[0].value?.[0] ?? ps[0].axisValue, 1);
        return [head, ...ps.filter((q) => q.seriesName !== 'changes' && q.value?.[2] !== undefined).map((q) => {
          const p = props.find((x) => x.label === q.seriesName);
          return `${q.marker}${q.seriesName}: ${fmt(q.value[2])}${p ? unit(p) : ''}`;
        })].join('<br/>');
      } },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, props, changesNote, session]);
  return <EChart option={option} height={150} testid="chart-line" />;
}

/** FR-58: the first selected field as means with ± 1 standard deviation over intervals suited to the period. */
export function ErrorBars({ session, p }: { session: ClientSession; p: Property }) {
  const version = session.version.value;
  const option = useMemo<EChartsOption>(() => {
    const [t0, t1] = windowOf(session);
    const binS = periodOf(session.selection.value.period).binS;
    const pts = points(session, p);
    const n = Math.ceil((t1 - t0) / binS);
    const sums = Array.from({ length: n }, () => ({ s: 0, ss: 0, k: 0 }));
    for (const x of pts) {
      if (!isNum(x.v)) continue;
      const i = Math.floor((x.t - t0) / binS);
      if (i < 0 || i >= n) continue;
      sums[i].s += x.v;
      sums[i].ss += x.v * x.v;
      sums[i].k++;
    }
    const bars = sums.map((b, i) => {
      if (!b.k) return null;
      const mean = b.s / b.k;
      const sd = Math.sqrt(Math.max(0, b.ss / b.k - mean * mean));
      return [ms(t0 + (i + 0.5) * binS), mean, mean - sd, mean + sd];
    }).filter((x): x is number[] => !!x);
    return {
      grid: { left: 36, right: 10, top: 10, bottom: 22 },
      xAxis: { type: 'time', min: ms(t0), max: ms(t1), axisLabel: { ...AXIS, formatter: (v: number) => timeLabel(v, t1 - t0), hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, axisLabel: AXIS, splitLine: { lineStyle: { color: '#eceae4' } } },
      tooltip: { trigger: 'item', confine: true, formatter: (q: any) => `${timeLabel(q.value[0], 1)}: ${fmt(q.value[1])} ± ${fmt((q.value[3] - q.value[2]) / 2)}${unit(p)}` },
      series: [
        { type: 'custom', renderItem: (_: any, api: any) => {
          const top = api.coord([api.value(0), api.value(3)]);
          const bot = api.coord([api.value(0), api.value(2)]);
          const w = 4;
          return { type: 'group', children: [
            { type: 'line', shape: { x1: top[0], y1: top[1], x2: bot[0], y2: bot[1] }, style: { stroke: '#1f2937', lineWidth: 1.2 } },
            { type: 'line', shape: { x1: top[0] - w, y1: top[1], x2: top[0] + w, y2: top[1] }, style: { stroke: '#1f2937', lineWidth: 1.2 } },
            { type: 'line', shape: { x1: bot[0] - w, y1: bot[1], x2: bot[0] + w, y2: bot[1] }, style: { stroke: '#1f2937', lineWidth: 1.2 } },
          ] };
        }, encode: { x: 0, y: [2, 3] }, data: bars, z: 1 },
        { type: 'line', data: bars, symbolSize: 5, lineStyle: { color: SERIES[0], width: 1.6 }, itemStyle: { color: SERIES[0] }, z: 2 },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, p, session]);
  return <EChart option={option} height={150} testid="chart-errorbars" />;
}

/** FR-59: the selected fields (rows) against time (columns), each row normalised. */
export function HeatMap({ session, props }: { session: ClientSession; props: Property[] }) {
  const version = session.version.value;
  const option = useMemo<EChartsOption>(() => {
    const [t0, t1] = windowOf(session);
    const cols = 24;
    const w = (t1 - t0) / cols;
    const data: [number, number, number | null, string][] = [];
    props.forEach((p, row) => {
      const pts = points(session, p);
      const cats = p.kind === 'band' ? [...new Set(pts.map((x) => String(x.v ?? '')).filter(Boolean))].sort() : [];
      const acc = Array.from({ length: cols }, () => ({ s: 0, k: 0, counts: new Map<string, number>() }));
      for (const x of pts) {
        const i = Math.floor((x.t - t0) / w);
        if (i < 0 || i >= cols || x.v == null) continue;
        if (p.kind === 'band') acc[i].counts.set(String(x.v), (acc[i].counts.get(String(x.v)) ?? 0) + 1);
        else if (isNum(x.v)) {
          acc[i].s += x.v;
          acc[i].k++;
        }
      }
      const vals = acc.map((a) => {
        if (p.kind === 'band') {
          const top = [...a.counts.entries()].sort((m, n) => n[1] - m[1])[0];
          return top ? cats.indexOf(top[0]) : null;
        }
        return a.k ? a.s / a.k : null;
      });
      const nums = vals.filter(isNum);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      vals.forEach((v, i) => data.push([i, row, isNum(v) ? (hi > lo ? (v - lo) / (hi - lo) : 0.5) : null, isNum(v) ? (p.kind === 'band' ? cats[v] : `${fmt(v)}${unit(p)}`) : 'no data']));
    });
    return {
      grid: { left: 4, right: 4, top: 4, bottom: 4, containLabel: false },
      xAxis: { type: 'category', data: Array.from({ length: cols }, (_, i) => i), show: false },
      yAxis: { type: 'category', data: props.map((p) => p.label), show: false, inverse: true },
      visualMap: { show: false, min: 0, max: 1, dimension: 2, inRange: { color: ['#2b4c9b', '#9fb3df', '#f3f1ec', '#e8a68f', '#b5452d'] } },
      tooltip: { trigger: 'item', confine: true, formatter: (q: any) => `${props[q.value[1]]?.label}: ${q.value[3]}` },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: '#fff', borderWidth: 1 } }],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, props, session]);
  return <EChart option={option} height={150} testid="chart-heatmap" />;
}

/** FR-60: cluster assignments as a band along the time axis, a legend, the algorithm and fields used, and the score. */
export function ClusterBand({ session, labelOf }: { session: ClientSession; labelOf: (name: string) => string }) {
  const run = session.run.value;
  const rows: Row[] = session.clusters;
  const sel = session.selection.value;
  if (!run || !rows.length) return <Empty>Waiting for Analysis's first clustering run on this selection…</Empty>;
  const pts = rows.map((r) => ({ t: r._t, v: r.cluster }));
  const t0 = run.window_start ? Date.parse(run.window_start) : ms(pts[0].t);
  const t1 = run.window_end ? Date.parse(run.window_end) : ms(pts[pts.length - 1].t);
  const segs = runs(pts, (t1 / 1000) - (ms(0) / 1000));
  const names = [...new Set(pts.map((p) => String(p.v)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const fields = String(run.fields ?? '').split(',').filter(Boolean).map(labelOf).join(', ');
  const current = run.algorithm === sel.algorithm && run.period === sel.period;
  const span = Math.max(1, t1 - t0);
  return (
    <div className="cluster-body">
      <div className="cluster-head">
        <span data-testid="cluster-caption">Clusters · on {fields || 'the selected fields'} · Algorithm {run.algorithm ?? '?'}</span>
        <span className="score" data-testid="cluster-score">score against ground truth{' '}
          <b>{typeof run.score_clusters === 'number' ? run.score_clusters.toFixed(2) : 'not scored'}</b>
          {run.illustrative ? ' (illustrative)' : ''}</span>
      </div>
      <svg className="cluster-band" viewBox="0 0 1000 26" preserveAspectRatio="none" role="img" aria-label="Cluster assignments along time">
        {segs.map((s, i) => {
          const x = ((ms(s.a) - t0) / span) * 1000;
          const w = ((ms(s.b) - ms(s.a)) / span) * 1000;
          return <rect key={i} x={x} y={0} width={Math.max(0.5, w)} height={26} fill={CLUSTER_COLOURS[Math.max(0, names.indexOf(s.v)) % CLUSTER_COLOURS.length]} />;
        })}
      </svg>
      <div className="cluster-legend">
        {names.map((n, i) => (
          <span key={n}><i style={{ background: CLUSTER_COLOURS[i % CLUSTER_COLOURS.length] }} />Cluster {n.replace(/^c/, '')}</span>
        ))}
        {!current && <span className="note">updating: a run for the current selection has been requested</span>}
      </div>
    </div>
  );
}
