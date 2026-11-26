// The handshake (FR-42 to FR-45): after login, standard discovery only (the
// landing page, conformance, the profile beside the server, every system,
// every datastream, every control stream), finding resources by unique id and
// output name, never by identifier. The profile is a template (FR-40a): its
// fixed essentials are checked here; its per-dataset essentials are checked when
// a dataset is loaded (fields.ts). Discovery happens only here (FR-44): after an
// import completes the client repeats the whole handshake.
import { ClientHttp } from './http';

export interface SweField {
  type: string;
  name: string;
  label?: string;
  definition?: string;
  uom?: { code?: string; href?: string };
  quality?: { href: string }[];
  constraint?: { type?: string; values?: unknown[]; intervals?: number[][] } & Record<string, unknown>;
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
  name: string;
  outputName: string;
  systemId: string;
  systemUid: string;
  /** The process kind of its system: true for a model's output (assetType Process). */
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
  /** A claimed profile that discovery contradicts is an error (FR-41). */
  rejected: string | null;
  /** Fixed essentials missing (FR-45). */
  problems: Problem[];
  systems: Map<string, SystemInfo>;
  datastreams: DatastreamInfo[];
  controlstreams: ControlStreamInfo[];
  /** Schemas fetched so far, by datastream id (the handshake's own, and each dataset's on load). */
  schemas: Map<string, SweField[]>;
  at: number;
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

/** A control stream by input name alone, wherever discovery found it (a model's settings, for example). */
export function findControlStreamByInput(d: Discovery, inputName: string): ControlStreamInfo | null {
  return d.controlstreams.find((x) => x.inputName === inputName) ?? null;
}

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
    } catch {
      profile = null;
    }
    const claimed = !!profile && conformsTo.includes(profile.id);

    const systems = new Map<string, SystemInfo>();
    // Every system, subsystems included (D-193). A listing carries no parent link, and nothing here needs one.
    for (const s of await http.all<any>('systems', { searchMembers: 'true' })) {
      systems.set(s.id, {
        id: s.id, uid: s.properties?.uid ?? s.uniqueId ?? '', label: s.properties?.name ?? s.label ?? s.id,
        assetType: s.properties?.assetType ?? s.assetType ?? '',
      });
    }
    const uidOf = (sid: string) => systems.get(sid)?.uid ?? '';
    const datastreams: DatastreamInfo[] = (await http.all<any>('datastreams')).map((d) => ({
      id: d.id, name: d.name ?? d.outputName, outputName: d.outputName, systemId: d['system@id'], systemUid: uidOf(d['system@id']),
      fromModel: systems.get(d['system@id'])?.assetType === 'Process',
    }));
    const controlstreams: ControlStreamInfo[] = (await http.all<any>('controlstreams')).map((c) => ({
      id: c.id, inputName: c.inputName ?? c.name, systemId: c['system@id'], systemUid: uidOf(c['system@id']), fields: [],
    }));
    const d: Discovery = { profile, claimed, rejected: null, problems: [], systems, datastreams, controlstreams, schemas: new Map(), at: Date.now() };

    // The fixed essentials (FR-40a): their schemas now, checked against the profile.
    for (const e of profile?.essentials ?? []) {
      if (e.scope === 'dataset') continue;
      if (e.kind === 'controlstream') {
        const cs = findControlStream(d, e.system, e.datastream);
        if (cs && !cs.fields.length) cs.fields = fieldsOf(await http.get(`controlstreams/${cs.id}/schema`));
        const f = cs?.fields.find((x) => x.name === e.field);
        if (!cs) d.problems.push({ essential: e, detail: `control stream ${e.datastream} of ${e.system} is not offered` });
        else if (!f || f.type !== e.type) d.problems.push({ essential: e, detail: `${e.datastream} has no ${e.type} ${e.field}` });
        continue;
      }
      const ds = findDatastream(d, e.system, e.datastream);
      if (ds && !d.schemas.has(ds.id)) d.schemas.set(ds.id, fieldsOf(await http.get(`datastreams/${ds.id}/schema`, { obsFormat: 'application/swe+json' })));
      const f = ds ? d.schemas.get(ds.id)!.find((x) => x.name === e.field) : undefined;
      if (!ds) d.problems.push({ essential: e, detail: `datastream ${e.datastream} of ${e.system} is not offered` });
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

/** The schema of each datastream given, fetched once and kept (FR-43: a dataset's field list, without a full handshake). */
export async function fetchSchemas(http: ClientHttp, d: Discovery, list: DatastreamInfo[]): Promise<void> {
  const todo = list.filter((x) => !d.schemas.has(x.id));
  await Promise.all(todo.map(async (x) => {
    d.schemas.set(x.id, fieldsOf(await http.get(`datastreams/${x.id}/schema`, { obsFormat: 'application/swe+json' })));
  }));
}

/** A control stream's parameters, fetched once (its bounds are in its schema, FR-27). */
export async function controlFields(http: ClientHttp, cs: ControlStreamInfo): Promise<SweField[]> {
  if (!cs.fields.length) cs.fields = fieldsOf(await http.get(`controlstreams/${cs.id}/schema`));
  return cs.fields;
}
