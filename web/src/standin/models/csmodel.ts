// What every stand-in model is written against (docs/v4-interfaces.md §10.1;
// backend/models/csmodel.py): the data server's Connected Systems interface,
// as HTTP requests with the model's service credentials. In the stand-in the
// models share a worker with the server, so `send` hands each request to the
// same entry point the relay uses (freeze, server down and capture included);
// nothing else differs. A datastream is named by a key, "system uid|outputName",
// which outlives restarts; the opaque identifier behind it is found by
// discovery and looked up again when the server says it has gone.
//
// The replay controller uses the same client with its own account.
import type { HttpRequest, HttpResponse } from '../api';
import { basic } from '../accounts';
import { LineReader } from '../stream';
import { Component, DataRecord, M } from '../swe';
import type { ComponentId, Tap } from '../tap';
import { iso, parseIso } from '../time';
import { NUMERIC } from '../store';
import type { StatusReport } from '../store';

/** The data server does not answer (down, starting): try again later. */
export class Unavailable extends Error {}
/** The data server refused the request. */
export class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
/** A command's parameters are out of bounds: reported as REJECTED, naming the bound (FR-27). */
export class Rejected extends Error {}

export interface Command {
  id: string;
  parameters: Record<string, unknown>;
  issueTime: string;
  sender?: string;
}

export type Row = Record<string, unknown> & { time?: number };
/** Columns of observations: `t` (Unix seconds) and one column per field. Numbers as Float64Array, NaN where missing. */
export type Cols = { t: Float64Array } & Record<string, Float64Array | unknown[]>;

export interface ApiOptions {
  user: string;
  password: string;
  /** The model's id, sent as x-tap-model (capture only); none for the replay controller. */
  model?: string;
  /** Who this client is on the flowchart, for scientific-library calls. */
  component: ComponentId;
  send: (req: HttpRequest) => Promise<HttpResponse | null>;
  tap: Tap;
}

const PAGE = 10_000;

/**
 * A command's outcome: its latest status report other than PENDING (D-199, revising D-164). OpenSensorHub stores
 * the sender's PENDING when the POST answers (about 5 s after it was sent), often after the receiver's COMPLETED.
 */
export function commandOutcome(reports: StatusReport[], cmdId: string): StatusReport | null {
  let best: StatusReport | null = null;
  for (const r of reports) {
    if (r['command@id'] !== cmdId || r.statusCode === 'PENDING') continue;
    if (!best || (r.reportTime ?? '') >= (best.reportTime ?? '')) best = r;
  }
  return best;
}

export class Api {
  quiet = false;
  private ids = new Map<string, string>(); // key -> datastream or control stream id
  private systems = new Map<string, string>(); // uid -> system id
  private types = new Map<string, Map<string, string>>(); // datastream id -> field -> SWE type

  constructor(readonly o: ApiOptions) {}

  get tap(): Tap {
    return this.o.tap;
  }

  /** Forget every identifier found: after Reset instance nothing found before exists. */
  forget(): void {
    this.ids.clear();
    this.systems.clear();
    this.types.clear();
  }

  /** Capture a call into, or a result out of, the scientific libraries (models ↔ scilibs). */
  sci(dir: 'call' | 'result', summary: string, content?: unknown): void {
    const me = this.o.component;
    const [src, dst] = dir === 'call' ? [me, 'scilibs' as const] : ['scilibs' as const, me];
    const m = this.o.model;
    this.tap.emit(src, dst, 'I', m ? `${m}: ${summary}` : summary, content, { model: m, quiet: this.quiet });
  }

  // --- one request ---------------------------------------------------------------------------
  private async request(method: string, target: string, body?: unknown, ctype = 'application/json'): Promise<HttpResponse> {
    const headers: [string, string][] = [['authorization', basic(this.o.user, this.o.password)]];
    if (this.o.model) headers.push(['x-tap-model', this.o.model]);
    if (this.quiet) headers.push(['x-tap-quiet', '1']);
    let raw: Uint8Array | null = null;
    if (body !== undefined) {
      raw = new TextEncoder().encode(JSON.stringify(body));
      headers.push(['content-type', ctype]);
    }
    const q = target.indexOf('?');
    const res = await this.o.send({
      method, path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), body: raw, headers,
      rootPath: '', origin: 'http://server',
    });
    if (res === null) throw new Unavailable('the data server does not answer');
    if (res.status >= 400) {
      const text = new TextDecoder().decode(res.body);
      const why = /<p>([^<]*)<\/p>/.exec(text)?.[1] ?? '';
      throw new Refused(res.status, `${method} ${target}: ${res.status} ${why}`.trim());
    }
    return res;
  }

  private async getJson(target: string): Promise<any> {
    const r = await this.request('GET', target);
    return JSON.parse(new TextDecoder().decode(r.body));
  }

  private location(r: HttpResponse): string {
    const loc = r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] ?? '';
    return loc.replace(/\/+$/, '').split('/').pop()!;
  }

  // --- discovery ------------------------------------------------------------------------------------
  /** A system's id by its unique id, through discovery: every system, subsystems included (D-193). */
  async findSystem(uid: string): Promise<string | null> {
    const known = this.systems.get(uid);
    if (known) return known;
    const all = await this.getJson('/systems?searchMembers=true&f=application/sml%2Bjson&limit=100000');
    for (const s of all.items) this.systems.set(s.uniqueId ?? s.properties?.uid, s.id);
    return this.systems.get(uid) ?? null;
  }

  async createSystem(body: Record<string, unknown>, parentUid: string | null = null): Promise<string> {
    let path = '/systems';
    if (parentUid) {
      const p = await this.findSystem(parentUid);
      if (!p) throw new Refused(404, `no system ${parentUid}`);
      path = `/systems/${p}/subsystems`;
    }
    const r = await this.request('POST', path, body, 'application/sml+json');
    const id = this.location(r);
    this.systems.set(String(body.uniqueId), id);
    return id;
  }

  /** Create a datastream (201 is success, new or existing: §9.1). Returns its key. */
  async createDatastream(systemUid: string, body: { name?: string; outputName: string; schema: DataRecord; description?: string }): Promise<string> {
    const sid = await this.findSystem(systemUid);
    if (!sid) throw new Refused(404, `no system ${systemUid}`);
    const r = await this.request('POST', `/systems/${sid}/datastreams`, {
      name: body.name ?? body.outputName, outputName: body.outputName, description: body.description,
      schema: { obsFormat: 'application/swe+json', recordSchema: body.schema },
    });
    const key = `${systemUid}|${body.outputName}`;
    const id = this.location(r);
    this.ids.set(key, id);
    this.types.set(id, new Map(body.schema.fields.map((f) => [f.name, f.type])));
    return key;
  }

  async createControlstream(systemUid: string, body: { name?: string; inputName: string; schema: DataRecord }): Promise<string> {
    const sid = await this.findSystem(systemUid);
    if (!sid) throw new Refused(404, `no system ${systemUid}`);
    const r = await this.request('POST', `/systems/${sid}/controlstreams`, {
      name: body.name ?? body.inputName, inputName: body.inputName, schema: { commandFormat: 'application/json', parametersSchema: body.schema },
    });
    const key = `${systemUid}|${body.inputName}`;
    this.ids.set(key, this.location(r));
    return key;
  }

  /** The key of a system's datastream (or control stream), or null while it is not there. */
  async find(systemUid: string, outputName: string, controlstream = false): Promise<string | null> {
    const key = `${systemUid}|${outputName}`;
    if (this.ids.has(key)) return key;
    const sid = await this.findSystem(systemUid);
    if (!sid) return null;
    const list = await this.getJson(`/systems/${sid}/${controlstream ? 'controlstreams' : 'datastreams'}?limit=10000`);
    const hit = (list.items as any[]).filter((d) => (controlstream ? d.inputName : d.outputName) === outputName).pop();
    if (!hit) return null;
    this.ids.set(key, hit.id);
    return key;
  }

  private async id(key: string): Promise<string> {
    let id = this.ids.get(key);
    if (!id) {
      const i = key.indexOf('|');
      if (!(await this.find(key.slice(0, i), key.slice(i + 1)))) throw new Refused(404, `datastream ${key} is not there`);
      id = this.ids.get(key)!;
    }
    return id;
  }

  /** Run `call(id)`; if the identifier has gone, look it up once more. */
  private async on<T>(key: string, call: (id: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.id(key));
    } catch (e) {
      if (!(e instanceof Refused) || e.status !== 404) throw e;
      this.ids.delete(key);
      this.systems.clear();
      return call(await this.id(key));
    }
  }

  async fieldTypes(key: string): Promise<Map<string, string>> {
    return this.on(key, async (id) => {
      let t = this.types.get(id);
      if (!t) {
        const s = await this.getJson(`/datastreams/${id}/schema?obsFormat=application/swe%2Bjson`);
        this.types.set(id, (t = new Map((s.recordSchema.fields as Component[]).map((f) => [f.name, f.type]))));
      }
      return t;
    });
  }

  // --- observations -------------------------------------------------------------------------------
  /** Observations with t0 <= time <= t1 as columns: f=application/swe+json, paged by offset; "NaN" is NaN. */
  async read(key: string, t0: number, t1: number, fields: string[] | null = null): Promise<Cols> {
    const types = await this.fieldTypes(key);
    const rows: Record<string, any>[] = await this.on(key, async (id) => {
      let out: Record<string, any>[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const lo = Number.isFinite(t0) ? iso(Math.ceil(t0)) : '..';
        const hi = Number.isFinite(t1) ? iso(Math.floor(t1)) : '..';
        const r = await this.request('GET', `/datastreams/${id}/observations?f=application/swe%2Bjson&phenomenonTime=${lo}/${hi}&limit=${PAGE}&offset=${offset}`);
        const page = JSON.parse(new TextDecoder().decode(r.body)) as Record<string, any>[];
        out = out.length ? out.concat(page) : page;
        if (page.length < PAGE) return out;
      }
    });
    return toCols(rows, types, fields);
  }

  /** The latest observation (resultTime=latest), or null. */
  async latest(key: string): Promise<Row | null> {
    const types = await this.fieldTypes(key);
    const rows = await this.on(key, async (id) => {
      const r = await this.request('GET', `/datastreams/${id}/observations?f=application/swe%2Bjson&resultTime=latest`);
      return JSON.parse(new TextDecoder().decode(r.body)) as Record<string, any>[];
    });
    if (!rows.length) return null;
    const c = toCols(rows.slice(-1), types, null);
    const out: Row = { time: c.t[0] };
    for (const [k, v] of Object.entries(c)) if (k !== 't') out[k] = (v as ArrayLike<unknown>)[0];
    return out;
  }

  /** ONE observation per POST (§9.1); NaN is sent as "NaN". `row.time` is Unix seconds. */
  async publish(key: string, row: Row): Promise<void> {
    const types = await this.fieldTypes(key);
    const body: Record<string, unknown> = { time: iso(row.time as number) };
    for (const [k, ty] of types) {
      if (k === 'time' || !(k in row)) continue;
      const v = row[k];
      if (ty === 'Time') body[k] = typeof v === 'number' && Number.isFinite(v) ? iso(v) : v ?? null;
      else if (NUMERIC.has(ty) && ty !== 'Boolean') body[k] = typeof v === 'number' && Number.isFinite(v) ? v : 'NaN';
      else body[k] = v ?? '';
    }
    await this.on(key, (id) => this.request('POST', `/datastreams/${id}/observations`, body, 'application/swe+json'));
  }

  /** Publish columns, one POST per row. */
  async publishMany(key: string, cols: Cols): Promise<number> {
    const names = Object.keys(cols).filter((k) => k !== 't');
    for (let i = 0; i < cols.t.length; i++) {
      const row: Row = { time: cols.t[i] };
      for (const k of names) row[k] = (cols[k] as ArrayLike<unknown>)[i];
      await this.publish(key, row);
    }
    return cols.t.length;
  }

  // --- commands (§9.2) -----------------------------------------------------------------------------
  /**
   * Subscribe to a control stream (push). Resolves once the subscription is open; `onEnd` is
   * called when it ends (the server stopped), so the caller resubscribes once it answers again.
   */
  async subscribe(csKey: string, onCommand: (c: Command) => void, onEnd: () => void): Promise<() => void> {
    const id = await this.id(csKey);
    const res = await this.request('GET', `/controlstreams/${id}/commands?subscribe=1`);
    if (!res.stream) throw new Refused(500, 'the subscription is not a stream');
    const reader = new LineReader((line) => {
      try {
        onCommand(JSON.parse(line));
      } catch (e) {
        console.error(e);
      }
    });
    const stream = res.stream;
    stream.attach({ chunk: (b) => reader.push(b), end: onEnd });
    return () => stream.cancel();
  }

  async commandStatus(csKey: string, cmdId: string, status: string, message = ''): Promise<void> {
    const id = await this.id(csKey);
    await this.request('POST', `/controlstreams/${id}/status`, { 'command@id': cmdId, statusCode: status, message });
  }

  /**
   * A command's outcome, as a sender reads it: its latest status report other than PENDING (D-199, revising
   * D-164). OpenSensorHub stores the sender's PENDING when the POST answers, often after the receiver's COMPLETED.
   */
  async commandOutcome(csKey: string, cmdId: string): Promise<StatusReport | null> {
    const id = await this.id(csKey);
    const items: StatusReport[] = (await this.getJson(`/controlstreams/${id}/status?limit=100000`)).items ?? [];
    return commandOutcome(items, cmdId);
  }

  /** The latest of urn:x-barge:replay|state. */
  async replayState(): Promise<ReplayState | null> {
    const key = await this.find('urn:x-barge:replay', 'state');
    if (!key) return null;
    const r = await this.latest(key);
    return r ? (r as unknown as ReplayState) : null;
  }

  /** The referee (scaffolding). The stand-in's models are unscored (FR-06e). */
  async score(kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.request('POST', `/demonstrator/referee/${kind}`, payload);
    return JSON.parse(new TextDecoder().decode(r.body));
  }

  /** Any GET, parsed (the replay controller's listings). */
  async get(target: string): Promise<any> {
    return this.getJson(target);
  }
}

export interface ReplayState {
  time: number;
  dataset: string;
  start: number;
  end: number;
  position: number;
  rate: number;
  max_rate: number;
  max_rate_model: string;
  playing: boolean;
  at_end: boolean;
  run: string;
  models_ready: boolean;
}

function toCols(rows: Record<string, any>[], types: Map<string, string>, fields: string[] | null): Cols {
  const cols: Cols = { t: Float64Array.from(rows, (r) => parseIso(r.time)) };
  for (const [n, ty] of types) {
    if (n === 'time' || (fields && !fields.includes(n))) continue;
    if (ty === 'Time') cols[n] = Float64Array.from(rows, (r) => (typeof r[n] === 'string' && r[n] ? parseIso(r[n]) : NaN));
    else if (ty === 'Boolean') cols[n] = Float64Array.from(rows, (r) => (r[n] === true ? 1 : r[n] === false ? 0 : NaN));
    else if (NUMERIC.has(ty)) cols[n] = Float64Array.from(rows, (r) => (typeof r[n] === 'number' ? r[n] : NaN));
    else cols[n] = rows.map((r) => r[n] ?? null);
  }
  return cols;
}

// --- a model ------------------------------------------------------------------------------------------

/** What the runner knows of the current dataset. */
export interface DatasetCtx {
  id: string;
  start: number;
  end: number;
}

/** Subclass this (§10.1). Times are Unix seconds of replay time. */
export abstract class Model {
  abstract readonly id: string;
  abstract readonly label: string;
  description = '';
  abstract readonly maxRate: number;
  /** Replay seconds per processing window, aligned to the dataset's start. */
  window = 60;
  /** True for a model that publishes CO₂-derived outputs under its restricted subsystem (FR-112). */
  restricted = true;
  controlKey: string | null = null;
  /** Who sent a command, and whether their role reads emissions (D-127: the sender is a user name). */
  senderReadsEmissions: (user: string | undefined) => boolean = () => false;

  get uid(): string {
    return `urn:x-barge:process:${this.id}`;
  }

  get restrictedUid(): string {
    return `${this.uid}:restricted`;
  }

  systemBody(): Record<string, unknown> {
    return {
      type: 'SimpleProcess', uniqueId: this.uid, label: this.label, description: this.description,
      definition: 'http://www.w3.org/ns/sosa/System', assetType: 'Process',
      characteristics: [{ label: 'Operating limits', characteristics: [
        { type: 'Quantity', name: 'max_rate', label: 'Highest replay rate sustained', definition: 'https://deepbluecltd.github.io/barge-monitor/def/max_rate', uom: { code: '1' }, value: this.maxRate }] }],
    };
  }

  /** Register: the system, its restricted subsystem, its control stream (the runner subscribes, then declares ready). */
  async setup(api: Api): Promise<void> {
    await api.createSystem(this.systemBody(), 'urn:x-barge:process:models');
    if (this.restricted) {
      await api.createSystem({ type: 'SimpleProcess', uniqueId: this.restrictedUid, label: `${this.label}, restricted outputs`,
        description: 'Outputs with CO₂ among their inputs (FR-112). Restricted.', definition: 'http://www.w3.org/ns/sosa/System', assetType: 'Process' }, this.uid);
    }
  }

  /** Create every datastream this model publishes for a dataset, restricted ones included. */
  /** Returns false when its inputs are not there yet (the runner asks again next second). */
  abstract prepare(api: Api, ds: DatasetCtx): Promise<boolean | void>;

  /** One window (t0, t1] of a dataset under a replay run. Return false when its inputs are not there yet. */
  abstract process(api: Api, ds: DatasetCtx, t0: number, t1: number, run: string): Promise<boolean>;

  /** Check a command against its bounds; throw Rejected naming the bound (FR-27). */
  async validate(_api: Api, _cmd: Command, _state: ReplayState | null): Promise<void> {}

  /** Apply a command that passed validation. Returns the COMPLETED message. */
  async apply(_api: Api, _cmd: Command, _state: ReplayState | null): Promise<string> {
    return 'no settings to apply';
  }
}

/** A run field for every output (§10.2). */
export function runField(): Component {
  return M.text('run', 'Replay run');
}

// --- small numerical helpers (the stand-in's "scientific libraries") ----------------------

/** Round to nd decimals. */
export function round(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const s = 10 ** nd;
  return Math.round(x * s) / s;
}

/** A small deterministic generator (mulberry32) for a model's own named stream (FR-14). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const UNITS: Record<string, string> = {
  air_temperature: 'Cel', apparent_wind_speed: 'm/s', relative_humidity: '%', pressure: 'hPa',
  apparent_wind_direction: 'deg', solar_irradiance: 'W/m2', water_temperature: 'Cel', co2: '[ppm]', // UCUM (D-195)
};
export const LABELS: Record<string, string> = {
  air_temperature: 'Air temperature', apparent_wind_speed: 'Wind speed', relative_humidity: 'Humidity', pressure: 'Pressure',
  apparent_wind_direction: 'Wind direction', solar_irradiance: 'Solar irradiance', water_temperature: 'Water temp', co2: 'CO₂',
};
