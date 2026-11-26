// The field list of the current dataset (FR-43, FR-53, FR-62), built from what
// discovery found and the datastreams' schemas, never from a list in the code.
// Each dataset's datastreams carry `__<dataset id>` in their output names (D-122).
//
// A field (a chip) is one measured or derived quantity of one subject: the subject
// comes from the datastream's output name and, for a datastream of a sensor, from its
// system's unique id. The same field is offered at up to three resolutions
// (FR-94, FR-94a): PT1S, PT1M and PT1H, read from different datastreams (readings, and
// the models' 1-minute and hourly summaries). Nothing here knows which fields exist: a
// field never seen before is offered and drawn by its SWE Common type (FR-62).
//
// Not offered as fields: a model's results kept per run that the profile names for a
// view (its `resolution` is `run`), every `runs` log (read generically for progress,
// FR-35b), and records carrying Text values, which no view draws (Data cleanse's blocks,
// D-280). Degraded mode is per dataset (FR-45): the profile's per-dataset essentials
// (FR-40a) are checked against this dataset when it is opened.
import { DatastreamInfo, Discovery, Essential, essentialLabel, findDatastream, forDataset, Problem, readable, SweField } from './discovery';

export type Resolution = 'PT1S' | 'PT1M' | 'PT1H';
export const RESOLUTIONS: Resolution[] = ['PT1S', 'PT1M', 'PT1H'];
export const RES_SECONDS: Record<string, number> = { PT1S: 1, PT1M: 60, PT1H: 3600 };

/** Words in output names that name a resolution, and words that name a processing stage, not a subject. */
const RES_WORDS: Record<string, Resolution> = { '1min': 'PT1M', '1h': 'PT1H' };
const STAGE_WORDS = new Set(['weather', 'cleaned', 'summary', 'derived', 'readings']);
/** A model's progress on a dataset, in every model's `runs` log (interfaces §8, §10.2). */
export const RUNS_OUTPUT = 'runs';

/** One datastream offering a field at one resolution. */
export interface Source {
  ds: DatastreamInfo;
  /** The output name without `__<dataset id>` (FR-94's `sources[].output`). */
  output: string;
  field: SweField;
  /** The datastream also carries `<field>_min` and `<field>_max` (FR-29). */
  stats: boolean;
  /** The datastream's rows carry a `run_id`: a model's results, of which the latest complete run is shown (FR-35). */
  runs: boolean;
}

export interface Property {
  key: string;
  label: string;
  field: string;
  type: string;
  uom: string | null;
  /** Named by the declared profile; anything else is optional, and may be new to this client (FR-62). */
  declared: boolean;
  byRes: Partial<Record<Resolution, Source>>;
}

export interface DatasetView {
  id: string;
  props: Property[];
  /** FR-45: per-dataset essentials missing from this dataset. */
  problems: Problem[];
  /** Per-dataset essentials of a model not yet published: the model is still preparing them (FR-35b). */
  awaited: Essential[];
  /** Model results kept per run: by output name, every readable datastream of that name for this dataset. */
  results: Map<string, DatastreamInfo[]>;
  /** Every readable runs log of this dataset (one per model, and per restricted subsystem the user may read). */
  runLogs: DatastreamInfo[];
}

export const suffixOf = (dataset: string) => `__${dataset}`;
export const datasetDatastreams = (d: Discovery, dataset: string) => d.datastreams.filter((x) => x.outputName.endsWith(suffixOf(dataset)));
export const outputOf = (outputName: string) => outputName.split('__')[0];

function words(text: string): string[] {
  return text.split(/[-_:]/).filter(Boolean);
}

function parse(ds: DatastreamInfo, dataset: string): { output: string; res: Resolution; subject: string[] } {
  const output = ds.outputName.slice(0, ds.outputName.length - suffixOf(dataset).length);
  const toks = words(output);
  const res = toks.map((t) => RES_WORDS[t]).find(Boolean) ?? 'PT1S';
  const subject = toks.filter((t) => !RES_WORDS[t] && !STAGE_WORDS.has(t));
  // A sensor's own datastream is about that sensor: its unique id's last parts name it.
  if (!ds.fromModel) subject.push(...ds.systemUid.split(':').slice(3));
  return { output, res, subject: [...new Set(subject)].sort() };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const DRAWABLE = new Set(['Quantity', 'Count', 'Category', 'Boolean']);

/** The fields of a record a view can draw: not the time, not QC flags, not min/max beside a mean, not the run. */
function drawable(fields: SweField[]): SweField[] {
  const names = new Set(fields.map((f) => f.name));
  const quality = new Set(fields.flatMap((f) => (f.quality ?? []).map((q) => q.href.replace(/^#/, ''))));
  return fields.filter((f) => DRAWABLE.has(f.type) && f.name !== 'time' && f.name !== 'run_id' && !quality.has(f.name) && !/_qc$/.test(f.name)
    && !(/_(min|max)$/.test(f.name) && names.has(f.name.replace(/_(min|max)$/, ''))));
}

/** Output names the profile ties to a view of a model's runs (`resolution: run`): drawn by those views, not offered as chips. */
export function resultOutputs(d: Discovery): Set<string> {
  const out = new Set<string>([RUNS_OUTPUT]);
  for (const e of d.profile?.essentials ?? []) if (e.resolution === 'run') out.add(outputOf(e.datastream));
  return out;
}

export function buildView(d: Discovery, dataset: string, complete: Set<string> = new Set()): DatasetView {
  const props = new Map<string, Property>();
  const results = new Map<string, DatastreamInfo[]>();
  const runLogs: DatastreamInfo[] = [];
  const kept = resultOutputs(d);
  const declared = new Set((d.profile?.essentials ?? []).filter((e) => e.scope === 'dataset' && e.resolution !== 'run').map((e) => e.field));
  for (const ds of datasetDatastreams(d, dataset)) {
    const fields = d.schemas.get(ds.id);
    if (!fields || !readable(d, ds)) continue;
    const { output, res, subject } = parse(ds, dataset);
    if (output === RUNS_OUTPUT) {
      runLogs.push(ds);
      continue;
    }
    if (kept.has(output)) {
      results.set(output, [...(results.get(output) ?? []), ds]);
      continue;
    }
    // A record carrying Text values is not drawn (Data cleanse's blocks, an Analysis correlation matrix).
    if (fields.some((f) => f.type === 'Text' && f.name !== 'run_id')) continue;
    const names = new Set(fields.map((f) => f.name));
    for (const f of drawable(fields)) {
      const subj = subject.filter((s) => !f.name.split('_').includes(s));
      const key = `${subj.join('+')}/${f.name}`;
      let p = props.get(key);
      if (!p) {
        p = {
          key, field: f.name, type: f.type, uom: f.uom?.code ?? null, declared: declared.has(f.name),
          label: `${subj.length ? subj.map(cap).join(' ') + ' · ' : ''}${f.label ?? f.name}`, byRes: {},
        };
        props.set(key, p);
      }
      const src: Source = { ds, output, field: f, stats: names.has(`${f.name}_min`) && names.has(`${f.name}_max`), runs: names.has('run_id') };
      const have = p.byRes[res];
      // At one resolution a sensor's own readings come before a model's copy of them.
      if (!have || (have.ds.fromModel && !ds.fromModel)) p.byRes[res] = src;
    }
  }
  const order = (p: Property) => (p.declared ? 0 : 1);
  const list = [...props.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label));
  const { problems, awaited } = checkDataset(d, dataset, complete);
  return { id: dataset, props: list, problems, awaited, results, runLogs };
}

/**
 * FR-45, FR-40a: every per-dataset essential, for this dataset. One a model publishes and has not yet is awaited, not
 * missing: the model is still preparing the dataset (FR-35b). The session says when a model's run is complete.
 */
export function checkDataset(d: Discovery, dataset: string, complete: Set<string> = new Set()): { problems: Problem[]; awaited: Essential[] } {
  const problems: Problem[] = [];
  const awaited: Essential[] = [];
  for (const e of d.profile?.essentials ?? []) {
    if (e.scope !== 'dataset') continue;
    const name = forDataset(e.datastream, dataset);
    const ds = findDatastream(d, e.system, name);
    const f = ds ? d.schemas.get(ds.id)?.find((x) => x.name === e.field) : undefined;
    const system = [...d.systems.values()].find((s) => s.uid === e.system);
    const fromModel = system?.assetType === 'Process';
    if (!ds || d.refused.has(ds.id)) {
      if (fromModel && !complete.has(e.system)) awaited.push(e);
      else problems.push({ essential: e, detail: `${name.replace('__', ' · ')} is not offered` });
    } else if (!f) problems.push({ essential: e, detail: `${name.replace('__', ' · ')} has no field ${e.field}` });
    else if (f.type !== e.type) problems.push({ essential: e, detail: `${e.field} is ${f.type}, expected ${e.type}` });
  }
  return { problems, awaited };
}

export function problemText(problems: Problem[]): string {
  return problems.map((p) => `${essentialLabel(p.essential)} (${p.detail})`).join('; ');
}

/** The essential the profile names for a view (its `views`), and a field. */
export function essentialFor(d: Discovery, view: string, field: string): Essential | null {
  return d.profile?.essentials.find((e) => e.views?.includes(view) && e.field === field) ?? null;
}

/** The source of a field at a resolution, or the nearest coarser one it has, or the nearest finer (FR-54). */
export function sourceAt(p: Property, res: Resolution): { src: Source; res: Resolution } | null {
  const i = RESOLUTIONS.indexOf(res);
  for (const r of [...RESOLUTIONS.slice(i), ...RESOLUTIONS.slice(0, i).reverse()]) {
    const s = p.byRes[r];
    if (s) return { src: s, res: r };
  }
  return null;
}
