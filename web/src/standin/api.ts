// The data server's HTTP interface: a stand-in that behaves as a configured stock
// OpenSensorHub (FR-06c; docs/v4-interfaces.md §9; backend/barge/api.py, the reference).
// The stand-in has no framework, so this module does what FastAPI's routing and the
// Python `Gate` do, with the same answers and captured messages (PR-06):
//
// * opaque ids; discovery by GET /systems?searchMembers=true; SensorML as
//   application/sml+json; UCUM codes; 201 with the existing Location;
// * one observation per POST; "NaN"; PUT, PATCH and DELETE answer 405;
// * f= chooses the format, Accept is ignored; paging by offset, no next link in SWE JSON;
// * refusals are HTML pages; no instance identifier and no 503 (starting or down: no answer);
// * commands are pushed to subscribers on /api-internal (service accounts only), held 5 s;
// * Basic authentication, 401 with WWW-Authenticate: basic; restricted resources are listed
//   and refused with 403; create and append only under one's own systems.
import { Account, mayReadCo2, MODEL_SERVICES } from './accounts';
import { DEFAULT_LIMIT, MAX_LIMIT, SOSA, URN } from './constants';
import { dumps, npRound, parseQs, PyFloat, pyFloat, qsDict } from './py';
import { Cols, CommandRec, ControlstreamRec, DatastreamRec, Store, Subscription, SystemRec } from './resources';
import type { Server } from './server';
import { PushStream } from './stream';
import { DataRecord, JSON_TYPE, OBS_FORMATS, schemaResponse, SWE_JSON } from './swe';
import type { ComponentId, Letter, Tap } from './tap';
import { iso, parseIso } from './time';
import { badCodes } from './ucum';

const CS1 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/';
const CS2 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/';
const CONFORMANCE = [
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  CS1 + 'system', CS1 + 'subsystem', CS1 + 'sensorml', CS1 + 'geojson',
  CS2 + 'datastream', CS2 + 'controlstream', CS2 + 'json', CS2 + 'swecommon-json', CS2 + 'create-replace-delete',
];
const REASONS: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  415: 'Unsupported Media Type', 500: 'Internal Server Error',
};
const COMMAND_STATUSES = ['ACCEPTED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED'];
export const INTERNAL = '/api-internal';
const NDJSON = 'application/x-ndjson';
const SML_JSON = 'application/sml+json';
const GEO_JSON = 'application/geo+json';
const FORMATS: Record<string, string> = {
  json: JSON_TYPE, [JSON_TYPE]: JSON_TYPE, 'swe+json': SWE_JSON, [SWE_JSON]: SWE_JSON,
  'sml+json': SML_JSON, [SML_JSON]: SML_JSON, geojson: GEO_JSON, [GEO_JSON]: GEO_JSON,
};
const FIELD_TYPES = new Set(['Quantity', 'Count', 'Category', 'Boolean', 'Text', 'Time']);
const SHOWN = 4 * 4000;
const PRECISION = 2;
const COMPONENTS = new Set(['folder', 'importer', 'server', 'models', 'scilibs', 'client']);
// Restricted systems, matched by unique id (§9.3): reading them, or anything under them, answers 403.
const CO2 = /^urn:x-barge:sensor:[^:]+:co2(:|$)/;
const RESTRICTED = /^urn:x-barge:process:[^:]+:restricted(:|$)/;
const WORKSPACE = /^urn:x-barge:workspace:([^:]+)$/;

export interface HttpRequest {
  method: string;
  path: string;
  query: string;
  body: Uint8Array | null;
  headers: [string, string][];
  rootPath: string;
  origin: string;
}

export interface HttpResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  /** A push subscription: the body never ends on its own (§9.2). */
  stream?: PushStream;
}

/** What the HTTP layer needs of the running back end. */
export interface ApiRuntime {
  server: Server | null;
  store: Store;
  tap: Tap;
  holdS: number;
  running: boolean;
  accounts: { authenticate(header: string | null | undefined): Account | null };
  hub: { subscribe(s: Subscription): Subscription; unsubscribe(s: Subscription): void; subscribers(csId: string): Subscription[] };
  now(): number;
  real(): number;
  push(cs: ControlstreamRec, cmd: Record<string, unknown>): number;
  commandStatus(cmdId: string, code: string, message?: string): unknown;
  sleep(seconds: number): Promise<void>;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly description: string, readonly headers: [string, string][] = []) {
    super(description);
  }
}

interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
  stream?: PushStream;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** A refusal is an HTML page, as OpenSensorHub's are; no client may rely on its body (§9.1). */
function refusalPage(status: number, description: string, headers: [string, string][] = []): Reply {
  const title = `${status} ${REASONS[status] ?? 'Error'}`;
  return {
    status, headers: [['content-type', 'text/html; charset=utf-8'], ...headers],
    body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${htmlEscape(description)}</p></body></html>`,
  };
}

function json(body: unknown, status = 200, headers: [string, string][] = []): Reply {
  return { status, headers: [['content-type', 'application/json'], ...headers], body: dumps(body) };
}

function empty(status: number, headers: [string, string][]): Reply {
  return { status, headers, body: '' };
}

function letterForRequest(method: string, path: string): Letter {
  const p = path.replace(/\/+$/, '');
  if (p.startsWith('/demonstrator')) return 'I';
  if (method === 'POST' && p.endsWith('/commands')) return 'K';
  if ((method === 'POST' || method === 'PUT') && p.endsWith('/observations')) return 'O';
  return 'Q';
}

function letterForResponse(status: number, path: string, ctype: string): Letter {
  if (status >= 400) return 'H';
  const p = path.replace(/\/+$/, '');
  if (p.startsWith('/demonstrator')) return 'I';
  if (p.endsWith('/profile.json')) return 'P';
  if (ctype.includes('swe+json') || p.endsWith('/observations')) return 'O';
  return 'D';
}

function shown(b: Uint8Array | string): string {
  const s = typeof b === 'string' ? b : new TextDecoder().decode(b.subarray(0, SHOWN));
  const n = typeof b === 'string' ? b.length : b.length;
  return n <= SHOWN ? s : s.slice(0, SHOWN) + `… (${n} bytes in all)`;
}

// --- permissions (§9.3; api.restricted_for, api.owns) -----------------------------------------
/**
 * True when this account may not read a system (with its ancestors): listed, refused with 403. With `contents` false
 * only its description is read, and a restricted one is described to everyone: a stream's title may be known, not its
 * contents (D-351). Another user's workspace is refused whole.
 */
export function restrictedFor(chain: SystemRec[], acct: Account, contents = true): boolean {
  for (const s of chain) {
    if (contents && (CO2.test(s.uid) || RESTRICTED.test(s.uid)) && !mayReadCo2(acct.role)) return true;
    const m = WORKSPACE.exec(s.uid);
    if (m && m[1] !== acct.user) return true;
  }
  return false;
}

export function owns(chain: SystemRec[], acct: Account): boolean {
  const uids = chain.map((s) => s.uid);
  if (acct.kind === 'user') return uids.includes(`${URN}workspace:${acct.user}`);
  if (acct.user === 'svc-importer') return uids.some((u) => u === URN + 'importer' || u.startsWith(URN + 'sensor:'));
  const mine = `${URN}process:${acct.user.slice(4)}`;
  return uids.some((u) => u === mine || u.startsWith(mine + ':'));
}

interface Ctx {
  method: string;
  rel: string;
  q: Map<string, string>;
  headers: Map<string, string>;
  base: string;
  body: Uint8Array;
  account: Account;
  model: string | null;
  quiet: boolean;
  internal: boolean;
}

const INT_RE = /^\s*[+-]?\d+\s*$/;

function intParam(c: Ctx, name: string, dflt: number): number {
  const v = c.q.get(name);
  if (v === undefined) return dflt;
  if (!INT_RE.test(v)) throw new Refusal(400, `${name}: Input should be a valid integer, unable to parse string as an integer`);
  return parseInt(v, 10);
}

function interval(text: string): [number, number] {
  let t0: number;
  let t1: number;
  try {
    if (text.includes('/')) {
      const i = text.indexOf('/');
      const a = text.slice(0, i);
      const b = text.slice(i + 1);
      t0 = a === '' || a === '..' ? -Infinity : parseIso(a);
      t1 = b === '' || b === '..' || b === 'now' ? Infinity : parseIso(b);
    } else {
      t0 = t1 = parseIso(text);
    }
  } catch (e) {
    throw new Refusal(400, `time interval: ${(e as Error).message}`);
  }
  if (t1 < t0) throw new Refusal(400, 'time interval: it ends before it starts');
  return [t0, t1];
}

/** api._decode: one published value, as stored. */
function decode(name: string, ty: string, v: unknown): unknown {
  if (ty === 'Quantity') {
    if (v === 'NaN') return NaN;
    if (typeof v !== 'number') throw new Refusal(400, `${name}: a Quantity is a number or "NaN", not ${JSON.stringify(v ?? null)}`);
    return v;
  }
  if (ty === 'Count') { // OpenSensorHub refuses both "NaN" and null in a Count (D-197)
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new Refusal(400, `${name}: a Count is a whole number`);
    return v;
  }
  if (ty === 'Boolean') {
    if (v === null || v === undefined) return NaN;
    if (typeof v !== 'boolean') throw new Refusal(400, `${name}: a Boolean is true or false`);
    return v ? 1 : 0;
  }
  if (ty === 'Time') {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v !== 'string') throw new Refusal(400, `${name}: not an ISO 8601 time`);
    try {
      return parseIso(v);
    } catch {
      throw new Refusal(400, `${name}: not an ISO 8601 time`);
    }
  }
  if (v !== null && v !== undefined && typeof v !== 'string') throw new Refusal(400, `${name}: a ${ty} is text`);
  return v ?? null;
}

/** api._column: one column of values as JSON ("NaN" for a missing number). */
function column(fd: Record<string, any>, v: ArrayLike<unknown>): unknown[] {
  const ty = fd.type;
  if (ty === 'Time') {
    return Array.from(v, (x) => {
      const n = x === null || x === undefined ? NaN : Number(x);
      return Number.isFinite(n) ? iso(n) : null;
    });
  }
  if (ty === 'Quantity') return Array.from(v as ArrayLike<number>, (x) => (Number.isNaN(x) ? 'NaN' : new PyFloat(npRound(x, PRECISION))));
  if (ty === 'Count') return Array.from(v as ArrayLike<number>, (x) => (Number.isNaN(x) ? 'NaN' : Math.trunc(x)));
  if (ty === 'Boolean') return Array.from(v as ArrayLike<number>, (x) => (Number.isNaN(x) ? null : !!x));
  return Array.from(v, (x) => (typeof x === 'number' && Number.isNaN(x) ? null : x));
}

export class Api {
  constructor(private readonly rt: ApiRuntime) {}

  private srv(): Server {
    return this.rt.server!;
  }

  private get store(): Store {
    return this.rt.store;
  }

  /** One request through the seam: the Python `Gate`. null: no answer at all (starting or down, §9.1). */
  async handle(req: HttpRequest): Promise<HttpResponse | null> {
    const rt = this.rt;
    if (!rt.running) return null;
    const tap = rt.tap;
    const method = req.method.toUpperCase();
    let root = req.rootPath || '';
    let rel = req.path || '/';
    let internal = root.endsWith(INTERNAL);
    if (!internal && (rel === INTERNAL || rel.startsWith(INTERNAL + '/'))) { // served at the site's root
      internal = true;
      root += INTERNAL;
      rel = rel.slice(INTERNAL.length) || '/';
    }
    const headers = new Map<string, string>();
    for (const [k, v] of req.headers) headers.set(k.toLowerCase(), v);
    const body = req.body ?? new Uint8Array(0);
    const auth = headers.get('authorization') ?? null;
    const acct = rt.accounts.authenticate(auth);
    const model = headers.get('x-tap-model') || null;
    const quiet = headers.get('x-tap-quiet') === '1';
    const who: ComponentId = model ? 'models' : (acct && COMPONENTS.has(acct.component) ? acct.component : 'client') as ComponentId;
    const opts = { model: model ?? undefined, quiet };
    const hopText = headers.get('x-tap-hop') ?? '1';
    const where = internal ? INTERNAL : '';
    const ask = `${method} ${where}${rel}${req.query ? '?' + req.query : ''}`;
    let prev = tap.beginChain(headers.get('x-tap-chain') ?? null, /^\d+$/.test(hopText) ? parseInt(hopText, 10) : 1);
    const chainId = tap.chainId();
    tap.emit(who, 'server', letterForRequest(method, rel), model ? `${model}: ${ask}` : ask,
      ask + (auth ? `\nAuthorization: ${auth}` : '') + (body.length ? '\n\n' + shown(body) : ''), opts);
    let hops = tap.endChain(prev);

    let resp: Reply;
    if (!acct) { // as OpenSensorHub answers; the relay drops WWW-Authenticate (D-226)
      resp = refusalPage(401, 'valid credentials are needed', [['www-authenticate', 'basic']]);
    } else if (internal && acct.kind !== 'service') { // the internal endpoint is for the server's own processes (D-223)
      resp = refusalPage(403, 'the internal endpoint is for service accounts only');
    } else {
      const ctx: Ctx = {
        method, rel, q: qsDict(parseQs(req.query || '')), headers, body, account: acct, model, quiet, internal,
        base: (req.origin + root).replace(/\/+$/, ''),
      };
      try {
        resp = await this.route(ctx);
      } catch (e) {
        if (e instanceof Refusal) resp = refusalPage(e.status, e.description, e.headers);
        else throw e;
      }
    }
    const payload = new TextEncoder().encode(resp.body);
    const out: [string, string][] = resp.headers.filter(([k]) => k.toLowerCase() !== 'content-length');
    if (!resp.stream) out.push(['content-length', String(payload.length)]);
    out.push(['x-tap-hops', String(hops + 1)]);
    prev = tap.beginChain(chainId, hops); // the response is on its request's chain
    const ctype = out.find(([k]) => k === 'content-type')?.[1] ?? '';
    const summary = `${resp.status} ${where}${rel}` + (resp.stream ? ' (subscribed)' : '');
    tap.emit('server', who, letterForResponse(resp.status, rel, ctype), model ? `${model}: ${summary}` : summary,
      resp.stream ? 'push subscription open: commands follow as they are sent' : shown(resp.body), opts);
    hops = tap.endChain(prev);
    return { status: resp.status, headers: out, body: method === 'HEAD' ? new Uint8Array(0) : payload, stream: resp.stream };
  }

  // --- routing ---------------------------------------------------------------------------------
  private async route(c: Ctx): Promise<Reply> {
    const m = c.method;
    const seg = c.rel.split('/').filter(Boolean);
    const [a, b, d] = seg;
    const get = m === 'GET';
    const nope = (): never => {
      if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') throw new Refusal(405, `${m} is not allowed: nothing is replaced or deleted`);
      if (m !== 'GET') throw new Refusal(405, `${m} ${c.rel} is not allowed`);
      throw new Refusal(404, `no resource at ${c.rel}`);
    };
    if (seg.length === 0) return get ? this.landing(c) : nope();
    if (seg.length === 1 && a === 'conformance') return get ? this.conformance() : nope();
    if (seg.length === 1 && a === 'profile.json') return get ? json(this.srv().profile) : nope();
    if (a === 'collections') {
      if (seg.length === 1 && get) return this.collections(c);
      if (seg.length === 2 && get) return this.collection(c, b);
      if (seg.length === 3 && d === 'items' && get) return this.collectionItems(c, b);
      return nope();
    }
    if (a === 'systems') {
      if (seg.length === 1) return get ? this.systemsList(c) : m === 'POST' ? this.createSystem(c, null) : nope();
      const s = this.store.systems.get(b);
      if (!s) {
        if (m === 'PUT' || m === 'PATCH' || m === 'DELETE') nope();
        throw new Refusal(404, `system ${b} not found`);
      }
      if (seg.length === 2) return get ? this.system(c, s) : nope();
      if (seg.length === 3 && d === 'subsystems') {
        if (get) return this.subsystems(c, s);
        if (m === 'POST') {
          this.readable(c, s.id);
          return this.createSystem(c, s.id);
        }
      }
      if (seg.length === 3 && d === 'datastreams') {
        if (get) return this.dsList(c, [...this.store.datastreams.values()].filter((x) => x.system === s.id), `/systems/${s.id}/datastreams`);
        if (m === 'POST') return this.createDatastream(c, s);
      }
      if (seg.length === 3 && d === 'controlstreams') {
        if (get) return this.csList(c, [...this.store.controlstreams.values()].filter((x) => x.system === s.id), `/systems/${s.id}/controlstreams`);
        if (m === 'POST') return this.createControlstream(c, s);
      }
      return nope();
    }
    if (a === 'datastreams') {
      if (seg.length === 1) return get ? this.dsList(c, [...this.store.datastreams.values()], '/datastreams') : nope();
      if (m !== 'GET' && m !== 'POST') nope();
      const ds = this.getDs(b, m === 'POST');
      if (seg.length === 2 && get) {
        this.readable(c, ds.system, false);
        return json(this.dsJson(c, ds));
      }
      if (seg.length === 3 && d === 'schema' && get) {
        this.readable(c, ds.system, false);
        return json(schemaResponse(this.srv().visible(ds), this.fmt(c.q.get('obsFormat') ?? c.q.get('f'), JSON_TYPE, OBS_FORMATS)));
      }
      if (seg.length === 3 && d === 'observations') return get ? this.observations(c, ds) : this.postObservation(c, ds);
      return nope();
    }
    if (a === 'controlstreams') {
      if (seg.length === 1) return get ? this.csList(c, [...this.store.controlstreams.values()], '/controlstreams') : nope();
      if (m !== 'GET' && m !== 'POST') nope();
      const cs = this.getCs(b);
      if (seg.length === 2 && get) {
        this.readable(c, cs.system, false);
        return json(this.csJson(c, cs));
      }
      if (seg.length === 3 && d === 'schema' && get) {
        this.readable(c, cs.system, false);
        return json({ commandFormat: JSON_TYPE, parametersSchema: cs.schema });
      }
      if (seg.length === 3 && d === 'commands') return get ? this.commands(c, cs) : this.postCommand(c, cs);
      if (seg.length === 3 && d === 'status') return get ? this.statusList(c, cs) : this.postStatus(c, cs);
      return nope();
    }
    if (a === 'commands' && seg.length >= 2 && get) {
      const cmd = this.store.commands.get(b);
      if (!cmd) throw new Refusal(404, `command ${b} not found`);
      this.readable(c, this.getCs(cmd['controlstream@id']).system);
      if (seg.length === 2) return json(this.commandJson(c, cmd));
      if (seg.length === 3 && d === 'status') return json({ items: cmd.status });
    }
    if (a === 'demonstrator' && b === 'referee' && seg.length === 3 && m === 'POST') return this.referee(c, d);
    return nope();
  }

  // --- helpers ---------------------------------------------------------------------------------
  private link(c: Ctx, href: string, rel: string, type = JSON_TYPE) {
    return { href: c.base + href, rel, type };
  }

  private page(c: Ctx, items: unknown[], path: string) {
    const limit = intParam(c, 'limit', DEFAULT_LIMIT);
    const offset = intParam(c, 'offset', 0);
    if (limit < 1 || offset < 0) throw new Refusal(400, 'limit must be at least 1 and offset zero or more');
    const links = [this.link(c, path, 'self')];
    if (offset + limit < items.length) links.push(this.link(c, `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset + limit}`, 'next'));
    return { items: items.slice(offset, offset + limit), links };
  }

  private fmt(f: string | undefined, dflt: string, allowed: string[]): string {
    if (f === undefined) return dflt; // Accept is ignored, as OpenSensorHub ignores it (§9.1)
    const norm = FORMATS[f.trim()];
    if (!allowed.includes(norm)) throw new Refusal(400, `format ${f} is not offered here; offered: ${allowed.join(', ')}`);
    return norm;
  }

  /** 403 when the account may not read the system (listed, refused: §9.3); `contents` false: its description only (D-351). */
  private readable(c: Ctx, sid: string, contents = true): SystemRec[] {
    const chain = this.store.chain(sid);
    if (restrictedFor(chain, c.account, contents)) throw new Refusal(403, 'this account may not read this resource');
    return chain;
  }

  private writable(c: Ctx, sid: string): void {
    if (!owns(this.store.chain(sid), c.account)) throw new Refusal(403, 'create and append only under your own systems');
  }

  private getDs(id: string, hidden = false): DatastreamRec {
    const d = this.store.datastreams.get(id);
    if (!d || !(hidden || this.srv().served(d))) throw new Refusal(404, `datastream ${id} not found`);
    return d;
  }

  private getCs(id: string): ControlstreamRec {
    const cs = this.store.controlstreams.get(id);
    if (!cs || cs.replaced) throw new Refusal(404, `control stream ${id} not found`);
    return cs;
  }

  private jsonBody(c: Ctx): any {
    const text = new TextDecoder().decode(c.body);
    try {
      return JSON.parse(text || 'null');
    } catch {
      throw new Refusal(400, 'the request body must be JSON');
    }
  }

  private created(c: Ctx, href: string): Reply {
    return empty(201, [['location', c.base + href]]);
  }

  // --- discovery --------------------------------------------------------------------------------
  private landing(c: Ctx): Reply {
    return json({
      title: 'Canal barge weather demonstrator',
      description: "A stand-in for OpenSensorHub's Connected Systems API. Everything is fictional.",
      links: [this.link(c, '/', 'self'), this.link(c, '/conformance', 'conformance'), this.link(c, '/collections', 'data'),
        this.link(c, '/systems', 'systems'), this.link(c, '/datastreams', 'datastreams'), this.link(c, '/controlstreams', 'controlstreams')],
    });
  }

  private conformance(): Reply {
    const claims = [...CONFORMANCE];
    if (this.srv().claimsProfile()) claims.push(this.srv().profile.id);
    return json({ conformsTo: claims });
  }

  private collectionJson(c: Ctx, cid: string) {
    const items = cid === 'all_systems' ? '/systems' : `/collections/${cid}/items`;
    return { id: cid, title: cid === 'all_systems' ? 'All systems' : 'All datastreams', itemType: cid === 'all_systems' ? 'feature' : 'Datastream',
      links: [this.link(c, `/collections/${cid}`, 'self'), this.link(c, items, 'items')] };
  }

  private collections(c: Ctx): Reply {
    return json({ links: [this.link(c, '/collections', 'self')], collections: ['all_systems', 'all_datastreams'].map((x) => this.collectionJson(c, x)) });
  }

  private collection(c: Ctx, cid: string): Reply {
    if (cid !== 'all_systems' && cid !== 'all_datastreams') throw new Refusal(404, `collection ${cid} not found`);
    return json(this.collectionJson(c, cid));
  }

  private collectionItems(c: Ctx, cid: string): Reply {
    if (cid === 'all_systems') throw new Refusal(400, "Invalid resource name: 'items'"); // as OpenSensorHub (D-193)
    if (cid === 'all_datastreams') return this.dsList(c, [...this.store.datastreams.values()], `/collections/${cid}/items`);
    throw new Refusal(404, `collection ${cid} not found`);
  }

  // --- systems ---------------------------------------------------------------------------------
  private systemJson(c: Ctx, s: SystemRec, form: string, listed = true) {
    const links = [this.link(c, `/systems/${s.id}`, 'self'), this.link(c, `/systems/${s.id}/datastreams`, 'datastreams'),
      this.link(c, `/systems/${s.id}/subsystems`, 'subsystems'), this.link(c, `/systems/${s.id}/controlstreams`, 'controlstreams')];
    if (s.parent && !listed) links.push(this.link(c, `/systems/${s.parent}`, 'parent')); // a listing carries no parent link (D-193)
    if (form === SML_JSON || form === JSON_TYPE) {
      return { type: ['Process', 'Simulation', 'Other'].includes(s.asset) ? 'SimpleProcess' : 'PhysicalSystem', id: s.id, uniqueId: s.uid,
        label: s.label, description: s.description, definition: s.feature, assetType: s.asset, links };
    }
    return { type: 'Feature', id: s.id, geometry: null,
      properties: { featureType: s.feature, uid: s.uid, name: s.label, description: s.description, assetType: s.asset }, links };
  }

  private systemsList(c: Ctx): Reply {
    const form = this.fmt(c.q.get('f'), GEO_JSON, [GEO_JSON, SML_JSON, JSON_TYPE]);
    const all = ['true', '1', 'yes', 'on'].includes((c.q.get('searchMembers') ?? '').toLowerCase());
    const items = [...this.store.systems.values()].filter((s) => all || !s.parent).map((s) => this.systemJson(c, s, form));
    return json(this.page(c, items, '/systems' + (all ? '?searchMembers=true' : '')));
  }

  private system(c: Ctx, s: SystemRec): Reply {
    const form = this.fmt(c.q.get('f'), GEO_JSON, [GEO_JSON, SML_JSON, JSON_TYPE]);
    this.readable(c, s.id, false);
    return json(this.systemJson(c, s, form, false));
  }

  private subsystems(c: Ctx, s: SystemRec): Reply {
    const form = this.fmt(c.q.get('f'), GEO_JSON, [GEO_JSON, SML_JSON, JSON_TYPE]);
    this.readable(c, s.id, false);
    const items = [...this.store.systems.values()].filter((x) => x.parent === s.id).map((x) => this.systemJson(c, x, form));
    return json(this.page(c, items, `/systems/${s.id}/subsystems`));
  }

  private createSystem(c: Ctx, parent: string | null): Reply {
    const a = c.account;
    const body = this.jsonBody(c);
    const ctype = (c.headers.get('content-type') ?? JSON_TYPE).split(';')[0].trim().toLowerCase();
    const kind = body && typeof body === 'object' ? body.type : undefined;
    // D-194: SensorML is sent as application/sml+json; anything else is read as GeoJSON, as OpenSensorHub does.
    if (ctype === SML_JSON && kind === 'Feature') throw new Refusal(400, 'a SensorML description cannot be a GeoJSON Feature');
    if (ctype !== SML_JSON && kind !== 'Feature') throw new Refusal(400, "The type of a GeoJSON feature must be 'Feature' (send SensorML as application/sml+json)");
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'a system must be SensorML JSON or a GeoJSON feature');
    const props = body.properties && typeof body.properties === 'object' ? body.properties : {};
    const uid = body.uniqueId ?? props.uid;
    const label = body.label ?? body.name ?? props.name;
    if (typeof uid !== 'string' || !uid || typeof label !== 'string') throw new Refusal(400, 'a system needs a uniqueId and a label');
    if (parent === null) {
      if (!(a.user === 'svc-importer' && uid === URN + 'importer')) throw new Refusal(403, 'this account may not create a top-level system');
    } else {
      const chain = this.store.chain(parent);
      const registering = MODEL_SERVICES.includes(a.user) && chain[0]?.uid === URN + 'process:models' && uid === `${URN}process:${a.user.slice(4)}`;
      if (!(registering || owns(chain, a))) throw new Refusal(403, 'this account may not create a system here');
    }
    const [s] = this.store.addSystem(uid, label, body.description ?? props.description ?? '', body.definition ?? props.featureType ?? SOSA + 'System',
      body.assetType ?? props.assetType ?? 'Process', parent, a.user);
    return this.created(c, `/systems/${s.id}`);
  }

  // --- datastreams and observations --------------------------------------------------------------
  private dsJson(c: Ctx, d: DatastreamRec) {
    const rec = this.srv().visible(d);
    const props = rec.fields.filter((f) => !(f.type === 'Time' && f.name === 'time'))
      .map((f) => ({ definition: f.definition ?? '', label: f.label ?? f.name, name: f.name }));
    const span = this.srv().timeRange(d);
    const spanIso = span ? [iso(span[0]), iso(span[1])] : null;
    const now = new Date(Math.floor(this.rt.real()) * 1000).toISOString().slice(0, 19) + 'Z';
    const times = spanIso ? { validTime: spanIso, phenomenonTime: spanIso, resultTime: spanIso } : { validTime: [now, now] };
    return {
      id: d.id, name: d.name, outputName: d.outputName, 'system@id': d.system, 'system@link': { href: c.base + `/systems/${d.system}` },
      ...times, resultType: 'record', live: false, formats: [...OBS_FORMATS], observedProperties: props,
      links: [this.link(c, `/datastreams/${d.id}`, 'self'), this.link(c, `/datastreams/${d.id}/schema?obsFormat=application%2Fswe%2Bjson`, 'schema'),
        this.link(c, `/datastreams/${d.id}/observations`, 'observations')],
    };
  }

  private dsList(c: Ctx, list: DatastreamRec[], path: string): Reply {
    return json(this.page(c, list.filter((d) => this.srv().served(d)).map((d) => this.dsJson(c, d)), path));
  }

  private createDatastream(c: Ctx, s: SystemRec): Reply {
    this.readable(c, s.id);
    this.writable(c, s.id);
    const body = this.jsonBody(c);
    const rec = body?.schema?.recordSchema;
    const out = body?.outputName;
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.fields) || !rec.fields.length || typeof out !== 'string' || !out) {
      throw new Refusal(400, 'a datastream needs an outputName and a SWE Common DataRecord');
    }
    const bad = badCodes(rec);
    if (bad.length) throw new Refusal(400, `Invalid UCUM code '${bad[0]}'`); // D-195
    if (rec.fields[0].type !== 'Time' || rec.fields[0].name !== 'time') throw new Refusal(400, 'the first field must be a Time named time');
    for (const f of rec.fields) {
      if (!FIELD_TYPES.has(f.type) || !f.name) throw new Refusal(400, `field ${f.name}: type ${f.type} is not supported`);
    }
    const [d] = this.store.addDatastream(s.id, out, body.name ?? out, rec as DataRecord, c.account.user);
    return this.created(c, `/datastreams/${d.id}`);
  }

  private observations(c: Ctx, d: DatastreamRec): Reply {
    this.readable(c, d.system);
    const of = this.fmt(c.q.get('f'), JSON_TYPE, OBS_FORMATS);
    const limit = intParam(c, 'limit', DEFAULT_LIMIT);
    const offset = intParam(c, 'offset', 0);
    if (limit < 1 || offset < 0) throw new Refusal(400, 'limit must be at least 1 and offset zero or more');
    const lim = Math.min(limit, MAX_LIMIT); // a limit over the maximum is served, not refused (§9.1)
    const phen = c.q.get('phenomenonTime');
    const resultTime = c.q.get('resultTime');
    const latest = resultTime === 'latest';
    let [t0, t1] = phen ? interval(phen) : [-Infinity, Infinity];
    if (resultTime && !latest) {
      const [r0, r1] = interval(resultTime);
      t0 = Math.max(t0, r0);
      t1 = Math.min(t1, r1);
    }
    const rec = this.srv().visible(d);
    const names = rec.fields.map((f) => f.name).filter((n) => n !== 'time');
    const ser = d.series;
    let idx: number[];
    if (latest) {
      const i = ser.latest();
      idx = i === null ? [] : [i];
    } else {
      const [i0, i1] = ser.range(t0, t1);
      idx = [];
      for (let i = i0 + offset; i < Math.min(i1, i0 + offset + lim); i++) idx.push(i);
    }
    const cols: Cols = ser.take(idx, names);
    return this.obsResponse(c, d, rec, cols, of, lim, offset);
  }

  private obsResponse(c: Ctx, d: DatastreamRec, rec: DataRecord, cols: Cols, of: string, lim: number, offset: number): Reply {
    const fields = rec.fields.filter((f) => f.name !== 'time' && f.name in cols);
    const times = Array.from(cols.t, (x) => iso(x));
    const columns: [string, unknown[]][] = fields.map((f) => [f.name, column(f, cols[f.name] as ArrayLike<unknown>)]);
    if (of === SWE_JSON) { // an array of records, time first; no next link (§9.1)
      const keys = columns.map(([n]) => ',' + dumps(n, true) + ':');
      const seen = new Map<string, string>();
      const enc = (x: unknown): string => {
        if (x === null || x === undefined) return 'null';
        if (x instanceof PyFloat) return pyFloat(x.v);
        if (typeof x === 'string') {
          let t = seen.get(x);
          if (t === undefined) seen.set(x, (t = dumps(x, true)));
          return t;
        }
        return dumps(x, true);
      };
      const parts: string[] = new Array(times.length);
      for (let i = 0; i < times.length; i++) {
        let row = '{"time":"' + times[i] + '"';
        for (let k = 0; k < columns.length; k++) row += keys[k] + enc(columns[k][1][i]);
        parts[i] = row + '}';
      }
      return { status: 200, headers: [['content-type', SWE_JSON]], body: '[' + parts.join(',') + ']' };
    }
    const items = times.map((tt, i) => {
      const result: Record<string, unknown> = {};
      for (const [n, col] of columns) result[n] = col[i];
      return { id: `${d.id}-${offset + i}`, 'datastream@id': d.id, phenomenonTime: tt, resultTime: tt, result };
    });
    const path = `/datastreams/${d.id}/observations`;
    const links: { href: string; rel: string }[] = [{ href: `${c.base}${path}`, rel: 'self' }];
    if (times.length === lim) {
      const q = new Map(c.q);
      q.set('limit', String(lim));
      q.set('offset', String(offset + lim));
      links.push({ href: `${c.base}${path}?` + [...q].map(([k, v]) => `${k}=${v}`).join('&'), rel: 'next' });
    }
    return json({ items, links });
  }

  private postObservation(c: Ctx, d: DatastreamRec): Reply {
    this.readable(c, d.system);
    this.writable(c, d.system);
    const body = this.jsonBody(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'one observation per request: the body must be one JSON object');
    let t: unknown;
    let values: Record<string, unknown>;
    if (body.result && typeof body.result === 'object') {
      t = body.phenomenonTime;
      values = body.result;
    } else {
      t = body.time;
      values = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'time'));
    }
    if (typeof t !== 'string') throw new Refusal(400, 'an observation needs its time (ISO 8601, UTC)');
    let tt: number;
    try {
      tt = parseIso(t);
    } catch (e) {
      throw new Refusal(400, `time: ${(e as Error).message}`);
    }
    const types = new Map(d.schema.fields.filter((f) => f.name !== 'time').map((f) => [f.name, f.type]));
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      const ty = types.get(k);
      if (!ty) throw new Refusal(400, `field ${k} is not in the datastream's schema`);
      row[k] = decode(k, ty, v);
    }
    this.store.appendRow(d, tt, row);
    return empty(201, [['location', c.base + `/datastreams/${d.id}/observations`]]);
  }

  // --- control streams and commands ---------------------------------------------------------------
  private csJson(c: Ctx, cs: ControlstreamRec) {
    return {
      id: cs.id, name: cs.name, inputName: cs.inputName, 'system@id': cs.system, 'system@link': { href: c.base + `/systems/${cs.system}` },
      live: this.rt.hub.subscribers(cs.id).length > 0, async: true, formats: [JSON_TYPE],
      links: [this.link(c, `/controlstreams/${cs.id}`, 'self'), this.link(c, `/controlstreams/${cs.id}/schema`, 'schema'),
        this.link(c, `/controlstreams/${cs.id}/commands`, 'commands')],
    };
  }

  private csList(c: Ctx, list: ControlstreamRec[], path: string): Reply {
    return json(this.page(c, list.filter((x) => !x.replaced).map((x) => this.csJson(c, x)), path));
  }

  private createControlstream(c: Ctx, s: SystemRec): Reply {
    this.readable(c, s.id);
    this.writable(c, s.id);
    const body = this.jsonBody(c);
    const rec = body?.schema?.parametersSchema;
    const name = body?.inputName;
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.fields) || typeof name !== 'string' || !name) {
      throw new Refusal(400, 'a control stream needs an inputName and a SWE Common DataRecord of parameters');
    }
    const bad = badCodes(rec);
    if (bad.length) throw new Refusal(400, `Invalid UCUM code '${bad[0]}'`);
    const [cs] = this.store.addControlstream(s.id, name, body.name ?? name, rec as DataRecord, c.account.user);
    return this.created(c, `/controlstreams/${cs.id}`);
  }

  private commandJson(c: Ctx, cmd: CommandRec) {
    return {
      id: cmd.id, 'controlstream@id': cmd['controlstream@id'], issueTime: cmd.issueTime, parameters: cmd.parameters, sender: cmd.sender,
      currentStatus: cmd.status.length ? cmd.status[cmd.status.length - 1].statusCode : 'PENDING',
      links: [this.link(c, `/commands/${cmd.id}/status`, 'status')],
    };
  }

  private async postCommand(c: Ctx, cs: ControlstreamRec): Promise<Reply> {
    this.readable(c, cs.system); // every user may command what it may read (§9.3)
    const body = this.jsonBody(c);
    const params = body?.parameters;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Refusal(400, 'a command needs a parameters object');
    const names = cs.schema.fields.map((f) => f.name);
    const missing = names.filter((n) => !(n in params));
    const unknown = Object.keys(params).filter((k) => !names.includes(k));
    if (missing.length || unknown.length) { // every parameter, on every command; bounds are the receiver's
      throw new Refusal(400, `a command carries every parameter: missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(unknown)}`);
    }
    const id = this.store.ids.next('command');
    const issueTime = new Date(Math.round(this.rt.real() * 1000)).toISOString();
    const cmd: CommandRec = { id, 'controlstream@id': cs.id, issueTime, parameters: params, sender: c.account.user, status: [] };
    if (!this.rt.hub.subscribers(cs.id).length) {
      await this.rt.sleep(this.rt.holdS); // dropped: nobody listens (§9.1)
      return { status: 202, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Accepted, but the request timed out: no receiver is subscribed' };
    }
    this.store.commands.set(id, cmd);
    this.rt.push(cs, { id, parameters: params, issueTime, sender: c.account.user });
    await this.rt.sleep(this.rt.holdS); // the sender never waits on this answer (FR-27, AT-39)
    // OpenSensorHub stores the sender's PENDING as it answers, often after the receiver's COMPLETED (D-199).
    this.rt.commandStatus(id, 'PENDING');
    return json({ ...this.commandJson(c, cmd), currentStatus: 'PENDING' }, 200, [['location', c.base + `/commands/${id}`]]);
  }

  private commands(c: Ctx, cs: ControlstreamRec): Reply {
    this.readable(c, cs.system);
    const sub = c.q.get('subscribe');
    if (sub !== undefined && !['', '0', 'false'].includes(sub)) {
      if (!c.internal) throw new Refusal(403, `subscribe on the internal endpoint (${INTERNAL}), as a service account`); // D-223
      const stream = new PushStream();
      const s = this.rt.hub.subscribe(new Subscription(cs.id, c.account, c.model, stream)); // registered before the answer
      stream.onCancel = () => this.rt.hub.unsubscribe(s);
      return { status: 200, headers: [['content-type', NDJSON], ['cache-control', 'no-store']], body: '', stream };
    }
    return json(this.page(c, [...this.store.commands.values()].filter((x) => x['controlstream@id'] === cs.id).map((x) => this.commandJson(c, x)),
      `/controlstreams/${cs.id}/commands`));
  }

  private postStatus(c: Ctx, cs: ControlstreamRec): Reply {
    this.readable(c, cs.system);
    this.writable(c, cs.system);
    const body = this.jsonBody(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'a status report is a JSON object');
    const cmd = this.store.commands.get(body['command@id']);
    if (!cmd || cmd['controlstream@id'] !== cs.id) throw new Refusal(400, `command ${body['command@id']} is not one of this control stream's`);
    if (!COMMAND_STATUSES.includes(body.statusCode)) throw new Refusal(400, `statusCode must be one of ${COMMAND_STATUSES.join(', ')}`);
    this.rt.commandStatus(cmd.id, body.statusCode, body.message ? String(body.message) : '');
    return empty(201, [['location', c.base + `/commands/${cmd.id}/status`]]);
  }

  private statusList(c: Ctx, cs: ControlstreamRec): Reply {
    this.readable(c, cs.system);
    return json(this.page(c, [...(this.store.statusReports.get(cs.id) ?? [])], `/controlstreams/${cs.id}/status`));
  }

  /**
   * The demonstrator's referee (scaffolding, FR-37). The stand-in has none: the manifest (the ground
   * truth) is written by the Python world generator and is not part of the pre-calculated history,
   * so every score is null (FR-06e).
   */
  private referee(c: Ctx, kind: string): Reply {
    this.jsonBody(c);
    if (kind === 'changes') return json({ boundary_recall: null, boundary_precision: null, front_recall: null, scored_by: 'stand-in: not scored' });
    if (kind === 'clusters') return json({ ari_air_mass: null, ari_reach_kind: null, scored_by: 'stand-in: not scored' });
    throw new Refusal(404, `the referee scores changes and clusters, not ${kind}`);
  }
}
