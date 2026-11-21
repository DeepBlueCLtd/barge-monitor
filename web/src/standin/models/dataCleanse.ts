// Data cleanse, stand-in (FR-34, FR-06e): the core model that runs first.
// It reads each sensor's raw records from the data server, removes readings
// the server's QC flags mark as anything but "pass" and readings that stand
// out from their neighbours by more than `spike_threshold` times a simple
// noise estimate, then smooths what is left with a 5-point mean. It publishes
// one cleaned datastream per sensor, with the same schema as the Python model;
// every other model reads these (AT-15). The method is simpler than the
// Python model's (median-based noise): its results are illustrative.
import type { Cols } from '../registry';
import { M } from '../swe';
import { Command, measurementFields, Model, ModelApi, PRECIP, QUANTITIES, roundArr } from './csmodel';

const SENSORS = ['bow', 'stern'];
const LAG_S = 2;
const SMOOTH = 5;

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

export function clean(cols: Cols, threshold: number): [Record<string, unknown> & { t: Float64Array }, number] {
  const out: Record<string, unknown> & { t: Float64Array } = { t: cols.t };
  let removed = 0;
  for (const p of QUANTITIES) {
    if (!(p in cols)) continue;
    const v = Float64Array.from(cols[p] as Float64Array);
    const flag = (cols[`${p}_qc`] as ArrayLike<unknown> | undefined) ?? new Float64Array(v.length).fill(1);
    const bad = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) if (Number(flag[i]) !== 1) bad[i] = 1;
    if (v.length >= 3 && p !== 'apparent_wind_direction') {
      const lim = threshold * noiseScale(v);
      for (let i = 1; i < v.length - 1; i++) if (Math.abs(v[i] - 0.5 * (v[i - 1] + v[i + 1])) > lim) bad[i] = 1;
    }
    for (let i = 0; i < v.length; i++) {
      if (bad[i]) {
        v[i] = NaN;
        removed++;
      }
    }
    let res = v;
    if (p !== 'apparent_wind_direction') { // an angle is not averaged across north
      // moving mean of the readings kept, by prefix sums (numpy.cumsum in the Python model)
      const n = v.length;
      const cs = new Float64Array(n + 1);
      const cn = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        const ok = Number.isFinite(v[i]);
        cs[i + 1] = cs[i] + (ok ? v[i] : 0);
        cn[i + 1] = cn[i] + (ok ? 1 : 0);
      }
      const h = SMOOTH >> 1;
      res = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - h);
        const hi = Math.min(n, i + h + 1);
        res[i] = Number.isFinite(v[i]) ? (cs[hi] - cs[lo]) / (cn[hi] - cn[lo]) : NaN;
      }
    }
    out[p] = roundArr(res, 3);
  }
  if ('precipitation_type' in cols) {
    out.precipitation_type = Array.from(cols.precipitation_type as unknown[]);
  }
  return [out, removed];
}

export class DataCleanse extends Model {
  readonly id = 'data-cleanse';
  readonly label = 'Data cleanse';
  description = 'Core model, runs first: flags and removes noise before any other model sees the data.';
  interval = 10;
  settings: Record<string, any> = { spike_threshold: 6.0 };
  raw: Record<string, string | null> = {};
  out: Record<string, string> = {};

  setup(api: ModelApi): void {
    super.setup(api);
    const fields = [M.time(), ...measurementFields(), M.category('precipitation_type', 'Precipitation', PRECIP)];
    for (const s of SENSORS) {
      this.raw[s] = api.find(`urn:x-barge:sensor:${s}`, 'weather');
      this.out[s] = api.createDatastream(this.system, {
        name: `Cleaned ${s} record`, outputName: `cleaned-${s}`, schema: M.record(`Cleaned ${s} record`, fields),
      });
    }
    this.controlKey = api.createControlstream(this.system, {
      name: 'Data cleanse settings', inputName: 'settings', schema: M.record('Data cleanse settings', [
        M.quantity('spike_threshold', 'Spike threshold, in multiples of the local noise', '1', 1, 10)]),
    });
  }

  onCommand(_api: ModelApi, cmd: Command): string {
    Object.assign(this.settings, cmd.parameters);
    return `spike threshold ${this.settings.spike_threshold}`;
  }

  step(api: ModelApi, t0: number, t1: number): number {
    let done = t1;
    for (const s of SENSORS) {
      const cols = api.read(this.raw[s]!, t0 - LAG_S, t1);
      const t = cols.t;
      if (t.length < 3) return t0;
      api.tap('scilibs', `stand-in: clean ${t.length} ${s} readings`,
        { calls: ['QC flags', 'spike test', '5-point mean'], readings: t.length, spike_threshold: this.settings.spike_threshold });
      const [out, removed] = clean(cols, Number(this.settings.spike_threshold));
      const last = t[t.length - 1] - LAG_S;
      // Times are sorted: the rows kept, (t0, last], are one run.
      let a = 0;
      while (a < t.length && !(t0 > 0 ? t[a] > t0 : t[a] >= 0)) a++;
      let b = t.length;
      while (b > a && t[b - 1] > last) b--;
      const sel: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(out)) sel[k] = (v as Float64Array | unknown[]).slice(a, b);
      api.tap('models', `stand-in: ${b - a} cleaned, ${removed} removed`, { rows: b - a, removed });
      api.publish(this.out[s], sel);
      done = Math.min(done, last);
    }
    return done;
  }
}
