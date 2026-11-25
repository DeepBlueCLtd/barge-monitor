// Data cleanse, stand-in (FR-34, FR-06e): the core model that runs first and
// the only one that reads the raw records (AT-15). Per window of a dataset it
// reads each sensor's weather record (and its CO₂ record), removes readings
// whose QC flag is not "pass" and readings that stand out from their
// neighbours by more than `spike_threshold` times a simple noise estimate,
// and smooths what is left with a 5-point mean inside the window. Cleaned
// CO₂ is published only under its restricted subsystem (FR-112). Simpler
// than the Python model: its results are illustrative.
import { SENSORS } from '../constants';
import { M } from '../swe';
import { Api, Cols, Command, DatasetCtx, LABELS, Model, Rejected, round, runField, UNITS } from './csmodel';

const SMOOTH = 5;
export const WEATHER_FIELDS = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];

/** Mean absolute step between neighbours, as a noise scale (≈ σ for Gaussian noise). */
function noiseScale(v: Float64Array): number {
  let s = 0;
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    if (Number.isFinite(d)) {
      s += Math.abs(d);
      n++;
    }
  }
  return n < 10 ? Infinity : (0.886 * s) / n + 1e-9;
}

/** One field cleaned; returns the values and how many were removed. */
export function cleanField(name: string, v0: Float64Array, flags: ArrayLike<unknown> | undefined, threshold: number): [Float64Array, number] {
  const v = Float64Array.from(v0);
  const bad = new Uint8Array(v.length);
  if (flags) for (let i = 0; i < v.length; i++) if (String(flags[i]) !== '1') bad[i] = 1;
  if (v.length >= 3 && name !== 'apparent_wind_direction') {
    const lim = threshold * noiseScale(v);
    for (let i = 1; i < v.length - 1; i++) if (Math.abs(v[i] - 0.5 * (v[i - 1] + v[i + 1])) > lim) bad[i] = 1;
  }
  let removed = 0;
  for (let i = 0; i < v.length; i++) {
    if (bad[i] || !Number.isFinite(v[i])) {
      if (Number.isFinite(v[i])) removed++;
      v[i] = NaN;
    }
  }
  if (name === 'apparent_wind_direction') return [v, removed]; // an angle is not averaged across north
  const n = v.length;
  const cs = new Float64Array(n + 1);
  const cn = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(v[i]);
    cs[i + 1] = cs[i] + (ok ? v[i] : 0);
    cn[i + 1] = cn[i] + (ok ? 1 : 0);
  }
  const h = SMOOTH >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h);
    const hi = Math.min(n, i + h + 1);
    out[i] = Number.isFinite(v[i]) ? round((cs[hi] - cs[lo]) / (cn[hi] - cn[lo]), 3) : NaN;
  }
  return [out, removed];
}

export class DataCleanse extends Model {
  readonly id = 'data-cleanse';
  readonly label = 'Data cleanse';
  description = 'Core model, runs first: flags and removes noise before any other model sees the data.';
  readonly maxRate = 100;
  window = 60;
  settings = { spike_threshold: 6.0 };
  private fields = new Map<string, string[]>(); // `${ds}|${sensor}` -> weather fields present

  async setup(api: Api): Promise<void> {
    await super.setup(api);
    this.controlKey = await api.createControlstream(this.uid, {
      name: 'Data cleanse settings', inputName: 'settings', schema: M.record('Data cleanse settings', [
        M.quantity('spike_threshold', 'Spike threshold, in multiples of the local noise', '1', 1, 10)]),
    });
  }

  async prepare(api: Api, ds: DatasetCtx): Promise<void> {
    for (const s of SENSORS) {
      const raw = await api.find(`urn:x-barge:sensor:${s}`, `weather__${ds.id}`);
      const present = raw ? WEATHER_FIELDS.filter((f) => false || true).filter(async () => true) : [];
      let names: string[] = [];
      if (raw) {
        const types = await api.fieldTypes(raw);
        names = WEATHER_FIELDS.filter((f) => types.has(f));
      }
      void present;
      this.fields.set(`${ds.id}|${s}`, names);
      const label = `Cleaned ${s} record, ${ds.id}`;
      await api.createDatastream(this.uid, {
        name: label, outputName: `cleaned-${s}__${ds.id}`,
        schema: M.record(label, [M.time(), ...names.map((f) => M.quantity(f, LABELS[f], UNITS[f])), runField()]),
      });
      const co2Label = `Cleaned ${s} CO₂, ${ds.id}`;
      await api.createDatastream(this.restrictedUid, {
        name: co2Label, outputName: `cleaned-co2-${s}__${ds.id}`,
        schema: M.record(co2Label, [M.time(), M.quantity('co2', LABELS.co2, UNITS.co2), runField()]),
      });
    }
  }

  async validate(_api: Api, cmd: Command): Promise<void> {
    const v = cmd.parameters.spike_threshold;
    if (typeof v !== 'number' || !(v >= 1 && v <= 10)) throw new Rejected(`spike_threshold ${JSON.stringify(v)} is outside its bounds, 1 to 10`);
  }

  async apply(_api: Api, cmd: Command): Promise<string> {
    this.settings.spike_threshold = Number(cmd.parameters.spike_threshold);
    return `spike threshold ${this.settings.spike_threshold}`;
  }

  async process(api: Api, ds: DatasetCtx, t0: number, t1: number, run: string): Promise<boolean> {
    const from = t0 === ds.start ? t0 : t0 + 1;
    for (const s of SENSORS) {
      const names = this.fields.get(`${ds.id}|${s}`) ?? [];
      const raw = await api.find(`urn:x-barge:sensor:${s}`, `weather__${ds.id}`);
      if (raw && names.length) {
        const cols = await api.read(raw, from, t1);
        await this.publish(api, `urn:x-barge:process:data-cleanse|cleaned-${s}__${ds.id}`, cols, names, run, s);
      }
      const co2 = await api.find(`urn:x-barge:sensor:${s}:co2`, `co2__${ds.id}`);
      if (co2) {
        const cols = await api.read(co2, from, t1);
        await this.publish(api, `${this.restrictedUid}|cleaned-co2-${s}__${ds.id}`, cols, ['co2'], run, s);
      }
    }
    return true;
  }

  private async publish(api: Api, key: string, cols: Cols, names: string[], run: string, sensor: string): Promise<void> {
    if (!cols.t.length) return;
    api.sci('call', `clean ${cols.t.length} ${sensor} readings`, { calls: ['QC flags', 'spike test', '5-point mean'], fields: names, readings: cols.t.length,
      spike_threshold: this.settings.spike_threshold });
    const out: Cols = { t: cols.t };
    let removed = 0;
    for (const f of names) {
      if (!(f in cols)) continue;
      const [v, r] = cleanField(f, cols[f] as Float64Array, cols[`${f}_qc`] as ArrayLike<unknown> | undefined, this.settings.spike_threshold);
      out[f] = v;
      removed += r;
    }
    out.run = new Array(cols.t.length).fill(run);
    api.sci('result', `${cols.t.length} cleaned, ${removed} removed`, { rows: cols.t.length, removed });
    await api.publishMany(key, out);
  }
}
