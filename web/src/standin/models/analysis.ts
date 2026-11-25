// Analysis, stand-in (FR-34, FR-35a, FR-06e): change detection, correlation and
// clustering, on Data cleanse's output only (AT-15). Per window of the current
// dataset it runs once on the last three hours of the bow's air temperature and wind
// speed; on a `clustering` command it runs on the data of interest the command
// carries. Every run is appended under its own `run_id` (FR-28a); a run whose
// selection includes CO₂ is published, with its runs-log entry, only under the
// restricted subsystem (FR-112), and a command naming CO₂ from a sender whose
// role lacks emissions is REJECTED (FR-112a, D-152). Simpler methods than the
// Python model: all three algorithms are k-means with their own seeds; changes
// come from a step detector. Every run is marked illustrative and unscored.
import { SENSORS } from '../constants';
import { datasetId } from '../csv';
import { M } from '../swe';
import { Api, Cols, Command, DatasetCtx, Model, Rejected, ReplayState, rng, runField } from './csmodel';

const DC = 'urn:x-barge:process:data-cleanse';
const KMEANS_SEED = 20310407;
const SEEDS: Record<string, number> = { A: KMEANS_SEED, B: KMEANS_SEED + 1, C: KMEANS_SEED + 2 };
const MAX_CLUSTERS = 8;
const RESOLUTIONS: Record<string, number> = { PT1S: 1, PT1M: 60, PT1H: 3600 };

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

/** Sustained steps in the standardised fields; peaks above 6/sensitivity, at least 2w apart. */
export function detectSteps(t: Float64Array, Z: Float64Array[], sensitivity: number, stepS: number) {
  const n = t.length;
  const out = { t: [] as number[], scale: [] as string[], strength: [] as number[] };
  const w = stepS <= 5 ? 24 : stepS <= 60 ? 45 : 8;
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
    out.scale.push(stepS <= 5 ? 'minutes' : 'hours');
    out.strength.push(Math.round(score[i] * 100) / 100);
  }
  return out;
}

function corrcoef(X: Float64Array[], m: number): number[][] {
  const n = X.length;
  const mean = new Float64Array(m);
  for (const r of X) for (let j = 0; j < m; j++) mean[j] += r[j] / n;
  const R: number[][] = [];
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
      R[a].push(Number.isFinite(v) ? Math.round(v * 1000) / 1000 : NaN);
    }
  }
  return R;
}

export interface Source {
  system: string;
  output: string;
  fields: string[];
}

export interface Doi {
  dataset: string | { file: string; sha256: string };
  start: string;
  end: string;
  resolution: string;
  sources: Source[];
}

/** The Data cleanse output a source is read from (AT-15), and whether it is CO₂. */
function cleanedFor(src: Source, field: string): { key: string; co2: boolean } | null {
  const s = SENSORS.find((x) => src.system.includes(`:sensor:${x}`) || src.output.includes(`-${x}`));
  if (!s) return null;
  const co2 = field === 'co2' || field.startsWith('co2_') || /:co2$|:restricted$/.test(src.system) || src.output.includes('co2');
  return co2 ? { key: `${DC}:restricted|cleaned-co2-${s}`, co2 } : { key: `${DC}|cleaned-${s}`, co2 };
}

export class Analysis extends Model {
  readonly id = 'analysis';
  readonly label = 'Analysis';
  description = 'Core model: change detection, correlation and clustering on a data of interest.';
  readonly maxRate = 10;
  window = 600;
  settings = { algorithm: 'B', clusters: 4, sensitivity: 5.0 };
  private runs = 0;

  async setup(api: Api): Promise<void> {
    await super.setup(api);
    this.controlKey = await api.createControlstream(this.uid, {
      name: 'Clustering', inputName: 'clustering', schema: M.record('Clustering settings', [
        M.category('algorithm', 'Algorithm', ['A', 'B', 'C']),
        M.text('doi', 'Data of interest (JSON): dataset, start, end, resolution, sources'),
        M.count('clusters', 'Number of clusters', 2, MAX_CLUSTERS),
        M.quantity('sensitivity', 'Change detector sensitivity', '1', 1, 10)]),
    });
  }

  private schemas(): Record<string, ReturnType<typeof M.record>> {
    return {
      runs: M.record('Runs', [M.time('time', 'Data range: end'), M.text('run_id', 'Analysis run'), runField(), M.text('command_id', 'Command'),
        M.text('algorithm', 'Algorithm'), M.text('sources', 'Sources (JSON)'), M.text('resolution', 'Resolution'),
        M.time('start', 'Data range: start'), M.time('end', 'Data range: end'), M.count('records', 'Records used'), M.count('clusters', 'Clusters'),
        M.quantity('sensitivity', 'Sensitivity', '1'), M.quantity('score_changes', 'Score: changes', '1'), M.quantity('score_clusters', 'Score: clusters', '1'),
        M.boolean('illustrative', 'Illustrative result (stand-in)')]),
      changes: M.record('Detected changes', [M.time(), M.text('run_id', 'Analysis run'), runField(),
        M.category('scale', 'Scale of the change', ['minutes', 'hours']), M.quantity('strength', 'Strength of the change', '1')]),
      clusters: M.record('Clusters', [M.time(), M.text('run_id', 'Analysis run'), runField(),
        M.category('cluster', 'Cluster', Array.from({ length: MAX_CLUSTERS }, (_, i) => `c${i + 1}`))]),
      correlation: M.record('Correlation', [M.time(), M.text('run_id', 'Analysis run'), runField(), M.text('fields', 'Fields, in matrix order'),
        M.text('matrix', 'Pearson correlation (JSON)')]),
    };
  }

  async prepare(api: Api, ds: DatasetCtx): Promise<void> {
    for (const [out, rec] of Object.entries(this.schemas())) {
      for (const uid of [this.uid, this.restrictedUid]) {
        await api.createDatastream(uid, { name: `${rec.label}, ${ds.id}${uid === this.uid ? '' : ', restricted'}`, outputName: `${out}__${ds.id}`, schema: rec });
      }
    }
  }

  /** The default run for a window: the last three hours of the bow's air temperature and wind speed, as minute means. */
  async process(api: Api, ds: DatasetCtx, _t0: number, t1: number, run: string): Promise<boolean> {
    const from = Math.max(ds.start, t1 - 3 * 3600);
    const probe = await api.read(`${DC}|cleaned-bow__${ds.id}`, Math.max(from, t1 - 5), t1, ['run']);
    if (!Array.from(probe.t).some((t, i) => t >= t1 && (probe.run as unknown[])[i] === run)) return false; // Data cleanse is behind
    const doi: Doi = {
      dataset: ds.id, start: '', end: '', resolution: 'PT1M',
      sources: [{ system: 'urn:x-barge:sensor:bow', output: 'weather', fields: ['air_temperature', 'apparent_wind_speed'] }],
    };
    await this.run(api, ds.id, from, t1, doi, run, '', this.settings.algorithm, this.settings.clusters, this.settings.sensitivity);
    return true;
  }

  private parseDoi(cmd: Command): Doi {
    let doi: Doi;
    try {
      doi = typeof cmd.parameters.doi === 'string' ? JSON.parse(cmd.parameters.doi) : (cmd.parameters.doi as Doi);
    } catch {
      throw new Rejected('doi is not a data of interest (JSON)');
    }
    if (!doi || typeof doi !== 'object') throw new Rejected('doi is not a data of interest (JSON)');
    return doi;
  }

  private dsOf(doi: Doi): string {
    const d = doi.dataset;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && d.file && d.sha256) return datasetId(d.file, d.sha256);
    throw new Rejected('doi.dataset names no dataset');
  }

  async validate(api: Api, cmd: Command): Promise<void> {
    const p = cmd.parameters;
    if (!['A', 'B', 'C'].includes(String(p.algorithm))) throw new Rejected(`algorithm ${JSON.stringify(p.algorithm)} is not one of A, B, C`);
    if (!Number.isInteger(p.clusters) || (p.clusters as number) < 2 || (p.clusters as number) > MAX_CLUSTERS) {
      throw new Rejected(`clusters ${JSON.stringify(p.clusters)} is outside its bounds, 2 to ${MAX_CLUSTERS}`);
    }
    if (typeof p.sensitivity !== 'number' || p.sensitivity < 1 || p.sensitivity > 10) {
      throw new Rejected(`sensitivity ${JSON.stringify(p.sensitivity)} is outside its bounds, 1 to 10`);
    }
    const doi = this.parseDoi(cmd);
    if (!(doi.resolution in RESOLUTIONS)) throw new Rejected(`resolution ${doi.resolution} is not available; available: PT1S, PT1M, PT1H`);
    if (!Array.isArray(doi.sources) || !doi.sources.length) throw new Rejected('doi.sources names no source');
    const ds = this.dsOf(doi);
    const fields = doi.sources.flatMap((s) => (s.fields ?? []).map((f) => cleanedFor(s, f)));
    if (fields.some((x) => x === null)) throw new Rejected('a requested source is not available');
    // FR-112a: the receiver checks the sender's role, whatever the client sent.
    if (fields.some((x) => x!.co2) && !this.senderReadsEmissions(cmd.sender)) throw new Rejected('a requested source is not available');
    if (!(await api.find(DC, `cleaned-bow__${ds}`))) throw new Rejected(`dataset ${ds} has not been processed`);
    const t0 = Date.parse(doi.start) / 1000;
    const t1 = Date.parse(doi.end) / 1000;
    if (!(t1 > t0)) throw new Rejected('doi.start must come before doi.end');
  }

  async apply(api: Api, cmd: Command, state: ReplayState | null): Promise<string> {
    const p = cmd.parameters;
    const doi = this.parseDoi(cmd);
    const ds = this.dsOf(doi);
    Object.assign(this.settings, { algorithm: String(p.algorithm), clusters: Number(p.clusters), sensitivity: Number(p.sensitivity) });
    const run = state && state.dataset === ds ? state.run : '';
    const r = await this.run(api, ds, Date.parse(doi.start) / 1000, Date.parse(doi.end) / 1000, doi, run, cmd.id,
      String(p.algorithm), Number(p.clusters), Number(p.sensitivity));
    return `${r.run_id} over ${r.records} records${r.restricted ? ' (restricted)' : ''}`;
  }

  /** Read the selection from Data cleanse's output, at its resolution. */
  private async series(api: Api, ds: string, t0: number, t1: number, doi: Doi, run: string): Promise<{ t: Float64Array; cols: Map<string, Float64Array>; co2: boolean }> {
    const step = RESOLUTIONS[doi.resolution] ?? 1;
    const cols = new Map<string, Float64Array>();
    let base: Float64Array | null = null;
    let co2 = false;
    const cache = new Map<string, Cols>();
    for (const src of doi.sources) {
      for (const f0 of src.fields ?? []) {
        const f = f0.replace(/_(min|max)$/, '');
        const c = cleanedFor(src, f)!;
        co2 ||= c.co2;
        const key = `${c.key}__${ds}`;
        let data = cache.get(key);
        if (!data) cache.set(key, (data = await api.read(key, t0, t1)));
        // the latest run of this dataset, or the replay run asked for (FR-35)
        const runs = data.run as unknown[];
        const want = run && runs.includes(run) ? run : (runs.length ? runs[runs.length - 1] : '');
        const tt: number[] = [];
        const vv: number[] = [];
        const v = data[f] as Float64Array | undefined;
        if (!v) continue;
        for (let i = 0; i < data.t.length; i++) if (runs[i] === want) {
          tt.push(Math.floor(data.t[i] / step) * step);
          vv.push(v[i]);
        }
        // bin to the resolution (means)
        const bins = new Map<number, [number, number]>();
        tt.forEach((t, i) => {
          if (!Number.isFinite(vv[i])) return;
          const b = bins.get(t) ?? [0, 0];
          b[0] += vv[i];
          b[1] += 1;
          bins.set(t, b);
        });
        const times = Float64Array.from([...bins.keys()].sort((a, b) => a - b));
        if (!base) base = times;
        const label = `${src.system.split(':').slice(-1)[0]}.${f}`;
        cols.set(label, Float64Array.from(base, (t) => {
          const b = bins.get(t);
          return b ? b[0] / b[1] : NaN;
        }));
      }
    }
    return { t: base ?? new Float64Array(0), cols, co2 };
  }

  private async run(api: Api, ds: string, t0: number, t1: number, doi: Doi, run: string, commandId: string,
    algorithm: string, k: number, sensitivity: number): Promise<{ run_id: string; records: number; restricted: boolean }> {
    const sel = await this.series(api, ds, t0, t1, doi, run);
    const names = [...sel.cols.keys()];
    const rows: number[] = [];
    for (let i = 0; i < sel.t.length; i++) if (names.every((f) => Number.isFinite(sel.cols.get(f)![i]))) rows.push(i);
    const t = Float64Array.from(rows, (i) => sel.t[i]);
    const X = rows.map((i) => Float64Array.from(names, (f) => sel.cols.get(f)![i]));
    if (X.length < Math.max(k, 3)) throw new Error(`only ${X.length} records in the selection: too few to cluster`);
    const m = names.length;
    const mean = new Float64Array(m);
    const sd = new Float64Array(m);
    for (const r of X) for (let j = 0; j < m; j++) mean[j] += r[j] / X.length;
    for (const r of X) for (let j = 0; j < m; j++) sd[j] += (r[j] - mean[j]) ** 2 / X.length;
    const Z = X.map((r) => r.map((x, j) => (x - mean[j]) / (Math.sqrt(sd[j]) + 1e-9)));
    api.sci('call', `cluster ${Z.length} records, algorithm ${algorithm}`, { algorithm, fields: names, records: Z.length, clusters: k });
    const labels = kmeans(Z, k, SEEDS[algorithm] ?? KMEANS_SEED);
    const det = detectSteps(t, names.map((_, j) => Float64Array.from(Z, (r) => r[j])), sensitivity, RESOLUTIONS[doi.resolution] ?? 1);
    const R = m > 1 ? corrcoef(X, m) : [[1]];
    api.sci('result', `k-means: ${new Set(labels).size} clusters; ${det.t.length} changes`, { changes: det.t.length });
    await api.score('clusters', { records: t.length }); // the referee: the stand-in is unscored (FR-06e)
    this.runs += 1;
    const runId = `a-${this.runs}`;
    const uid = sel.co2 ? this.restrictedUid : this.uid; // FR-112
    for (let i = 0; i < det.t.length; i++) {
      await api.publish(`${uid}|changes__${ds}`, { time: det.t[i], run_id: runId, run, scale: det.scale[i], strength: det.strength[i] });
    }
    const cl = relabel(labels);
    for (let i = 0; i < t.length; i++) await api.publish(`${uid}|clusters__${ds}`, { time: t[i], run_id: runId, run, cluster: cl[i] });
    await api.publish(`${uid}|correlation__${ds}`, {
      time: t[t.length - 1], run_id: runId, run, fields: names.join(','),
      matrix: JSON.stringify(R.map((r) => r.map((x) => (Number.isFinite(x) ? x : null)))),
    });
    await api.publish(`${uid}|runs__${ds}`, {
      time: t[t.length - 1], run_id: runId, run, command_id: commandId, algorithm, sources: JSON.stringify(doi.sources),
      resolution: doi.resolution, start: t[0], end: t[t.length - 1], records: t.length, clusters: k, sensitivity,
      score_changes: NaN, score_clusters: NaN, illustrative: true,
    });
    return { run_id: runId, records: t.length, restricted: sel.co2 };
  }
}
