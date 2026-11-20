// Model A, stand-in: summaries and derived values (FR-29, FR-34; the split
// is ADR 0003). From Data cleanse's output only (AT-15) it publishes, with
// the same datastreams and schemas as backend/models/model_a.py:
//   * summary datastreams per sensor: 1-minute and hourly means of the seven
//     parameters, readings removed, most frequent precipitation type;
//   * derived values at both resolutions: dew point, bow minus stern air
//     temperature, pressure tendency.
// A minute is published once it is complete; an hour once its sixty minutes are.
import type { Cols } from '../registry';
import { M } from '../swe';
import { Command, measurementFields, Model, ModelApi, PRECIP, QUANTITIES, roundArr } from './csmodel';

const SENSORS = ['bow', 'stern'] as const;

export function dewPoint(T: Float64Array, RH: Float64Array): Float64Array {
  const a = 17.62;
  const b = 243.12;
  return T.map((t, i) => {
    const rh = Math.min(Math.max(RH[i], 1), 100);
    const g = Math.log(rh / 100) + (a * t) / (b + t);
    return (b * g) / (a - g);
  });
}

type Rows = Record<string, any> & { t: Float64Array };

/** Means of each quantity over n bins of `width` seconds from `start`, ignoring removed readings. */
export function binMeans(t: Float64Array, cols: Record<string, unknown>, start: number, width: number, n: number): Rows {
  const idx = new Int32Array(t.length);
  const present = new Float64Array(n);
  for (let i = 0; i < t.length; i++) {
    const k = Math.floor((t[i] - start) / width);
    idx[i] = k >= 0 && k < n ? k : -1;
    if (idx[i] >= 0) present[idx[i]]++;
  }
  const out: Rows = { t: Float64Array.from({ length: n }, (_, k) => start + width * k) };
  const removed = new Float64Array(n);
  for (const p of QUANTITIES) {
    if (!(p in cols)) continue;
    const v = cols[p] as Float64Array;
    const s = new Float64Array(n);
    const c = new Float64Array(n);
    for (let i = 0; i < t.length; i++) {
      if (idx[i] < 0 || !Number.isFinite(v[i])) continue;
      s[idx[i]] += v[i];
      c[idx[i]]++;
    }
    for (let k = 0; k < n; k++) removed[k] += present[k] - c[k];
    out[p] = s.map((x, k) => (c[k] > 0 ? x / c[k] : NaN));
  }
  out.readings_removed = removed;
  if ('precipitation_type' in cols) {
    const cats = cols.precipitation_type as unknown[];
    const counts: Map<string, number>[] = Array.from({ length: n }, () => new Map());
    for (let i = 0; i < t.length; i++) {
      const c = cats[i];
      if (idx[i] < 0 || c === null || c === undefined) continue;
      counts[idx[i]].set(c as string, (counts[idx[i]].get(c as string) ?? 0) + 1);
    }
    out.precipitation_type = counts.map((m) => {
      let best: string | null = null;
      let bn = 0;
      for (const [k, v] of m) if (v > bn) [best, bn] = [k, v];
      return best;
    });
  }
  return out;
}

function concat(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class ModelA extends Model {
  readonly id = 'model-a';
  readonly label = 'Model A';
  description = 'Core model: publishes its own datastreams.';
  interval = 60;
  settings: Record<string, any> = { tendency_hours: 3.0 };
  cleaned: Record<string, string | null> = {};
  out: Record<string, string> = {};
  /** Minute rows not yet summarised into hours, per sensor. */
  private minutes: Record<string, Rows[]> = { bow: [], stern: [] };
  /** Recent bow minute pressures (for the 1-minute tendency) and hourly pressures (for the hourly one). */
  private minuteP: number[] = [];
  private hourP: number[] = [];
  private hourDone = -1;

  setup(api: ModelApi): void {
    super.setup(api);
    const summary = [M.time('time', 'Start of the interval'), ...measurementFields(),
      M.count('readings_removed', 'Readings removed'), M.category('precipitation_type', 'Precipitation', PRECIP)];
    const derived = [M.time('time', 'Start of the interval'), M.quantity('dew_point', 'Dew point', 'Cel'),
      M.quantity('bow_minus_stern', 'Bow − stern', 'Cel'), M.quantity('pressure_tendency_3h', 'Pressure tendency', 'hPa')];
    for (const [res, label] of [['1min', '1-minute'], ['1h', 'hourly']]) {
      for (const s of SENSORS) {
        const cap = s.charAt(0).toUpperCase() + s.slice(1);
        this.out[`summary-${res}-${s}`] = api.createDatastream(this.system, {
          name: `${cap} ${label} means`, outputName: `summary-${res}-${s}`, schema: M.record(`${cap} ${label} means`, summary),
        });
      }
      this.out[`derived-${res}`] = api.createDatastream(this.system, {
        name: `Derived values, ${label}`, outputName: `derived-${res}`, schema: M.record(`Derived values, ${label}`, derived),
      });
    }
    this.controlKey = api.createControlstream(this.system, {
      name: 'Model A settings', inputName: 'settings',
      schema: M.record('Model A settings', [M.quantity('tendency_hours', 'Pressure tendency span', 'h', 1, 6)]),
    });
  }

  onCommand(_api: ModelApi, cmd: Command): string {
    Object.assign(this.settings, cmd.parameters);
    return `tendency over ${this.settings.tendency_hours} h`;
  }

  private sources(api: ModelApi): boolean {
    for (const s of SENSORS) if (!this.cleaned[s]) this.cleaned[s] = api.find('urn:x-barge:process:data-cleanse', `cleaned-${s}`);
    return SENSORS.every((s) => this.cleaned[s]);
  }

  private derivedRows(rows: Record<string, Rows>, span: number, history: number[]): Rows {
    const b = rows.bow;
    const s = rows.stern;
    const n = b.t.length;
    const T = b.air_temperature as Float64Array | undefined;
    const RH = b.relative_humidity as Float64Array | undefined;
    const out: Rows = { t: b.t };
    out.dew_point = roundArr(T && RH ? dewPoint(T, RH) : new Float64Array(n).fill(NaN), 3);
    if (T && s.air_temperature) out.bow_minus_stern = roundArr(T.map((x, i) => x - (s.air_temperature as Float64Array)[i]), 3);
    if (b.pressure) {
      const p = concat(Float64Array.from(history), b.pressure as Float64Array);
      const tend = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = history.length + i;
        tend[i] = span < p.length && j >= span ? p[j] - p[j - span] : NaN;
      }
      out.pressure_tendency_3h = roundArr(tend, 3);
    }
    return out;
  }

  step(api: ModelApi, t0: number, t1: number): number {
    if (!this.sources(api)) return t0;
    const start = Math.floor(t0 / 60) * 60;
    const data: Record<string, Cols> = {};
    for (const s of SENSORS) data[s] = api.read(this.cleaned[s]!, start, t1);
    const avail = Math.min(...SENSORS.map((s) => (data[s].t.length ? data[s].t[data[s].t.length - 1] : start)));
    const end = Math.floor((avail + 1) / 60) * 60;
    const n = Math.floor((end - start) / 60);
    if (n <= 0) return t0;
    api.tap('scilibs', `stand-in: ${n} minute means`, { calls: ['bin means', 'dew point'], minutes: n });
    const rows: Record<string, Rows> = {};
    for (const s of SENSORS) rows[s] = binMeans(data[s].t, data[s], start, 60, n);
    const span = Math.trunc(this.settings.tendency_hours * 60);
    const derived = this.derivedRows(rows, span, this.minuteP.slice(-span));
    api.tap('models', `stand-in: ${n} minutes summarised`, { rows: n });
    for (const s of SENSORS) api.publish(this.out[`summary-1min-${s}`], rows[s]);
    api.publish(this.out['derived-1min'], derived);
    const bp = rows.bow.pressure as Float64Array | undefined;
    for (let i = 0; i < n; i++) this.minuteP.push(bp ? bp[i] : NaN);
    if (this.minuteP.length > 6 * 60) this.minuteP.splice(0, this.minuteP.length - 6 * 60);
    for (const s of SENSORS) this.minutes[s].push(rows[s]);
    this.hours(api, end);
    return end;
  }

  /** Hours: from the minute means, once all sixty minutes of an hour are in. */
  private hours(api: ModelApi, end: number) {
    const mins: Record<string, Rows> = {};
    for (const s of SENSORS) mins[s] = mergeRows(this.minutes[s]);
    if (!mins.bow.t.length) return;
    const first = Math.ceil(mins.bow.t[0] / 3600) * 3600;
    const hEnd = Math.floor(end / 3600) * 3600;
    const hours: number[] = [];
    for (let h = first; h < hEnd; h += 3600) if (h > this.hourDone) hours.push(h);
    if (!hours.length) return;
    const rows: Record<string, Rows> = {};
    for (const s of SENSORS) {
      const m = mins[s];
      const r = binMeans(m.t, m, hours[0], 3600, hours.length);
      const removed = new Float64Array(hours.length);
      const mr = m.readings_removed as Float64Array;
      for (let i = 0; i < m.t.length; i++) {
        const k = Math.floor((m.t[i] - hours[0]) / 3600);
        if (k >= 0 && k < hours.length) removed[k] += mr[i];
      }
      r.readings_removed = removed;
      rows[s] = r;
    }
    const span = Math.round(this.settings.tendency_hours);
    const derived = this.derivedRows(rows, span, this.hourP.slice(-span));
    const hp = rows.bow.pressure as Float64Array | undefined;
    for (let i = 0; i < hours.length; i++) this.hourP.push(hp ? hp[i] : NaN);
    if (this.hourP.length > 12) this.hourP.splice(0, this.hourP.length - 12);
    api.tap('scilibs', `stand-in: ${hours.length} hourly means`, { calls: ['bin means'], hours: hours.length });
    api.tap('models', `stand-in: ${hours.length} hours summarised`, { rows: hours.length });
    for (const s of SENSORS) api.publish(this.out[`summary-1h-${s}`], rows[s]);
    api.publish(this.out['derived-1h'], derived);
    this.hourDone = hours[hours.length - 1];
    // Minutes of summarised hours are no longer needed.
    const keepFrom = this.hourDone + 3600;
    for (const s of SENSORS) this.minutes[s] = [sliceRows(mins[s], keepFrom)];
  }
}

function mergeRows(parts: Rows[]): Rows {
  if (parts.length === 1) return parts[0];
  const out: Rows = { t: new Float64Array(0) };
  const keys = new Set(parts.flatMap((p) => Object.keys(p)));
  for (const k of keys) {
    if (parts.every((p) => p[k] instanceof Float64Array)) {
      const n = parts.reduce((a, p) => a + p[k].length, 0);
      const arr = new Float64Array(n);
      let o = 0;
      for (const p of parts) {
        arr.set(p[k], o);
        o += p[k].length;
      }
      out[k] = arr;
    } else {
      out[k] = parts.flatMap((p) => (p[k] ? Array.from(p[k] as ArrayLike<unknown>) : new Array(p.t.length).fill(null)));
    }
  }
  return out;
}

function sliceRows(r: Rows, from: number): Rows {
  let i = 0;
  while (i < r.t.length && r.t[i] < from) i++;
  const out: Rows = { t: r.t.slice(i) };
  for (const [k, v] of Object.entries(r)) if (k !== 't') out[k] = v.slice(i);
  return out;
}
