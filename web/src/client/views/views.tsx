// The display client's views (§8.3, FR-57 to FR-62), as ECharts charts (FR-80,
// D-121): a line plot, a line plot with error bars (minimum, mean and maximum from
// the summaries), a heat map and a cluster view. Each follows the current field and
// period selection, up to the client's replay time (FR-63b). A field the client knows
// nothing about is drawn by its SWE Common type alone (FR-62): a Quantity as a line, a
// Count as steps, a Boolean as steps of 0 and 1, a Category as points on a band of its
// values. There is no measurement-specific code here. A view that depends on a model
// still preparing the dataset says so (FR-35b), and shows its latest complete run.
import { ReactNode, useMemo } from 'react';
import { Diamond } from '../../shell/Diamond';
import { useStore } from '../../shell/store';
import type { Property, Source } from '../fields';
import { DisplayClientSession, Opened, Row } from '../session';
import { AXIS, EChart, EChartsOption, ms, SERIES, timeLabel } from './chart';

export const CLUSTER_COLOURS = ['#3653d4', '#e8890c', '#0f766e', '#9b3fd9', '#d43d51', '#3d8c40', '#8d5524', '#5c677d'];

export function ViewFrame({ title, sub, children, testid, preparing = [] }: { title: string; sub: ReactNode; children: ReactNode; testid: string; preparing?: Preparing[] }) {
  return (
    <section className="dc-view" data-testid={testid} aria-label={title}>
      <header>
        <h4>{title}</h4>
        <p>{sub}</p>
      </header>
      <Diamond className="view-diamond" size={18} />
      {preparing.length > 0 && (
        <p className="dc-preparing" data-testid="preparing" aria-live="polite">
          Results being prepared: {preparing.map((p) => `${p.label}${p.pct != null ? ` ${p.pct} %` : ''}`).join(', ')}.
        </p>
      )}
      {children}
    </section>
  );
}

type Preparing = { label: string; pct: number | null; system: string };

/** The models still preparing what a view reads (FR-35b), by the systems of its sources and their subsystems. */
function usePreparing(session: DisplayClientSession, systems: string[]): Preparing[] {
  useStore(session.runs);
  useStore(session.view);
  return session.preparing().filter((p) => systems.some((u) => u === p.system || u.startsWith(`${p.system}:`)));
}

/** FR-45, FR-56: a view never appears empty without saying why. */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="dc-empty">{children}</div>;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (u: string | null) => (u && u !== '1' ? ` ${u}` : '');
const fmt = (v: unknown) => (isNum(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v ?? '–'));

interface Line {
  prop: Property;
  src: Source;
  rows: Row[];
}

function useLines(session: DisplayClientSession): { lines: Line[]; window: [number, number] | null } {
  useStore(session.data);
  useStore(session.selection);
  useStore(session.clock.state);
  const lines = session.inUse().filter((u) => u.use === 'line').map((u) => ({ prop: u.prop, src: u.src, rows: session.rows(u.src) }));
  return { lines, window: session.window() };
}

function timeAxis(w: [number, number]) {
  const span = Math.max(1, w[1] - w[0]);
  return {
    type: 'time', min: ms(w[0]), max: ms(w[1]), axisLabel: { ...AXIS, hideOverlap: true, formatter: (v: number) => timeLabel(v, span) },
    splitLine: { show: false },
  };
}

/** A field's values as numbers to plot, by its type alone (FR-62). */
function plotValues(l: Line): { data: [number, number | null][]; categories: string[] | null; step: boolean } {
  const f = l.src.field;
  if (f.type === 'Category') {
    const cats = [...new Set(l.rows.map((r) => String(r[f.name] ?? '')).filter(Boolean))].sort();
    return { data: l.rows.map((r) => [ms(r.t), r[f.name] == null ? null : cats.indexOf(String(r[f.name]))]), categories: cats, step: true };
  }
  if (f.type === 'Boolean') return { data: l.rows.map((r) => [ms(r.t), r[f.name] == null ? null : r[f.name] ? 1 : 0]), categories: ['false', 'true'], step: true };
  return { data: l.rows.map((r) => [ms(r.t), isNum(r[f.name]) ? (r[f.name] as number) : null]), categories: null, step: f.type === 'Count' };
}

/** FR-57: the selected fields over the period; one axis when they share a unit, otherwise each scaled to its own range. */
export function LineView({ session }: { session: DisplayClientSession }) {
  const { lines, window: w } = useLines(session);
  const preparing = usePreparing(session, lines.filter((l) => l.src.ds.fromModel).map((l) => l.src.ds.systemUid));
  const units = new Set(lines.map((l) => l.prop.uom ?? '?'));
  const shared = units.size === 1 && lines.every((l) => l.src.field.type === 'Quantity' || l.src.field.type === 'Count');
  const option = useMemo<EChartsOption | null>(() => {
    if (!w || !lines.length) return null;
    const series = lines.map((l, i) => {
      const pv = plotValues(l);
      let data = pv.data;
      if (!shared) {
        const vals = data.map((d) => d[1]).filter(isNum);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        data = data.map(([t, v]) => [t, v == null ? null : hi > lo ? (v - lo) / (hi - lo) : 0.5]);
      }
      return {
        name: l.prop.label, type: pv.categories && l.src.field.type === 'Category' ? 'scatter' : 'line', data, step: pv.step ? 'end' : undefined,
        showSymbol: false, symbolSize: 4, connectNulls: false, lineStyle: { width: 1.4 }, color: SERIES[i % SERIES.length],
        raw: pv.data,
      };
    });
    return {
      grid: { left: 52, right: 14, top: 26, bottom: 26 },
      legend: { top: 0, textStyle: { ...AXIS, fontSize: 12 }, itemHeight: 8 },
      // Each line's own reading and unit, not the 0 to 1 it is drawn at when the units differ.
      tooltip: {
        trigger: 'axis',
        formatter: (ps: any) => {
          const list = (Array.isArray(ps) ? ps : [ps]) as any[];
          if (!list.length) return '';
          const head = new Date(list[0].axisValue).toISOString().slice(0, 19).replace('T', ' ');
          return [head, ...list.map((p) => {
            const l = lines[p.seriesIndex];
            const v = (series[p.seriesIndex].raw as [number, unknown][])[p.dataIndex]?.[1];
            return `${p.marker}${l.prop.label} <b>${fmt(v)}</b>${unit(l.prop.uom)}`;
          })].join('<br/>');
        },
      },
      xAxis: timeAxis(w),
      yAxis: { type: 'value', scale: true, name: shared ? [...units][0] : '', nameTextStyle: AXIS, axisLabel: AXIS },
      series,
    } as EChartsOption;
  }, [lines, w, shared]);
  return (
    <ViewFrame preparing={preparing} title="Line" sub={lines.length ? lines.map((l) => `${l.prop.label}${unit(l.prop.uom)}`).join(', ') + (shared ? '' : ' · each scaled to its own range') : 'No field selected'} testid="view-line">
      {!option ? <Empty>No field is selected. Choose one above.</Empty>
 : lines.every((l) => !l.rows.length) ? <Empty>{preparing.length ? 'Results being prepared.' : 'No readings in this period yet.'}</Empty>
          : <EChart option={option} testid="chart-line" extra={{ 'data-points': String(lines.reduce((n, l) => n + l.rows.length, 0)) }} />}
    </ViewFrame>
  );
}

/** FR-58: minimum, mean and maximum per interval, from the summary datastreams (FR-29). */
export function ErrorBarView({ session }: { session: DisplayClientSession }) {
  useStore(session.data);
  useStore(session.selection);
  useStore(session.clock.state);
  const w = session.window();
  const u = session.inUse().find((x) => x.use === 'stats' && x.prop.type === 'Quantity');
  const preparing = usePreparing(session, u ? [u.src.ds.systemUid] : session.awaitedSystems('graphs'));
  const rows = u ? session.rows(u.src) : [];
  const option = useMemo<EChartsOption | null>(() => {
    if (!u || !w || !rows.length) return null;
    const f = u.src.field.name;
    const uom = u.prop.uom ?? null;
    const bars = rows.filter((r) => isNum(r[`${f}_min`]) && isNum(r[`${f}_max`])).map((r) => [ms(r.t), r[`${f}_min`], r[`${f}_max`]]);
    return {
      grid: { left: 52, right: 14, top: 12, bottom: 26 },
      tooltip: {
        trigger: 'axis',
        formatter: (ps: any) => {
          const list = (Array.isArray(ps) ? ps : [ps]) as any[];
          if (!list.length) return '';
          const u = unit(uom);
          const head = new Date(list[0].axisValue).toISOString().slice(0, 19).replace('T', ' ');
          return [head, ...list.map((p) => p.seriesIndex === 0
            ? `${p.marker}minimum to maximum <b>${fmt(p.value[1])} to ${fmt(p.value[2])}</b>${u}`
            : `${p.marker}mean <b>${fmt(p.value[1])}</b>${u}`)].join('<br/>');
        },
      },
      xAxis: timeAxis(w),
      yAxis: { type: 'value', scale: true, name: u.prop.uom ?? '', nameTextStyle: AXIS, axisLabel: AXIS },
      series: [
        {
          name: 'minimum to maximum', type: 'custom', data: bars, encode: { x: 0, y: [1, 2] },
          renderItem: (_: unknown, api: any) => {
            const lo = api.coord([api.value(0), api.value(1)]);
            const hi = api.coord([api.value(0), api.value(2)]);
            // A bar with caps, so one interval (early in a replay) is still plain to see.
            const cap = 5, st = { stroke: '#64748b', lineWidth: 1.6 };
            return { type: 'group', children: [
              { type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style: st },
              { type: 'line', shape: { x1: lo[0] - cap, y1: lo[1], x2: lo[0] + cap, y2: lo[1] }, style: st },
              { type: 'line', shape: { x1: hi[0] - cap, y1: hi[1], x2: hi[0] + cap, y2: hi[1] }, style: st },
            ] };
          },
        },
        { name: 'mean', type: 'line', showSymbol: true, symbolSize: 5, data: rows.map((r) => [ms(r.t), isNum(r[f]) ? r[f] : null]), color: SERIES[0], lineStyle: { width: 1.6 } },
      ],
    } as EChartsOption;
  }, [u, w, rows]);
  return (
    <ViewFrame preparing={preparing} title="Line with error bars" sub={u ? `${u.prop.label}: minimum, mean and maximum per ${u.res === 'PT1H' ? 'hour' : 'minute'}` : 'Minimum, mean and maximum'} testid="view-errorbars">
      {!session.selection.value.fields.length ? <Empty>No field is selected.</Empty>
        : !u ? <Empty>{preparing.length ? 'Results being prepared: error bars come from the models’ summaries.' : 'No summary of the selected fields: error bars come from the models’ summaries.'}</Empty>
          : !option ? <Empty>{preparing.length ? 'Results being prepared.' : 'No summaries in this period yet.'}</Empty>
            : <EChart option={option} testid="chart-errorbars" />}
    </ViewFrame>
  );
}

/** FR-59: each selected field as a row of time bins, coloured by its value within its own range. */
export function HeatmapView({ session }: { session: DisplayClientSession }) {
  const { lines, window: w } = useLines(session);
  const numeric = lines.filter((l) => l.src.field.type !== 'Category' && l.src.field.type !== 'Text');
  const option = useMemo<EChartsOption | null>(() => {
    if (!w || !numeric.length || numeric.every((l) => !l.rows.length)) return null;
    const BINS = 48;
    const step = Math.max(1, (w[1] - w[0]) / BINS);
    const data: [number, number, number | null][] = [];
    numeric.forEach((l, row) => {
      const sums = new Array(BINS).fill(0), ns = new Array(BINS).fill(0);
      for (const r of l.rows) {
        const v = plotValues({ ...l, rows: [r] }).data[0][1];
        if (!isNum(v)) continue;
        const b = Math.min(BINS - 1, Math.floor((r.t - w[0]) / step));
        sums[b] += v;
        ns[b]++;
      }
      const means = sums.map((s, i) => (ns[i] ? s / ns[i] : null));
      const vals = means.filter(isNum);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      means.forEach((m, i) => data.push([i, row, m == null ? null : hi > lo ? (m - lo) / (hi - lo) : 0.5]));
    });
    return {
      grid: { left: 140, right: 14, top: 8, bottom: 26 },
      tooltip: { formatter: (p: any) => `${numeric[p.value[1]].prop.label}<br/>${new Date(ms(w[0] + p.value[0] * step)).toISOString().slice(11, 19)}` },
      xAxis: { type: 'category', data: Array.from({ length: BINS }, (_, i) => timeLabel(ms(w[0] + i * step), w[1] - w[0])), axisLabel: { ...AXIS, hideOverlap: true } },
      yAxis: { type: 'category', data: numeric.map((l) => l.prop.label), axisLabel: { ...AXIS, fontSize: 12, width: 130, overflow: 'truncate' } },
      visualMap: { min: 0, max: 1, show: false, inRange: { color: ['#dbeafe', '#3b82f6', '#1e3a8a'] } },
      series: [{ type: 'heatmap', data }],
    } as EChartsOption;
  }, [numeric, w]);
  return (
    <ViewFrame title="Heat map" sub="Each field across the period, darker where higher in its own range" testid="view-heatmap">
      {!lines.length ? <Empty>No field is selected.</Empty> : !option ? <Empty>No readings in this period yet.</Empty> : <EChart option={option} testid="chart-heatmap" />}
    </ViewFrame>
  );
}

/** FR-60: the latest Analysis run's clusters over time, with its detected changes (FR-35). */
export function ClusterView({ session }: { session: DisplayClientSession }) {
  const a = useStore(session.analysis);
  const d = useStore(session.discovery);
  const v = useStore(session.view);
  useStore(session.clock.state);
  const now = session.window()?.[1] ?? null;
  const out = (d?.profile?.essentials.find((e) => e.views?.includes('clusters') && e.field === 'cluster')?.datastream ?? 'clusters').split('__')[0];
  const preparing = usePreparing(session, (v?.results.get(out) ?? []).map((x) => x.systemUid).concat(session.awaitedSystems('clusters')));
  const option = useMemo<EChartsOption | null>(() => {
    if (!a || !a.clusters.length) return null;
    const cats = [...new Set(a.clusters.map((r) => String(r.cluster)))].sort();
    // Each assignment holds until the next one, the last until the replay time: a bar, not a lone dot.
    const until = Math.min(a.end, Math.max(now ?? a.end, a.clusters[a.clusters.length - 1].t));
    const spans = a.clusters.map((r, i) => [ms(r.t), ms(i + 1 < a.clusters.length ? a.clusters[i + 1].t : until), cats.indexOf(String(r.cluster))]);
    const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
    return {
      grid: { left: 52, right: 14, top: 12, bottom: 26 },
      tooltip: { trigger: 'item', confine: true, formatter: (p: any) => p.seriesName === 'changes' ? '' : `${p.marker}${cats[p.value[2]]}: ${hhmm(p.value[0])} to ${hhmm(p.value[1])}` },
      xAxis: timeAxis([a.start, a.end]),
      yAxis: { type: 'category', data: cats, axisLabel: AXIS },
      series: [
        {
          name: 'clusters', type: 'custom', data: spans, encode: { x: [0, 1], y: 2 },
          renderItem: (_: unknown, api: any) => {
            const s0 = api.coord([api.value(0), api.value(2)]);
            const s1 = api.coord([api.value(1), api.value(2)]);
            const h = Math.max(6, api.size([0, 1])[1] * 0.5);
            return { type: 'rect', shape: { x: s0[0], y: s0[1] - h / 2, width: Math.max(3, s1[0] - s0[0]), height: h },
              style: { fill: CLUSTER_COLOURS[api.value(2) % CLUSTER_COLOURS.length] } };
          },
        },
        {
          name: 'changes', type: 'scatter', data: [], markLine: {
            symbol: 'none', silent: true, lineStyle: { color: '#be123c', type: 'dashed' },
            data: a.changes.map((r) => ({ xAxis: ms(r.t) })),
          },
        },
      ],
    } as EChartsOption;
  }, [a, now]);
  return (
    <ViewFrame preparing={preparing} title="Clusters" sub={a ? `Run ${a.runId}${a.algorithm ? ` · algorithm ${a.algorithm}` : ''} · ${a.changes.length} change${a.changes.length === 1 ? '' : 's'} marked` : 'The latest Analysis run on this dataset'} testid="view-clusters">
      {!option ? <Empty>{preparing.length ? 'Results being prepared.' : a ? 'No clusters up to the replay time yet.' : 'No complete Analysis run on this dataset yet.'}</Empty>
        : <EChart option={option} testid="chart-clusters" extra={{ 'data-run': a!.runId }} />}
    </ViewFrame>
  );
}

/** FR-106, FR-107: an opened record, or two compared on elapsed time. */
export function OpenedView({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  const compare = opened.kind === 'compare';
  const option = useMemo<EChartsOption>(() => {
    const series = opened.records.flatMap((rec, ri) => rec.series.map((s, si) => ({
      name: compare ? `${rec.item.record.label} · ${s.label}` : s.label, type: 'line', showSymbol: false, lineStyle: { width: 1.4, type: ri ? 'dashed' : 'solid' },
      color: SERIES[(ri * 3 + si) % SERIES.length],
      data: s.rows.map((r) => [compare ? r.t : ms(r.t), isNum(r.v) ? r.v : null]),
    })));
    return {
      grid: { left: 52, right: 14, top: 28, bottom: 34 },
      legend: { top: 0, textStyle: { ...AXIS, fontSize: 12 } },
      tooltip: { trigger: 'axis', valueFormatter: (v: unknown) => fmt(v) },
      xAxis: compare
        ? { type: 'value', name: 'elapsed', nameLocation: 'middle', nameGap: 20, nameTextStyle: AXIS, axisLabel: { ...AXIS, formatter: (v: number) => elapsed(v) } }
        : { type: 'time', axisLabel: { ...AXIS, hideOverlap: true } },
      yAxis: { type: 'value', scale: true, axisLabel: AXIS },
      series,
    } as EChartsOption;
  }, [opened, compare]);
  const r0 = opened.records[0].item.record;
  return (
    <section className="dc-opened" data-testid={compare ? 'doi-compare' : 'doi-opened'} data-checksum={opened.checksum}>
      <header>
        <h4>{compare ? 'Compared on elapsed time' : `Favourite: ${r0.label}`}</h4>
        <p data-testid="opened-what">{opened.records.map((r) => `${r.item.record.label}: ${r.item.record.dataset.file}, ${r.item.record.start} to ${r.item.record.end} at ${r.item.record.resolution}`).join(' · ')}
          {compare ? ` · each from its own start, at ${opened.res}, labelled elapsed: never simultaneous` : ''}</p>
        <button className="dc-btn small" onClick={onClose} data-testid="doi-close">Close</button>
      </header>
      <EChart option={option} testid={compare ? 'chart-compare' : 'chart-opened'} />
    </section>
  );
}

function elapsed(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

