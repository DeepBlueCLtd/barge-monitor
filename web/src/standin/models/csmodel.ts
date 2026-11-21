// What every stand-in model is written against: the data server's Connected
// Systems interface (FR-35; backend/models/csmodel.py). A model has `setup` (register
// its process system, datastreams and control stream: FR-28), `step`
// (process newly arrived data) and `onCommand` (take its settings as
// commands: FR-27). The Runner calls them on the simulation clock (FR-13).
// Models see only what the server serves, never the manifest (FR-37).
import type { HttpRequest, HttpResponse } from '../api';
import { SIM_EPOCH_UNIX, SOSA } from '../constants';
import { Cols, NUMERIC } from '../registry';
import { iso, parseIso } from '../time';
import { Component, M } from '../swe';
import type { Tap } from '../tap';

export const QUANTITIES = ['air_temperature', 'apparent_wind_speed', 'relative_humidity', 'pressure',
  'apparent_wind_direction', 'solar_irradiance', 'water_temperature'];
export const UNITS: Record<string, string> = {
  air_temperature: 'Cel', apparent_wind_speed: 'm/s', relative_humidity: '%', pressure: 'hPa',
  apparent_wind_direction: 'deg', solar_irradiance: 'W/m2', water_temperature: 'Cel',
};
export const LABELS: Record<string, string> = {
  air_temperature: 'Air temperature', apparent_wind_speed: 'Wind speed', relative_humidity: 'Humidity', pressure: 'Pressure',
  apparent_wind_direction: 'Wind direction', solar_irradiance: 'Solar irradiance', water_temperature: 'Water temp',
};
export const PRECIP = ['none', 'drizzle', 'rain', 'showers'];

/** The seven quantities, with the definitions of the raw parameters they come from (FR-29). */
export function measurementFields(): Component[] {
  return QUANTITIES.map((p) => M.quantity(p, LABELS[p], UNITS[p]));
}

/** The data server is waiting or down: try again on the next step. */
export class Unavailable extends Error {}
/** The data server refused the call. */
export class Refused extends Error {}
/** A model cannot run on what it has (Python's ValueError in the models). */
export class NoRun extends Error {}

export interface Command {
  id: string;
  issueTime: string;
  parameters: Record<string, unknown>;
}

/** Models ask a datastream's observations a page at a time: the server's declared maximum. */
const PAGE = 100_000;

class NotFound extends Refused {}

interface Made {
  path: string;
  body: Record<string, unknown>;
}

/**
 * What a model does with the data server, as OGC API – Connected Systems requests
 * (docs/v4-interfaces.md §7; `Api` in backend/models/csmodel.py). In the stand-in the
 * models share a worker with the server, so `send` hands each request straight to the
 * HTTP layer; nothing else differs. A model names a datastream by a key,
 * `system:outputName`, which outlives server restarts; the public identifier behind it
 * is looked up again when the server says it has gone, or a new instance answers.
 */
export class ModelApi {
  quiet = false;
  private instance: string | null = null;
  private ids = new Map<string, string>(); // key -> current public identifier
  private made = new Map<string, Made>(); // key -> what this model created
  private types = new Map<string, Map<string, string>>(); // public identifier -> field -> SWE type
  private systems = new Map<string, string>(); // uniqueId -> system id

  constructor(readonly model: string, private readonly send: (req: HttpRequest) => HttpResponse | null,
    private readonly rt: { now(): number; tap: Tap }) {}

  now(): number {
    return this.rt.now();
  }

  /** Capture a call into, or a result out of, the scientific libraries (models ↔ scilibs). */
  tap(dst: 'scilibs' | 'models', summary: string, content?: unknown): void {
    const [src, to] = dst === 'scilibs' ? (['models', 'scilibs'] as const) : (['scilibs', 'models'] as const);
    this.rt.tap.emit(src, to, 'I', `${this.model}: ${summary}`, content, { model: this.model, quiet: this.quiet });
  }

  // --- one request ---------------------------------------------------------------------------
  private request(method: string, target: string, body?: unknown, ctype = 'application/json', ok = [200, 201]): { status: number; headers: Map<string, string>; text: string } {
    const headers: [string, string][] = [['accept', 'application/json, application/swe+json'], ['x-tap-model', this.model]];
    if (this.quiet) headers.push(['x-tap-quiet', '1']);
    let raw: Uint8Array | null = null;
    if (body !== undefined) {
      raw = new TextEncoder().encode(JSON.stringify(body));
      headers.push(['content-type', ctype]);
    }
    const q = target.indexOf('?');
    const res = this.send({
      method, path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), body: raw, headers,
      rootPath: '', origin: 'http://models',
    });
    if (res === null) { // the server is down: no answer at all (drawn stopped at the boundary, VS-14)
      this.rt.tap.emit('models', 'fastapi', 'Q', `${this.model}: ${method} ${target}: no answer, the server is down`,
        `${method} ${target}\n\nnetwork failure: no server to answer`, { failed: true, model: this.model, quiet: this.quiet });
      throw new Unavailable('the data server does not answer');
    }
    const rh = new Map(res.headers.map(([k, v]) => [k.toLowerCase(), v] as [string, string]));
    const inst = rh.get('x-server-instance');
    if (inst && inst !== this.instance) {
      if (this.instance !== null) { // a new server instance: identifiers may have changed
        this.ids.clear();
        this.types.clear();
      }
      this.instance = inst;
    }
    const text = new TextDecoder().decode(res.body);
    if (res.status === 503) throw new Unavailable('the data server is waiting');
    if (!ok.includes(res.status)) {
      let why = '';
      try {
        why = JSON.parse(text || '{}').description ?? '';
      } catch { /* not JSON */ }
      const msg = `${method} ${target}: ${res.status} ${why}`.trim();
      throw res.status === 404 ? new NotFound(msg) : new Refused(msg);
    }
    return { status: res.status, headers: rh, text };
  }

  /** POST a resource; an identical one already there answers 409 with its Location. */
  private create(m: Made): string {
    const r = this.request('POST', m.path, m.body, 'application/json', [201, 409]);
    return r.headers.get('location')!.replace(/\/+$/, '').split('/').pop()!;
  }

  // --- registering (FR-28) ----------------------------------------------------------------------
  createSystem(body: Record<string, unknown>): string {
    return this.create({ path: '/systems/models/subsystems', body });
  }

  createDatastream(systemId: string, body: Record<string, any>): string {
    const key = `${systemId}:${body.outputName}`;
    const m = {
      path: `/systems/${systemId}/datastreams`,
      body: { name: body.name ?? body.outputName, outputName: body.outputName, schema: { obsFormat: 'application/swe+json', recordSchema: body.schema } },
    };
    this.made.set(key, m);
    this.ids.set(key, this.create(m));
    return key;
  }

  createControlstream(systemId: string, body: Record<string, any>): string {
    const name = body.inputName || 'settings';
    const key = `${systemId}:${name}`;
    const m = {
      path: `/systems/${systemId}/controlstreams`,
      body: { name: body.name ?? name, inputName: name, schema: { commandFormat: 'application/json', parametersSchema: body.schema } },
    };
    this.made.set(key, m);
    this.ids.set(key, this.create(m));
    return key;
  }

  // --- finding other systems' datastreams --------------------------------------------------------
  private systemId(uid: string): string | null {
    if (!this.systems.has(uid)) {
      for (const parent of ['models', 'barge']) {
        for (const s of JSON.parse(this.request('GET', `/systems/${parent}/subsystems?limit=1000`).text).items) this.systems.set(s.uniqueId, s.id);
      }
    }
    return this.systems.get(uid) ?? null;
  }

  private lookup(key: string): string | null {
    const i = key.indexOf(':');
    const items = JSON.parse(this.request('GET', `/systems/${key.slice(0, i)}/datastreams?limit=1000`).text).items as any[];
    return items.find((d) => d.outputName === key.slice(i + 1))?.id ?? null;
  }

  /** The key of another system's datastream, or null while it is not there. */
  find(systemUid: string, outputName: string): string | null {
    const sid = this.systemId(systemUid);
    if (sid === null) return null;
    const key = `${sid}:${outputName}`;
    const ds = this.lookup(key);
    if (ds === null) return null;
    this.ids.set(key, ds);
    return key;
  }

  private id(key: string): string {
    if (!this.ids.has(key)) {
      const m = this.made.get(key);
      const ds = m ? this.create(m) : this.lookup(key);
      if (ds === null) throw new Refused(`datastream ${key} is not published`);
      this.ids.set(key, ds);
    }
    return this.ids.get(key)!;
  }

  /** Run `call(public id)`; if the identifier has gone (a new schema, a new offering), look it up once more. */
  private on<T>(key: string, call: (id: string) => T): T {
    try {
      return call(this.id(key));
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
      this.ids.delete(key);
      return call(this.id(key));
    }
  }

  // --- observations ---------------------------------------------------------------------------
  private fieldTypes(ds: string): Map<string, string> {
    if (!this.types.has(ds)) {
      const rec = JSON.parse(this.request('GET', `/datastreams/${ds}/schema?obsFormat=application%2Fswe%2Bjson`).text).recordSchema;
      this.types.set(ds, new Map(rec.fields.map((f: any) => [f.name, f.type])));
    }
    return this.types.get(ds)!;
  }

  /** Observations with t0 <= time <= t1 as columns. Numbers arrive as Float64Array (NaN where missing). */
  read(key: string, t0: number, t1: number, fields: string[] | null = null): Cols {
    return this.on(key, (ds) => {
      const types = this.fieldTypes(ds);
      const names = [...types.keys()].filter((n) => n !== 'time' && (fields === null || fields.includes(n)));
      const lo = Math.ceil(Math.max(t0, -SIM_EPOCH_UNIX));
      const hi = Math.floor(t1);
      let rows: Record<string, any>[] = [];
      let path: string | null = hi < lo ? null : `/datastreams/${ds}/observations?phenomenonTime=${iso(lo)}/${iso(hi)}&limit=${PAGE}`;
      while (path) {
        const r = this.request('GET', path);
        rows = rows.length ? rows.concat(JSON.parse(r.text)) : JSON.parse(r.text);
        const nxt: string = r.headers.get('link') ?? '';
        path = nxt.includes('rel="next"') ? nxt.slice(nxt.indexOf('/datastreams/'), nxt.indexOf('>')) : null;
      }
      const cols: Cols = { t: Float64Array.from(rows, (r) => parseIso(r.time)) };
      for (const n of names) {
        const ty = types.get(n)!;
        if (ty === 'Time') cols[n] = Float64Array.from(rows, (r) => (typeof r[n] === 'string' ? parseIso(r[n]) : NaN));
        else if (NUMERIC.has(ty)) cols[n] = Float64Array.from(rows, (r) => (r[n] === null || r[n] === undefined ? NaN : Number(r[n])));
        else cols[n] = rows.map((r) => r[n] ?? null);
      }
      return cols;
    });
  }

  /** Publish columns as observations. `replace`: in place of everything published before (plain HTTP PUT). */
  publish(key: string, cols: Record<string, unknown>, replace = false): number {
    const t = cols.t as ArrayLike<number>;
    const names = Object.keys(cols).filter((k) => k !== 't');
    const made = this.made.get(key);
    const timesToo = new Set<string>(made ? ((made.body.schema as any).recordSchema.fields as any[]).filter((f) => f.type === 'Time').map((f) => f.name) : []);
    const plain = (k: string, v: unknown) => {
      if (timesToo.has(k)) return typeof v === 'number' && Number.isFinite(v) ? iso(v) : null;
      return typeof v === 'number' && !Number.isFinite(v) ? null : v ?? null;
    };
    const rows: Record<string, unknown>[] = new Array(t.length);
    for (let i = 0; i < t.length; i++) {
      const r: Record<string, unknown> = { time: iso(t[i]) };
      for (const k of names) r[k] = plain(k, (cols[k] as ArrayLike<unknown>)[i]);
      rows[i] = r;
    }
    if (!rows.length && !replace) return 0;
    return this.on(key, (ds) => JSON.parse(this.request(replace ? 'PUT' : 'POST', `/datastreams/${ds}/observations`, rows, 'application/swe+json').text).created ?? 0);
  }

  // --- commands (FR-27) -----------------------------------------------------------------------
  commands(key: string): Command[] {
    return this.on(key, (cs) => (JSON.parse(this.request('GET', `/controlstreams/${cs}/commands?statusCode=PENDING`).text).items as any[])
      .map((c) => ({ id: c.id, issueTime: c.issueTime, parameters: c.parameters })));
  }

  commandStatus(cmdId: string, status: string, message = ''): void {
    this.request('POST', `/commands/${cmdId}/status`, { statusCode: status, ...(message ? { message } : {}) });
  }

  // --- the demonstrator's referee (scaffolding; FR-37) -------------------------------------------
  score(kind: string, payload: Record<string, unknown>): Record<string, number | null> {
    return JSON.parse(this.request('POST', `/demonstrator/referee/${kind}`, payload).text);
  }
}

/** Subclass this. `interval` is in simulated seconds. */
export abstract class Model {
  abstract readonly id: string;
  abstract readonly label: string;
  description = '';
  interval = 60;
  /** Simulated seconds between looks at its control stream; null: at each step. */
  commandInterval: number | null = null;
  /** How much history one step takes while catching up. The stand-in takes big steps: startup is fast. */
  catchUpChunk = 86400;
  /** Caught up once this close to now (never less than two intervals). */
  catchUpMargin = 120;
  startFrom: 'history' | 'now' = 'history';
  system = '';
  controlKey: string | null = null;

  systemBody(): Record<string, unknown> {
    return {
      uniqueId: `urn:x-barge:process:${this.id}`, label: this.label, description: this.description,
      systemType: SOSA + 'System', assetType: 'Process',
    };
  }

  setup(api: ModelApi): void {
    this.system = api.createSystem(this.systemBody());
  }

  /** Process data in (t0, t1]; return the time processed up to. */
  step(_api: ModelApi, _t0: number, t1: number): number {
    return t1;
  }

  onCommand(_api: ModelApi, _cmd: Command): string {
    return 'no settings to apply';
  }

  /** For a model that starts from now: a first run once its inputs exist. True when done. */
  initial(_api: ModelApi): boolean {
    return true;
  }
}

/** Steps a model on the simulation clock (csmodel.Runner). */
export class Runner {
  ready = false;
  last: number | null = null;
  retryAt = -1; // after a step that found nothing new, wait before trying again
  phase = 'starting';
  detail = '';
  errors = 0;
  asked = -1; // when it last looked at its control stream
  initialDone = false;

  constructor(readonly model: Model, readonly api: ModelApi) {}

  /**
   * Commands waiting on the model's control stream. Connected Systems publish/subscribe (Part 3) is
   * unpublished, so a model polls, on the simulation clock. `wake`: the demonstrator shell says a
   * viewer's click is waiting while the clock stands still, and lets it through.
   */
  private commandsDue(playing: boolean, wake: boolean): Command[] {
    const m = this.model;
    const now = this.api.now();
    if (!m.controlKey) return [];
    const every = m.commandInterval ?? m.interval;
    if (!(wake || (playing && (this.asked < 0 || now - this.asked >= every)))) return [];
    this.asked = now;
    return this.api.commands(m.controlKey);
  }

  get caughtUp(): boolean {
    return this.last !== null && this.api.now() - this.last < Math.max(2 * this.model.interval, this.model.catchUpMargin);
  }

  tick(playing: boolean, wake = false): void {
    const { api, model: m } = this;
    const now = api.now();
    try {
      if (!this.ready) {
        api.quiet = true;
        m.setup(api);
        this.ready = true;
        this.last = m.startFrom === 'history' ? 0 : now;
        this.phase = 'catching up';
      }
      if (m.startFrom === 'now' && !this.initialDone) {
        api.quiet = true;
        this.initialDone = m.initial(api);
        this.detail = this.initialDone ? '' : 'waiting for its inputs';
        this.phase = this.initialDone ? 'live' : 'catching up';
        return;
      }
      if (!this.caughtUp) {
        api.quiet = true;
        const last = this.last!;
        const upto = Math.min(now, last + m.catchUpChunk);
        const done = m.step(api, last, upto);
        this.last = Math.max(last, done);
        this.detail = `${Math.min(100, Math.round((100 * this.last) / Math.max(now, 1)))}% of history`;
        if (this.caughtUp) {
          this.phase = 'live';
          this.detail = '';
        }
        return;
      }
      api.quiet = false;
      this.phase = 'live';
      this.detail = '';
      for (const cmd of this.commandsDue(playing, wake)) {
        api.commandStatus(cmd.id, 'ACCEPTED');
        try {
          const msg = m.onCommand(api, cmd);
          api.commandStatus(cmd.id, 'COMPLETED', msg || '');
        } catch (e) {
          if (e instanceof Unavailable || e instanceof Refused) throw e;
          api.commandStatus(cmd.id, 'FAILED', `${errorName(e)}: ${(e as Error)?.message ?? e}`);
        }
      }
      if (playing && now - this.last! >= m.interval && now >= this.retryAt) {
        const done = m.step(api, this.last!, now);
        // Its inputs are not there yet: try again a little later (as backend/models/csmodel.py).
        if (done <= this.last!) this.retryAt = now + Math.min(m.interval, 10);
        this.last = Math.max(this.last!, done);
      }
    } catch (e) {
      if (e instanceof Unavailable) this.detail = `waiting: ${e.message}`;
      else if (e instanceof Refused) {
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
