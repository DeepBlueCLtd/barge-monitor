// The CSV dialect (docs/v4-interfaces.md §5, FR-17). The importer is the only
// code that understands it (FR-20): a comment block, a `;`-separated header with
// the unit in brackets, a decimal comma, T_HS94 half-seconds since 1994, tenths
// of a degree, knots, -9999 and //// for missing, VRB for a variable wind.
import { KNOT, LOGGER_EPOCH_UNIX, Sensor } from './constants';

const CODES: Record<string, string> = {
  AT: 'air_temperature', RH: 'relative_humidity', PR: 'pressure', AWS: 'apparent_wind_speed',
  AWD: 'apparent_wind_direction', SR: 'solar_irradiance', WT: 'water_temperature', CO2: 'co2',
};
const SENSOR_OF: Record<string, Sensor> = { BOW: 'bow', STN: 'stern' };

export interface Column {
  name: string;
  sensor: Sensor;
  field: string;
  unit: string;
}

export interface Parsed {
  comments: string[];
  header: string;
  columns: Column[];
  ignored: string[];
  t: Float64Array; // Unix seconds
  values: Map<string, Float64Array>; // `${sensor}:${field}` -> values in the stored unit
  variable: Map<string, Uint8Array>; // `${sensor}:${field}` -> 1 where the reading was VRB
  firstRows: string[];
}

/** The multiplier from the bracketed unit to the stored one (§6: Cel, m/s, %, hPa, deg, W/m2, ppm). */
function scaleOf(unit: string): number {
  if (unit === 'dC') return 0.1;
  if (unit === 'kn') return KNOT;
  return 1;
}

const MISSING = NaN;

/** One cell: an integer or a decimal-comma number; -9999 and //// missing. */
function cell(s: string, a: number, b: number): number {
  let i = a;
  let neg = false;
  if (s.charCodeAt(i) === 45) {
    neg = true;
    i++;
  }
  let v = 0;
  let frac = 0;
  let div = 1;
  let any = false;
  for (; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      any = true;
      if (frac) {
        div *= 10;
        v += (c - 48) / div;
      } else v = v * 10 + (c - 48);
    } else if (c === 44 || c === 46) {
      if (frac) return MISSING;
      frac = 1;
    } else return MISSING; // VRB, ////, or anything unreadable
  }
  if (!any) return MISSING;
  if (neg) {
    if (v === 9999 && !frac) return MISSING;
    v = -v;
  }
  return v;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function parseCsv(bytes: Uint8Array): Parsed {
  const text = new TextDecoder('latin1').decode(bytes);
  let pos = 0;
  const nextLine = (): string | null => {
    if (pos >= text.length) return null;
    let e = text.indexOf('\n', pos);
    if (e < 0) e = text.length;
    const line = text.charCodeAt(e - 1) === 13 ? text.slice(pos, e - 1) : text.slice(pos, e);
    pos = e + 1;
    return line;
  };
  const comments: string[] = [];
  let header = '';
  for (let line = nextLine(); line !== null; line = nextLine()) {
    if (line.startsWith('#')) comments.push(line);
    else {
      header = line;
      break;
    }
  }
  const names = header.split(';');
  if (names[0] !== 'T_HS94') throw new Error(`the first column is ${names[0] || 'missing'}, not T_HS94`);
  const columns: (Column | null)[] = [null];
  const ignored: string[] = [];
  for (const n of names.slice(1)) {
    const m = /^([A-Z]+)_([A-Z0-9]+)\[([^\]]*)\]$/.exec(n);
    const sensor = m ? SENSOR_OF[m[1]] : undefined;
    const field = m ? CODES[m[2]] : undefined;
    if (!m || !sensor || !field) {
      ignored.push(n);
      columns.push(null);
    } else columns.push({ name: n, sensor, field, unit: m[3] });
  }
  // Count rows to size the arrays: every non-empty line after the header.
  const bodyStart = pos;
  let rows = 0;
  for (let i = bodyStart; i < text.length;) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = text.length;
    if (e - i > 1) rows++;
    i = e + 1;
  }
  const t = new Float64Array(rows);
  const cols = columns.map((c) => (c ? new Float64Array(rows) : null));
  const vrb = columns.map((c) => (c && c.field === 'apparent_wind_direction' ? new Uint8Array(rows) : null));
  const scales = columns.map((c) => (c ? scaleOf(c.unit) : 1));
  const firstRows: string[] = [];
  let r = 0;
  let i = bodyStart;
  while (i < text.length && r < rows) {
    let e = text.indexOf('\n', i);
    if (e < 0) e = text.length;
    let le = e;
    if (text.charCodeAt(le - 1) === 13) le--;
    if (le > i) {
      if (firstRows.length < 3) firstRows.push(text.slice(i, le));
      let a = i;
      for (let k = 0; k < columns.length; k++) {
        let b = text.indexOf(';', a);
        if (b < 0 || b > le) b = le;
        if (k === 0) t[r] = LOGGER_EPOCH_UNIX + cell(text, a, b) / 2;
        else {
          const out = cols[k];
          if (out) {
            const v = cell(text, a, b);
            out[r] = scales[k] === 1 ? v : round6(v * scales[k]);
            const vr = vrb[k];
            if (vr && b - a === 3 && text.startsWith('VRB', a)) vr[r] = 1;
          }
        }
        a = b + 1;
        if (a > le) {
          for (let kk = k + 1; kk < columns.length; kk++) if (cols[kk]) cols[kk]![r] = MISSING;
          break;
        }
      }
      r++;
    }
    i = e + 1;
  }
  const values = new Map<string, Float64Array>();
  const variable = new Map<string, Uint8Array>();
  columns.forEach((c, k) => {
    if (!c) return;
    const key = `${c.sensor}:${c.field}`;
    values.set(key, r === rows ? cols[k]! : cols[k]!.subarray(0, r));
    if (vrb[k]) variable.set(key, vrb[k]!);
  });
  return {
    comments, header, columns: columns.filter((c): c is Column => !!c), ignored,
    t: r === rows ? t : t.subarray(0, r), values, variable, firstRows,
  };
}

/** The dataset id (§6): the file's slug and the first 8 hex characters of its sha256. */
export function datasetId(file: string, sha256: string): string {
  const slug = file.replace(/\.csv$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug}-${sha256.slice(0, 8)}`;
}
