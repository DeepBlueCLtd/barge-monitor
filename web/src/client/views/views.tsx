// Views. Specific views draw essential sources (FR-55..FR-59); the generic
// view draws any other field by its SWE Common type alone (FR-61, FR-62).
import type { EChartsOption } from 'echarts';
import type { Field } from '../handshake';
import { Row } from '../data';
import { Chart, timeAxis } from './Chart';

const CAT = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#9c755f'];
const ms = (iso: string) => Date.parse(iso);
const unitOf = (f: Field) => f.uom?.code ?? '';
const ANGULAR = new Set(['deg', 'rad', '°']);

export interface Mark {
  time: string;
  label: string;
}

function marksSeries(marks: Mark[]): any {
  return {
    type: 'line', name: 'changes', data: [], silent: true,
    markLine: { symbol: 'none', label: { show: false }, lineStyle: { color: '#dc2626', type: 'dashed', width: 1.5 },
      data: marks.map((m) => ({ xAxis: ms(m.time), name: m.label })) },
  };
}

/** Bow and stern overlaid, with QC-flagged readings marked (FR-55). */
export function PairChart({ title, unit, bow, stern, field, marks, testid }: { title: string; unit: string; bow: Row[]; stern: Row[]; field: string; marks: Mark[]; testid?: string }) {
  const flagged = bow.filter((r) => r[`${field}_qc`] && r[`${field}_qc`] !== '1').map((r) => [ms(r.time), r[field]]);
  const option: EChartsOption = {
    ...timeAxis(),
    title: { text: `${title} (${unit})`, left: 8, top: 4, textStyle: { fontSize: 15 } },
    legend: { top: 4, right: 8, textStyle: { fontSize: 14 } },
    series: [
      { type: 'line', name: 'bow', showSymbol: false, data: bow.map((r) => [ms(r.time), r[field]]), lineStyle: { width: 1.5 }, color: '#e15759' },
      { type: 'line', name: 'stern', showSymbol: false, data: stern.map((r) => [ms(r.time), r[field]]), lineStyle: { width: 1.5 }, color: '#4e79a7' },
      { type: 'scatter', name: 'QC flagged (bow)', data: flagged, symbolSize: 7, color: '#f2b701' },
      marksSeries(marks),
    ],
  };
  return <Chart option={option} group="live" height={200} testid={testid} />;
}

export function LineChart({ title, unit, rows, field, marks, testid }: { title: string; unit: string; rows: Row[]; field: string; marks?: Mark[]; testid?: string }) {
  const option: EChartsOption = {
    ...timeAxis(),
    title: { text: `${title} (${unit})`, left: 8, top: 4, textStyle: { fontSize: 15 } },
    series: [{ type: 'line', name: title, showSymbol: false, data: rows.map((r) => [ms(r.time), r[field]]), color: '#59a14f' },
      ...(marks ? [marksSeries(marks)] : [])],
  };
  return <Chart option={option} group="live" height={180} testid={testid} />;
}

/** A coloured band along the time axis, legend from the allowed values. */
export function BandChart({ title, rows, field, tokens, testid }: { title: string; rows: Row[]; field: string; tokens: string[]; testid?: string }) {
  const option: EChartsOption = {
    ...timeAxis(),
    grid: { left: 64, right: 24, top: 34, bottom: 52 },
    title: { text: title, left: 8, top: 4, textStyle: { fontSize: 15 } },
    yAxis: { type: 'category', data: [''], axisLabel: { show: false } },
    legend: { bottom: 0, right: 8, textStyle: { fontSize: 13 }, data: tokens },
    series: tokens.map((tok, i) => ({
      type: 'scatter', name: tok, symbol: 'rect', symbolSize: [6, 28], color: CAT[i % CAT.length],
      data: rows.filter((r) => r[field] === tok).map((r) => [ms(r.time), '']),
    })),
  };
  return <Chart option={option} group="live" height={130} testid={testid} />;
}

export function Heatmap({ names, matrix, subtitle, testid }: { names: string[]; matrix: (number | null)[][]; subtitle: string; testid?: string }) {
  const data = matrix.flatMap((row, i) => row.map((v, j) => [j, i, v == null ? '-' : v]));
  const option: EChartsOption = {
    animation: false,
    title: { text: 'Correlation matrix', subtext: subtitle, left: 8, textStyle: { fontSize: 15 }, subtextStyle: { fontSize: 13 } },
    tooltip: { formatter: (p: any) => `${names[p.value[1]]} × ${names[p.value[0]]}: ${p.value[2]}` },
    grid: { left: 170, right: 70, top: 70, bottom: 140 },
    xAxis: { type: 'category', data: names, axisLabel: { rotate: 45, fontSize: 12 } },
    yAxis: { type: 'category', data: names, axisLabel: { fontSize: 12 } },
    visualMap: { min: -1, max: 1, calculable: true, orient: 'vertical', right: 0, top: 'middle', inRange: { color: ['#2166ac', '#f7f7f7', '#b2182b'] } },
    series: [{ type: 'heatmap', data, label: { show: names.length <= 8, fontSize: 12, formatter: (p: any) => (typeof p.value[2] === 'number' ? p.value[2].toFixed(2) : '–') } }],
  };
  return <Chart option={option} height={420} testid={testid} />;
}

/** FR-61: rendered by schema type alone. */
export function GenericView({ title, field, rows }: { title: string; field: Field; rows: Row[] }) {
  const unit = unitOf(field);
  const label = `${field.label ?? field.name}`;
  if (field.type === 'Quantity' && ANGULAR.has(unit)) {
    const option: EChartsOption = { ...timeAxis(), title: { text: `${label} (${unit})`, subtext: title, left: 8, textStyle: { fontSize: 14 } },
      yAxis: { type: 'value', min: 0, max: 360 },
      series: [{ type: 'scatter', name: label, symbolSize: 3, data: rows.map((r) => [ms(r.time), r[field.name]]), color: '#4e79a7' }] };
    return <Chart option={option} group="live" height={170} />;
  }
  if (field.type === 'Quantity') {
    const option: EChartsOption = { ...timeAxis(), title: { text: `${label} (${unit})`, subtext: title, left: 8, textStyle: { fontSize: 14 } },
      series: [{ type: 'line', name: label, showSymbol: rows.length < 50, data: rows.map((r) => [ms(r.time), r[field.name]]), color: '#4e79a7' }] };
    return <Chart option={option} group="live" height={170} />;
  }
  if (field.type === 'Count') {
    const option: EChartsOption = { ...timeAxis(), title: { text: label, subtext: title, left: 8, textStyle: { fontSize: 14 } },
      series: [{ type: 'line', step: 'end', name: label, showSymbol: false, data: rows.map((r) => [ms(r.time), r[field.name]]), color: '#76b7b2' }] };
    return <Chart option={option} group="live" height={170} />;
  }
  if (field.type === 'Category') {
    const tokens: string[] = field.constraint?.values ?? Array.from(new Set(rows.map((r) => r[field.name]).filter(Boolean)));
    return <BandChart title={`${label} · ${title}`} rows={rows} field={field.name} tokens={tokens} />;
  }
  const recent = rows.slice(-5).reverse();
  return (
    <div className="table-view">
      <div className="view-title">{label} <small>{title}</small></div>
      <table>
        <tbody>
          {recent.map((r, i) => (
            <tr key={i}><th>{r.time.replace('T', ' ').replace('Z', '')}</th><td>{typeof r[field.name] === 'object' ? JSON.stringify(r[field.name]) : String(r[field.name] ?? '—')}</td></tr>
          ))}
          {!recent.length && <tr><td>No values yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
