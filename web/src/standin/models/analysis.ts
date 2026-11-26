// Analysis, stand-in: change detection, correlation and clustering (FR-34,
// FR-06e). The same datastreams, schemas and control stream as
// backend/models/analysis.py, and the same reading plan:
//   PT1H: cleaned 1 s records, every 5 s; PT6H, P1D: 1-minute means;
//   P7D, P28D: hourly means.
// Simpler methods: all three algorithms are k-means, each with its own seed;
// changes come from a plain step detector. Every run is marked illustrative,
// and nothing is scored: the stand-in has no referee (FR-06e).
import { PyFloat } from '../py';
import type { Cols } from '../resources';
import { M } from '../swe';
import { Command, interp, Model, ModelApi, NoRun, rng } from './csmodel';

const PERIODS: Record<string, number> = { PT1M: 60, PT1H: 3600, PT6H: 6 * 3600, P1D: 86400, P7D: 7 * 86400, P28D: 28 * 86400 };
const SENSOR_FIELDS = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];
const DERIVED_FIELDS = ['dew_point', 'bow_minus_stern', 'pressure_tendency_3h'];
const KMEANS_SEED = 20310407; // Analysis's own named stream (FR-14)
const SEEDS: Record<string, number> = { A: KMEANS_SEED, B: KMEANS_SEED + 1, C: KMEANS_SEED + 2 };
const MAX_CLUSTERS = 8;
const SCORED_AGAINST = 'stand-in: not scored';

/** k-means with k-means++ seeding, from the algorithm's own seed. */
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

export class Analysis extends Model {
  readonly id = 'analysis';
  readonly label = 'Analysis';
  description = 'Core model: publishes its own datastreams.';
  interval = 600; // re-run the latest settings every ten simulated minutes
  startFrom = 'now' as const;
  settings: Record<string, any> = { algorithm: 'B', fields: 'air_temperature,apparent_wind_speed', period: 'PT1M', clusters: 4, sensitivity: 5.0 };
  private src = new Map<string, string>();
  out: Record<string, string> = {};
  runs = 0;
  lastCommand = '';

  async setup(api: ModelApi): Promise<void> {
    await super.setup(api);
    const defs: Record<string, ReturnType<typeof M.time>[]> = {
      changes: [M.time(), M.text('run_id', 'Run'), M.category('scale', 'Scale of the change', ['minutes', 'hours']),
        M.quantity('strength', 'Strength of the change', '1')],
      clusters: [M.time(), M.text('run_id', 'Run'), M.category('cluster', 'Cluster', Array.from({ length: MAX_CLUSTERS }, (_, i) => `c${i + 1}`))],
      // The matrix is Text (JSON): OpenSensorHub refused an array of implicit size (interfaces §6).
      correlation: [M.time(), M.text('run_id', 'Run'), M.text('fields', 'Fields, in matrix order'),
        M.text('matrix', 'Pearson correlation, as JSON rows')],
      runs: [M.time('time', 'Time the run completed'), M.text('run_id', 'Run'), M.text('command_id', 'Command'),
        M.text('algorithm', 'Algorithm'), M.text('fields', 'Fields'), M.text('period', 'Period'),
        M.time('window_start', 'Data range: start'), M.time('window_end', 'Data range: end'),
        M.count('records', 'Records used'), M.count('clusters', 'Clusters'),
        M.quantity('score_changes', 'Score: changes found against the manifest', '1'),
        M.quantity('score_clusters', 'Score: clusters against the manifest (adjusted Rand index)', '1'),
        M.text('scored_against', 'What the clusters were scored against'),
        M.boolean('illustrative', 'Illustrative result (stand-in)')],
    };
    const names: Record<string, string> = { changes: 'Detected changes', clusters: 'Clusters', correlation: 'Correlation', runs: 'Runs' };
    for (const [out, fields] of Object.entries(defs)) {
      this.out[out] = await api.createDatastream(this.system, { name: names[out], outputName: out, schema: M.record(names[out], fields) });
    }
    this.controlKey = await api.createControlstream(this.system, {
      name: 'Clustering', inputName: 'clustering', schema: M.record('Clustering settings', [
        M.category('algorithm', 'Algorithm', ['A', 'B', 'C']),
        M.text('fields', 'Fields, comma-separated', [...SENSOR_FIELDS, ...DERIVED_FIELDS]),
        M.category('period', 'Period', Object.keys(PERIODS)),
        M.count('clusters', 'Number of clusters', 2, MAX_CLUSTERS),
        M.quantity('sensitivity', 'Change detector sensitivity', '1', 1, 10)]),
    });
  }

  async onCommand(api: ModelApi, cmd: Command): Promise<string> {
    Object.assign(this.settings, cmd.parameters);
    this.lastCommand = cmd.id;
    const r = await this.run(api);
    return `${r.run_id} over ${r.records} records`;
  }

  async initial(api: ModelApi): Promise<boolean> {
    try {
      await this.run(api);
      return true;
    } catch (e) {
      if (e instanceof NoRun) return false; // its inputs are not there yet
      throw e;
    }
  }

  async step(api: ModelApi, _t0: number, t1: number): Promise<number> {
    try {
      await this.run(api);
    } catch (e) {
      if (!(e instanceof NoRun)) throw e;
      api.tap('models', `no run: ${e.message}`, { error: e.message });
    }
    return t1;
  }

  private async key(api: ModelApi, system: string, output: string): Promise<string | null> {
    const k = `${system}/${output}`;
    if (!this.src.has(k)) {
      const found = await api.find(`urn:x-barge:process:${system}`, output);
      if (found) this.src.set(k, found); // a datastream not there yet is looked for again next time
      return found;
    }
    return this.src.get(k)!;
  }

  /** Sample times and one column per field, on the source the period calls for. */
  private async series(api: ModelApi, t0: number, t1: number, fields: string[]): Promise<[Float64Array, Record<string, Float64Array>, number]> {
    const period = this.settings.period as string;
    let key: string | null;
    let dkey: string | null;
    let step: number;
    if (period === 'PT1M') [key, dkey, step] = [await this.key(api, 'data-cleanse', 'cleaned-bow'), await this.key(api, 'summaries', 'derived-1min'), 1];
    else if (period === 'PT1H') [key, dkey, step] = [await this.key(api, 'data-cleanse', 'cleaned-bow'), await this.key(api, 'summaries', 'derived-1min'), 5];
    else if (period === 'PT6H' || period === 'P1D') [key, dkey, step] = [await this.key(api, 'summaries', 'summary-1min-bow'), await this.key(api, 'summaries', 'derived-1min'), 1];
    else [key, dkey, step] = [await this.key(api, 'summaries', 'summary-1h-bow'), await this.key(api, 'summaries', 'derived-1h'), 1];
    const sf = fields.filter((f) => SENSOR_FIELDS.includes(f));
    const df = fields.filter((f) => DERIVED_FIELDS.includes(f));
    const base: Cols = key ? await api.read(key, t0, t1, sf.length ? sf : ['air_temperature']) : { t: new Float64Array(0) };
    const pick = (v: Float64Array) => v.filter((_, i) => i % step === 0);
    const t = pick(base.t);
    const cols: Record<string, Float64Array> = {};
    for (const f of sf) if (f in base) cols[f] = pick(base[f] as Float64Array);
    if (df.length && dkey) {
      const d = await api.read(dkey, t0 - 3600, t1, df);
      for (const f of df) if (f in d && d.t.length) cols[f] = interp(t, d.t, d[f] as Float64Array);
    }
    return [t, cols, period === 'PT1M' || period === 'PT1H' ? step : period === 'PT6H' || period === 'P1D' ? 60 : 3600];
  }

  async run(api: ModelApi): Promise<{ run_id: string; records: number }> {
    const s = this.settings;
    const t1 = api.now();
    const t0 = Math.max(0, t1 - PERIODS[s.period]);
    const fields = String(s.fields).split(',').map((f) => f.trim()).filter(Boolean);
    const [tAll, cols, stepS] = await this.series(api, t0, t1, fields);
    const names = fields.filter((f) => f in cols);
    if (!names.length) throw new NoRun(`none of the fields ${JSON.stringify(fields)} is published`);
    const rows: number[] = [];
    for (let i = 0; i < tAll.length; i++) if (names.every((f) => Number.isFinite(cols[f][i]))) rows.push(i);
    const t = Float64Array.from(rows, (i) => tAll[i]);
    const X = rows.map((i) => Float64Array.from(names, (f) => cols[f][i]));
    const k = Math.trunc(Number(s.clusters));
    if (X.length < Math.max(k, 3)) throw new NoRun(`only ${X.length} records in the period: too few to cluster`);
    const m = names.length;
    const mean = new Float64Array(m);
    const sd = new Float64Array(m);
    for (const r of X) for (let j = 0; j < m; j++) mean[j] += r[j] / X.length;
    for (const r of X) for (let j = 0; j < m; j++) sd[j] += (r[j] - mean[j]) ** 2 / X.length;
    const Z = X.map((r) => r.map((x, j) => (x - mean[j]) / (Math.sqrt(sd[j]) + 1e-9)));
    api.tap('scilibs', `cluster ${Z.length} records, algorithm ${s.algorithm}`,
      { algorithm: s.algorithm, fields: names, records: Z.length, clusters: k });
    const labels = kmeans(Z, k, SEEDS[s.algorithm] ?? KMEANS_SEED);
    const how = `stand-in: k-means (seed ${SEEDS[s.algorithm] ?? KMEANS_SEED})`;
    const det = detectSteps(t, names.map((_, j) => Float64Array.from(Z, (r) => r[j])), Number(s.sensitivity), stepS);
    const R = m > 1 ? corrcoef(X, m) : [[new PyFloat(1)]];
    api.tap('models', `${how}: ${new Set(labels).size} clusters; ${det.t.length} changes`, { method: how, changes: det.t.length });
    const sc = await api.score('changes', { t: det.t, scale: det.scale, t0: t[0], t1: t[t.length - 1] });
    const cs = await api.score('clusters', { t: Array.from(t), labels: Array.from(labels) });
    const scoreChanges = stepS <= 5 ? sc.boundary_recall : sc.front_recall;
    const scoreClusters = cs.ari_reach_kind;
    this.runs += 1;
    const runId = `run-${this.runs}`;
    const n = det.t.length;
    await api.publishMany(this.out.changes, {
      t: Float64Array.from(det.t), run_id: new Array(n).fill(runId), scale: det.scale.map((x) => (x === 0 ? 'minutes' : 'hours')),
      strength: Float64Array.from(det.strength, (x) => Math.round(x * 100) / 100),
    });
    await api.publishMany(this.out.clusters, { t, run_id: new Array(t.length).fill(runId), cluster: relabel(labels) });
    await api.publishMany(this.out.correlation, { t: Float64Array.of(t1), run_id: [runId], fields: [names.join(',')],
      matrix: [JSON.stringify(R.map((row) => row.map((x) => (x instanceof PyFloat ? x.v : x))))] });
    await api.publishMany(this.out.runs, {
      t: Float64Array.of(t1), run_id: [runId], command_id: [this.lastCommand], algorithm: [s.algorithm], fields: [names.join(',')],
      period: [s.period], window_start: [t[0]], window_end: [t[t.length - 1]], records: Float64Array.of(t.length),
      clusters: Float64Array.of(k), score_changes: Float64Array.of(scoreChanges ?? NaN),
      score_clusters: Float64Array.of(scoreClusters ?? NaN), scored_against: [SCORED_AGAINST],
      illustrative: Float64Array.of(1), // FR-06e: every stand-in result is illustrative
    });
    return { run_id: runId, records: t.length };
  }
}
