// Analysis, stand-in (FR-34, FR-35a, FR-06e; analysis.py, the reference): change
// detection, correlation and clustering, on Data cleanse's output only (AT-15),
// from its latest complete run on a dataset. Run 1 on each imported dataset is
// the whole dataset, the bow's air temperature, humidity, water temperature and
// pressure at the full resolution; a `clustering` command starts one run on the
// dataset its doi names. The same datastreams, schemas and control stream as the
// Python model; a run whose sources include CO₂ is published, with its runs
// entry, only under the restricted subsystem (FR-112), and a command naming CO₂
// from a sender without emissions is REJECTED (FR-112a). Simpler methods: all
// three algorithms are k-means, each with its own seed; changes come from a plain
// step detector. The stand-in has no referee: its runs are unscored (FR-06e).
import runsJson from '../../../../contracts/swe/runs-analysis.json';
import clusteringJson from '../../../../contracts/swe/controlstreams/analysis-clustering.json';
import { datasetId } from '../csv';
import { PyFloat } from '../py';
import { DataRecord, M } from '../swe';
import { CO2_ROLES, Command, Dataset, master, Model, ModelApi, QUANTITIES, Rejected, rng, Run, RunRequest, SENSORS } from './csmodel';

const KMEANS_SEED = 20310407; // Analysis's own named stream (FR-14)
const SEEDS: Record<string, number> = { A: KMEANS_SEED, B: KMEANS_SEED + 1, C: KMEANS_SEED + 2 };
const MAX_CLUSTERS = 8;

export function kmeans(X: Float64Array[], k: number, seed: number, iters = 50): Int32Array {
  const n = X.length;
  const dim = n ? X[0].length : 0;
  const rand = rng(seed);
  const d2 = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let j = 0; j < dim; j++) s += (a[j] - b[j]) ** 2;
    return s;
  };
  const centres: Float64Array[] = [Float64Array.from(X[Math.floor(rand() * n)])];
  const best = new Float64Array(n).fill(Infinity);
  while (centres.length < k) {
    const c = centres[centres.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      best[i] = Math.min(best[i], d2(X[i], c));
      total += best[i];
    }
    let pick = Math.floor(rand() * n);
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < n; i++) {
        r -= best[i];
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    }
    centres.push(Float64Array.from(X[pick]));
  }
  const labels = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bj = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = d2(X[i], centres[j]);
        if (d < bd) [bd, bj] = [d, j];
      }
      if (labels[i] !== bj) changed = true;
      labels[i] = bj;
    }
    if (it && !changed) break;
    for (let j = 0; j < k; j++) {
      const sum = new Float64Array(dim);
      let c = 0;
      for (let i = 0; i < n; i++) {
        if (labels[i] !== j) continue;
        for (let q = 0; q < dim; q++) sum[q] += X[i][q];
        c++;
      }
      if (c) centres[j] = sum.map((x) => x / c);
    }
  }
  return labels;
}

/** c1, c2, … in order of first appearance, so colours stay steady between runs. */
function relabel(labels: Int32Array): string[] {
  const order = new Map<number, number>();
  return Array.from(labels, (x) => {
    if (!order.has(x)) order.set(x, order.size + 1);
    return `c${order.get(x)}`;
  });
}

/**
 * Sustained steps in the standardised fields: at each sample, the mean over
 * the next `w` samples minus the mean over the previous `w`, averaged over
 * fields; peaks above 6/sensitivity standard deviations, at least 2w apart.
 */
export function detectSteps(t: Float64Array, Z: Float64Array[], sensitivity: number, stepS: number) {
  const n = t.length;
  const out = { t: [] as number[], scale: [] as number[], strength: [] as number[] };
  const w = stepS <= 5 ? 24 : stepS <= 60 ? 45 : 8; // two minutes, 45 minutes or eight hours
  if (n < 2 * w + 1 || !Z.length) return out;
  const score = new Float64Array(n);
  for (const col of Z) {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + col[i];
    for (let i = w; i <= n - w; i++) score[i] += Math.abs((c[i + w] - c[i]) / w - (c[i] - c[i - w]) / w) / Z.length;
  }
  const threshold = 6 / sensitivity;
  const idx = [...score.keys()].filter((i) => score[i] > threshold).sort((a, b) => score[b] - score[a] || a - b);
  const picked: number[] = [];
  for (const i of idx) if (picked.every((j) => Math.abs(i - j) > 2 * w)) picked.push(i);
  picked.sort((a, b) => a - b);
  for (const i of picked) {
    out.t.push(t[i]);
    out.scale.push(stepS <= 5 ? 0 : 1);
    out.strength.push(score[i]);
  }
  return out;
}

function corrcoef(X: Float64Array[], m: number): (PyFloat | null)[][] {
  const n = X.length;
  const mean = new Float64Array(m);
  for (const r of X) for (let j = 0; j < m; j++) mean[j] += r[j] / n;
  const R: (PyFloat | null)[][] = [];
  for (let a = 0; a < m; a++) {
    R.push([]);
    for (let b = 0; b < m; b++) {
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (const r of X) {
        const da = r[a] - mean[a];
        const db = r[b] - mean[b];
        sab += da * db;
        saa += da * da;
        sbb += db * db;
      }
      const v = sab / Math.sqrt(saa * sbb);
      R[a].push(Number.isFinite(v) ? new PyFloat(Math.round(v * 1000) / 1000) : null); // floats, as numpy writes them
    }
  }
  return R;
}

const RESOLUTIONS: Record<string, number> = { PT1S: 1, PT1M: 60, PT1H: 3600 };
const MAX_POINTS = 720; // cluster labels published per run, at most
const QUANTITY_NAMES = new Set([...QUANTITIES, 'co2']);

export interface Source {
  system: string;
  output: string;
  fields: string[];
}

const DEFAULT = {
  algorithm: 'A', clusters: 4, sensitivity: 5.0, resolution: 'PT1S',
  sources: [{ system: 'urn:x-barge:sensor:bow', output: 'weather', fields: ['air_temperature', 'relative_humidity', 'water_temperature', 'pressure'] }],
};

/** Which of Data cleanse's outputs a requested field is read from (bow, co2-stern, …), and the field; null if none. */
export function reading(src: Source, field: string): [string, string] | null {
  const f = field.replace(/_(min|max)$/, '');
  if (!QUANTITY_NAMES.has(f)) return null;
  const where = `${src.system ?? ''} ${src.output ?? ''}`;
  const sensor = SENSORS.find((s) => new RegExp(`(:|-|^)${s}(:|$|\\b)`).test(where));
  if (!sensor) return null;
  const co2 = f === 'co2' || where.includes(':co2') || String(src.output ?? '').includes('co2');
  return [co2 ? `co2-${sensor}` : sensor, f];
}

const namesCo2 = (sources: Source[]) => sources.some((s) => (s.fields ?? []).some((f) => (reading(s, f)?.[0] ?? '').startsWith('co2-')));

export class Analysis extends Model {
  readonly id = 'analysis';
  readonly label = 'Analysis';
  description = 'Core model: change detection, correlation and clustering on a data of interest.';
  window = null; // a run's whole data range at once
  usesCo2 = true;
  restrictedRuns = true;
  control: [string, DataRecord] = ['clustering', master(clusteringJson)];
  defaults = { ...DEFAULT };
  runsMaster = master(runsJson);
  private out = new Map<string, Map<string, string>>();

  private schemas(): Record<string, DataRecord> {
    return {
      changes: M.record('Detected changes', [M.time(), M.text('run_id', 'Analysis run'), M.category('scale', 'Scale of the change', ['minutes', 'hours']),
        M.quantity('strength', 'Strength of the change', '1')]),
      clusters: M.record('Clusters', [M.time(), M.text('run_id', 'Analysis run'),
        M.category('cluster', 'Cluster', Array.from({ length: MAX_CLUSTERS }, (_, i) => `c${i + 1}`))]),
      correlation: M.record('Correlation', [M.time(), M.text('run_id', 'Analysis run'), M.text('fields', 'Fields, in matrix order'),
        M.text('matrix', 'Pearson correlation (JSON)')]),
    };
  }

  async outputs(api: ModelApi, ds: Dataset): Promise<boolean> {
    const names: Record<string, string> = { changes: 'Detected changes', clusters: 'Clusters', correlation: 'Correlation' };
    const out = new Map<string, string>();
    for (const [where, sys] of [['open', this.system], ['restricted', this.restricted!]] as const) {
      for (const [o, rec] of Object.entries(this.schemas())) {
        out.set(`${where}|${o}`, await api.createDatastream(sys, { name: `${names[o]} · ${ds.id}${where === 'restricted' ? ' (restricted)' : ''}`,
          outputName: `${o}__${ds.id}`, schema: rec }));
      }
    }
    this.out.set(ds.id, out);
    return true;
  }

  wanted(_ds: Dataset, complete: Record<string, any>[]): Record<string, any> | null {
    return complete.length ? null : { ...DEFAULT }; // run 1 on import; later runs only on command
  }

  entry(run: Run): Record<string, unknown> {
    const s = run.settings;
    return { start: run.start, end: run.end - 1, algorithm: s.algorithm, resolution: s.resolution, sensitivity: Number(s.sensitivity),
      clusters: Number(s.clusters), records: 0, score_changes: NaN, score_clusters: NaN };
  }

  private static doi(cmd: Command): Record<string, any> {
    try {
      const d = typeof cmd.parameters.doi === 'string' ? JSON.parse(cmd.parameters.doi) : cmd.parameters.doi;
      if (d && typeof d === 'object') return d;
    } catch { /* below */ }
    throw new Rejected('doi is not a data of interest (JSON)');
  }

  validate(api: ModelApi, cmd: Command): void {
    super.validate(api, cmd);
    const doi = Analysis.doi(cmd);
    const dsr = doi.dataset ?? {};
    if (typeof dsr !== 'object' || !dsr.file || !dsr.sha256) throw new Rejected('doi.dataset must name the file and its sha256');
    const t0 = Date.parse(doi.start);
    const t1 = Date.parse(doi.end);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new Rejected('doi.start and doi.end must be ISO 8601 times');
    if (t1 <= t0) throw new Rejected('doi.end must be after doi.start');
    if (!(doi.resolution in RESOLUTIONS)) throw new Rejected(`doi.resolution '${doi.resolution}' has no datastream; available: PT1S, PT1M, PT1H`);
    const srcs = doi.sources;
    if (!Array.isArray(srcs) || !srcs.length || !srcs.every((s: any) => s && s.system && s.output && Array.isArray(s.fields) && s.fields.length)) {
      throw new Rejected('doi.sources must name at least one source with its system, output and fields');
    }
    // FR-112a: the receiver checks the sender's role, whatever the client sent.
    if (namesCo2(srcs) && !CO2_ROLES.has(String(api.roleOf(cmd.sender ?? '') ?? ''))) throw new Rejected('a requested source is not available');
    if (srcs.some((s: Source) => s.fields.some((f) => reading(s, f) === null))) throw new Rejected('a requested source is not available');
  }

  async onCommand(_api: ModelApi, cmd: Command): Promise<RunRequest> {
    const p = cmd.parameters;
    const doi = Analysis.doi(cmd);
    return {
      dataset: datasetId(doi.dataset.file, doi.dataset.sha256),
      settings: { algorithm: p.algorithm, clusters: Number(p.clusters), sensitivity: Number(p.sensitivity), resolution: doi.resolution, sources: doi.sources },
      restricted: namesCo2(doi.sources), start: Date.parse(doi.start) / 1000, end: Date.parse(doi.end) / 1000 + 1,
    };
  }

  /** The selection's fields from Data cleanse's output, at the run's resolution, on common times. */
  private async series(api: ModelApi, ds: Dataset, t0: number, t1: number, run: Run): Promise<{ names: string[]; t: Float64Array; X: Float64Array[] }> {
    const step = RESOLUTIONS[run.settings.resolution];
    const need = new Map<string, string[]>();
    for (const src of run.settings.sources as Source[]) {
      for (const f of src.fields) {
        const [where, name] = reading(src, f)!;
        const list = need.get(where) ?? [];
        if (!list.includes(name)) list.push(name);
        need.set(where, list);
      }
    }
    const series: { label: string; t: Float64Array; v: Float64Array }[] = [];
    for (const [where, names] of need) {
      const cols = await this.readCleaned(api, ds.id, where, t0, t1, run.source!, names);
      for (const n of names) {
        const v = cols[n] ?? new Float64Array(cols.t.length).fill(NaN);
        let tt = cols.t;
        let vv = v;
        if (step > 1) { // means in intervals aligned to the dataset's start
          const bins = new Map<number, [number, number]>();
          for (let i = 0; i < cols.t.length; i++) {
            if (!Number.isFinite(v[i])) continue;
            const b = ds.start + Math.floor((cols.t[i] - ds.start) / step) * step;
            const x = bins.get(b) ?? [0, 0];
            x[0] += v[i];
            x[1] += 1;
            bins.set(b, x);
          }
          tt = Float64Array.from([...bins.keys()].sort((a, b) => a - b));
          vv = Float64Array.from(tt, (b) => bins.get(b)![0] / bins.get(b)![1]);
        }
        series.push({ label: need.size === 1 ? n : `${where}.${n}`, t: tt, v: vv });
      }
    }
    if (!series.length) return { names: [], t: new Float64Array(0), X: [] };
    const maps = series.map((s) => new Map(Array.from(s.t, (t, i) => [t, s.v[i]])));
    const t: number[] = [];
    const X: Float64Array[] = [];
    for (const tt of series[0].t) {
      const row = Float64Array.from(maps, (m) => m.get(tt) ?? NaN);
      if (row.every((x) => Number.isFinite(x))) {
        t.push(tt);
        X.push(row);
      }
    }
    return { names: series.map((s) => s.label), t: Float64Array.from(t), X };
  }

  async process(api: ModelApi, ds: Dataset, t0: number, t1: number, run: Run): Promise<void> {
    const s = run.settings;
    const { names, t, X } = await this.series(api, ds, t0, t1, run);
    const k = Number(s.clusters);
    if (X.length < Math.max(k, 3)) {
      run.result = { records: X.length };
      return;
    }
    const m = names.length;
    const mean = new Float64Array(m);
    const sd = new Float64Array(m);
    for (const r of X) for (let j = 0; j < m; j++) mean[j] += r[j] / X.length;
    for (const r of X) for (let j = 0; j < m; j++) sd[j] += (r[j] - mean[j]) ** 2 / X.length;
    const Z = X.map((r) => r.map((x, j) => (x - mean[j]) / (Math.sqrt(sd[j]) + 1e-9)));
    const stride = Math.max(1, Math.ceil(Z.length / MAX_POINTS));
    const sub = Z.filter((_, i) => i % stride === 0);
    const tl = t.filter((_, i) => i % stride === 0);
    api.tap('scilibs', `stand-in: cluster ${sub.length} records, algorithm ${s.algorithm}`, { algorithm: s.algorithm, fields: names, records: sub.length, clusters: k });
    const labels = kmeans(sub, k, SEEDS[s.algorithm] ?? KMEANS_SEED);
    const step = RESOLUTIONS[s.resolution];
    const thin = step <= 1 ? 5 : 1; // readings every 5 s for the step detector, as the Python model's coarse pass
    const det = detectSteps(t.filter((_, i) => i % thin === 0), names.map((_, j) => Float64Array.from(Z.filter((_, i) => i % thin === 0), (r) => r[j])),
      Number(s.sensitivity), step <= 1 ? 5 : step);
    const R = m > 1 ? corrcoef(X, m) : [[new PyFloat(1)]];
    api.tap('models', `stand-in: k-means: ${new Set(labels).size} clusters; ${det.t.length} changes`, { changes: det.t.length });
    const scores = await api.score('clusters', { t: Array.from(tl), labels: Array.from(labels) }).catch(() => ({} as Record<string, number | null>));
    const where = run.restricted ? 'restricted' : 'open';
    const out = this.out.get(ds.id)!;
    await api.publishMany(out.get(`${where}|changes`)!, { t: det.t, run_id: det.t.map(() => run.id), scale: det.scale.map((x) => (x === 0 ? 'minutes' : 'hours')),
      strength: det.strength.map((x) => Math.round(x * 100) / 100) });
    await api.publishMany(out.get(`${where}|clusters`)!, { t: tl, run_id: Array.from(tl, () => run.id), cluster: relabel(labels) });
    await api.publish(out.get(`${where}|correlation`)!, { t: t[t.length - 1], run_id: run.id, fields: names.join(','),
      matrix: JSON.stringify(R.map((row) => row.map((x) => (x instanceof PyFloat ? x.v : x)))) });
    // The stand-in has no referee (FR-06e): its runs are illustrative and unscored.
    run.result = { records: t.length, score_changes: NaN, score_clusters: typeof scores.ari_air_mass === 'number' ? scores.ari_air_mass : NaN };
  }
}
