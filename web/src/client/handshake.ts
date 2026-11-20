// The handshake (FR-40, FR-41): standard discovery only, then a check of the
// declared profile against what discovery actually shows (FR-39).
import type { DeclaredProfile } from '../generated/schemas';
import { ClientHttp } from './http';

export type Field = { type: string; name: string; label?: string; uom?: { code?: string }; constraint?: any; definition?: string; quality?: { href: string }[] };
export type Essential = DeclaredProfile['essentials'][number];

export interface Datastream {
  id: string;
  name: string;
  outputName: string;
  systemId: string;
  systemUid: string;
  systemLabel: string;
  fields: Field[];
}

export interface Problem {
  essential: Essential;
  reason: 'missing' | 'wrong type' | 'wrong unit';
  detail: string;
}

export interface Configuration {
  instance: string;
  profile: DeclaredProfile | null;
  claimed: boolean;
  rejected: string | null;
  problems: Problem[];
  bindings: Record<string, { ds: Datastream; field: Field }>; // essential id -> source
  generic: { ds: Datastream; field: Field }[];
  datastreams: Datastream[];
  control: { id: string; schema: { fields: Field[] } } | null;
}

async function all(http: ClientHttp, path: string, wait?: (s: number) => void): Promise<any[]> {
  const items: any[] = [];
  let offset = 0;
  for (;;) {
    const r = await http.get(path, { offset: String(offset) }, wait);
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
    items.push(...r.body.items);
    if (!r.body.links?.some((l: any) => l.rel === 'next')) return items;
    offset = items.length;
  }
}

export async function handshake(http: ClientHttp, wait?: (s: number) => void): Promise<Configuration> {
  const landing = await http.get('', undefined, wait);
  http.instance = landing.headers.get('x-server-instance');
  const conf = await http.get('conformance', undefined, wait);
  const profileLink = landing.body.links.find((l: any) => l.rel === 'profile');
  let profile: DeclaredProfile | null = null;
  if (profileLink) {
    const p = await http.get('profile', undefined, wait);
    if (p.status === 200) profile = p.body;
  }
  const claimed = !!profile && conf.body.conformsTo.includes(profile.id);
  const top = await all(http, 'systems', wait);
  const systems = [...top];
  for (const s of top) systems.push(...(await all(http, `systems/${s.id}/subsystems`, wait)));
  const bySys = new Map(systems.map((s) => [s.id, s]));
  const datastreams: Datastream[] = [];
  for (const d of await all(http, 'datastreams', wait)) {
    const sch = await http.get(`datastreams/${d.id}/schema`, { obsFormat: 'application/swe+json' }, wait);
    const s = bySys.get(d['system@id']);
    datastreams.push({ id: d.id, name: d.name, outputName: d.outputName, systemId: d['system@id'], systemUid: s?.uniqueId ?? '',
      systemLabel: s?.label ?? d['system@id'], fields: sch.body.recordSchema.fields });
  }
  let control: Configuration['control'] = null;
  const cs = await all(http, 'controlstreams', wait);
  if (cs.length) {
    const sch = await http.get(`controlstreams/${cs[0].id}/schema`, undefined, wait);
    control = { id: cs[0].id, schema: sch.body.parametersSchema };
  }
  const problems: Problem[] = [];
  const bindings: Configuration['bindings'] = {};
  for (const e of profile?.essentials ?? []) {
    const ds = datastreams.find((d) => d.systemUid === e.system && d.outputName === e.datastream);
    const f = ds?.fields.find((x) => x.name === e.field);
    if (!ds || !f) problems.push({ essential: e, reason: 'missing', detail: `${e.datastream}.${e.field} is not offered` });
    else if (f.type !== e.type) problems.push({ essential: e, reason: 'wrong type', detail: `${f.type}, expected ${e.type}` });
    else if ((f.uom?.code ?? null) !== e.uom) problems.push({ essential: e, reason: 'wrong unit', detail: `${f.uom?.code ?? 'none'}, expected ${e.uom}` });
    else bindings[e.id] = { ds, field: f };
  }
  const bound = new Set(Object.values(bindings).map((b) => `${b.ds.id}/${b.field.name}`));
  // Flag fields referenced as a measurement's quality are drawn with it, not as sources of their own.
  const qualityRefs = new Set(datastreams.flatMap((d) => d.fields.flatMap((f) => (f.quality ?? []).map((q) => `${d.id}/${q.href.replace('#', '')}`))));
  const generic = datastreams.flatMap((ds) => ds.fields
    .filter((f) => !(f.type === 'Time' && f.name === 'time') && !bound.has(`${ds.id}/${f.name}`) && !qualityRefs.has(`${ds.id}/${f.name}`))
    .map((field) => ({ ds, field })));
  const rejected = claimed && problems.length
    ? `The server claims the declared profile, but its discovery contradicts the claim: ${problems.map((p) => `${p.essential.label} (${p.reason}: ${p.detail})`).join('; ')}.`
    : null;
  return { instance: http.instance ?? '', profile, claimed, rejected, problems, bindings, generic, datastreams, control };
}
