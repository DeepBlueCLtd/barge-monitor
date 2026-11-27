// The handshake (FR-42 to FR-45): after login, standard discovery only (the landing
// page, conformance, the profile beside the server, every system, every datastream,
// every control stream), finding resources by unique id and output name, never by
// identifier. The profile is a template (FR-40a): its fixed essentials are checked
// here; its per-dataset essentials when a dataset is opened (fields.ts). Discovery
// happens only here (FR-44): after an import completes the client repeats it whole.
//
// FR-118, D-225: a datastream whose schema answers 403 is left out, like one the client
// cannot use. It is never reported missing and never makes a dataset degraded. The
// client keeps no list of such sources: it learns them from the server's answers.
import { ClientHttp, HttpError } from './http';

export interface SweField {
  type: string;
  name: string;
  label?: string;
  definition?: string;
  uom?: { code?: string; href?: string };
  quality?: { href: string }[];
  constraint?: { type?: string; values?: unknown[]; tokens?: unknown[]; intervals?: number[][] } & Record<string, unknown>;
  [k: string]: unknown;
}

export interface Essential {
  id: string;
  label?: string;
  system: string; // uniqueId
  datastream: string; // outputName, or a template with {dataset}
  field: string;
  type: string;
  uom?: string | null;
  resolution?: string;
  views?: string[];
  scope?: 'dataset' | 'fixed';
  kind?: string;
}

export interface Profile {
  id: string;
  title?: string;
  essentials: Essential[];
}

export interface SystemInfo {
  id: string;
  uid: string;
  label: string;
  assetType: string;
}

export interface DatastreamInfo {
  id: string;
  outputName: string;
  systemId: string;
  systemUid: string;
  /** A model's output: its system is a process (assetType Process). */
  fromModel: boolean;
}

export interface ControlStreamInfo {
  id: string;
  inputName: string;
  systemId: string;
  systemUid: string;
  fields: SweField[];
}

export interface Problem {
  essential: Essential;
  detail: string;
}

export interface Discovery {
  profile: Profile | null;
  /** The server claims the declared profile in its conformance (FR-41). */
  claimed: boolean;
  /** A claimed profile that discovery contradicts: the server is not used (FR-41, AT-08). */
  rejected: string | null;
  /** Fixed essentials missing (FR-45). */
  problems: Problem[];
  systems: Map<string, SystemInfo>;
  datastreams: DatastreamInfo[];
  controlstreams: ControlStreamInfo[];
  /** Schemas fetched so far, by datastream id (the handshake's own, and each dataset's on opening). */
  schemas: Map<string, SweField[]>;
  /** Datastreams the server refused to describe or serve (403): left out everywhere (FR-118). */
  refused: Set<string>;
}

export const fieldsOf = (schema: any): SweField[] => schema?.recordSchema?.fields ?? schema?.resultSchema?.fields ?? schema?.parametersSchema?.fields ?? schema?.fields ?? [];

export const essentialLabel = (e: Essential) => e.label ?? `${e.datastream}.${e.field}`;

/** The output name an essential names for a dataset (FR-40a). */
export const forDataset = (template: string, dataset: string) => template.replace('{dataset}', dataset);

/** The system, by unique id, among those discovery found. */
export function systemByUid(d: Discovery, uid: string): SystemInfo | null {
  for (const s of d.systems.values()) if (s.uid === uid) return s;
  return null;
}

/** A datastream by its system's unique id and its output name (PR-04). */
export function findDatastream(d: Discovery, uid: string, outputName: string): DatastreamInfo | null {
  return d.datastreams.filter((x) => x.systemUid === uid && x.outputName === outputName).pop() ?? null;
}

export function findControlStream(d: Discovery, uid: string, inputName: string): ControlStreamInfo | null {
  return d.controlstreams.find((x) => x.systemUid === uid && x.inputName === inputName) ?? null;
}

/** A control stream by input name alone, wherever discovery found it (a model's, for example). */
export function findControlStreamByInput(d: Discovery, inputName: string): ControlStreamInfo | null {
  return d.controlstreams.find((x) => x.inputName === inputName) ?? null;
}

/** Usable: listed, and not refused. */
export const readable = (d: Discovery, x: DatastreamInfo) => !d.refused.has(x.id);

export async function handshake(http: ClientHttp): Promise<Discovery> {
  http.paced = true;
  try {
    await http.get('');
    const conf: any = await http.get('conformance');
    const conformsTo: string[] = conf?.conformsTo ?? [];
    // FR-41: the profile is at a fixed path beside the server; it is not linked from the landing page.
    let profile: Profile | null = null;
    try {
      profile = await http.get<Profile>('profile.json');
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
    const claimed = !!profile && conformsTo.includes(profile.id);

    const systems = new Map<string, SystemInfo>();
    // Every system, subsystems included (D-193). A listing carries no parent link, and nothing here needs one.
    for (const s of await http.all<any>('systems', { searchMembers: 'true' })) {
      systems.set(s.id, {
        id: s.id, uid: s.properties?.uid ?? s.uniqueId ?? '', label: s.properties?.name ?? s.label ?? s.name ?? s.id,
        assetType: s.properties?.assetType ?? s.assetType ?? '',
      });
    }
    const uidOf = (sid: string) => systems.get(sid)?.uid ?? '';
    const datastreams: DatastreamInfo[] = (await http.all<any>('datastreams', { limit: '10000' })).map((x) => ({
      id: x.id, outputName: x.outputName, systemId: x['system@id'], systemUid: uidOf(x['system@id']),
      fromModel: systems.get(x['system@id'])?.assetType === 'Process',
    }));
    const controlstreams: ControlStreamInfo[] = (await http.all<any>('controlstreams')).map((c) => ({
      id: c.id, inputName: c.inputName ?? c.name, systemId: c['system@id'], systemUid: uidOf(c['system@id']), fields: [],
    }));
    const d: Discovery = { profile, claimed, rejected: null, problems: [], systems, datastreams, controlstreams, schemas: new Map(), refused: new Set() };

    // The fixed essentials (FR-40a): their schemas now, checked against the profile.
    for (const e of profile?.essentials ?? []) {
      if (e.scope === 'dataset') continue;
      if (e.kind === 'controlstream') {
        const cs = findControlStream(d, e.system, e.datastream);
        if (cs) await controlFields(http, cs).catch(() => []);
        const f = cs?.fields.find((x) => x.name === e.field);
        if (!cs) d.problems.push({ essential: e, detail: `control stream ${e.datastream} is not offered` });
        else if (!f || f.type !== e.type) d.problems.push({ essential: e, detail: `${e.datastream} has no ${e.type} ${e.field}` });
        continue;
      }
      const ds = findDatastream(d, e.system, e.datastream);
      if (ds) await fetchSchemas(http, d, [ds], false);
      const f = ds ? d.schemas.get(ds.id)?.find((x) => x.name === e.field) : undefined;
      if (!ds || d.refused.has(ds.id)) d.problems.push({ essential: e, detail: `${e.datastream} is not offered` });
      else if (!f) d.problems.push({ essential: e, detail: `${e.datastream} has no field ${e.field}` });
      else if (f.type !== e.type) d.problems.push({ essential: e, detail: `${e.field} is ${f.type}, expected ${e.type}` });
    }
    if (claimed && d.problems.length) {
      d.rejected = `The server claims the declared profile, but its discovery contradicts the claim: ${d.problems.map((p) => `${essentialLabel(p.essential)} (${p.detail})`).join('; ')}.`;
    }
    return d;
  } finally {
    http.paced = false;
  }
}

/**
 * The schema of each datastream given, fetched once and kept (FR-43: a dataset's field list, without a full
 * handshake). One that answers 403 is left out (FR-118, D-225); so is one gone since the handshake (404).
 */
export async function fetchSchemas(http: ClientHttp, d: Discovery, list: DatastreamInfo[], parallel = true): Promise<void> {
  const one = async (x: DatastreamInfo) => {
    const r = await http.request('GET', `datastreams/${x.id}/schema`, { obsFormat: 'application/swe+json' });
    if (r.status === 200) d.schemas.set(x.id, fieldsOf(r.body));
    else if (r.status === 403 || r.status === 404) d.refused.add(x.id);
    else throw new HttpError(`datastreams/${x.id}/schema`, r.status);
  };
  const todo = [...new Map(list.map((x) => [x.id, x])).values()].filter((x) => !d.schemas.has(x.id) && !d.refused.has(x.id));
  if (parallel) await Promise.all(todo.map(one));
  else for (const x of todo) await one(x);
}

/** A control stream's parameters, fetched once (its bounds are in its schema, FR-27). */
export async function controlFields(http: ClientHttp, cs: ControlStreamInfo): Promise<SweField[]> {
  if (!cs.fields.length) cs.fields = fieldsOf(await http.get(`controlstreams/${cs.id}/schema`));
  return cs.fields;
}
