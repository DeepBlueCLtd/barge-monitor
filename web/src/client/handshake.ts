// The handshake (FR-42..FR-45): standard discovery only (landing page,
// conformance, profile, systems, datastreams and schemas), then a check of
// the declared profile against what discovery actually shows (FR-41).
// Discovery happens only here; the client never adds or removes sources while running (FR-44).
//
// 4.7 (docs/v4-interfaces.md §9): every system is found by GET /systems?searchMembers=true
// (D-193); the profile is at profile.json beside the API, not linked (FR-41); a datastream
// whose schema answers 403 is left out, like one the client cannot use (FR-118, D-225).
//
// The bridge to 4.7's models (plan Phase 6, D-286), until the display client of Phase 7 opens
// datasets: the 4.1 client shows Mission A. Its datastreams `<output>__<Mission A>` are taken
// under their 4.1 names, and stand in for the logger's `weather`; other datasets' are left out,
// as are outputs the 4.1 views never draw (Data cleanse's blocks, correlation, CO₂, the
// restricted subsystems, the runs logs of other models than Analysis).
import { ClientHttp, HttpError } from './http';

export interface SweField {
  type: string;
  name: string;
  label?: string;
  definition?: string;
  uom?: { code?: string; href?: string };
  quality?: { href: string }[];
  constraint?: unknown;
  [k: string]: unknown;
}

export type Resolution = 'raw' | 'PT1M' | 'PT1H' | 'run' | 'native';

export interface Essential {
  id?: string;
  label?: string;
  system: string; // uniqueId
  datastream: string; // outputName
  field: string;
  type: string;
  uom?: string | null;
  resolution?: Resolution;
  views?: string[];
}

export interface Profile {
  id: string;
  title?: string;
  essentials: Essential[];
}

export interface Datastream {
  id: string;
  name: string;
  outputName: string;
  systemId: string;
  systemUid: string;
  systemLabel: string;
  fields: SweField[];
  /** From the profile when it names this datastream; otherwise native (docs/v4-interfaces.md §5). */
  resolution: Resolution;
}

export interface Problem {
  essential: Essential;
  reason: 'missing' | 'wrong type' | 'wrong unit';
  detail: string;
}

export interface ControlStream {
  id: string;
  systemId: string;
  name: string;
  fields: SweField[];
}

/** The dataset the 4.1 client shows (D-286): Mission A, as the importer's catalogue names it. */
export interface BridgeDataset {
  id: string;
  file: string;
  size: number;
  modified: string;
  sha256: string;
  start: string;
  end: string;
}

export interface Configuration {
  /** The dataset shown (D-286); null before Mission A is imported. */
  dataset: BridgeDataset | null;
  profile: Profile | null;
  claimed: boolean;
  /** FR-41: a claimed profile that discovery contradicts is an error. */
  rejected: string | null;
  problems: Problem[];
  datastreams: Datastream[];
  /** Analysis's clustering control stream (FR-55), if offered. */
  clustering: ControlStream | null;
}

export const essentialLabel = (e: Essential) => e.label ?? `${e.datastream}.${e.field}`;

const fieldsOf = (schema: any): SweField[] => schema?.recordSchema?.fields ?? schema?.resultSchema?.fields ?? schema?.parametersSchema?.fields ?? schema?.fields ?? [];

export async function handshake(http: ClientHttp): Promise<Configuration> {
  const landing = await http.get('');
  if (landing.status !== 200) throw new HttpError('landing page', landing.status, landing.body);
  const conf = await http.get('conformance');
  const conformsTo: string[] = conf.body?.conformsTo ?? [];
  // The profile is at a fixed path beside the server (FR-41).
  const p = await http.get('profile.json');
  const profile: Profile | null = p.status === 200 && typeof p.body === 'object' ? p.body : null;
  const claimed = !!profile && conformsTo.includes(profile.id);

  // Every system, subsystems included, in one listing (D-193); SensorML gives each one's uniqueId.
  const systems: any[] = await http.all('systems', { searchMembers: 'true', f: 'application/sml+json' });
  const bySys = new Map(systems.map((s) => [s.id, s]));

  const named = new Map<string, Resolution>();
  for (const e of profile?.essentials ?? []) if (e.resolution) named.set(`${e.system} ${e.datastream}`, e.resolution);

  const datastreams: Datastream[] = [];
  const listed: any[] = await http.all('datastreams');
  const uidOf = (d: any) => {
    const s = bySys.get(d['system@id'] ?? d.system?.id ?? d.systemId);
    return s?.uniqueId ?? s?.properties?.uid ?? '';
  };
  const shown = bridged(listed, uidOf);
  let dataset: BridgeDataset | null = null;
  if (shown.dataset) {
    const cat = listed.find((d) => d.outputName === 'catalogue' && uidOf(d) === 'urn:x-barge:importer');
    const rows: any[] = cat ? await http.all(`datastreams/${cat.id}/observations`, { f: 'application/swe+json' }) : [];
    const row = [...rows].reverse().find((r) => r.dataset === shown.dataset);
    if (row) dataset = { id: row.dataset, file: row.file, size: row.size, modified: row.modified, sha256: row.sha256, start: row.start, end: row.end };
  }
  for (const [d, outputName] of shown.list) {
    const sch = await http.get(`datastreams/${d.id}/schema`, { obsFormat: 'application/swe+json' });
    if (sch.status === 403) continue; // not for this account: left out, never reported missing (FR-118)
    const sysId = d['system@id'] ?? d.system?.id ?? d.systemId;
    const s = bySys.get(sysId);
    const uid = s?.uniqueId ?? s?.properties?.uid ?? '';
    datastreams.push({
      id: d.id, name: d.name ?? outputName, outputName, systemId: sysId, systemUid: uid,
      systemLabel: s?.label ?? s?.name ?? s?.properties?.name ?? sysId,
      fields: sch.status === 200 ? fieldsOf(sch.body) : [],
      resolution: named.get(`${uid} ${outputName}`) ?? 'native',
    });
  }

  // Analysis's clustering control stream: its fields carry the bounds (FR-27, FR-55).
  let clustering: ControlStream | null = null;
  // Control streams are listed under the system that owns them (Connected Systems Part 2).
  const streams: any[] = [];
  for (const s of systems) {
    if (s.properties?.assetType && s.properties.assetType !== 'Process') continue;
    if (s.assetType && s.assetType !== 'Process') continue;
    const r = await http.get(`systems/${s.id}/controlstreams`);
    if (r.status === 200) streams.push(...(Array.isArray(r.body) ? r.body : r.body?.items ?? []).map((c: any) => ({ 'system@id': s.id, ...c })));
  }
  const cs = streams.find((c: any) => [c.inputName, c.name, c.id].some((v) => String(v ?? '').toLowerCase().includes('clustering')));
  if (cs) {
    const sch = await http.get(`controlstreams/${cs.id}/schema`);
    clustering = { id: cs.id, systemId: cs['system@id'] ?? '', name: cs.inputName ?? cs.name ?? cs.id, fields: sch.status === 200 ? fieldsOf(sch.body) : [] };
  }

  // FR-45: every essential must be offered with the declared type and unit.
  const problems: Problem[] = [];
  for (const e of profile?.essentials ?? []) {
    const ds = datastreams.find((d) => d.systemUid === e.system && d.outputName === e.datastream);
    const f = ds?.fields.find((x) => x.name === e.field);
    if (!ds) problems.push({ essential: e, reason: 'missing', detail: `datastream ${e.datastream} of ${e.system.split(':').pop()} is not offered` });
    else if (!f) problems.push({ essential: e, reason: 'missing', detail: `${e.datastream} has no field ${e.field}` });
    else if (f.type !== e.type) problems.push({ essential: e, reason: 'wrong type', detail: `${f.type}, expected ${e.type}` });
    else if ((e.uom ?? null) !== null && (f.uom?.code ?? null) !== e.uom) problems.push({ essential: e, reason: 'wrong unit', detail: `${f.uom?.code ?? 'none'}, expected ${e.uom}` });
  }
  const rejected = claimed && problems.length
    ? `The server claims the declared profile, but its discovery contradicts the claim: ${problems.map((p) => `${essentialLabel(p.essential)} (${p.reason}: ${p.detail})`).join('; ')}.`
    : null;
  return { dataset, profile, claimed, rejected, problems, datastreams, clustering };
}

const MISSION_A = /^mission-a-/;
/** Outputs the 4.1 views never draw (D-286). */
const NOT_DRAWN = /^(cleaned-|correlation$|co2$|summary-1(min|h)-co2-)/;

/**
 * The bridge (D-286): which listed datastreams the 4.1 client takes, and under which name. Mission A's per-dataset
 * outputs under their 4.1 names, standing in for the logger's `weather`; nothing of another dataset.
 */
export function bridged(listed: any[], uidOf: (d: any) => string): { dataset: string | null; list: [any, string][] } {
  const ids = listed.map((d) => String(d.outputName).split('__')[1]).filter((x): x is string => !!x && MISSION_A.test(x));
  const dataset = ids.length ? ids[ids.length - 1] : null;
  const list: [any, string][] = [];
  for (const d of listed) {
    const [name, ds] = String(d.outputName).split('__');
    const uid = uidOf(d);
    if (/:restricted$|:co2$/.test(uid)) continue;
    if (ds === undefined) {
      if (dataset && name === 'weather') continue; // Mission A's weather stands in for the logger's
      list.push([d, name]);
    } else if (ds === dataset && !NOT_DRAWN.test(name) && (name !== 'runs' || uid === 'urn:x-barge:process:analysis')) {
      list.push([d, name]);
    }
  }
  return { dataset, list };
}
