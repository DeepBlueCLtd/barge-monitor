// The data server's HTTP interface (C-04 behind C-06; api.py). In the Python
// back end this is FastAPI on Starlette; the stand-in has no framework, so
// this module does what FastAPI's routing, parameter validation and the
// `lifecycle` middleware do, with the same refusals, headers and captured
// messages (FR-06c, FR-06g, PR-06). The routes are the declared subset of OGC
// API – Connected Systems Parts 1 and 2 (FR-23..FR-30); everything else is
// refused with the thing refused named.
import openapiJson from '../../../contracts/openapi.json';
import { DEFAULT_LIMIT, MAX_LIMIT, PROFILE_URI, RETRY_AFTER_S, SOSA } from './constants';
import { CATALOGUE, Field } from './fields';
import type { ModelHost } from './modelhost';
import { dumps, npRound, parseQs, PyFloat, pySlice, qsDict, urlencode } from './py';
import { Cols, CommandRec, ControlstreamRec } from './registry';
import { CommandError, DsView, Server } from './server';
import { JSON_TYPE, OBS_FORMATS, schemaResponse, SWE_JSON } from './swe';
import type { Letter, Tap } from './tap';
import { iso, parseIso } from './time';

const CS1 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/';
const CS2 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/';
const CONFORMANCE = [
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
  'http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  CS1 + 'api-common', CS1 + 'system', CS1 + 'subsystem', CS1 + 'property', CS1 + 'sensorml',
  CS2 + 'api-common', CS2 + 'datastream', CS2 + 'controlstream', CS2 + 'json', CS2 + 'swecommon-json',
];
const NOT_IMPLEMENTED: Record<string, string> = {
  deployments: 'Part 1 Deployment Features', procedures: 'Part 1 Procedure Features',
  samplingFeatures: 'Part 1 Sampling Features', featuresOfInterest: 'Part 1 Sampling Features',
  systemEvents: 'Part 2 System Events', systemHistory: 'Part 2 System History', feasibility: 'Part 2 Command Feasibility',
};
const UNSUPPORTED_PARAMS: Record<string, string> = {
  q: 'Advanced Filtering (free-text search)', observedProperty: 'Advanced Filtering by observed property',
  foi: 'Advanced Filtering by feature of interest', bbox: 'spatial filtering: no system carries a location',
  geom: 'spatial filtering: no system carries a location', select: 'property selection', properties: 'property selection',
  parent: 'Advanced Filtering by parent', procedure: 'Advanced Filtering by procedure', recursive: 'recursive subsystem listing',
};
const UNSUPPORTED_FORMATS: Record<string, string> = {
  'application/swe+text': 'SWE Common Text encoding', 'application/swe+binary': 'SWE Common Binary encoding',
  'application/swe+csv': 'SWE Common Text encoding', 'text/csv': 'SWE Common Text encoding',
  'application/geo+json': 'GeoJSON encoding', 'text/html': 'HTML encoding',
  'application/vnd.ogc.swe+json': 'the preliminary SWE JSON media type (use application/swe+json)',
};
const FORMAT_ALIASES: Record<string, string> = {
  json: JSON_TYPE, 'swe+json': SWE_JSON, [JSON_TYPE]: JSON_TYPE, [SWE_JSON]: SWE_JSON,
  'sml+json': 'application/sml+json', 'application/sml+json': 'application/sml+json',
};
const PRECISION = 2;
const COLLECTIONS: Record<string, [string, string, string]> = {
  all_systems: ['All systems', '/systems', SOSA + 'System'],
  all_datastreams: ['All datastreams', '/datastreams', 'http://www.opengis.net/def/x-ogc/csapi/Datastream'],
};

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
}

/** What the HTTP layer needs of the running back end. */
export interface ApiRuntime {
  server: Server | null;
  tap: Tap;
  host: ModelHost;
  now(): number;
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly description: string, readonly refused: string | null = null,
    readonly headers: [string, string][] = [], readonly extra: Record<string, unknown> = {}) {
    super(description);
  }
  response(): Reply {
    const body: Record<string, unknown> = { code: this.code, description: this.description };
    if (this.refused) body.refused = this.refused;
    Object.assign(body, this.extra);
    return json(body, this.status, this.headers);
  }
}

interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
}

function json(body: unknown, status = 200, headers: [string, string][] = []): Reply {
  return { status, headers: [['content-type', 'application/json'], ...headers], body: dumps(body) };
}

interface Ctx {
  method: string;
  rel: string;
  pairs: [string, string][];
  q: Map<string, string>;
  headers: Map<string, string>;
  base: string;
  rootPath: string;
  body: Uint8Array;
}

type Handler = (ctx: Ctx, p: Record<string, string>) => Reply;

function letterForRequest(method: string, path: string): Letter {
  return method === 'POST' && path.replace(/\/+$/, '').endsWith('/commands') ? 'K' : 'Q';
}

function letterForResponse(status: number, path: string, ctype: string): Letter {
  if (status >= 400) return 'H';
  const p = path.replace(/\/+$/, '');
  if (p.endsWith('/profile')) return 'P';
  if (ctype.includes('swe+json') || p.endsWith('/observations')) return 'O';
  return 'D'; // every other resource, commands and their status included (decisions-log D-61)
}

const INT_RE = /^\s*[+-]?\d+(?:_\d+)*(?:\.0*)?\s*$/;

/** FastAPI's validation of an `int` query parameter (pydantic, lax mode). */
function intParam(ctx: Ctx, name: string, dflt: number): number {
  const v = ctx.q.get(name);
  if (v === undefined) return dflt;
  if (!INT_RE.test(v)) {
    throw new Refusal(400, 'InvalidParameterValue', `${name}: Input should be a valid integer, unable to parse string as an integer`, name);
  }
  return Math.trunc(Number(v.replace(/_/g, '').trim()));
}

function offsetOf(offset: number): number {
  if (offset < 0) throw new Refusal(400, 'InvalidParameterValue', 'offset must be zero or more', 'offset');
  return offset;
}

function limitOf(limit: number): number {
  if (limit < 1) throw new Refusal(400, 'InvalidParameterValue', 'limit must be at least 1', 'limit');
  if (limit > MAX_LIMIT) {
    throw new Refusal(400, 'InvalidParameterValue',
      `limit ${limit} is over the maximum of ${MAX_LIMIT}. Narrow the query: page with a smaller limit, or give a shorter phenomenonTime interval.`,
      'limit', [], { maximum: MAX_LIMIT });
  }
  return limit;
}

function interval(text: string, name: string, now: number): [number, number] {
  let t0: number;
  let t1: number;
  try {
    if (text.includes('/')) {
      const i = text.indexOf('/');
      const a = text.slice(0, i);
      const b = text.slice(i + 1);
      t0 = a === '' || a === '..' ? -Infinity : parseIso(a);
      t1 = b === '' || b === '..' ? now : parseIso(b);
    } else {
      t0 = t1 = parseIso(text);
    }
  } catch (e) {
    throw new Refusal(400, 'InvalidParameterValue', `${name}: ${(e as Error).message}`, name);
  }
  if (t1 < t0) throw new Refusal(400, 'InvalidParameterValue', `${name} ends before it starts`, name);
  return [t0, t1];
}

function property(f: Field): Record<string, unknown> {
  const p: Record<string, unknown> = { id: f.name, label: f.label, definition: f.definition, type: f.swe_type, kind: f.kind };
  if (f.uom) p.uom = f.uom;
  if (f.inputs.length) p.inputs = [...f.inputs];
  return p;
}

function isoMany(t: ArrayLike<number>): string[] {
  return Array.from(t, (x) => iso(x));
}

/** api._column: one column of values as JSON. */
function column(fd: Record<string, any>, v: ArrayLike<unknown>): unknown[] {
  if (fd.type === 'Time') {
    return Array.from(v, (x) => {
      const n = x === null || x === undefined ? NaN : Number(x);
      return Number.isFinite(n) ? iso(n) : null;
    });
  }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x));
  const f = v as Float64Array;
  if (fd.type === 'Quantity') return Array.from(f, (x) => (Number.isNaN(x) ? null : new PyFloat(npRound(x, PRECISION))));
  if (fd.type === 'Count') return Array.from(f, (x) => (Number.isNaN(x) ? null : Math.trunc(x)));
  if (fd.type === 'Boolean') return Array.from(f, (x) => (Number.isNaN(x) ? null : !!x));
  return Array.from(f);
}

export class Api {
  private routes: [string[], RegExp, string[], Handler][] = [];

  constructor(private readonly rt: ApiRuntime) {
    const r = (methods: string[], pattern: string, h: Handler) => {
      const names: string[] = [];
      const re = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      }) + '$');
      this.routes.push([methods, re, names, h]);
    };
    const G = ['GET'];
    r(G, '/api', (c) => this.openapi(c));
    r(G, '/', (c) => this.landing(c));
    r(G, '/conformance', (c) => this.conformance(c));
    r(G, '/profile', (c) => this.profile(c));
    r(G, '/collections', (c) => this.collections(c));
    r(G, '/collections/{collectionId}', (c, p) => this.collection(c, p.collectionId));
    r(G, '/collections/{collectionId}/items', (c, p) => this.collectionItems(c, p.collectionId));
    r(G, '/systems', (c) => this.systemsList(c));
    r(G, '/systems/{systemId}', (c, p) => this.system(c, p.systemId));
    r(G, '/systems/{systemId}/subsystems', (c, p) => this.subsystems(c, p.systemId));
    r(G, '/properties', (c) => this.properties(c));
    r(G, '/properties/{propId}', (c, p) => this.property(c, p.propId));
    r(G, '/datastreams', (c) => this.datastreamsList(c));
    r(G, '/systems/{systemId}/datastreams', (c, p) => this.systemDatastreams(c, p.systemId));
    r(G, '/datastreams/{dsId}', (c, p) => this.datastream(c, p.dsId));
    r(G, '/datastreams/{dsId}/schema', (c, p) => this.dsSchema(c, p.dsId));
    r(G, '/datastreams/{dsId}/observations', (c, p) => this.observations(c, p.dsId));
    r(G, '/controlstreams', (c) => this.controlstreamsList(c));
    r(G, '/systems/{systemId}/controlstreams', (c, p) => this.systemControlstreams(c, p.systemId));
    r(G, '/controlstreams/{csId}', (c, p) => this.controlstream(c, p.csId));
    r(G, '/controlstreams/{csId}/schema', (c, p) => this.controlstreamSchema(c, p.csId));
    r(['POST'], '/controlstreams/{csId}/commands', (c, p) => this.createCommand(c, p.csId));
    r(G, '/controlstreams/{csId}/commands', (c, p) => this.commands(c, p.csId));
    r(G, '/commands/{cmdId}', (c, p) => this.command(c, p.cmdId));
    r(G, '/commands/{cmdId}/status', (c, p) => this.commandStatus(c, p.cmdId));
    r(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'], '/(.*)', (c) => this.refuse(c));
  }

  private srv(): Server {
    return this.rt.server!;
  }

  // --- the `lifecycle` middleware: waiting mode, instance identifier, capture ------------
  /** One request through the seam. null: no answer at all (the server is down, FR-49). */
  handle(req: HttpRequest, down: boolean): HttpResponse | null {
    if (down) return null;
    const tap = this.rt.tap;
    const method = req.method.toUpperCase();
    const rel = req.path || '/';
    const headers = new Map<string, string>();
    for (const [k, v] of req.headers) headers.set(k.toLowerCase(), v);
    const pairs = parseQs(req.query || '');
    const body = req.body ?? new Uint8Array(0);
    const ctx: Ctx = {
      method, rel, pairs, q: qsDict(pairs), headers, rootPath: req.rootPath || '',
      base: (req.origin + (req.rootPath || '')).replace(/\/+$/, ''), body,
    };
    const hopText = headers.get('x-tap-hop') ?? '1';
    const prev = tap.beginChain(headers.get('x-tap-chain') ?? null, /^\d+$/.test(hopText) ? parseInt(hopText, 10) : 1);
    const chainId = tap.chainId();
    const text = new TextDecoder().decode(body);
    tap.emit('client', 'fastapi', letterForRequest(method, rel), `${method} ${rel}${req.query ? '?' + req.query : ''}`,
      body.length ? text : `${method} ${rel}?${req.query}`);
    const s = this.rt.server;
    let resp: Reply;
    if (s === null) {
      resp = new Refusal(503, 'ServiceUnavailable', 'the server is down').response();
    } else if (!s.ready) {
      const p = s.progress();
      resp = new Refusal(503, 'ServiceUnavailable', `waiting mode: rebuilding the index from the store (${p.indexed} of ${p.stored} records)`,
        null, [['retry-after', String(RETRY_AFTER_S)]]).response();
    } else {
      tap.emit('fastapi', 'server', 'I', `route ${method} ${rel}`, { path: rel, query: req.query });
      resp = this.route(ctx);
      tap.emit('server', 'fastapi', 'I', `result ${resp.status}`, { status: resp.status });
    }
    const payload = new TextEncoder().encode(resp.body);
    const out: [string, string][] = resp.headers.filter(([k]) => k.toLowerCase() !== 'content-length');
    out.push(['content-length', String(payload.length)]);
    if (s !== null) {
      out.push(['x-server-instance', s.instance]);
      if (rel === '' || rel === '/') out.push(['etag', `"${s.instance}"`]);
    }
    const hops = tap.endChain(prev);
    out.push(['x-tap-hops', String(hops + 1)]);
    const prev2 = tap.beginChain(chainId, hops); // the response is on its request's chain
    const ctype = out.find(([k]) => k === 'content-type')?.[1] ?? '';
    tap.emit('fastapi', 'client', letterForResponse(resp.status, rel, ctype), `${resp.status} ${rel}`, resp.body);
    tap.endChain(prev2);
    return { status: resp.status, headers: out, body: method === 'HEAD' ? new Uint8Array(0) : payload };
  }

  private route(ctx: Ctx): Reply {
    try {
      let pathMatched = false;
      for (const [methods, re, names, h] of this.routes) {
        const m = re.exec(ctx.rel);
        if (!m) continue;
        if (!methods.includes(ctx.method)) {
          pathMatched = true;
          continue;
        }
        const p: Record<string, string> = {};
        names.forEach((n, i) => (p[n] = m[i + 1]));
        return h(ctx, p);
      }
      // Starlette: a path that matched with another method, and no route for this one
      return json({ detail: pathMatched ? 'Method Not Allowed' : 'Not Found' }, pathMatched ? 405 : 404,
        pathMatched ? [['allow', 'GET']] : []);
    } catch (e) {
      if (e instanceof Refusal) return e.response();
      return json({ code: 'InternalError', description: String(e) }, 500);
    }
  }

  // --- helpers ---------------------------------------------------------------------------
  private link(ctx: Ctx, href: string, rel: string, type = 'application/json', title?: string) {
    const lk: Record<string, string> = { href: ctx.base + href, rel, type };
    if (title) lk.title = title;
    return lk;
  }

  private only(ctx: Ctx, allowed: string[]) {
    for (const k of ctx.q.keys()) {
      if (allowed.includes(k)) continue;
      if (k in UNSUPPORTED_PARAMS) throw new Refusal(400, 'OptionNotSupported', `${k} is not supported (${UNSUPPORTED_PARAMS[k]})`, k);
      throw new Refusal(400, 'InvalidParameterName', `unknown query parameter ${k}`, k);
    }
  }

  private fmt(ctx: Ctx, f: string | undefined, dflt: string, allowed: string[]): string {
    let want = f;
    if (want === undefined) {
      // Accept is a preference, not a demand: the default when acceptable, else the first offered type.
      // An Accept naming nothing offered (a browser's text/html) gets the default (RFC 9110 §12.5.1).
      const accepted = (ctx.headers.get('accept') ?? '').split(',').map((x) => x.split(';')[0].trim());
      if (accepted.includes(dflt) || accepted.includes('*/*')) return dflt;
      want = accepted.find((a) => allowed.includes(a));
    }
    if (want === undefined) return dflt;
    if (want in UNSUPPORTED_FORMATS) {
      throw new Refusal(400, 'OptionNotSupported', `format ${want} is not supported (${UNSUPPORTED_FORMATS[want]})`, `f:${want}`);
    }
    const norm = FORMAT_ALIASES[want];
    if (!allowed.includes(norm)) {
      throw new Refusal(400, 'OptionNotSupported', `format ${want} is not offered here; offered: ${allowed.join(', ')}`, `f:${want}`);
    }
    return norm;
  }

  private nextUrl(ctx: Ctx, path: string, lim: number, offset: number): string {
    const q = new Map(ctx.q);
    q.set('limit', String(lim));
    q.set('offset', String(offset + lim));
    return `${path}?${urlencode([...q.entries()])}`;
  }

  private page(items: unknown[], ctx: Ctx, path: string, limit: number, offset: number) {
    const lim = limitOf(limit);
    offsetOf(offset);
    const [a, b] = pySlice(items.length, offset, offset + lim);
    const links = [this.link(ctx, path, 'self')];
    if (offset + lim < items.length) links.push(this.link(ctx, this.nextUrl(ctx, path, lim, offset), 'next'));
    return { items: items.slice(a, b), links };
  }

  private listParams(ctx: Ctx): [number, number] {
    return [intParam(ctx, 'limit', DEFAULT_LIMIT), intParam(ctx, 'offset', 0)];
  }

  private getSystem(sid: string) {
    const s = this.srv().allSystems().get(sid);
    if (!s) throw new Refusal(404, 'NotFound', `system ${sid} does not exist`, `system:${sid}`);
    return s;
  }

  private getDs(dsId: string): DsView {
    const d = this.srv().datastreams().get(dsId);
    if (!d) throw new Refusal(404, 'NotFound', `datastream ${dsId} does not exist`, `datastream:${dsId}`);
    return d;
  }

  private getCs(csId: string): ControlstreamRec & { id: string } {
    const c = this.srv().controlstreams().get(csId);
    if (!c) throw new Refusal(404, 'NotFound', `control stream ${csId} does not exist`, `controlstream:${csId}`);
    return c;
  }

  private getCmd(cmdId: string): CommandRec {
    const c = this.srv().registry.commands.get(cmdId);
    if (!c) throw new Refusal(404, 'NotFound', `command ${cmdId} does not exist`, `command:${cmdId}`);
    return c;
  }

  private systemJson(ctx: Ctx, s: Record<string, any>) {
    const sid = s.id;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== 'parent' && k !== 'createdBy') out[k] = v; // internal fields stay internal
    const links = [this.link(ctx, `/systems/${sid}`, 'self', 'application/sml+json'),
      this.link(ctx, `/systems/${sid}/datastreams`, 'datastreams'),
      this.link(ctx, `/systems/${sid}/subsystems`, 'subsystems'),
      this.link(ctx, `/systems/${sid}/controlstreams`, 'controlstreams')];
    if (s.parent) links.push(this.link(ctx, `/systems/${s.parent}`, 'parent'));
    out.links = links;
    return out;
  }

  private dsJson(ctx: Ctx, d: DsView) {
    const pt = this.srv().timeRange(d);
    const now = this.rt.now();
    const props = d.schema.fields.filter((f) => !(f.type === 'Time' && f.name === 'time'))
      .map((f) => ({ definition: f.definition ?? '', label: f.label ?? f.name, name: f.name }));
    return {
      id: d.id, name: d.name, outputName: d.outputName,
      'system@id': d.system, 'system@link': { href: ctx.base + `/systems/${d.system}` },
      validTime: [pt ? iso(pt[0]) : iso(0), iso(Math.max(now, pt ? pt[1] : 0))],
      phenomenonTime: pt ? [iso(pt[0]), iso(pt[1])] : null,
      resultTime: pt ? [iso(pt[0]), iso(pt[1])] : null,
      resultType: 'record', live: true, formats: [...OBS_FORMATS], observedProperties: props,
      links: [this.link(ctx, `/datastreams/${d.id}`, 'self'),
        this.link(ctx, `/datastreams/${d.id}/schema?obsFormat=${SWE_JSON.replace('+', '%2B')}`, 'schema'),
        this.link(ctx, `/datastreams/${d.id}/observations`, 'observations', SWE_JSON)],
    };
  }

  private csJson(ctx: Ctx, c: ControlstreamRec & { id: string }) {
    const cid = c.id;
    return {
      id: cid, name: c.name, inputName: c.inputName, 'system@id': c.system,
      'system@link': { href: ctx.base + `/systems/${c.system}` }, live: true, async: true, formats: [JSON_TYPE],
      links: [this.link(ctx, `/controlstreams/${cid}`, 'self'), this.link(ctx, `/controlstreams/${cid}/schema`, 'schema'),
        this.link(ctx, `/controlstreams/${cid}/commands`, 'commands')],
    };
  }

  private commandJson(ctx: Ctx, c: CommandRec) {
    return {
      id: c.id, 'controlstream@id': c['controlstream@id'], issueTime: c.issueTime, parameters: c.parameters,
      currentStatus: c.status[c.status.length - 1].statusCode, links: [this.link(ctx, `/commands/${c.id}/status`, 'status')],
    };
  }

  // --- discovery (FR-23) -------------------------------------------------------------------
  private openapi(ctx: Ctx): Reply {
    const root = ctx.rootPath.replace(/\/+$/, '');
    return json(root ? { ...openapiJson, servers: [{ url: root }] } : openapiJson);
  }

  private landing(ctx: Ctx): Reply {
    this.only(ctx, ['f']);
    const s = this.srv();
    return json({
      title: 'Canal barge weather demonstrator',
      description: 'OGC API – Connected Systems over a deliberately awkward logger store. Everything is fictional: canal, places and weather. Instance '
        + s.instance + '.',
      links: [this.link(ctx, '/', 'self'), this.link(ctx, '/api', 'service-desc', 'application/vnd.oai.openapi+json;version=3.1'),
        this.link(ctx, '/conformance', 'conformance'), this.link(ctx, '/collections', 'data'),
        this.link(ctx, '/systems', 'systems'), this.link(ctx, '/datastreams', 'datastreams'),
        this.link(ctx, '/controlstreams', 'controlstreams'), this.link(ctx, '/properties', 'properties'),
        this.link(ctx, '/profile', 'profile', 'application/json', 'Declared profile')],
    });
  }

  private conformance(ctx: Ctx): Reply {
    this.only(ctx, ['f']);
    const claims = [...CONFORMANCE];
    if (this.srv().claimsProfile()) claims.push(PROFILE_URI);
    return json({ conformsTo: claims });
  }

  private profile(ctx: Ctx): Reply {
    this.only(ctx, []);
    return json(this.srv().profile);
  }

  private collectionJson(ctx: Ctx, cid: string) {
    const [title, , ft] = COLLECTIONS[cid];
    return {
      id: cid, title, itemType: cid === 'all_systems' ? 'feature' : 'Datastream', featureType: ft,
      links: [this.link(ctx, `/collections/${cid}`, 'self'), this.link(ctx, `/collections/${cid}/items`, 'items')],
    };
  }

  private collections(ctx: Ctx): Reply {
    this.only(ctx, ['f']);
    return json({ links: [this.link(ctx, '/collections', 'self')], collections: Object.keys(COLLECTIONS).map((c) => this.collectionJson(ctx, c)) });
  }

  private collection(ctx: Ctx, cid: string): Reply {
    this.only(ctx, ['f']);
    if (!(cid in COLLECTIONS)) throw new Refusal(404, 'NotFound', `collection ${cid} does not exist`, `collection:${cid}`);
    return json(this.collectionJson(ctx, cid));
  }

  private collectionItems(ctx: Ctx, cid: string): Reply {
    this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'datetime', 'f']);
    if (cid === 'all_systems') return this.systemsList(ctx);
    if (cid === 'all_datastreams') return this.datastreamsList(ctx);
    throw new Refusal(404, 'NotFound', `collection ${cid} does not exist`, `collection:${cid}`);
  }

  // --- Part 1: systems, subsystems, properties --------------------------------------------
  private systemsList(ctx: Ctx): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'datetime', 'f']);
    const items = [...this.srv().allSystems().values()].filter((s) => !s.parent).map((s) => this.systemJson(ctx, s));
    return json(this.page(items, ctx, '/systems', limit, offset));
  }

  private system(ctx: Ctx, sid: string): Reply {
    this.only(ctx, ['f']);
    this.fmt(ctx, ctx.q.get('f'), JSON_TYPE, [JSON_TYPE, 'application/sml+json']);
    return json(this.systemJson(ctx, this.getSystem(sid)));
  }

  private subsystems(ctx: Ctx, sid: string): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    this.getSystem(sid);
    const items = [...this.srv().allSystems().values()].filter((s) => s.parent === sid).map((s) => this.systemJson(ctx, s));
    return json(this.page(items, ctx, `/systems/${sid}/subsystems`, limit, offset));
  }

  private properties(ctx: Ctx): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    return json(this.page([...CATALOGUE.values()].map(property), ctx, '/properties', limit, offset));
  }

  private property(ctx: Ctx, pid: string): Reply {
    this.only(ctx, ['f']);
    const f = CATALOGUE.get(pid);
    if (!f) throw new Refusal(404, 'NotFound', `property ${pid} does not exist`, `property:${pid}`);
    return json(property(f));
  }

  // --- Part 2: datastreams, schema, observations ----------------------------------------------
  private datastreamsList(ctx: Ctx): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'datetime', 'f']);
    const items = [...this.srv().datastreams().values()].map((d) => this.dsJson(ctx, d));
    return json(this.page(items, ctx, '/datastreams', limit, offset));
  }

  private systemDatastreams(ctx: Ctx, sid: string): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    this.getSystem(sid);
    const items = [...this.srv().datastreams().values()].filter((d) => d.system === sid).map((d) => this.dsJson(ctx, d));
    return json(this.page(items, ctx, `/systems/${sid}/datastreams`, limit, offset));
  }

  private datastream(ctx: Ctx, dsId: string): Reply {
    this.only(ctx, ['f']);
    return json(this.dsJson(ctx, this.getDs(dsId)));
  }

  private dsSchema(ctx: Ctx, dsId: string): Reply {
    this.only(ctx, ['obsFormat', 'f']);
    const d = this.getDs(dsId);
    const obsFormat = ctx.q.get('obsFormat');
    if (obsFormat === undefined) {
      throw new Refusal(400, 'MissingParameterValue', 'obsFormat is required: application/swe+json or application/json', 'obsFormat');
    }
    const of = this.fmt(ctx, obsFormat, SWE_JSON, OBS_FORMATS);
    return json(schemaResponse(d.schema, of));
  }

  private observations(ctx: Ctx, dsId: string): Reply {
    let limit = intParam(ctx, 'limit', DEFAULT_LIMIT);
    const offset = intParam(ctx, 'offset', 0);
    this.only(ctx, ['phenomenonTime', 'resultTime', 'limit', 'offset', 'f']);
    const d = this.getDs(dsId);
    const of = this.fmt(ctx, ctx.q.get('f'), SWE_JSON, OBS_FORMATS);
    limit = limitOf(limit);
    offsetOf(offset);
    const now = this.rt.now();
    const phen = ctx.q.get('phenomenonTime');
    const resultTime = ctx.q.get('resultTime');
    const latest = resultTime === 'latest';
    let [t0, t1] = phen ? interval(phen, 'phenomenonTime', now) : [-Infinity, now];
    if (resultTime && !latest) {
      const [r0, r1] = interval(resultTime, 'resultTime', now);
      t0 = Math.max(t0, r0);
      t1 = Math.min(t1, r1);
    }
    const [cols, total] = this.fetch(d, t0, t1, limit, offset, latest);
    return this.obsResponse(ctx, d, cols, of, limit, offset, total, `/datastreams/${dsId}/observations`);
  }

  /** api._fetch: columns for one page and the total available. */
  private fetch(d: DsView, t0: number, t1: number, lim: number, offset: number, latest: boolean): [Cols, number] {
    const s = this.srv();
    const names = d.schema.fields.map((f) => f.name).filter((n) => n !== 'time');
    if (d.kind === 'sensor') {
      if (latest) {
        const tr = s.adapter.timeRange(d.sensor!);
        if (!tr) return [{ t: new Float64Array(0) }, 0];
        t0 = t1 = tr[1];
      }
      const total = s.adapter.count(d.sensor!, t0, t1);
      const fields = names.filter((n) => !n.endsWith('_qc'));
      return [s.sensorRecords(d.sensor!, t0, t1, lim, offset, fields), total];
    }
    const ser = d.series!;
    let [i0, i1] = ser.range(t0, t1);
    if (latest && ser.length) [i0, i1] = [ser.length - 1, ser.length];
    const total = Math.max(0, i1 - i0);
    return [ser.slice(i0 + offset, Math.min(i1, i0 + offset + lim), names), total];
  }

  /** api._obs_response. */
  private obsResponse(ctx: Ctx, d: DsView, cols: Cols, of: string, lim: number, offset: number, total: number, path: string): Reply {
    const fields = d.schema.fields;
    const times = isoMany(cols.t);
    let columns: [string, unknown[]][] = [];
    for (const fd of fields) {
      if (fd.name === 'time' || !(fd.name in cols)) continue;
      if (fd.name.endsWith('_qc') && d.kind === 'sensor') {
        columns.push([fd.name, Array.from(cols[fd.name] as Float64Array, (x) => (Number.isNaN(x) ? null : String(Math.trunc(x))))]);
      } else {
        columns.push([fd.name, column(fd, cols[fd.name])]);
      }
    }
    if (d.kind === 'sensor') {
      const pt = fields.find((f) => f.name === 'precipitation_type');
      if (pt) {
        const tokens: string[] = pt.constraint.values;
        const pv = cols.precipitation_type as Float64Array;
        columns = columns.map(([n, c]) => (n === 'precipitation_type'
          ? [n, Array.from(pv, (x) => (Number.isNaN(x) ? null : tokens[Math.trunc(x)]))] : [n, c]));
      }
    }
    const nxt = offset + lim < total ? ctx.base + this.nextUrl(ctx, path, lim, offset) : null;
    if (of === SWE_JSON) {
      const rows = times.map((tt, i) => {
        const row: Record<string, unknown> = { time: tt };
        for (const [n, c] of columns) row[n] = c[i];
        return row;
      });
      const headers: [string, string][] = [['content-type', SWE_JSON]];
      if (nxt) headers.push(['link', `<${nxt}>; rel="next"`]);
      headers.push(['x-total-count', String(total)]);
      return { status: 200, headers, body: dumps(rows, true) };
    }
    const items = times.map((tt, i) => {
      const result: Record<string, unknown> = {};
      for (const [n, c] of columns) result[n] = c[i];
      return { id: `${d.id}-${tt}`, 'datastream@id': d.id, phenomenonTime: tt, resultTime: tt, result };
    });
    const links = [{ href: `${ctx.base}${path}`, rel: 'self' }, ...(nxt ? [{ href: nxt, rel: 'next' }] : [])];
    return json({ items, links, numberMatched: total });
  }

  // --- Part 2: control streams and commands (FR-27) -------------------------------------------
  private controlstreamsList(ctx: Ctx): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    return json(this.page([...this.srv().controlstreams().values()].map((c) => this.csJson(ctx, c)), ctx, '/controlstreams', limit, offset));
  }

  private systemControlstreams(ctx: Ctx, sid: string): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    this.getSystem(sid);
    const items = [...this.srv().controlstreams().values()].filter((c) => c.system === sid).map((c) => this.csJson(ctx, c));
    return json(this.page(items, ctx, `/systems/${sid}/controlstreams`, limit, offset));
  }

  private controlstream(ctx: Ctx, csId: string): Reply {
    this.only(ctx, ['f']);
    return json(this.csJson(ctx, this.getCs(csId)));
  }

  private controlstreamSchema(ctx: Ctx, csId: string): Reply {
    this.only(ctx, ['f']);
    return json({ commandFormat: JSON_TYPE, parametersSchema: this.getCs(csId).schema });
  }

  private createCommand(ctx: Ctx, csId: string): Reply {
    this.only(ctx, []);
    const c = this.getCs(csId);
    let body: unknown;
    try {
      const text = new TextDecoder().decode(ctx.body);
      body = JSON.parse(text.trim() ? text : 'null');
    } catch {
      throw new Refusal(400, 'InvalidParameterValue', 'the request body must be JSON', 'body');
    }
    const params = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).parameters : undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Refusal(400, 'InvalidParameterValue', 'a command needs a parameters object', 'parameters');
    }
    const s = this.srv();
    try {
      s.validateCommand(c, params as Record<string, unknown>);
    } catch (e) {
      if (e instanceof CommandError) throw new Refusal(400, 'InvalidParameterValue', e.message, e.field);
      throw e;
    }
    const reg = s.registry;
    reg.commandSeq += 1;
    const cid = `cmd-${reg.commandSeq}`;
    const issued = iso(this.rt.now());
    const cmd: CommandRec = {
      id: cid, 'controlstream@id': csId, cs_key: c.key, issueTime: issued, parameters: params as Record<string, unknown>,
      status: [{ statusCode: 'PENDING', reportTime: issued }],
    };
    reg.commands.set(cid, cmd);
    const owner = reg.systems.get(c.system)?.createdBy;
    this.rt.host.notify(owner, { type: 'command', command: { id: cmd.id, issueTime: cmd.issueTime, parameters: cmd.parameters } });
    return json(this.commandJson(ctx, cmd), 201, [['location', ctx.base + `/commands/${cid}`]]);
  }

  private commands(ctx: Ctx, csId: string): Reply {
    const [limit, offset] = this.listParams(ctx);
    this.only(ctx, ['limit', 'offset', 'f']);
    const c = this.getCs(csId);
    const items = [...this.srv().registry.commands.values()].filter((x) => x.cs_key === c.key).map((x) => this.commandJson(ctx, x));
    return json(this.page(items, ctx, `/controlstreams/${csId}/commands`, limit, offset));
  }

  private command(ctx: Ctx, cmdId: string): Reply {
    this.only(ctx, ['f']);
    return json(this.commandJson(ctx, this.getCmd(cmdId)));
  }

  private commandStatus(ctx: Ctx, cmdId: string): Reply {
    this.only(ctx, ['f']);
    return json({ items: this.getCmd(cmdId).status });
  }

  // --- everything else is refused by name (FR-30) ------------------------------------------
  private refuse(ctx: Ctx): Reply {
    const rest = ctx.rel.replace(/^\//, '');
    const first = rest.split('/')[0];
    if (ctx.method === 'PATCH') throw new Refusal(405, 'OperationNotSupported', 'PATCH is not supported (Part 1 and 2 Update classes)', 'PATCH');
    if (ctx.method === 'HEAD' || ctx.method === 'OPTIONS') {
      throw new Refusal(405, 'OperationNotSupported', `${ctx.method} is not supported`, ctx.method);
    }
    if (['POST', 'PUT', 'DELETE'].includes(ctx.method)) {
      throw new Refusal(405, 'OperationNotSupported',
        `${ctx.method} /${rest} is not supported (Create/Replace/Delete classes): models register through the data server's internal interface, and only commands are created over HTTP`,
        ctx.method);
    }
    if (first in NOT_IMPLEMENTED) throw new Refusal(404, 'OperationNotSupported', `${first} is not implemented (${NOT_IMPLEMENTED[first]})`, first);
    throw new Refusal(404, 'NotFound', `no resource at /${rest}`, `path:/${rest}`);
  }
}
