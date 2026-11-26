// The handshake (FR-42..FR-45): standard discovery only (landing page,
// conformance, profile, systems, datastreams and schemas), then a check of
// the declared profile against what discovery actually shows (FR-41).
// Discovery happens only here; the client never adds or removes sources while running (FR-44).
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

export interface Configuration {
  instance: string;
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

/** The path of a link relative to the API base, so the client follows links without absolute URLs (FR-04). */
function relPath(href: string): string {
  const i = href.indexOf('/api/');
  if (i >= 0) return href.slice(i + 5);
  return href.replace(/^\/+/, '');
}

const fieldsOf = (schema: any): SweField[] => schema?.recordSchema?.fields ?? schema?.resultSchema?.fields ?? schema?.parametersSchema?.fields ?? schema?.fields ?? [];

export async function handshake(http: ClientHttp, wait?: (s: number) => void): Promise<Configuration> {
  const landing = await http.get('', undefined, wait);
  if (landing.status !== 200) throw new HttpError('landing page', landing.status, landing.body);
  http.instance = landing.headers.get('x-server-instance') ?? landing.headers.get('etag')?.replace(/"/g, '') ?? null;
  const conf = await http.get('conformance', undefined, wait);
  const conformsTo: string[] = conf.body?.conformsTo ?? [];
  const profileLink = (landing.body?.links ?? []).find((l: any) => l.rel === 'profile' || String(l.rel).endsWith('/profile'));
  let profile: Profile | null = null;
  if (profileLink) {
    const p = await http.get(relPath(profileLink.href), undefined, wait);
    if (p.status === 200) profile = p.body;
  }
  const claimed = !!profile && conformsTo.includes(profile.id);

  // Systems, with subsystems (the sensors under the platform, the models under Models).
  const systems: any[] = [];
  const visit = async (path: string, depth: number) => {
    for (const s of await http.all(path, {}, wait)) {
      systems.push(s);
      if (depth < 2) await visit(`systems/${s.id}/subsystems`, depth + 1);
    }
  };
  await visit('systems', 0);
  const bySys = new Map(systems.map((s) => [s.id, s]));

  const named = new Map<string, Resolution>();
  for (const e of profile?.essentials ?? []) if (e.resolution) named.set(`${e.system} ${e.datastream}`, e.resolution);

  const datastreams: Datastream[] = [];
  for (const d of await http.all('datastreams', {}, wait)) {
    const sch = await http.get(`datastreams/${d.id}/schema`, { obsFormat: 'application/swe+json' }, wait);
    const sysId = d['system@id'] ?? d.system?.id ?? d.systemId;
    const s = bySys.get(sysId);
    const uid = s?.uniqueId ?? s?.properties?.uid ?? '';
    datastreams.push({
      id: d.id, name: d.name ?? d.outputName, outputName: d.outputName, systemId: sysId, systemUid: uid,
      systemLabel: s?.label ?? s?.name ?? s?.properties?.name ?? sysId,
      fields: sch.status === 200 ? fieldsOf(sch.body) : [],
      resolution: named.get(`${uid} ${d.outputName}`) ?? 'native',
    });
  }

  // Analysis's clustering control stream: its fields carry the bounds (FR-27, FR-55).
  let clustering: ControlStream | null = null;
  // Control streams are listed under the system that owns them (Connected Systems Part 2).
  const streams: any[] = [];
  for (const s of systems) {
    if (s.properties?.assetType && s.properties.assetType !== 'Process') continue;
    if (s.assetType && s.assetType !== 'Process') continue;
    const r = await http.get(`systems/${s.id}/controlstreams`, undefined, wait);
    if (r.status === 200) streams.push(...(Array.isArray(r.body) ? r.body : r.body?.items ?? []).map((c: any) => ({ 'system@id': s.id, ...c })));
  }
  const cs = streams.find((c: any) => [c.inputName, c.name, c.id].some((v) => String(v ?? '').toLowerCase().includes('clustering')));
  if (cs) {
    const sch = await http.get(`controlstreams/${cs.id}/schema`, undefined, wait);
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
  return { instance: http.instance ?? '', profile, claimed, rejected, problems, datastreams, clustering };
}
