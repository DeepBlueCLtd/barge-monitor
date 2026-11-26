// Summaries, stand-in (FR-29, FR-34; summaries.py, the reference). From Data
// cleanse's output only (AT-15), per dataset, reading Data cleanse's latest
// complete run on it, with the same datastreams and schemas as the Python model:
//   * summary-1min-<sensor>__{ds} and summary-1h-<sensor>__{ds}: <f>_min, <f>,
//     <f>_max per quantity, and the readings Data cleanse removed;
//   * derived-1min__{ds} and derived-1h__{ds}: dew point, bow minus stern air
//     temperature, pressure tendency over `tendency_hours`;
//   * the CO₂ summaries only under its restricted subsystem (FR-112).
// A window is an hour aligned to the dataset's start: its sixty minutes, then the hour.
import runsJson from '../../../../contracts/swe/runs-summaries.json';
import settingsJson from '../../../../contracts/swe/controlstreams/summaries-settings.json';
import { Component, DataRecord, M } from '../swe';
import { Dataset, DC, LABELS, master, Model, ModelApi, QUANTITIES, Run, SENSORS, UNITS } from './csmodel';

const MINUTE = 60;
const HOUR = 3600;

export function dewPoint(T: number, RH: number): number {
  const a = 17.62;
  const b = 243.12;
  const rh = Math.min(Math.max(RH, 1), 100);
  const g = Math.log(rh / 100) + (a * T) / (b + T);
  return (b * g) / (a - g);
}

/** Python's round(x, 3), for one value. */
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type Row = Record<string, number | string> & { t: number };

/** One row per interval [a, b): min, mean and max per quantity; readings removed. */
export function summarise(t: Float64Array, cols: Record<string, Float64Array>, names: string[], spans: [number, number][]): Row[] {
  const rows: Row[] = [];
  let i0 = 0;
  for (const [a, b] of spans) {
    while (i0 < t.length && t[i0] < a) i0++;
    let i1 = i0;
    while (i1 < t.length && t[i1] < b) i1++;
    const row: Row = { t: a };
    let removed = 0;
    for (const p of names) {
      const v = cols[p];
      let lo = Infinity;
      let hi = -Infinity;
      let s = 0;
      let n = 0;
      for (let i = i0; i < i1; i++) {
        const x = v[i];
        if (!Number.isFinite(x)) {
          removed++;
          continue;
        }
        if (x < lo) lo = x;
        if (x > hi) hi = x;
        s += x;
        n++;
      }
      row[`${p}_min`] = n ? r3(lo) : NaN;
      row[p] = n ? r3(s / n) : NaN;
      row[`${p}_max`] = n ? r3(hi) : NaN;
    }
    row.readings_removed = removed;
    rows.push(row);
    i0 = i1;
  }
  return rows;
}

function summaryFields(names: string[]): Component[] {
  const fields: Component[] = [M.time('time', 'Start of the interval'), M.text('run_id', 'Run')];
  for (const p of names) {
    const mean = M.quantity(p, LABELS[p] ?? p, UNITS[p] ?? '1');
    fields.push({ ...mean, name: `${p}_min`, label: `${mean.label}: minimum` }, mean, { ...mean, name: `${p}_max`, label: `${mean.label}: maximum` });
  }
  fields.push(M.count('readings_removed', 'Readings removed'));
  return fields;
}

const DERIVED = [M.time('time', 'Start of the interval'), M.text('run_id', 'Run'), M.quantity('dew_point', 'Dew point', 'Cel'),
  M.quantity('bow_minus_stern', 'Bow − stern', 'Cel'), M.quantity('pressure_tendency_3h', 'Pressure tendency', 'hPa')];

function derived(bow: Row, stern: Row, past: number, runId: string): Row {
  const T = Number(bow.air_temperature ?? NaN);
  const RH = Number(bow.relative_humidity ?? NaN);
  const Ts = Number(stern.air_temperature ?? NaN);
  const P = Number(bow.pressure ?? NaN);
  return {
    t: bow.t, run_id: runId,
    dew_point: Number.isFinite(T) && Number.isFinite(RH) ? r3(dewPoint(T, RH)) : NaN,
    bow_minus_stern: Number.isFinite(T) && Number.isFinite(Ts) ? r3(T - Ts) : NaN,
    pressure_tendency_3h: Number.isFinite(P) && Number.isFinite(past) ? r3(P - past) : NaN,
  };
}

function columns(rows: Row[]): Record<string, unknown> {
  const keys = rows.length ? Object.keys(rows[0]) : ['t'];
  return Object.fromEntries(keys.map((k) => [k, rows.map((r) => r[k])]));
}

export class Summaries extends Model {
  readonly id = 'summaries';
  readonly label = 'Summaries';
  description = 'Core model: 1-minute and hourly minimum, mean and maximum, and derived values.';
  window = HOUR;
  usesCo2 = true;
  control: [string, DataRecord] = ['settings', master(settingsJson)];
  defaults = { tendency_hours: 3.0 };
  runsMaster = master(runsJson);
  private src = new Map<string, Map<string, string[]>>();
  private out = new Map<string, Map<string, string>>();

  async outputs(api: ModelApi, ds: Dataset): Promise<boolean> {
    const d = ds.id;
    const src = new Map<string, string[]>();
    const out = new Map<string, string>();
    const both = [['1min', '1-minute'], ['1h', 'hourly']] as const;
    for (const s of SENSORS) {
      const k = await api.find(DC, `cleaned-${s}__${d}`);
      if (k === null) return false; // Data cleanse has not declared it yet
      const names = [...(await api.schema(k))].filter(([n, ty]) => QUANTITIES.includes(n) && ty === 'Text').map(([n]) => n);
      src.set(s, names);
      for (const [res, label] of both) {
        const S = s[0].toUpperCase() + s.slice(1);
        out.set(`${res}-${s}`, await api.createDatastream(this.system, { name: `${S} ${label} summary · ${d}`, outputName: `summary-${res}-${s}__${d}`,
          schema: M.record(`${S} ${label} summary`, summaryFields(names)) }));
      }
    }
    for (const s of SENSORS) { // CO₂ only under the restricted subsystem (FR-112)
      if ((await api.find(DC + ':restricted', `cleaned-co2-${s}__${d}`)) === null) continue;
      src.set(`co2-${s}`, ['co2']);
      for (const [res, label] of both) {
        const S = s[0].toUpperCase() + s.slice(1);
        out.set(`${res}-co2-${s}`, await api.createDatastream(this.restricted!, { name: `${S} CO₂ ${label} summary · ${d}`,
          outputName: `summary-${res}-co2-${s}__${d}`, schema: M.record(`${S} CO₂ ${label} summary`, summaryFields(['co2'])) }));
      }
    }
    for (const [res, label] of both) {
      out.set(`derived-${res}`, await api.createDatastream(this.system, { name: `Derived values, ${label} · ${d}`, outputName: `derived-${res}__${d}`,
        schema: M.record(`Derived values, ${label}`, DERIVED) }));
    }
    this.src.set(d, src);
    this.out.set(d, out);
    return true;
  }

  async process(api: ModelApi, ds: Dataset, t0: number, t1: number, run: Run): Promise<void> {
    const src = this.src.get(ds.id)!;
    const out = this.out.get(ds.id)!;
    const span = Number(run.settings.tendency_hours) * HOUR;
    const minutes: [number, number][] = [];
    for (let a = t0; a < t1; a += MINUTE) minutes.push([a, Math.min(a + MINUTE, t1)]);
    const mins = new Map<string, Row[]>();
    const hours = new Map<string, Row>();
    for (const [name, names] of src) {
      const cols = await this.readCleaned(api, ds.id, name, t0, t1, run.source!, names);
      mins.set(name, summarise(cols.t, cols, names, minutes));
      hours.set(name, summarise(cols.t, cols, names, [[t0, t1]])[0]);
    }
    api.tap('scilibs', `stand-in: summaries of the hour from ${api.iso(t0)}`, { calls: ['min', 'mean', 'max'], minutes: minutes.length });
    const pmin: Record<number, number> = (run.state.pressure1min ??= {});
    const phour: Record<number, number> = (run.state.pressure1h ??= {});
    for (const [name, rows] of mins) {
      await api.publishMany(out.get(`1min-${name}`)!, columns(rows.map((r) => ({ ...r, run_id: run.id }))));
      await api.publish(out.get(`1h-${name}`)!, { ...hours.get(name)!, run_id: run.id });
    }
    const bow = mins.get('bow')!;
    const stern = mins.get('stern')!;
    const rows = bow.map((b, i) => {
      pmin[b.t] = Number(b.pressure ?? NaN);
      return derived(b, stern[i], pmin[b.t - span] ?? NaN, run.id);
    });
    await api.publishMany(out.get('derived-1min')!, columns(rows));
    phour[t0] = Number(hours.get('bow')!.pressure ?? NaN);
    await api.publish(out.get('derived-1h')!, derived(hours.get('bow')!, hours.get('stern')!, phour[t0 - span] ?? NaN, run.id));
    api.tap('models', `summaries published for the hour from ${api.iso(t0)}`, { minutes: minutes.length });
  }
}
