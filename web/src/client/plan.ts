// The display client's field list and reading plan (FR-43, FR-53, FR-54, FR-29;
// docs/v4-interfaces.md §6). Built from the handshake alone: nothing here
// knows any measurement by name (FR-62). Fields are grouped into properties by
// their definition, so a cleaned value or a summary mean joins its raw quantity.
import type { Configuration, Datastream, Resolution, SweField } from './handshake';

export type PeriodId = 'PT1M' | 'PT1H' | 'PT6H' | 'P1D' | 'P7D' | 'P28D';
export const PERIODS: { id: PeriodId; label: string; seconds: number; want: number; binS: number }[] = [
  // want: the resolution to read (seconds); binS: interval for the error-bar plot (FR-58).
  { id: 'PT1M', label: '1 min', seconds: 60, want: 1, binS: 10 },
  { id: 'PT1H', label: '1 h', seconds: 3600, want: 1, binS: 300 },
  { id: 'PT6H', label: '6 h', seconds: 6 * 3600, want: 60, binS: 1800 },
  { id: 'P1D', label: 'Day', seconds: 86400, want: 60, binS: 7200 },
  { id: 'P7D', label: 'Week', seconds: 7 * 86400, want: 3600, binS: 12 * 3600 },
  { id: 'P28D', label: '4 weeks', seconds: 28 * 86400, want: 3600, binS: 2 * 86400 },
];
export const periodOf = (id: PeriodId) => PERIODS.find((p) => p.id === id)!;

/** Model B's run outputs feed the views, not the chips (docs/v4-interfaces.md §6). */
const RUN_OUTPUTS = new Set(['changes', 'clusters', 'correlation', 'runs']);
export const RES_S: Record<Resolution, number | null> = { raw: 1, PT1M: 60, PT1H: 3600, run: null, native: null };

/** How a field is drawn, by its SWE Common type alone (FR-62). */
export type Kind = 'line' | 'angle' | 'band' | 'steps';
export function kindOf(f: SweField): Kind | null {
  if (f.type === 'Quantity') return f.uom?.code === 'deg' ? 'angle' : 'line';
  if (f.type === 'Count') return 'steps';
  if (f.type === 'Category' || f.type === 'Boolean') return 'band';
  return null;
}

export interface Source {
  ds: Datastream;
  field: SweField;
}

/** One chip: a property, with every datastream that carries it. */
export interface Property {
  key: string; // the definition, or the field name when there is none
  name: string; // the property name used in commands (FR-55)
  label: string;
  type: string;
  uom: string | null;
  kind: Kind;
  essential: boolean; // named in the profile: drawn solid; otherwise dashed, "optional" (FR-53)
  sources: Source[];
  /** Set when an essential source for it is unavailable: the chip is disabled, naming why (FR-45). */
  unavailable: string | null;
}

const isQualityFlag = (ds: Datastream, f: SweField) =>
  f.name.endsWith('_qc') || ds.fields.some((g) => (g.quality ?? []).some((q) => q.href.replace(/^#/, '') === f.name));

export function properties(config: Configuration): Property[] {
  const essentialFields = new Set((config.profile?.essentials ?? []).map((e) => `${e.system} ${e.datastream} ${e.field}`));
  const out = new Map<string, Property>();
  for (const ds of config.datastreams) {
    if (RUN_OUTPUTS.has(ds.outputName)) continue;
    // Sensor properties are plotted from the bow sensor: the stern's streams and stern variants are left out.
    if (/stern/i.test(ds.systemUid) || /-stern$/.test(ds.outputName)) continue;
    for (const f of ds.fields) {
      if (f.name === 'time' || f.type === 'Time' || f.type === 'Text' || isQualityFlag(ds, f)) continue;
      const kind = kindOf(f);
      if (!kind) continue;
      const key = f.definition ?? f.name;
      let p = out.get(key);
      if (!p) {
        p = { key, name: f.name, label: f.label ?? f.name, type: f.type, uom: f.uom?.code ?? null, kind, essential: false, sources: [], unavailable: null };
        out.set(key, p);
      }
      p.sources.push({ ds, field: f });
      if (essentialFields.has(`${ds.systemUid} ${ds.outputName} ${f.name}`)) p.essential = true;
      // Prefer the name and label of the raw sensor field.
      if (ds.resolution === 'raw') Object.assign(p, { name: f.name, label: f.label ?? f.name });
    }
  }
  // FR-45: a missing or mistyped essential disables the control for its property.
  for (const pr of config.problems) {
    const e = pr.essential;
    for (const p of out.values()) {
      if (p.name === e.field || p.key.endsWith(`/${e.field}`)) {
        p.essential = true;
        p.unavailable = `${e.label ?? `${e.datastream}.${e.field}`}: ${pr.reason} (${pr.detail})`;
      }
    }
    // An essential that is missing altogether still gets a disabled chip, so the viewer sees what is absent.
    if (![...out.values()].some((p) => p.name === e.field) && e.datastream !== 'clusters' && e.datastream !== 'changes' && e.datastream !== 'runs') {
      out.set(`missing:${e.field}`, { key: `missing:${e.field}`, name: e.field, label: e.label ?? e.field, type: e.type, uom: e.uom ?? null, kind: 'line',
        essential: true, sources: [], unavailable: `${e.label ?? e.field}: ${pr.reason} (${pr.detail})` });
    }
  }
  // Essentials first, in discovery order; then the optional ones.
  return [...out.values()].sort((a, b) => Number(b.essential) - Number(a.essential));
}

/** Which datastream to read a property from for a period (FR-29, docs/v4-interfaces.md §6). */
export function sourceFor(p: Property, period: PeriodId): Source | null {
  if (!p.sources.length) return null;
  const want = periodOf(period).want;
  // Datastreams the profile names carry a declared resolution; prefer them.
  const declared = p.sources.filter((s) => RES_S[s.ds.resolution] != null);
  if (declared.length) {
    // The finest resolution that is not finer than the period wants; else the coarsest there is.
    const ok = declared.filter((s) => RES_S[s.ds.resolution]! >= want).sort((a, b) => RES_S[a.ds.resolution]! - RES_S[b.ds.resolution]!);
    if (ok.length) return ok[0];
    return [...declared].sort((a, b) => RES_S[b.ds.resolution]! - RES_S[a.ds.resolution]!)[0];
  }
  // A property found only in datastreams the profile does not name: read at native resolution.
  return p.sources[0];
}

export interface Read {
  ds: Datastream;
  fields: SweField[];
  props: Property[];
  raw: boolean;
}

/** The set of reads one selection makes: one per datastream (FR-54: one set of requests per preset). */
export function readingPlan(props: Property[], period: PeriodId): Read[] {
  const reads = new Map<string, Read>();
  for (const p of props) {
    const s = sourceFor(p, period);
    if (!s) continue;
    let r = reads.get(s.ds.id);
    if (!r) reads.set(s.ds.id, (r = { ds: s.ds, fields: [], props: [], raw: s.ds.resolution === 'raw' }));
    r.fields.push(s.field);
    r.props.push(p);
  }
  return [...reads.values()];
}

export function runStream(config: Configuration, outputName: 'runs' | 'clusters' | 'changes'): Datastream | null {
  return config.datastreams.find((d) => d.outputName === outputName && !/stern/i.test(d.systemUid)) ?? null;
}
