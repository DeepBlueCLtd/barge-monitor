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
// `Model` and `Runner` are 4.7's (§10.2): a model follows no clock and no current
// dataset; the runner finds datasets in the importer's catalogue, declares a new
// one's datastreams, processes the whole dataset in windows aligned to its start
// and logs each run in runs__{ds}. Times are Unix seconds throughout.
import { basic, passwordOf, roleOf } from '../accounts';
import type { HttpRequest, HttpResponse } from '../api';
import { DEF, SOSA, URN } from '../constants';
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
export class NotFound extends Refused {}
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
  retryS = 1;
  private lastReal = 0;
  readonly roleOf = roleOf;
  private readonly auth: string;
  private systems = new Map<string, string>(); // uniqueId -> id
  private ids = new Map<string, string>(); // key -> datastream or control stream id
  private types = new Map<string, Map<string, string>>(); // datastream id -> field -> type
  readonly made = new Map<string, { kind: string; uid: string; body: Record<string, any> }>();

  constructor(readonly model: string, readonly user: string, private readonly send: Send, private readonly rt: { real(): number; tap: Tap }) {
    this.auth = basic(user, passwordOf(user));
  }

  /** Real time, Unix seconds. */
  realNow(): number {
    return this.rt.real();
  }

  /** Real time for a runs entry, strictly increasing (a millisecond apart at least, D-198). */
  real(): number {
    const t = Math.max(Math.round(this.rt.real() * 1000) / 1000, Math.round((this.lastReal + 0.001) * 1000) / 1000);
    this.lastReal = t;
    return t;
  }

  /** Drop every identifier found or made (csmodel.Api.forget): looked up, or made, again on next use. */
  forget(): void {
    this.systems.clear();
    this.ids.clear();
    this.types.clear();
  }

  iso(t: number): string {
    return isoUnix(t);
  }

  time(v: string): number {
    return fromIso(v);
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

  /** Every observation of a datastream, as records, paged by offset. */
  async all(key: string): Promise<Record<string, any>[]> {
    return this.on(key, async (ds) => {
      let rows: Record<string, any>[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await this.get(`/datastreams/${ds}/observations?f=${SWE}&limit=${PAGE}&offset=${offset}`);
        rows = rows.length ? rows.concat(page) : page;
        if (page.length < PAGE) return rows;
      }
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

  /**
   * Every dataset to process (§10.2): those whose file status is imported, changed or superseded, in the order they
   * were imported, with their start and end (Unix seconds).
   */
  async datasets(): Promise<Dataset[]> {
    if ((await this.find(URN + 'importer', 'catalogue')) === null) return [];
    const order: string[] = [];
    const current = new Map<string, Record<string, any>>();
    for (const r of await this.all(URN + 'importer|catalogue')) {
      const d = r.dataset;
      if (d && DATASET_STATUSES.includes(r.status) && r.start && r.end) {
        if (!current.has(d)) order.push(d);
        current.set(d, r);
      }
    }
    return order.map((d) => {
      const r = current.get(d)!;
      return { id: d, file: r.file, sha256: r.sha256, start: fromIso(r.start), end: fromIso(r.end) };
    });
  }

  // --- the demonstrator's referee (scaffolding; FR-37) -------------------------------------------
  async score(kind: string, payload: Record<string, unknown>): Promise<Record<string, number | null>> {
    return JSON.parse((await this.request('POST', `/demonstrator/referee/${kind}`, payload)).text);
  }
}

// --- 4.7: models process each dataset on import (§10.2; csmodel.py) -----------------------------------
/** A file status that names a dataset to process. */
export const DATASET_STATUSES = ['imported', 'changed', 'superseded'];
export const SENSORS = ['bow', 'stern'];
export const DC = URN + 'process:data-cleanse';
/** The roles that include emissions (accounts.ts). */
export const CO2_ROLES = new Set(['owner', 'viewer-emissions', 'service']);
const DECILE = 10; // a runs entry every 10 %
/** The longest cleaned block (Data cleanse's window). */
export const BLOCK_MAX_S = 3600;

/** A run's inputs are not there yet (Data cleanse's run on the dataset is not complete): tried again later. */
export class NotReady extends Error {}

export interface Dataset {
  id: string;
  file: string;
  sha256: string;
  start: number;
  end: number;
}

/** A SWE Common master (contracts/swe), without its descriptions (D-276). */
export function master(rec: Record<string, any>): DataRecord {
  const strip = (x: any): any => (Array.isArray(x) ? x.map(strip)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'description').map(([k, v]) => [k, strip(v)])) : x);
  return strip(rec);
}

// --- Data cleanse's output in blocks (D-280) ---------------------------------------------------------
/** A cleaned block: one observation per window, each quantity's readings as a JSON array in a Text (D-280). */
export function blockFields(names: string[]): Component[] {
  const fields: Component[] = [M.time('time', 'Start of the block'), M.text('run_id', 'Run'),
    M.text('offsets', 'Seconds from the start of the block, for each reading (JSON array)')];
  for (const n of names) {
    fields.push({ type: 'Text', name: n, definition: DEF + n,
      label: `${LABELS[n] ?? n}, each reading (JSON array, ${UNITS[n] ?? '1'}; null where removed)` });
  }
  fields.push(M.count('removed', 'Readings removed in the block'));
  return fields;
}

/** A value as Python's json.dumps writes it, from numpy's round(v, 3): whole numbers without a fraction. */
const num = (x: number): number | null => (Number.isFinite(x) ? x : null);

export function encodeBlock(t0: number, cols: Record<string, ArrayLike<number>>, names: string[], removed: number, runId: string): Record<string, unknown> {
  const t = cols.t;
  const row: Record<string, unknown> = { t: t0, run_id: runId, offsets: JSON.stringify(Array.from(t, (x) => num(x - t0))), removed };
  for (const n of names) row[n] = JSON.stringify(Array.from(roundArr(Float64Array.from(cols[n]), 3), num));
  return row;
}

/** Blocks as read back into columns, readings with t0 <= time < t1 only. */
export function decodeBlocks(cols: Cols, names: string[], t0 = -Infinity, t1 = Infinity): { t: Float64Array } & Record<string, Float64Array> {
  const t: number[] = [];
  const out: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const offsets = (cols.offsets ?? []) as unknown[];
  for (let i = 0; i < cols.t.length; i++) {
    const off: number[] = JSON.parse(String(offsets[i] ?? '[]'));
    const vals = names.map((n) => (cols[n] ? JSON.parse(String((cols[n] as unknown[])[i] ?? 'null')) ?? [] : []) as (number | null)[]);
    for (let j = 0; j < off.length; j++) {
      const tt = cols.t[i] + off[j];
      if (tt < t0 || tt >= t1) continue;
      t.push(tt);
      names.forEach((n, k) => out[n].push(vals[k][j] ?? NaN));
    }
  }
  const res = { t: Float64Array.from(t) } as { t: Float64Array } & Record<string, Float64Array>;
  for (const n of names) res[n] = Float64Array.from(out[n]);
  return res;
}

/** One run of a model on one dataset (§10.2): `<model>-<dataset>-<n>`, with the settings it uses. */
export class Run {
  id: string;
  next: number | null = null; // the start of the next window; null until it starts
  logged = -1; // the last tenth logged
  source: string | null = null; // Data cleanse's run it reads (every other model, AT-15)
  state: Record<string, any> = {};
  result: Record<string, unknown> = {};
  renumber = false; // numbered again from the runs log (after a restart)
  readonly start: number;
  readonly end: number; // exclusive

  constructor(readonly model: string, readonly ds: Dataset, public n: number, readonly settings: Record<string, any>,
    readonly restricted = false, start: number | null = null, end: number | null = null, readonly command: string | null = null) {
    this.id = `${model}-${ds.id}-${n}`;
    this.start = start ?? ds.start;
    this.end = end ?? ds.end + 1;
  }

  get doneUntil(): number {
    return this.next === null ? this.start : Math.min(this.next, this.end);
  }

  get pct(): number {
    const span = Math.max(this.end - this.start, 1);
    return Math.min(100, Math.max(0, Math.floor(((this.doneUntil - this.start) * 100) / span)));
  }
}

export function runNumber(runId: unknown): number {
  const n = Number(String(runId).split('-').pop());
  return Number.isFinite(n) ? n : 0;
}

const same = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

export interface RunRequest {
  dataset: string | null; // null: every dataset
  settings: Record<string, any>;
  restricted?: boolean;
  start?: number;
  end?: number;
}

/** Subclass this (§10.1; csmodel.Model). The runner does everything but `outputs` and `process`. */
export abstract class Model {
  abstract readonly id: string;
  abstract readonly label: string;
  description = '';
  /** Seconds of data per window, aligned to the dataset's start; null: a run's whole data range at once. */
  window: number | null = 60;
  usesCo2 = false;
  restrictedRuns = false;
  /** [inputName, master record] of its control stream. */
  control: [string, DataRecord] | null = null;
  defaults: Record<string, any> = {};
  runsMaster: DataRecord | null = null;
  readsCleanse = true;
  settings: Record<string, any> = {};
  system = '';
  restricted: string | null = null;
  controlKey: string | null = null;

  get uid(): string {
    return `${URN}process:${this.id}`;
  }

  systemBody(restricted = false): Record<string, unknown> {
    return { type: 'SimpleProcess', uniqueId: this.uid + (restricted ? ':restricted' : ''), label: restricted ? `${this.label}, restricted outputs` : this.label,
      description: restricted ? 'Outputs derived from CO₂ (restricted, FR-112).' : this.description, definition: SOSA + 'System', assetType: 'Process' };
  }

  /** Register (FR-28): its process system under Models, its restricted subsystem, its control stream. */
  async setup(api: ModelApi): Promise<void> {
    if (!Object.keys(this.settings).length) this.settings = { ...this.defaults };
    this.system = await api.createSystem(this.systemBody(), URN + 'process:models');
    this.restricted = this.usesCo2 ? await api.createSystem(this.systemBody(true), this.uid) : null;
    this.controlKey = null;
    if (this.control) {
      const [name, rec] = this.control;
      this.controlKey = await api.createControlstream(this.system, { name: rec.label, inputName: name, schema: M.record(rec.label, rec.fields) });
    }
  }

  runsRecord(): DataRecord {
    if (this.runsMaster) return this.runsMaster;
    return M.record(`${this.label} runs`, [M.time('time', 'Time of the entry (real time)'), M.text('run_id', 'Run'),
      M.category('status', 'Run status', ['processing', 'complete']), M.time('done_until', 'Processed up to'), M.count('pct', 'Progress, percent', 0, 100),
      ...Object.entries(this.defaults).filter(([, v]) => typeof v === 'number').map(([k]) => M.quantity(k, k.replace(/_/g, ' '), '1'))]);
  }

  /** Create every datastream it may publish for a dataset, restricted ones included, and runs__{ds}. */
  async declare(api: ModelApi, ds: Dataset): Promise<boolean> {
    if (!(await this.outputs(api, ds))) return false;
    const rec = this.runsRecord();
    await api.createDatastream(this.system, { name: `${this.label} runs · ${ds.id}`, outputName: `runs__${ds.id}`, schema: rec });
    if (this.restricted && this.restrictedRuns) {
      await api.createDatastream(this.restricted, { name: `${this.label} runs · ${ds.id} (restricted)`, outputName: `runs__${ds.id}`, schema: rec });
    }
    return true;
  }

  /** Create its output datastreams for a dataset; false while its inputs are not there. */
  async outputs(_api: ModelApi, _ds: Dataset): Promise<boolean> {
    return true;
  }

  runsKey(ds: string, restricted = false): string {
    return `${this.uid}${restricted ? ':restricted' : ''}|runs__${ds}`;
  }

  /** One window [t0, t1) of a dataset, in a run. */
  async process(_api: ModelApi, _ds: Dataset, _t0: number, _t1: number, _run: Run): Promise<void> {}

  /** After the last window: `run.result` for the complete entry. */
  async finish(_api: ModelApi, _ds: Dataset, _run: Run): Promise<void> {}

  /** The settings of a run this dataset still needs, given its complete runs' entries; null for none. */
  wanted(_ds: Dataset, complete: Record<string, any>[]): Record<string, any> | null {
    const mine = Object.entries(this.settings).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
    for (const e of complete) if (mine.every(([k, v]) => !(k in e) || same(e[k], v))) return null;
    return { ...this.settings };
  }

  /** Check every parameter against its control stream's bounds; throw Rejected naming the bound (FR-27). */
  validate(_api: ModelApi, cmd: Command): void {
    if (!this.control) throw new Rejected('this model takes no commands');
    const params = cmd.parameters ?? {};
    for (const f of this.control[1].fields) {
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
        if (allowed?.length && !allowed.includes(v)) throw new Rejected(`${n}='${v}' is not one of ${allowed.join(', ')}`);
      }
    }
  }

  /** A validated command: the runs it asks for. A settings command: a new run over every dataset (§10.3). */
  async onCommand(_api: ModelApi, cmd: Command): Promise<RunRequest> {
    for (const [k, v] of Object.entries(cmd.parameters)) if (k in this.settings) this.settings[k] = v;
    return { dataset: null, settings: { ...this.settings } };
  }

  /** What a runs entry carries besides its progress: the run's settings (FR-37). */
  entry(run: Run): Record<string, unknown> {
    return { ...run.settings };
  }

  /** Data cleanse's latest complete run on a dataset; null while it has none, or is processing one (§10.2). */
  async cleanseRun(api: ModelApi, ds: string): Promise<string | null> {
    const key = await api.find(DC, `runs__${ds}`);
    if (key === null) return null;
    const rows = await api.all(key);
    const last = rows[rows.length - 1];
    return last && last.status === 'complete' ? String(last.run_id) : null;
  }

  /** Data cleanse's readings of `source` (bow, stern, co2-bow, co2-stern) with t0 <= time < t1, of one run (D-280). */
  async readCleaned(api: ModelApi, ds: string, source: string, t0: number, t1: number, runId: string, names: string[] | null = null) {
    const co2 = source.startsWith('co2-');
    const key = await api.find(DC + (co2 ? ':restricted' : ''), `cleaned-${source}__${ds}`);
    if (key === null) throw new NotReady(`cleaned-${source}__${ds} is not there`);
    const types = await api.schema(key);
    const want = (names ?? [...types].filter(([n, ty]) => ty === 'Text' && n !== 'run_id' && n !== 'offsets').map(([n]) => n)).filter((n) => types.has(n));
    const cols = await api.read(key, t0 - BLOCK_MAX_S, t1 - 0.001);
    const runs = (cols.run_id ?? []) as unknown[];
    const keep = runs.map((r, i) => (r === runId ? i : -1)).filter((i) => i >= 0);
    const sel: Cols = { t: Float64Array.from(keep, (i) => cols.t[i]) };
    for (const k of ['offsets', ...want]) sel[k] = keep.map((i) => (cols[k] as unknown[])[i]);
    return decodeBlocks(sel, want, t0, t1);
  }
}

/**
 * Runs a model on every imported dataset (§10.2; csmodel.Runner). `step()` is called again and again: it registers,
 * reads the catalogue (once per real second), declares a new dataset's datastreams, and processes a few windows.
 */
export class Runner {
  static MAX_WINDOWS = 6;
  /** For tests only (`?runpace=`, D-355): a wait at each 10 % of a run, so a run lasts long enough to be seen. */
  static paceMs = 0;
  phase = 'starting';
  detail = '';
  errors = 0;
  registered = false;
  subscribed = false;
  private subscribing = false;
  handling = 0;
  scanS = 1;
  private scanned = -Infinity;
  datasets = new Map<string, Dataset>();
  private declared = new Set<string>();
  private planned = new Set<string>();
  private numbers = new Map<string, number>();
  queue: Run[] = [];
  current: Run | null = null;
  completed: string[] = [];

  constructor(readonly model: Model, readonly api: ModelApi) {}

  private async register(): Promise<void> {
    const { api, model: m } = this;
    api.quiet = true; // registering: counted, not drawn (§2)
    try {
      api.forget();
      await m.setup(api);
    } finally {
      api.quiet = false;
    }
    this.registered = true;
    // Datastreams and results persist across a restart (D-228); what was in hand is planned again.
    this.declared.clear();
    this.planned.clear();
    if (this.current) {
      this.queue.unshift(this.current); // a run cut short is restarted as a new run (§10.2)
      this.current = null;
    }
    this.numbers.clear(); // numbered again from the runs logs, which a Reset instance (FR-50a) empties
    for (const r of this.queue) {
      r.next = null;
      r.logged = -1;
      r.renumber = true;
    }
    this.scanned = -Infinity;
    if (m.controlKey && !this.subscribing) {
      this.subscribing = true;
      void api.subscribe(m.controlKey, this.onCommand, this.onOpen);
    } else if (!m.controlKey) this.subscribed = true;
  }

  private onOpen = (closed: boolean): void => {
    if (closed) { // the server went away: register again once it answers, and resubscribe (AT-38)
      this.subscribed = false;
      this.registered = false;
    } else this.subscribed = true;
  };

  private newRun(ds: Dataset, settings: Record<string, any>, restricted = false, start: number | null = null, end: number | null = null, command: string | null = null): Run {
    const n = (this.numbers.get(ds.id) ?? 0) + 1;
    this.numbers.set(ds.id, n);
    return new Run(this.model.id, ds, n, settings, restricted, start, end, command);
  }

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
        const req = await m.onCommand(api, cmd);
        const every = req.dataset === null;
        let targets: Dataset[];
        if (every) targets = [...this.datasets.values()].reverse(); // a new run over every dataset, newest first
        else if (this.datasets.has(req.dataset!)) targets = [this.datasets.get(req.dataset!)!];
        else throw new Rejected(`dataset ${req.dataset} has not been imported`);
        const runs: Run[] = [];
        for (const ds of targets) {
          if (every) this.queue = this.queue.filter((x) => x.ds.id !== ds.id || x.command !== null);
          runs.push(this.newRun(ds, req.settings, req.restricted ?? false, req.start ?? null, req.end ?? null, cmd.id));
        }
        this.queue.unshift(...runs);
        await api.commandStatus(key, cmd.id, 'COMPLETED', `new run${runs.length !== 1 ? 's' : ''}: ${runs.map((r) => r.id).join(', ') || 'none'}`);
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

  /** Append to the run's log (FR-35b): processing at its start and every 10 %, complete at its end. */
  private async log(run: Run, status: string): Promise<void> {
    const m = this.model;
    const rec: Record<string, unknown> = { ...m.entry(run), t: this.api.real(), run_id: run.id, status, done_until: run.doneUntil,
      pct: status === 'complete' ? 100 : run.pct };
    if (status === 'complete') Object.assign(rec, run.result);
    await this.api.publish(m.runsKey(run.ds.id, run.restricted), rec);
  }

  private async entries(ds: string): Promise<Record<string, any>[]> {
    const m = this.model;
    const out: Record<string, any>[] = [];
    for (const restricted of m.restricted && m.restrictedRuns ? [false, true] : [false]) {
      try {
        out.push(...(await this.api.all(m.runsKey(ds, restricted))));
      } catch (e) {
        if (!(e instanceof NotFound)) throw e;
      }
    }
    return out;
  }

  private async plan(ds: Dataset): Promise<void> {
    const entries = await this.entries(ds.id);
    this.numbers.set(ds.id, Math.max(this.numbers.get(ds.id) ?? 0, ...entries.map((e) => runNumber(e.run_id))));
    for (const r of this.queue) {
      if (r.ds.id === ds.id && r.renumber) {
        r.n = this.numbers.get(ds.id)! + 1;
        this.numbers.set(ds.id, r.n);
        r.id = `${this.model.id}-${ds.id}-${r.n}`;
        r.renumber = false;
      }
    }
    if (this.queue.some((r) => r.ds.id === ds.id) || this.current?.ds.id === ds.id) return;
    const last = new Map<string, Record<string, any>>();
    for (const e of entries) last.set(e.run_id, e);
    const settings = this.model.wanted(ds, [...last.values()].filter((e) => e.status === 'complete'));
    if (settings) this.queue.push(this.newRun(ds, settings));
  }

  /** Read the catalogue (§10.2): declare each new dataset, then plan its runs. */
  private async scan(): Promise<void> {
    const found = await this.api.datasets();
    this.datasets = new Map(found.map((d) => [d.id, this.datasets.get(d.id) ?? d]));
    // A dataset no longer in the catalogue (after Reset instance) is not processed any further.
    this.queue = this.queue.filter((r) => this.datasets.has(r.ds.id));
    if (this.current && !this.datasets.has(this.current.ds.id)) this.current = null;
    for (const id of [...this.declared]) if (!this.datasets.has(id)) this.declared.delete(id);
    for (const id of [...this.planned]) if (!this.datasets.has(id)) this.planned.delete(id);
    for (const ds of found) {
      if (!this.declared.has(ds.id)) {
        if (!(await this.model.declare(this.api, ds))) {
          this.detail = `waiting for the inputs of ${ds.id}`;
          continue;
        }
        this.declared.add(ds.id);
      }
      if (!this.planned.has(ds.id)) {
        await this.plan(ds);
        this.planned.add(ds.id);
      }
    }
  }

  private async take(): Promise<Run | null> {
    for (const r of [...this.queue]) {
      if (!this.declared.has(r.ds.id) || r.renumber) continue;
      if (this.model.readsCleanse) {
        const src = await this.model.cleanseRun(this.api, r.ds.id);
        if (src === null) {
          this.detail = `waiting for Data cleanse on ${r.ds.id}`;
          continue;
        }
        r.source = src;
      }
      this.queue.splice(this.queue.indexOf(r), 1);
      return r;
    }
    return null;
  }

  /** A few windows of the run in hand, oldest first; the last, partial window at the dataset's end. */
  private async work(): Promise<void> {
    const { api, model: m } = this;
    if (!this.current) {
      this.current = await this.take();
      if (!this.current) return;
    }
    const run = this.current;
    const ds = run.ds;
    const width = m.window ?? run.end - run.start;
    if (run.next === null) {
      // Whole windows aligned to the dataset's start (D-129); a run on part of it starts in its window.
      run.next = m.window ? ds.start + Math.floor((run.start - ds.start) / width) * width : run.start;
      run.state = {};
      run.result = {};
      await this.log(run, 'processing');
      run.logged = 0;
    }
    for (let i = 0; i < Runner.MAX_WINDOWS && run.next! < run.end; i++) {
      const t0 = run.next!;
      const t1 = Math.min(t0 + width, run.end);
      await m.process(api, ds, Math.max(t0, run.start), t1, run);
      run.next = t1;
      const tenth = Math.floor(run.pct / DECILE);
      if (tenth > run.logged && run.next < run.end) {
        run.logged = tenth;
        await this.log(run, 'processing');
        if (Runner.paceMs) await new Promise((r) => setTimeout(r, Runner.paceMs));
      }
    }
    this.detail = `${run.id}: ${run.pct}%`;
    if (run.next! >= run.end) {
      await m.finish(api, ds, run);
      await this.log(run, 'complete');
      this.completed.push(run.id);
      this.current = null;
      this.detail = `${run.id} complete`;
    }
  }

  async step(): Promise<void> {
    const { api, model: m } = this;
    try {
      if (!this.registered) {
        this.phase = 'starting';
        this.detail = 'registering';
        await this.register();
      }
      if (m.controlKey && !this.subscribed) {
        this.phase = 'subscribing';
        this.detail = 'subscribing to its commands';
        return; // ready only once its subscription is open (AT-38)
      }
      api.quiet = true; // processing a dataset is counted, not drawn (D-283)
      const now = api.realNow();
      if (now - this.scanned >= this.scanS) {
        this.scanned = now;
        await this.scan();
      }
      await this.work();
      if (!this.current && !this.queue.length) {
        this.phase = 'live';
        this.detail = this.datasets.size ? 'every dataset processed' : 'no dataset imported yet';
      } else this.phase = 'processing';
    } catch (e) {
      if (e instanceof NotReady) {
        this.phase = 'waiting';
        this.detail = e.message;
      } else if (e instanceof Unavailable) {
        this.registered = false; // the server may have restarted: register again once it answers
        this.phase = 'waiting';
        this.detail = e.message;
      } else if (e instanceof Refused) {
        this.errors += 1;
        this.phase = 'waiting';
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
