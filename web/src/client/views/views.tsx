// Views, as plain text readouts: the latest value of each source, how many
// records the client holds, and which readings were flagged. No charts: the
// demonstrator's subject is the flowchart, and charts cost too much on slow
// machines (decision D-53). Specific readouts show essential sources
// (FR-55..FR-59); the generic readout shows any other field by its SWE Common
// type alone (FR-61, FR-62).
import type { Field } from '../handshake';
import { Row } from '../data';

const unitOf = (f: Field) => f.uom?.code ?? '';
const ANGULAR = new Set(['deg', 'rad', '°']);
const time = (r?: Row) => (r ? r.time.replace('T', ' ').replace(/\.\d+/, '').replace('Z', '') : '—');
const num = (v: unknown, digits = 1) => (typeof v === 'number' ? v.toFixed(digits) : v == null ? '—' : String(v));
// QARTOD: '1' is pass; anything else present is a flag.
const flagged = (rows: Row[], field: string) => rows.filter((r) => r[`${field}_qc`] && r[`${field}_qc`] !== '1').length;

/** One row of a readout table: a source, its latest value, how many records and flags. */
export function Reading({ label, rows, field, unit, digits, testid }: { label: string; rows: Row[]; field: string; unit?: string; digits?: number; testid?: string }) {
  const last = rows[rows.length - 1];
  const flags = flagged(rows, field);
  return (
    <tr data-testid={testid}>
      <th>{label}</th>
      <td className="value">{num(last?.[field], digits)}{unit && last ? ` ${unit}` : ''}</td>
      <td className="mono">{time(last)}</td>
      <td className="mono">{rows.length.toLocaleString()}{flags ? <span className="flags" title="QC-flagged readings"> · {flags} flagged</span> : null}</td>
    </tr>
  );
}

export function ReadoutTable({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return (
    <table className="readouts" data-testid={testid}>
      <thead><tr><th>Source</th><th>Latest</th><th>At</th><th>Records</th></tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** The correlation matrix as numbers (FR-58). */
export function CorrelationTable({ names, matrix, subtitle, testid }: { names: string[]; matrix: (number | null)[][]; subtitle: string; testid?: string }) {
  return (
    <div data-testid={testid}>
      <p className="hint">{subtitle}</p>
      <table className="matrix">
        <thead><tr><th />{names.map((n) => <th key={n} title={n}>{n.replace(/_/g, ' ')}</th>)}</tr></thead>
        <tbody>
          {names.map((n, i) => (
            <tr key={n}><th>{n.replace(/_/g, ' ')}</th>
              {names.map((_, j) => { const v = matrix[i]?.[j]; return <td key={j} className={v == null ? '' : Math.abs(v) >= 0.6 ? 'strong' : ''}>{num(v, 2)}</td>; })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The kind of readout a field gets from its schema type alone (FR-61). */
export function kindOf(field: Field): 'quantity' | 'angle' | 'count' | 'category' | 'other' {
  if (field.type === 'Quantity') return ANGULAR.has(unitOf(field)) ? 'angle' : 'quantity';
  if (field.type === 'Count') return 'count';
  if (field.type === 'Category') return 'category';
  return 'other';
}

/** FR-61: any other field, shown by schema type alone. */
export function GenericView({ title, field, rows }: { title: string; field: Field; rows: Row[] }) {
  const kind = kindOf(field);
  const last = rows[rows.length - 1];
  const v = last?.[field.name];
  const value = kind === 'quantity' ? `${num(v, 2)} ${last ? unitOf(field) : ''}`
    : kind === 'angle' ? `${num(v, 0)}°`
    : kind === 'count' ? num(v, 0)
    : kind === 'category' ? (v ?? '—')
    : v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <tr className="gview" data-view={kind} data-field={field.name} data-testid={`field-${field.name}`}>
      <th>{field.label ?? field.name}<small> · {title}</small></th>
      <td className="value">{String(value)}</td>
      <td className="mono">{time(last)}</td>
      <td className="mono">{rows.length.toLocaleString()} <small>{kind}</small></td>
    </tr>
  );
}
