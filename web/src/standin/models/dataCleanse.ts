// Data cleanse, stand-in (FR-34, FR-06e; data_cleanse.py, the reference): the core
// model that runs first. For each imported dataset it reads each sensor's
// weather__{ds} (and each analyser's co2__{ds}), removes readings the QC flags
// mark as anything but "pass" and readings that stand out from their neighbours
// by more than `spike_threshold` times a simple noise estimate, then smooths what
// is left with a 5-point mean. It publishes cleaned-<sensor>__{ds}, and CO₂ only
// under its restricted subsystem (FR-112), one block per hour (D-280), with the
// same schemas as the Python model; every other model reads these (AT-15). The
// method is simpler than the Python model's (median-based noise): illustrative.
import runsJson from '../../../../contracts/swe/runs-data-cleanse.json';
import settingsJson from '../../../../contracts/swe/controlstreams/data-cleanse-settings.json';
import type { Cols } from '../resources';
import { DataRecord, M } from '../swe';
import { blockFields, Dataset, encodeBlock, master, Model, ModelApi, QUANTITIES, roundArr, Run, SENSORS } from './csmodel';

const MARGIN = 2; // seconds read either side of a window, so its edge readings have neighbours
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

export function clean(cols: Cols, names: string[], threshold: number): [Record<string, unknown> & { t: Float64Array }, number] {
  const out: Record<string, unknown> & { t: Float64Array } = { t: cols.t };
  let removed = 0;
  for (const p of names) {
    if (!(p in cols)) continue;
    const v = Float64Array.from(cols[p] as Float64Array);
    const flag = cols[`${p}_qc`] as ArrayLike<unknown> | undefined;
    const bad = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) if ((flag && String(flag[i]) !== '1') || !Number.isFinite(v[i])) bad[i] = 1;
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
  return [out, removed];
}

export class DataCleanse extends Model {
  readonly id = 'data-cleanse';
  readonly label = 'Data cleanse';
  description = 'Core model, runs first: removes noise before any other model sees the data.';
  window = 3600;
  usesCo2 = true;
  control: [string, DataRecord] = ['settings', master(settingsJson)];
  defaults = { spike_threshold: 6.0 };
  runsMaster = master(runsJson);
  readsCleanse = false; // it is the one that reads the sensors (AT-15)
  private src = new Map<string, Map<string, { key: string; names: string[]; out: string }>>();

  async outputs(api: ModelApi, ds: Dataset): Promise<boolean> {
    const d = ds.id;
    const src = new Map<string, { key: string; names: string[]; out: string }>();
    for (const s of SENSORS) {
      const k = await api.find(`urn:x-barge:sensor:${s}`, `weather__${d}`);
      if (k === null) return false;
      const names = [...(await api.schema(k)).keys()].filter((n) => QUANTITIES.includes(n));
      const out = await api.createDatastream(this.system, { name: `Cleaned ${s} record · ${d}`, outputName: `cleaned-${s}__${d}`,
        schema: M.record(`Cleaned ${s} record`, blockFields(names)) });
      src.set(s, { key: k, names, out });
    }
    for (const s of SENSORS) { // CO₂ only under the restricted subsystem (FR-112)
      const k = await api.find(`urn:x-barge:sensor:${s}:co2`, `co2__${d}`);
      if (k === null) continue;
      const out = await api.createDatastream(this.restricted!, { name: `Cleaned ${s} CO₂ · ${d}`, outputName: `cleaned-co2-${s}__${d}`,
        schema: M.record(`Cleaned ${s} CO₂`, blockFields(['co2'])) });
      src.set(`co2-${s}`, { key: k, names: ['co2'], out });
    }
    this.src.set(d, src);
    return true;
  }

  async process(api: ModelApi, ds: Dataset, t0: number, t1: number, run: Run): Promise<void> {
    const thr = Number(run.settings.spike_threshold);
    for (const [name, { key, names, out }] of this.src.get(ds.id)!) {
      const cols = await api.read(key, t0 - MARGIN, t1 + MARGIN - 0.001);
      const t = cols.t;
      if (!t.length) continue;
      api.tap('scilibs', `stand-in: clean ${t.length} ${name} readings`, { calls: ['QC flags', 'spike test', '5-point mean'], readings: t.length, spike_threshold: thr });
      const [cleaned] = clean(cols, names, thr);
      let a = 0;
      while (a < t.length && t[a] < t0) a++;
      let b = a;
      while (b < t.length && t[b] < t1) b++;
      const block: Record<string, Float64Array> = { t: t.slice(a, b) };
      let removed = 0;
      for (const n of names) {
        block[n] = (cleaned[n] as Float64Array).slice(a, b);
        for (const x of block[n]) if (!Number.isFinite(x)) removed++;
      }
      api.tap('models', `stand-in: ${b - a} cleaned, ${removed} removed`, { rows: b - a, removed });
      await api.publish(out, encodeBlock(t0, block, names, removed, run.id));
    }
  }
}
