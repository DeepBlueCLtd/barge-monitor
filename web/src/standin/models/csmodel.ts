// What every stand-in model is written against: the data server, over HTTP only
// (docs/v4-interfaces.md §10.1; backend/models/csmodel.py, the reference).
//
// `ModelApi` is the 4.7 interface: every method is one or more requests with the
// model's service credentials, behaving as OpenSensorHub requires (§9.1): discovery
// by searchMembers, SensorML as application/sml+json, 201 with the existing Location,
// f=application/swe+json and paging by offset, "NaN" both ways, one observation per
// POST, commands pushed on a subscription held on the internal endpoint (§9.2), and a
// command's outcome as its latest status report other than PENDING (D-199).
//
// `Model` and `Runner` below are still Version 4.1's: a model steps on the simulation
// clock and catches up a bounded backlog at startup (D-251). Plan Phase 6 replaces
// them with the runner of §10.2. Until then `epoch` is the simulation epoch, so times
// are the simulation's seconds; in 4.7 it is 0 (Unix seconds).
import { basic, passwordOf, roleOf } from '../accounts';
import type { HttpRequest, HttpResponse } from '../api';
import { SIM_EPOCH_UNIX, SOSA, URN } from '../constants';
import { Cols, NUMERIC } from '../resources';
import { LineReader } from '../stream';
import { Component, DataRecord, M } from '../swe';
import type { Tap } from '../tap';

export const QUANTITIES = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];
export const UNITS: Record<string, string> = {
  air_temperature: 'Cel', apparent_wind_speed: 'm/s', relative_humidity: '%', pressure: 'hPa',
  apparent_wind_direction: 'deg', solar_irradiance: 'W/m2', water_temperature: 'Cel', co2: '[ppm]', // UCUM (D-195)
};
export const LABELS: Record<string, string> = {
  air_temperature: 'Air temperature', apparent_wind_speed: 'Wind speed', relative_humidity: 'Humidity', pressure: 'Pressure',
  apparent_wind_direction: 'Wind direction', solar_irradiance: 'Solar irradiance', water_temperature: 'Water temp', co2: 'CO₂',
};
export const PRECIP = ['none', 'drizzle', 'rain', 'showers'];
const PAGE = 50_000; // observations asked for per request
const SWE = 'application%2Fswe%2Bjson';
const IN_FLIGHT = 16; // observations published at once: one POST each, several in flight

/** The seven quantities, with the definitions of the raw parameters they come from (FR-29). */
export function measurementFields(): Component[] {
  return QUANTITIES.map((p) => M.quantity(p, LABELS[p], UNITS[p]));
}

/** The data server does not answer (starting, down): try again later. */
export class Unavailable extends Error {}
/** The data server refused the call. */
export class Refused extends Error {}
class NotFound extends Refused {}
/** A command the receiver refuses: reported as REJECTED, naming the bound (FR-27). */
export class Rejected extends Error {}
/** A model cannot run on what it has (Python's ValueError in the models). */
export class NoRun extends Error {}

export interface Command {
  id: string;
  issueTime: string;
  parameters: Record<string, unknown>;
  sender?: string;
}

/** A command's outcome: its latest status report other than PENDING (D-199). */
export function commandOutcome(reports: Record<string, any>[], cmdId: string): Record<string, any> | null {
  const mine = reports.filter((r) => r['command@id'] === cmdId && r.statusCode !== 'PENDING');
  mine.sort((a, b) => String(a.reportTime ?? '').localeCompare(String(b.reportTime ?? '')));
  return mine.length ? mine[mine.length - 1] : null;
}

function isoUnix(u: number): string {
  const ms = Math.round(u * 1000);
  const s = new Date(ms).toISOString();
  return ms % 1000 === 0 ? s.slice(0, 19) + 'Z' : s;
}

function fromIso(v: string): number {
  return Date.parse(v) / 1000;
}

/** One value as published: NaN as "NaN" (§9.1). */
function jsonValue(ty: string, v: unknown, toIso: (t: number) => string): unknown {
  if (ty === 'Quantity') return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? 'NaN' : Number(v);
  if (ty === 'Count') return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? 0 : Math.trunc(Number(v));
  if (ty === 'Boolean') return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : !!v;
  if (ty === 'Time') return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : typeof v === 'string' ? v : toIso(Number(v));
  return typeof v === 'number' && Number.isNaN(v) ? null : v ?? null;
}

type Send = (req: HttpRequest) => Promise<HttpResponse | null>;

/**
 * What a model does with the data server (§10.1; `Api` in backend/models/csmodel.py). In the stand-in the models share a
 * worker with the server, so `send` hands each request straight to the HTTP layer; nothing else differs. A datastream or
 * control stream is named by a key, `"<system uniqueId>|<name>"`, that outlives restarts.
 */
export class ModelApi {
  quiet = false;
  epoch = SIM_EPOCH_UNIX; // the 4.1 models' simulation epoch (D-251); 0 in 4.7
  retryS = 1;
  readonly roleOf = roleOf;
  private readonly auth: string;
  private systems = new Map<string, string>(); // uniqueId -> id
  private ids = new Map<string, string>(); // key -> datastream or control stream id
  private types = new Map<string, Map<string, string>>(); // datastream id -> field -> type
  readonly made = new Map<string, { kind: string; uid: string; body: Record<string, any> }>();

  constructor(readonly model: string, readonly user: string, private readonly send: Send, private readonly rt: { now(): number; tap: Tap }) {
    this.auth = basic(user, passwordOf(user));
  }

  now(): number {
    return this.rt.now();
  }

  iso(t: number): string {
    return isoUnix(this.epoch + t);
  }

  time(v: string): number {
    return fromIso(v) - this.epoch;
  }

  /** Capture a call into, or a result out of, the scientific libraries (models ↔ scilibs). */
  tap(dst: 'scilibs' | 'models', summary: string, content?: unknown): void {
    const [src, to] = dst === 'scilibs' ? (['models', 'scilibs'] as const) : (['scilibs', 'models'] as const);
    this.rt.tap.emit(src, to, 'I', `${this.model}: ${summary}`, content, { model: this.model, quiet: this.quiet });
  }

  private headers(quiet = this.quiet): [string, string][] {
    const h: [string, string][] = [['authorization', this.auth], ['x-tap-model', this.model]];
    if (quiet) h.push(['x-tap-quiet', '1']);
    return h;
  }

  private async raw(method: string, target: string, body?: unknown, ctype = 'application/json', internal = false): Promise<HttpResponse> {
    // Subscribing (internal) is part of registering: counted, not drawn (§2); the commands pushed on it are drawn.
    const headers = this.headers(this.quiet || internal);
    let raw: Uint8Array | null = null;
    if (body !== undefined) {
      raw = new TextEncoder().encode(JSON.stringify(body));
      headers.push(['content-type', ctype]);
    }
    const q = target.indexOf('?');
    const res = await this.send({
      method, path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), body: raw, headers,
      rootPath: internal ? '/api-internal' : '', origin: 'http://models',
    });
    if (res === null) { // the server is starting or down: no answer at all
      this.rt.tap.emit('models', 'server', 'Q', `${this.model}: ${method} ${target}: no answer, the server is down`,
        `${method} ${target}\n\nnetwork failure: no server to answer`, { failed: true, model: this.model, quiet: this.quiet });
      throw new Unavailable('the data server does not answer');
    }
    return res;
  }

  async request(method: string, target: string, body?: unknown, ctype = 'application/json', ok = [200, 201]): Promise<{ status: number; headers: Map<string, string>; text: string }> {
    const res = await this.raw(method, target, body, ctype);
    const text = new TextDecoder().decode(res.body);
    if (!ok.includes(res.status)) {
      const msg = `${method} ${target}: ${res.status}`;
      throw res.status === 404 ? new NotFound(msg) : new Refused(msg);
    }
    return { status: res.status, headers: new Map(res.headers.map(([k, v]) => [k.toLowerCase(), v] as [string, string])), text };
  }

  private async get(target: string): Promise<any> {
    return JSON.parse((await this.request('GET', target)).text); // JSON whatever the Content-Type says (D-196)
  }

  private static located(h: Map<string, string>): string {
    return h.get('location')!.replace(/\/+$/, '').split('/').pop()!;
  }

  // --- discovery ----------------------------------------------------------------------------------
  async findSystem(uid: string): Promise<string | null> {
    if (!this.systems.has(uid)) {
      // Every system, subsystems included (D-193); the listing carries no parent link.
      for (const s of (await this.get('/systems?searchMembers=true&f=application%2Fsml%2Bjson&limit=100000')).items) {
        this.systems.set(s.uniqueId ?? s.properties?.uid, s.id);
      }
    }
    return this.systems.get(uid) ?? null;
  }

  /** The key of a datastream, or null while it is not there. */
  async find(systemUid: string, outputName: string): Promise<string | null> {
    const sid = await this.findSystem(systemUid);
    if (sid === null) return null;
    const d = ((await this.get(`/systems/${sid}/datastreams?limit=100000`)).items as any[]).find((x) => x.outputName === outputName);
    if (!d) return null;
    const key = `${systemUid}|${outputName}`;
    this.ids.set(key, d.id);
    return key;
  }

  async findControlstream(systemUid: string, inputName: string): Promise<string | null> {
    const sid = await this.findSystem(systemUid);
    if (sid === null) return null;
    const c = ((await this.get(`/systems/${sid}/controlstreams`)).items as any[]).find((x) => x.inputName === inputName);
    if (!c) return null;
    const key = `${systemUid}|${inputName}`;
    this.ids.set(key, c.id);
    return key;
  }

  // --- registering (FR-28): 201 with the existing Location is success -----------------------------
  async createSystem(body: Record<string, unknown>, parentUid: string | null = null): Promise<string> {
    let path = '/systems';
    if (parentUid) {
      const pid = await this.findSystem(parentUid);
      if (pid === null) throw new NotFound(`system ${parentUid} is not there`);
      path = `/systems/${pid}/subsystems`;
    }
    const r = await this.request('POST', path, { type: 'SimpleProcess', ...body }, 'application/sml+json'); // SensorML (D-194)
    const sid = ModelApi.located(r.headers);
    this.systems.set(String(body.uniqueId), sid);
    return sid;
  }

  private uidOf(systemId: string): string {
    for (const [u, i] of this.systems) if (i === systemId) return u;
    throw new Error(`unknown system ${systemId}`);
  }

  async createDatastream(systemId: string, body: Record<string, any>): Promise<string> {
    const uid = this.uidOf(systemId);
    const key = `${uid}|${body.outputName}`;
    const made = { name: body.name ?? body.outputName, outputName: body.outputName, schema: { obsFormat: 'application/swe+json', recordSchema: body.schema } };
    this.made.set(key, { kind: 'datastreams', uid, body: made });
    const id = ModelApi.located((await this.request('POST', `/systems/${systemId}/datastreams`, made)).headers);
    this.ids.set(key, id);
    this.types.set(id, new Map((body.schema as DataRecord).fields.map((f) => [f.name, f.type])));
    return key;
  }

  async createControlstream(systemId: string, body: Record<string, any>): Promise<string> {
    const uid = this.uidOf(systemId);
    const name = body.inputName || 'settings';
    const key = `${uid}|${name}`;
    const made = { name: body.name ?? name, inputName: name, schema: { commandFormat: 'application/json', parametersSchema: body.schema } };
    this.made.set(key, { kind: 'controlstreams', uid, body: made });
    this.ids.set(key, ModelApi.located((await this.request('POST', `/systems/${systemId}/controlstreams`, made)).headers));
    return key;
  }

  private async id(key: string): Promise<string> {
    if (!this.ids.has(key)) {
      const m = this.made.get(key);
      if (m) {
        const sid = await this.findSystem(m.uid);
        if (sid === null) throw new NotFound(`system ${m.uid} is not there`);
        this.ids.set(key, ModelApi.located((await this.request('POST', `/systems/${sid}/${m.kind}`, m.body)).headers));
      } else {
        const i = key.indexOf('|');
        const uid = key.slice(0, i);
        const out = key.slice(i + 1);
        if ((await this.find(uid, out)) === null && (await this.findControlstream(uid, out)) === null) throw new NotFound(`${key} is not there`);
      }
    }
    return this.ids.get(key)!;
  }

  private async on<T>(key: string, call: (id: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.id(key));
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
      this.ids.delete(key);
      this.systems.clear();
      return call(await this.id(key));
    }
  }

  /** field -> SWE type of a datastream, as served. */
  async schema(key: string): Promise<Map<string, string>> {
    return this.on(key, async (ds) => {
      if (!this.types.has(ds)) {
        const rec = (await this.get(`/datastreams/${ds}/schema?obsFormat=${SWE}`)).recordSchema;
        this.types.set(ds, new Map(rec.fields.map((f: any) => [f.name, f.type])));
      }
      return this.types.get(ds)!;
    });
  }

  // --- observations --------------------------------------------------------------------------------
  /** Observations with t0 <= time <= t1 as columns; "NaN" becomes NaN. f=application/swe+json, paged by offset (§9.1). */
  async read(key: string, t0: number, t1: number, fields: string[] | null = null): Promise<Cols> {
    const lo = Math.ceil(t0);
    const hi = Math.floor(t1);
    return this.on(key, async (ds) => {
      const types = await this.schema(key);
      let rows: Record<string, any>[] = [];
      if (hi >= lo) {
        for (let offset = 0; ; offset += PAGE) {
          const page = await this.get(`/datastreams/${ds}/observations?f=${SWE}&phenomenonTime=${this.iso(lo)}/${this.iso(hi)}&limit=${PAGE}&offset=${offset}`);
          rows = rows.length ? rows.concat(page) : page;
          if (page.length < PAGE) break;
        }
      }
      const cols: Cols = { t: Float64Array.from(rows, (r) => this.time(r.time)) };
      for (const [n, ty] of types) {
        if (n === 'time' || (fields !== null && !fields.includes(n))) continue;
        if (ty === 'Time') cols[n] = Float64Array.from(rows, (r) => (typeof r[n] === 'string' && r[n] !== 'NaN' ? this.time(r[n]) : NaN));
        else if (NUMERIC.has(ty)) cols[n] = Float64Array.from(rows, (r) => (r[n] === null || r[n] === undefined || r[n] === 'NaN' ? NaN : Number(r[n])));
        else cols[n] = rows.map((r) => r[n] ?? null);
      }
      return cols;
    });
  }

  /** The last observation inserted (resultTime=latest), as a record. */
  async latest(key: string): Promise<Record<string, any> | null> {
    return this.on(key, async (ds) => {
      const rows = await this.get(`/datastreams/${ds}/observations?f=${SWE}&resultTime=latest`);
      return rows.length ? rows[rows.length - 1] : null;
    });
  }

  /** ONE observation per POST (§9.1). `row` has `t` (seconds) or `time` (ISO). */
  async publish(key: string, row: Record<string, unknown>): Promise<void> {
    return this.on(key, async (ds) => {
      const types = this.types.get(ds) ?? (await this.schema(key));
      const t = row.time ?? row.t;
      const obs: Record<string, unknown> = { time: typeof t === 'string' ? t : this.iso(Number(t)) };
      for (const [k, v] of Object.entries(row)) {
        if (k === 't' || k === 'time' || !types.has(k)) continue;
        obs[k] = jsonValue(types.get(k)!, v, (x) => this.iso(x));
      }
      await this.request('POST', `/datastreams/${ds}/observations`, obs, 'application/swe+json');
    });
  }

  /** Columns as observations, one POST each, a few in flight at once. Returns how many. */
  async publishMany(key: string, cols: Record<string, unknown>): Promise<number> {
    const t = cols.t as ArrayLike<number>;
    const names = Object.keys(cols).filter((k) => k !== 't');
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < t.length; i++) {
      const r: Record<string, unknown> = { t: t[i] };
      for (const k of names) r[k] = (cols[k] as ArrayLike<unknown>)[i];
      rows.push(r);
    }
    for (let i = 0; i < rows.length; i += IN_FLIGHT) await Promise.all(rows.slice(i, i + IN_FLIGHT).map((r) => this.publish(key, r)));
    return rows.length;
  }

  // --- commands (FR-27): pushed, validated by the receiver ---------------------------------------------
  /**
   * Hold a push subscription on the internal endpoint (§9.2, D-223); resubscribe after any unreachability.
   * `onOpen(false)` when it opens, `onOpen(true)` when it ends. Never returns.
   */
  async subscribe(csKey: string, onCommand: (cmd: Command) => Promise<void>, onOpen?: (closed: boolean) => void): Promise<void> {
    for (;;) {
      try {
        const cs = await this.id(csKey);
        const res = await this.raw('GET', `/controlstreams/${cs}/commands?subscribe=1`, undefined, 'application/json', true);
        if (res.status !== 200 || !res.stream) throw res.status === 404 ? new NotFound(`subscribe: ${res.status}`) : new Refused(`subscribe: ${res.status}`);
        onOpen?.(false);
        const queue: Command[] = [];
        let wake: (() => void) | null = null;
        let ended = false;
        const reader = new LineReader((line) => {
          queue.push(JSON.parse(line));
          wake?.();
        });
        res.stream.attach({ chunk: (b) => reader.push(b), end: () => { ended = true; wake?.(); } });
        for (;;) {
          while (queue.length) await onCommand(queue.shift()!);
          if (ended) break;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      } catch (e) {
        if (!(e instanceof Unavailable || e instanceof Refused)) throw e;
      }
      onOpen?.(true);
      await new Promise((r) => setTimeout(r, this.retryS * 1000));
    }
  }

  async commandStatus(csKey: string, cmdId: string, status: string, message = ''): Promise<void> {
    await this.on(csKey, (cs) => this.request('POST', `/controlstreams/${cs}/status`, { 'command@id': cmdId, statusCode: status, ...(message ? { message } : {}) }));
  }

  /** A command's outcome, as a sender reads it: its latest status report other than PENDING (D-199). */
  async commandOutcome(csKey: string, cmdId: string): Promise<Record<string, any> | null> {
    return this.on(csKey, async (cs) => commandOutcome((await this.get(`/controlstreams/${cs}/status?limit=100000`)).items ?? [], cmdId));
  }

  // --- the importer's catalogue (§7) -------------------------------------------------------------
  /** The catalogue folded per file: the latest observation for each file is its current status (§7). Empty with no importer. */
  async catalogue(): Promise<Record<string, any>[]> {
    const key = URN + 'importer|catalogue';
    if ((await this.find(URN + 'importer', 'catalogue')) === null) return [];
    return this.on(key, async (ds) => {
      const latest = new Map<string, Record<string, any>>();
      for (let offset = 0; ; offset += PAGE) {
        const page = await this.get(`/datastreams/${ds}/observations?f=${SWE}&limit=${PAGE}&offset=${offset}`);
        for (const r of page) latest.set(r.file, r);
        if (page.length < PAGE) break;
      }
      return [...latest.values()];
    });
  }

  // --- the demonstrator's referee (scaffolding; FR-37) -------------------------------------------
  async score(kind: string, payload: Record<string, unknown>): Promise<Record<string, number | null>> {
    return JSON.parse((await this.request('POST', `/demonstrator/referee/${kind}`, payload)).text);
  }
}

/** Subclass this. `interval` is in simulated seconds (Version 4.1, until plan Phase 6). */
export abstract class Model {
  abstract readonly id: string;
  abstract readonly label: string;
  description = '';
  interval = 60;
  /** How much history one step takes while catching up. The stand-in takes big steps: startup is fast. */
  catchUpChunk = 86400;
  /** Caught up once this close to now (never less than two intervals). */
  catchUpMargin = 120;
  startFrom: 'history' | 'now' = 'history';
  /** How much history a model catches up at startup (D-251): one observation per POST makes the whole day too slow. */
  backlog = 1800;
  system = '';
  controlKey: string | null = null;

  get uid(): string {
    return `${URN}process:${this.id}`;
  }

  systemBody(): Record<string, unknown> {
    return { type: 'SimpleProcess', uniqueId: this.uid, label: this.label, description: this.description, definition: SOSA + 'System', assetType: 'Process' };
  }

  /** Register (FR-28): its process system under Models. */
  async setup(api: ModelApi): Promise<void> {
    this.system = await api.createSystem(this.systemBody(), URN + 'process:models');
  }

  /** Process data in (t0, t1]; return the time processed up to. */
  async step(_api: ModelApi, _t0: number, t1: number): Promise<number> {
    return t1;
  }

  /** Check every parameter against its control stream's bounds; throw Rejected naming the bound (FR-27). */
  validate(api: ModelApi, cmd: Command): void {
    const made = this.controlKey ? api.made.get(this.controlKey) : undefined;
    const fields: Component[] = made ? made.body.schema.parametersSchema.fields : [];
    const params = cmd.parameters ?? {};
    for (const f of fields) {
      const n = f.name;
      if (!(n in params)) throw new Rejected(`${n} is missing: every parameter is sent on every command`);
      const v = params[n];
      const con = f.constraint ?? {};
      if (f.type === 'Quantity' || f.type === 'Count') {
        if (typeof v !== 'number') throw new Rejected(`${n} must be a number`);
        if (f.type === 'Count' && !Number.isInteger(v)) throw new Rejected(`${n} must be a whole number`);
        if (con.intervals?.length) {
          const [lo, hi] = con.intervals[0];
          if (!(lo <= v && v <= hi)) throw new Rejected(`${n}=${v} is outside the schema's AllowedValues interval [${lo}, ${hi}]`);
        }
      } else if (f.type === 'Category' || f.type === 'Text') {
        if (typeof v !== 'string') throw new Rejected(`${n} must be text`);
        const allowed: string[] | undefined = con.values;
        const items = f.type === 'Text' ? v.split(',').map((x) => x.trim()) : [v];
        if (allowed?.length) {
          const bad = items.filter((x) => !allowed.includes(x));
          if (bad.length || !items.length || (items.length === 1 && items[0] === '')) {
            throw new Rejected(`${n}='${v}': ${bad.join(', ') || 'nothing'} not in the schema's AllowedTokens`);
          }
        }
      }
    }
  }

  async onCommand(_api: ModelApi, _cmd: Command): Promise<string> {
    return 'no settings to apply';
  }

  /** For a model that starts from now: a first run once its inputs exist. True when done. */
  async initial(_api: ModelApi): Promise<boolean> {
    return true;
  }
}

/** Steps a 4.1 model on the simulation clock; its commands are pushed to it (§9.2; csmodel.Runner). */
export class Runner {
  ready = false;
  last: number | null = null;
  retryAt = -1; // after a step that found nothing new, wait before trying again
  phase = 'starting';
  detail = '';
  errors = 0;
  initialDone = false;
  subscribed = false;
  private subscribing = false;
  handling = 0;

  constructor(readonly model: Model, readonly api: ModelApi) {}

  get caughtUp(): boolean {
    return this.last !== null && this.api.now() - this.last < Math.max(2 * this.model.interval, this.model.catchUpMargin);
  }

  private onOpen = (closed: boolean): void => {
    if (closed) { // the server went away: register again once it answers, and resubscribe (AT-38)
      this.subscribed = false;
      this.ready = false;
    } else this.subscribed = true;
  };

  private onCommand = async (cmd: Command): Promise<void> => {
    const { api, model: m } = this;
    const key = m.controlKey!;
    this.handling += 1;
    try {
      try {
        m.validate(api, cmd);
      } catch (e) {
        if (e instanceof Rejected) return api.commandStatus(key, cmd.id, 'REJECTED', e.message);
        throw e;
      }
      await api.commandStatus(key, cmd.id, 'ACCEPTED');
      try {
        const msg = await m.onCommand(api, cmd);
        await api.commandStatus(key, cmd.id, 'COMPLETED', msg || '');
      } catch (e) {
        if (e instanceof Rejected) await api.commandStatus(key, cmd.id, 'REJECTED', e.message);
        else if (e instanceof Unavailable || e instanceof Refused) throw e;
        else await api.commandStatus(key, cmd.id, 'FAILED', `${errorName(e)}: ${(e as Error)?.message ?? e}`);
      }
    } catch (e) {
      if (e instanceof Unavailable || e instanceof Refused) this.detail = `a command's status was not reported: ${e.message}`;
      else throw e;
    } finally {
      this.handling -= 1;
    }
  };

  async tick(playing: boolean): Promise<void> {
    const { api, model: m } = this;
    const now = api.now();
    try {
      if (!this.ready) {
        api.quiet = true;
        await m.setup(api);
        this.ready = true;
        if (this.last === null) this.last = m.startFrom === 'history' ? Math.max(0, now - m.backlog) : now;
        this.phase = 'catching up';
        if (m.controlKey && !this.subscribing) {
          this.subscribing = true;
          void api.subscribe(m.controlKey, this.onCommand, this.onOpen);
        }
      }
      if (m.controlKey && !this.subscribed) {
        this.detail = 'subscribing to its commands';
        return; // live only once its subscription is open (AT-38)
      }
      if (m.startFrom === 'now' && !this.initialDone) {
        api.quiet = true;
        this.initialDone = await m.initial(api);
        this.detail = this.initialDone ? '' : 'waiting for its inputs';
        this.phase = this.initialDone ? 'live' : 'catching up';
        return;
      }
      if (!this.caughtUp) {
        api.quiet = true;
        const last = this.last!;
        const upto = Math.min(now, last + m.catchUpChunk);
        const done = await m.step(api, last, upto);
        this.last = Math.max(last, done);
        this.detail = `${Math.min(100, Math.max(0, Math.round(100 * (1 - (now - this.last) / Math.max(m.backlog, 1)))))}% of its backlog`;
        if (this.caughtUp) {
          this.phase = 'live';
          this.detail = '';
        }
        return;
      }
      api.quiet = false;
      this.phase = 'live';
      this.detail = '';
      if (playing && now - this.last! >= m.interval && now >= this.retryAt) {
        const done = await m.step(api, this.last!, now);
        // Its inputs are not there yet: try again a little later (as backend/models/csmodel.py).
        if (done <= this.last!) this.retryAt = now + Math.min(m.interval, 10);
        this.last = Math.max(this.last!, done);
      }
    } catch (e) {
      if (e instanceof Unavailable) {
        this.ready = false; // the server may have restarted: register again once it answers
        this.detail = `waiting: ${e.message}`;
      } else if (e instanceof Refused) {
        this.errors += 1;
        this.detail = `refused: ${e.message}`;
      } else throw e;
    } finally {
      api.quiet = false;
    }
  }
}

function errorName(e: unknown): string {
  if (e instanceof NoRun) return 'ValueError';
  return (e as Error)?.name ?? 'Error';
}

// --- small numerical helpers (the stand-in's "scientific libraries") ----------------------

/** Round each value to nd decimals, half to even (numpy.round). */
export function roundArr(v: Float64Array, nd: number): Float64Array {
  const s = 10 ** nd;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) {
      out[i] = x;
      continue;
    }
    const y = x * s;
    const f = Math.floor(y);
    const d = y - f;
    out[i] = (d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1) / s;
  }
  return out;
}

/** numpy.interp with left/right NaN. */
export function interp(x: Float64Array, xp: Float64Array, fp: Float64Array): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const n = xp.length;
  if (!n) return out;
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v < xp[0] || v > xp[n - 1]) continue;
    while (j < n - 2 && xp[j + 1] < v) j++;
    while (j > 0 && xp[j] > v) j--;
    if (v === xp[j]) out[i] = fp[j];
    else if (j + 1 < n) {
      const w = (v - xp[j]) / (xp[j + 1] - xp[j]);
      out[i] = fp[j] + w * (fp[j + 1] - fp[j]);
    } else out[i] = fp[j];
  }
  return out;
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
