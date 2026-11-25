// The data server's HTTP interface, behaving as a stock OpenSensorHub's
// Connected Systems service does where this system relies on it (FR-06c,
// docs/v4-interfaces.md §9.1): opaque identifiers, 201 with the existing
// Location, one observation per POST, "NaN" for a missing value, 405 for PUT
// and DELETE, the format chosen by `f` (Accept ignored), paging by limit and
// offset, refusals as HTML pages, commands pushed to subscribers (§9.2), and
// 401 without valid credentials (§9.3). Every request and response is
// captured at the boundary (FR-66), with credentials redacted (§9.4).
import type { Account } from './accounts';
import { DEFAULT_LIMIT, PROFILE_URI } from './constants';
import { parseQs, qsDict } from './py';
import { componentOf, HttpError, Server, SystemBody } from './server';
import { ControlstreamRec, DatastreamRec, Pick, storedAsNumber, SystemRec } from './store';
import { PushStream } from './stream';
import { DataRecord, JSON_TYPE, NDJSON, schemaResponse, SWE_JSON } from './swe';
import type { Chain, ComponentId, Letter, Tap } from './tap';
import { iso, parseIso, realNow } from './time';

export interface HttpRequest {
  method: string;
  path: string; // relative to the API root, starting with /
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
  /** A push subscription: the body never ends (§9.2). */
  stream?: PushStream;
}

/** What the HTTP layer needs of the running back end. */
export interface ApiRuntime {
  server: Server;
  tap: Tap;
  accounts: { authenticate(h: string | undefined): Account | null };
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 415: 'Unsupported Media Type', 500: 'Internal Server Error',
};
const GEO_JSON = 'application/geo+json';
const SML_JSON = 'application/sml+json';
const OM_JSON = 'application/om+json';
const REFEREE = '/demonstrator/referee/';
const SHOWN = 4000;

interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
  stream?: PushStream;
}

interface Ctx {
  method: string;
  rel: string;
  q: Map<string, string>;
  headers: Map<string, string>;
  base: string;
  body: Uint8Array;
  account: Account;
  from: ComponentId;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A refusal: an HTML page with the status line in its title (§9.1). No client relies on its body. */
function htmlError(status: number, message: string): Reply {
  const line = `${status} ${STATUS_TEXT[status] ?? 'Error'}`;
  return {
    status, headers: [['content-type', 'text/html;charset=utf-8']],
    body: `<html><head><title>${line}</title></head><body><h2>${line}</h2><p>${esc(message)}</p></body></html>`,
  };
}

function json(body: unknown, status = 200, headers: [string, string][] = [], ctype = JSON_TYPE): Reply {
  return { status, headers: [['content-type', ctype], ...headers], body: JSON.stringify(body) };
}

function letterForRequest(method: string, path: string): Letter {
  const p = path.replace(/\/+$/, '');
  if (p.startsWith(REFEREE)) return 'I';
  if (method === 'POST' && p.endsWith('/commands')) return 'K';
  if (method === 'POST' && (p.endsWith('/observations') || p.endsWith('/status'))) return 'O';
  return 'Q';
}

function letterForResponse(status: number, path: string, ctype: string): Letter {
  if (status >= 400) return 'H';
  const p = path.replace(/\/+$/, '');
  if (p.startsWith(REFEREE)) return 'I';
  if (p === '/profile.json') return 'P';
  if (ctype.includes('swe+json') || (p.endsWith('/observations') && !ctype.includes('ndjson'))) return 'O';
  return 'D';
}

function enc(n: number): string | number {
  return Number.isFinite(n) ? n : 'NaN';
}

/** One field's value as SWE JSON writes it: a missing number is "NaN" (§9.1). */
function encoder(f: Record<string, any>): (v: unknown) => unknown {
  switch (f.type) {
    case 'Quantity': return (v) => enc(v as number);
    case 'Count': return (v) => (Number.isFinite(v as number) ? Math.trunc(v as number) : 'NaN');
    case 'Boolean': return (v) => (Number.isFinite(v as number) ? !!(v as number) : null);
    case 'Time': return (v) => (typeof v === 'number' && Number.isFinite(v) ? iso(v) : typeof v === 'string' ? v : null);
    default:
      if (storedAsNumber(f as never)) return (v) => (Number.isFinite(v as number) ? String(Math.trunc(v as number)) : '');
      return (v) => (v === null || v === undefined ? '' : v);
  }
}

/** A value posted for a field, checked as OpenSensorHub's parser does: null in a Quantity is refused. */
function decode(f: Record<string, any>, v: unknown): unknown {
  const bad = () => new HttpError(400, `field ${f.name}: ${JSON.stringify(v)} is not a valid ${f.type}`);
  if (v === undefined) return f.type === 'Quantity' || f.type === 'Count' ? NaN : null;
  switch (f.type) {
    case 'Quantity':
    case 'Count':
      if (v === 'NaN') return NaN;
      if (typeof v !== 'number') throw bad();
      return v;
    case 'Boolean':
      if (typeof v !== 'boolean') throw bad();
      return v;
    case 'Time':
      if (typeof v !== 'string') throw bad();
      try {
        return parseIso(v);
      } catch {
        throw bad();
      }
    default:
      if (v === null || typeof v === 'object') throw bad();
      return String(v);
  }
}

export class Api {
  constructor(private readonly rt: ApiRuntime) {}

  private get srv(): Server {
    return this.rt.server;
  }

  /** One request through the server. The runtime has already decided the server is up and not frozen. */
  async handle(req: HttpRequest, via: { from?: { id: ComponentId; model?: string }; chain?: Chain } = {}): Promise<HttpResponse> {
    const tap = this.rt.tap;
    const method = req.method.toUpperCase();
    const rel = req.path || '/';
    const headers = new Map<string, string>();
    for (const [k, v] of req.headers) headers.set(k.toLowerCase(), v);
    const body = req.body ?? new Uint8Array(0);
    const account = this.rt.accounts.authenticate(headers.get('authorization'));
    // Who is asking, for capture only (§2): the gateway, or a module inside the server known by its account.
    const model = headers.get('x-tap-model') || undefined;
    const who: { id: ComponentId; model?: string } = via.from
      ?? (model ? { id: 'models', model } : account ? componentOf(account.user) : { id: 'client' });
    const quiet = headers.get('x-tap-quiet') === '1';
    const hopText = headers.get('x-tap-hop') ?? '0';
    const chain = via.chain ?? tap.newChain(headers.get('x-tap-chain') ?? null, /^\d+$/.test(hopText) ? parseInt(hopText, 10) : 0);
    const opts = { model: who.model, quiet, chain };
    const ask = `${method} ${rel}${req.query ? '?' + req.query : ''}`;
    const shownHeaders = [...headers].filter(([k]) => k === 'authorization' || k === 'content-type').map(([k, v]) => `${k}: ${v}`);
    const text = body.length ? new TextDecoder().decode(body.length > SHOWN ? body.subarray(0, SHOWN) : body) : '';
    tap.emit(who.id, 'server', letterForRequest(method, rel), who.model ? `${who.model}: ${ask}` : ask,
      [ask, ...shownHeaders].join('\n') + (text ? '\n\n' + text : ''), opts);
    let resp: Reply;
    if (!account) {
      resp = htmlError(401, 'valid credentials are needed');
      resp.headers.push(['www-authenticate', 'Basic realm="OpenSensorHub"']); // as OpenSensorHub sends it; the gateway strips it (D-153)
    } else {
      const pairs = parseQs(req.query || '');
      const ctx: Ctx = {
        method, rel, q: qsDict(pairs), headers, body, account, from: who.id,
        base: (req.origin + (req.rootPath || '')).replace(/\/+$/, ''),
      };
      try {
        resp = await this.route(ctx);
      } catch (e) {
        if (e instanceof HttpError) resp = htmlError(e.status, e.message);
        else {
          console.error(e);
          resp = htmlError(500, String((e as Error)?.message ?? e));
        }
      }
    }
    const payload = new TextEncoder().encode(resp.body);
    const out: [string, string][] = resp.headers.filter(([k]) => k.toLowerCase() !== 'content-length');
    if (!resp.stream) out.push(['content-length', String(payload.length)]);
    out.push(['x-tap-hops', String(chain.hop + 1)]);
    const ctype = out.find(([k]) => k === 'content-type')?.[1] ?? '';
    const shown = resp.stream ? 'push subscription open: one command per line (application/x-ndjson)'
      : resp.body.length > SHOWN ? resp.body.slice(0, SHOWN) + `… (${payload.length} bytes in all)` : resp.body;
    tap.emit('server', who.id, letterForResponse(resp.status, rel, ctype),
      who.model ? `${who.model}: ${resp.status} ${rel}` : `${resp.status} ${rel}`, shown, opts);
    return { status: resp.status, headers: out, body: method === 'HEAD' ? new Uint8Array(0) : payload, stream: resp.stream };
  }

  // --- routing --------------------------------------------------------------------------------------
  private async route(c: Ctx): Promise<Reply> {
    const seg = c.rel.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const m = c.method;
    const get = m === 'GET' || m === 'HEAD';
    const no = (allowed: string) => new HttpError(405, `${m} is not allowed on /${seg.join('/')}; allowed: ${allowed}`);
    const [a, b, d, e] = seg;
    if (!seg.length) {
      if (get) return this.landing(c);
      throw no('GET');
    }
    if (seg.length === 1 && a === 'conformance') return get ? this.conformance(c) : Promise.reject(no('GET'));
    if (seg.length === 1 && a === 'profile.json') return get ? this.profileJson() : Promise.reject(no('GET'));
    if (a === 'demonstrator' && b === 'referee' && seg.length === 3) {
      if (m !== 'POST') throw no('POST');
      return json({ illustrative: true, kind: d, scored_by: 'stand-in: not scored (FR-06e)' });
    }
    switch (a) {
      case 'collections':
        if (!get) throw no('GET');
        return this.collections(c, b, d);
      case 'systems':
        if (seg.length === 1) {
          if (get) return this.systemsList(c, [...this.srv.store.systems.values()].filter((s) => !s.parent));
          if (m === 'POST') return this.createSystem(c, null);
          throw no('GET, POST');
        }
        if (seg.length === 2) {
          const s = this.srv.system(b);
          if (get) return this.systemOne(c, s);
          throw no('GET');
        }
        if (seg.length === 3) {
          const s = this.srv.system(b);
          if (d === 'subsystems') {
            if (get) return this.systemsList(c, [...this.srv.store.systems.values()].filter((x) => x.parent === s.id));
            if (m === 'POST') return this.createSystem(c, s);
            throw no('GET, POST');
          }
          if (d === 'datastreams') {
            if (get) return this.dsList(c, this.srv.servedDatastreams().filter((x) => x.system === s.id));
            if (m === 'POST') return this.createDatastream(c, s);
            throw no('GET, POST');
          }
          if (d === 'controlstreams') {
            if (get) return this.csList(c, [...this.srv.store.controlstreams.values()].filter((x) => x.system === s.id));
            if (m === 'POST') return this.createControlstream(c, s);
            throw no('GET, POST');
          }
        }
        break;
      case 'datastreams':
        if (seg.length === 1) {
          if (get) return this.dsList(c, this.srv.servedDatastreams());
          throw no('GET');
        }
        {
          const ds = this.srv.datastream(b);
          if (seg.length === 2) return get ? this.dsOne(c, ds) : Promise.reject(no('GET'));
          if (seg.length === 3 && d === 'schema') return get ? this.dsSchema(c, ds) : Promise.reject(no('GET'));
          if (seg.length === 3 && d === 'observations') {
            if (get) return this.observations(c, ds);
            if (m === 'POST') return this.postObservation(c, ds);
            throw no('GET, POST');
          }
        }
        break;
      case 'observations':
        if (seg.length === 2) return get ? this.observationOne(c, b) : Promise.reject(no('GET'));
        break;
      case 'controlstreams':
        if (seg.length === 1) {
          if (get) return this.csList(c, [...this.srv.store.controlstreams.values()]);
          throw no('GET');
        }
        {
          const cs = this.srv.controlstream(b);
          if (seg.length === 2) return get ? this.csOne(c, cs) : Promise.reject(no('GET'));
          if (seg.length === 3 && d === 'schema') {
            if (!get) throw no('GET');
            return json({ commandFormat: JSON_TYPE, parametersSchema: cs.schema });
          }
          if (seg.length === 3 && d === 'commands') {
            if (get) return c.q.has('subscribe') && c.q.get('subscribe') !== '0' && c.q.get('subscribe') !== 'false' ? this.subscribe(c, cs) : this.commandsList(c, cs);
            if (m === 'POST') return this.postCommand(c, cs);
            throw no('GET, POST');
          }
          if (seg.length === 3 && d === 'status') {
            if (get) return this.statusList(c, cs);
            if (m === 'POST') return this.postStatus(c, cs);
            throw no('GET, POST');
          }
        }
        break;
      case 'commands': {
        const cmd = this.srv.command(b);
        if (seg.length === 2) return get ? json(this.commandJson(c, cmd)) : Promise.reject(no('GET'));
        if (seg.length === 3 && d === 'status') return get ? json({ items: cmd.status, links: [] }) : Promise.reject(no('GET'));
        break;
      }
      default:
        void e;
        throw new HttpError(400, `invalid resource name: ${a}`);
    }
    throw new HttpError(404, `no resource at /${seg.join('/')}`);
  }

  // --- helpers ----------------------------------------------------------------------------------------
  private link(c: Ctx, href: string, rel: string, type = JSON_TYPE, title?: string) {
    const lk: Record<string, string> = { href: c.base + href, rel, type };
    if (title) lk.title = title;
    return lk;
  }

  private paging(c: Ctx): [number, number] {
    const num = (k: string, d: number) => {
      const v = c.q.get(k);
      if (v === undefined || v === '') return d;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `invalid ${k}: ${v}`);
      return n;
    };
    return [Math.max(1, num('limit', DEFAULT_LIMIT)), num('offset', 0)]; // a large limit is not refused (§9.1)
  }

  private page(c: Ctx, items: unknown[], path: string): Reply {
    const [limit, offset] = this.paging(c);
    const links: Record<string, string>[] = [];
    if (offset + limit < items.length) {
      const q = new URLSearchParams([...c.q.entries()]);
      q.set('offset', String(offset + limit));
      q.set('limit', String(limit));
      links.push(this.link(c, `${path}?${q}`, 'next'));
    }
    return json({ items: items.slice(offset, offset + limit), links });
  }

  private jsonBody(c: Ctx): any {
    try {
      const t = new TextDecoder().decode(c.body);
      return JSON.parse(t.trim() ? t : 'null');
    } catch {
      throw new HttpError(400, 'the request body is not valid JSON');
    }
  }

  private created(c: Ctx, href: string): Reply {
    return { status: 201, headers: [['location', c.base + href]], body: '' };
  }

  private format(c: Ctx, allowed: string[], dflt: string): string {
    const f = c.q.get('f') ?? c.q.get('format');
    if (f === undefined) return dflt; // the Accept header is ignored (§9.1)
    const norm = f === 'json' ? JSON_TYPE : f === 'swe+json' ? SWE_JSON : f === 'sml+json' ? SML_JSON : f === 'geojson' ? GEO_JSON : f;
    if (!allowed.includes(norm)) throw new HttpError(400, `unsupported format: ${f}`);
    return norm;
  }

  // --- discovery ------------------------------------------------------------------------------------
  private landing(c: Ctx): Reply {
    return json({
      title: 'Canal barge weather demonstrator: data server (OpenSensorHub stand-in)',
      description: 'OGC API – Connected Systems. Everything is fictional.',
      links: [this.link(c, '/', 'self'), this.link(c, '/conformance', 'conformance'), this.link(c, '/collections', 'data'),
        this.link(c, '/systems', 'systems'), this.link(c, '/datastreams', 'datastreams'), this.link(c, '/controlstreams', 'controlstreams')],
    });
  }

  private conformance(_c: Ctx): Reply {
    const CS1 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-1/1.0/conf/';
    const CS2 = 'http://www.opengis.net/spec/ogcapi-connectedsystems-2/1.0/conf/';
    const claims = ['http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
      'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core', CS1 + 'system', CS1 + 'subsystem', CS1 + 'sensorml', CS1 + 'geojson',
      CS2 + 'datastream', CS2 + 'controlstream', CS2 + 'json', CS2 + 'swecommon-json', CS2 + 'create-replace-delete'];
    if (this.srv.claimsProfile()) claims.push(PROFILE_URI);
    return json({ conformsTo: claims });
  }

  private profileJson(): Reply {
    return json(this.srv.profile);
  }

  private collections(c: Ctx, cid?: string, items?: string): Reply {
    const all: Record<string, string> = { all_systems: 'All systems', all_datastreams: 'All datastreams' };
    const one = (id: string) => ({ id, title: all[id], itemType: 'feature', links: [this.link(c, `/collections/${id}/items`, 'items')] });
    if (!cid) return json({ collections: Object.keys(all).map(one), links: [this.link(c, '/collections', 'self')] });
    if (!(cid in all)) throw new HttpError(404, `no collection ${cid}`);
    if (!items) return json(one(cid));
    if (items !== 'items') throw new HttpError(404, `no resource ${items}`);
    return cid === 'all_systems' ? this.systemsList(c, [...this.srv.store.systems.values()]) : this.dsList(c, this.srv.servedDatastreams());
  }

  // --- systems ----------------------------------------------------------------------------------------
  private systemJson(c: Ctx, s: SystemRec, fmt: string): Record<string, unknown> {
    const links = [this.link(c, `/systems/${s.id}/subsystems`, 'subsystems'), this.link(c, `/systems/${s.id}/datastreams`, 'datastreams'),
      this.link(c, `/systems/${s.id}/controlstreams`, 'controlstreams')];
    if (s.parent) links.push(this.link(c, `/systems/${s.parent}`, 'parent'));
    if (fmt === SML_JSON) {
      const out: Record<string, unknown> = {
        type: s.smlType, id: s.id, definition: s.featureType, uniqueId: s.uid, label: s.label, description: s.description,
      };
      if (s.characteristics) out.characteristics = s.characteristics;
      out.links = links;
      return out;
    }
    return {
      type: 'Feature', id: s.id, geometry: null,
      properties: { featureType: s.featureType, uid: s.uid, name: s.label, description: s.description, assetType: s.assetType },
      links,
    };
  }

  private systemsList(c: Ctx, list: SystemRec[]): Reply {
    const fmt = this.format(c, [JSON_TYPE, GEO_JSON, SML_JSON], GEO_JSON);
    const r = this.page(c, list.map((s) => this.systemJson(c, s, fmt)), c.rel);
    return r;
  }

  private systemOne(c: Ctx, s: SystemRec): Reply {
    const fmt = this.format(c, [JSON_TYPE, GEO_JSON, SML_JSON], GEO_JSON);
    return json(this.systemJson(c, s, fmt));
  }

  private createSystem(c: Ctx, parent: SystemRec | null): Reply {
    const b = this.jsonBody(c);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'a system must be a JSON object');
    let body: SystemBody;
    if (b.type === 'Feature') {
      const p = b.properties ?? {};
      body = { uid: p.uid, label: p.name, description: p.description ?? '', featureType: p.featureType ?? 'http://www.w3.org/ns/sosa/System',
        assetType: p.assetType ?? 'Other', smlType: 'PhysicalSystem' };
    } else {
      body = { uid: b.uniqueId, label: b.label, description: b.description ?? '', featureType: b.definition ?? 'http://www.w3.org/ns/sosa/System',
        assetType: b.assetType ?? 'Other', smlType: b.type ?? 'PhysicalSystem', characteristics: b.characteristics };
    }
    if (typeof body.uid !== 'string' || !body.uid || typeof body.label !== 'string') throw new HttpError(400, 'a system needs a unique id and a name');
    const r = this.srv.createSystem(c.account, body, parent ? parent.id : null);
    return this.created(c, `/systems/${r.id}`);
  }

  // --- datastreams ----------------------------------------------------------------------------------
  private dsJson(c: Ctx, d: DatastreamRec): Record<string, unknown> {
    const id = this.srv.viewId(d);
    const rec = this.srv.visible(d);
    const tr = d.series.timeRange();
    return {
      id, name: d.name, description: d.description, outputName: d.outputName, 'system@id': d.system,
      'system@link': { href: c.base + `/systems/${d.system}` },
      validTime: tr ? [iso(tr[0]), iso(tr[1])] : [new Date().toISOString().replace(/\.\d+Z$/, 'Z'), new Date().toISOString().replace(/\.\d+Z$/, 'Z')], // closed at the data's end: the data lie in a fictional future
      phenomenonTime: tr ? [iso(tr[0]), iso(tr[1])] : undefined, resultTime: tr ? [iso(tr[0]), iso(tr[1])] : undefined,
      resultType: 'record', live: false, formats: [JSON_TYPE, SWE_JSON],
      observedProperties: rec.fields.filter((f) => f.name !== 'time').map((f) => ({ definition: f.definition ?? '', label: f.label ?? f.name })),
      links: [this.link(c, `/datastreams/${id}/observations`, 'observations')],
    };
  }

  private dsList(c: Ctx, list: DatastreamRec[]): Reply {
    return this.page(c, list.map((d) => this.dsJson(c, d)), c.rel);
  }

  private dsOne(c: Ctx, d: DatastreamRec): Reply {
    return json(this.dsJson(c, d));
  }

  private dsSchema(c: Ctx, d: DatastreamRec): Reply {
    const of = c.q.get('obsFormat') ?? c.q.get('f') ?? JSON_TYPE;
    const norm = of === 'swe+json' ? SWE_JSON : of;
    if (![SWE_JSON, JSON_TYPE, OM_JSON].includes(norm)) throw new HttpError(400, `unsupported format: ${of}`);
    return json(schemaResponse(this.srv.visible(d), norm === SWE_JSON ? SWE_JSON : JSON_TYPE));
  }

  private createDatastream(c: Ctx, s: SystemRec): Reply {
    const b = this.jsonBody(c);
    const rec = b?.schema?.recordSchema ?? b?.schema?.resultSchema;
    checkRecord(rec);
    if (typeof b.outputName !== 'string' || !b.outputName) throw new HttpError(400, 'a datastream needs an outputName');
    if (!/^[A-Za-z_][\w.-]*$/.test(b.outputName)) throw new HttpError(400, `invalid outputName: ${b.outputName}`);
    const fields = rec.fields[0]?.type === 'Time' ? rec.fields : [{ type: 'Time', name: 'time', label: 'Time' }, ...rec.fields];
    const r = this.srv.createDatastream(c.account, s.id, { name: b.name, outputName: b.outputName, description: b.description, schema: { ...rec, fields } });
    return this.created(c, `/datastreams/${r.id}`);
  }

  // --- observations -----------------------------------------------------------------------------------
  private observations(c: Ctx, d: DatastreamRec): Reply {
    const fmt = this.format(c, [JSON_TYPE, OM_JSON, SWE_JSON], JSON_TYPE);
    const [limit, offset] = this.paging(c);
    const phen = c.q.get('phenomenonTime');
    const res = c.q.get('resultTime');
    let pick: Pick;
    if (res === 'latest') pick = d.series.latest();
    else {
      let [t0, t1] = phen ? interval(phen) : [-Infinity, Infinity];
      if (res) {
        const [r0, r1] = interval(res);
        t0 = Math.max(t0, r0);
        t1 = Math.min(t1, r1);
      }
      pick = d.series.select(t0, t1);
    }
    const rec = this.srv.visible(d);
    const names = rec.fields.map((f) => f.name).filter((n) => n !== 'time');
    const cols = d.series.rows(pick, offset, limit, names);
    const viewId = this.srv.viewId(d);
    return this.obsReply(c, rec, cols, fmt, viewId, offset + limit < pick.total ? offset + limit : null, limit);
  }

  private obsReply(c: Ctx, rec: DataRecord, cols: Record<string, any> & { t: Float64Array; ord: Float64Array }, fmt: string,
    dsId: string, next: number | null, limit: number): Reply {
    const fields = rec.fields.filter((f) => f.name !== 'time');
    const encs = fields.map((f) => encoder(f));
    const n = cols.t.length;
    if (fmt === SWE_JSON) {
      // One record per observation, written a record at a time: a day of records is one response. No next link (§9.1).
      const keys = fields.map((f) => ',' + JSON.stringify(f.name) + ':');
      const parts: string[] = new Array(n);
      for (let i = 0; i < n; i++) {
        let row = '{"time":"' + iso(cols.t[i]) + '"';
        for (let k = 0; k < fields.length; k++) row += keys[k] + JSON.stringify(encs[k](cols[fields[k].name][i]));
        parts[i] = row + '}';
      }
      return { status: 200, headers: [['content-type', SWE_JSON]], body: '[' + parts.join(',') + ']' };
    }
    const items = new Array(n);
    for (let i = 0; i < n; i++) {
      const tt = iso(cols.t[i]);
      const result: Record<string, unknown> = {};
      for (let k = 0; k < fields.length; k++) result[fields[k].name] = encs[k](cols[fields[k].name][i]);
      items[i] = { id: obsId(dsId, cols.ord[i]), 'datastream@id': dsId, phenomenonTime: tt, resultTime: tt, result };
    }
    const links: Record<string, string>[] = [];
    if (next !== null) {
      const q = new URLSearchParams([...c.q.entries()]);
      q.set('offset', String(next));
      q.set('limit', String(limit));
      links.push(this.link(c, `/datastreams/${dsId}/observations?${q}`, 'next'));
    }
    return json({ items, links });
  }

  private observationOne(c: Ctx, id: string): Reply {
    const i = id.lastIndexOf('-');
    if (i < 0) throw new HttpError(404, `no observation ${id}`);
    const d = this.srv.datastream(id.slice(0, i));
    const ord = parseInt(id.slice(i + 1), 32);
    const pick = Number.isFinite(ord) ? d.series.byOrdinal(ord) : null;
    if (!pick) throw new HttpError(404, `no observation ${id}`);
    const rec = this.srv.visible(d);
    const cols = d.series.rows(pick, 0, 1, rec.fields.map((f) => f.name));
    const r = this.obsReply(c, rec, cols, JSON_TYPE, this.srv.viewId(d), null, 1);
    return json(JSON.parse(r.body).items[0]);
  }

  /** One observation per POST (§9.1): an array is refused. */
  private postObservation(c: Ctx, d: DatastreamRec): Reply {
    const b = this.jsonBody(c);
    if (Array.isArray(b)) throw new HttpError(400, 'one observation per request: an array is not accepted');
    if (!b || typeof b !== 'object') throw new HttpError(400, 'an observation must be a JSON object');
    const ctype = (c.headers.get('content-type') ?? JSON_TYPE).split(';')[0].trim();
    let rec: Record<string, unknown>;
    let timeText: unknown;
    if (ctype === SWE_JSON || (!('result' in b) && 'time' in b)) {
      rec = b;
      timeText = b.time;
    } else {
      rec = b.result ?? {};
      timeText = b.phenomenonTime ?? b.resultTime;
    }
    if (typeof timeText !== 'string') throw new HttpError(400, 'an observation needs its time');
    let t: number;
    try {
      t = parseIso(timeText);
    } catch {
      throw new HttpError(400, `invalid time: ${timeText}`);
    }
    const known = new Map(d.schema.fields.map((f) => [f.name, f]));
    for (const k of Object.keys(rec)) if (k !== 'time' && !known.has(k)) throw new HttpError(400, `field ${k} is not in the datastream's schema`);
    const row: Record<string, unknown> = {};
    for (const f of d.schema.fields) if (f.name !== 'time') row[f.name] = decode(f, rec[f.name]);
    const ord = d.series.appendRow(t, row);
    return this.created(c, `/observations/${obsId(this.srv.viewId(d), ord)}`);
  }

  // --- control streams and commands (§9.1, §9.2) --------------------------------------------------------------
  private csJson(c: Ctx, cs: ControlstreamRec): Record<string, unknown> {
    return {
      id: cs.id, name: cs.name, description: cs.description, inputName: cs.inputName, 'system@id': cs.system,
      'system@link': { href: c.base + `/systems/${cs.system}` }, live: this.srv.subscribers(cs.id) > 0, async: true, formats: [JSON_TYPE],
      links: [this.link(c, `/controlstreams/${cs.id}/commands`, 'commands')],
    };
  }

  private csList(c: Ctx, list: ControlstreamRec[]): Reply {
    return this.page(c, list.map((x) => this.csJson(c, x)), c.rel);
  }

  private csOne(c: Ctx, cs: ControlstreamRec): Reply {
    return json(this.csJson(c, cs));
  }

  private createControlstream(c: Ctx, s: SystemRec): Reply {
    const b = this.jsonBody(c);
    const rec = b?.schema?.parametersSchema ?? b?.schema?.recordSchema;
    checkRecord(rec);
    const name = b.inputName ?? b.name;
    if (typeof name !== 'string' || !name) throw new HttpError(400, 'a control stream needs an inputName');
    const r = this.srv.createControlstream(c.account, s.id, { name: b.name, inputName: name, description: b.description, schema: rec });
    return this.created(c, `/controlstreams/${r.id}`);
  }

  private commandJson(c: Ctx, cmd: { id: string; cs: string; issueTime: string; parameters: unknown; sender: string; status: { statusCode: string }[] }) {
    return {
      id: cmd.id, 'controlstream@id': cmd.cs, issueTime: cmd.issueTime, sender: cmd.sender, parameters: cmd.parameters,
      currentStatus: cmd.status.length ? cmd.status[cmd.status.length - 1].statusCode : 'PENDING',
      links: [this.link(c, `/commands/${cmd.id}/status`, 'status')],
    };
  }

  private commandsList(c: Ctx, cs: ControlstreamRec): Reply {
    const items = [...this.srv.store.commands.values()].filter((x) => x.cs === cs.id).map((x) => this.commandJson(c, x));
    return this.page(c, items, c.rel);
  }

  /** POST a command: every parameter must be present; bounds are the receiver's to check (FR-27). */
  private async postCommand(c: Ctx, cs: ControlstreamRec): Promise<Reply> {
    const b = this.jsonBody(c);
    const params = b && typeof b === 'object' && !Array.isArray(b) ? b.parameters : undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new HttpError(400, 'a command needs a parameters object');
    const names = cs.schema.fields.map((f) => f.name);
    const missing = names.filter((n) => !(n in params));
    if (missing.length) throw new HttpError(400, `missing parameter(s): ${missing.join(', ')}`);
    const extra = Object.keys(params).filter((n) => !names.includes(n));
    if (extra.length) throw new HttpError(400, `unknown parameter(s): ${extra.join(', ')}`);
    const r = await this.srv.sendCommand(c.account, cs, params);
    if (!r.cmd) return { status: 202, headers: [['content-type', 'text/plain']], body: 'Request accepted but timed out' };
    return json(this.commandJson(c, r.cmd), 200, [['location', c.base + `/commands/${r.cmd.id}`]]);
  }

  /** A push subscription (§9.2): 200, application/x-ndjson, a body that never ends. */
  private subscribe(c: Ctx, cs: ControlstreamRec): Reply {
    const stream = this.srv.subscribe(c.account, cs, c.from);
    return { status: 200, headers: [['content-type', NDJSON], ['cache-control', 'no-store']], body: '', stream };
  }

  private statusList(c: Ctx, cs: ControlstreamRec): Reply {
    const items = [...this.srv.store.commands.values()].filter((x) => x.cs === cs.id).flatMap((x) => x.status);
    return this.page(c, items, c.rel);
  }

  private postStatus(c: Ctx, cs: ControlstreamRec): Reply {
    const b = this.jsonBody(c);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'a status report must be a JSON object');
    const cmd = this.srv.reportStatus(cs, b);
    return this.created(c, `/commands/${cmd.id}/status`);
  }
}

function obsId(dsId: string, ord: number): string {
  return `${dsId}-${Math.trunc(ord).toString(32)}`;
}

function interval(text: string): [number, number] {
  try {
    if (text === 'now' || text === 'latest') return [-Infinity, Infinity];
    const i = text.indexOf('/');
    if (i < 0) {
      const t = parseIso(text);
      return [t, t];
    }
    const a = text.slice(0, i);
    const b = text.slice(i + 1);
    return [a === '' || a === '..' ? -Infinity : parseIso(a), b === '' || b === '..' || b === 'now' ? Infinity : parseIso(b)];
  } catch (e) {
    throw new HttpError(400, `invalid time interval: ${text}`);
  }
}

const SWE_TYPES = new Set(['Quantity', 'Count', 'Category', 'Boolean', 'Text', 'Time']);

function checkRecord(rec: any): asserts rec is DataRecord {
  if (!rec || typeof rec !== 'object' || rec.type !== 'DataRecord' || !Array.isArray(rec.fields) || !rec.fields.length) {
    throw new HttpError(400, 'the schema must be a SWE Common DataRecord with fields');
  }
  for (const f of rec.fields) {
    if (!f || typeof f.name !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(f.name)) throw new HttpError(400, `invalid field name: ${f?.name}`);
    if (!SWE_TYPES.has(f.type)) throw new HttpError(400, `field ${f.name}: implicit size not supported by JSON parser (type ${f.type})`);
  }
}

