// The access gateway (docs/v4-interfaces.md §9.5, D-150): written for this
// system, in front of the data server, because a stock OpenSensorHub cannot
// hide a system. Every request from the display client and from the models
// passes it; the importer and the replay controller are modules inside the
// server and do not. It is a component of its own (`gateway`), drawn as such.
//
// It authenticates every request against the delivered accounts and answers
// 401 itself, without WWW-Authenticate; it reads the role on every request
// (a role change takes effect at once, D-151); it removes restricted systems
// (CO₂ analysers, models' restricted subsystems) and other users' workspaces
// from every listing, with their datastreams and control streams, and answers
// 404 under them; it lets a user create and append only under their own
// workspace and a service account only under its own systems; it refuses PUT,
// PATCH and DELETE with 405 for every account (SRD §17: only Reset instance
// deletes; a stock OpenSensorHub deletes on DELETE, D-200); and it lets only
// service accounts subscribe to control streams.
//
// To know which system an identifier belongs to, it reads the server's system
// tree (in a developed system it would learn it by discovery, and cache it).
import { Account, Accounts, isService, readsEmissions } from './accounts';
import type { Api, HttpRequest, HttpResponse } from './api';
import { DEFAULT_LIMIT, UID } from './constants';
import type { Server } from './server';
import { PushStream } from './stream';
import type { Chain, ComponentId, Letter, Tap } from './tap';

export interface GatewayHost {
  server(): Server;
  api(): Api;
  tap: Tap;
  accounts: Accounts;
}

/** Restricted systems (FR-111), matched by unique-id prefix (§9.5). */
export function isRestrictedUid(uid: string): boolean {
  return /^urn:x-barge:sensor:[^:]+:co2(:|$)/.test(uid) || /^urn:x-barge:process:[^:]+:restricted(:|$)/.test(uid);
}

function workspaceOf(uid: string): string | null {
  const m = /^urn:x-barge:workspace:([^:]+)/.exec(uid);
  return m ? m[1] : null;
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed' };

function refusal(status: number, message: string): HttpResponse {
  const line = `${status} ${STATUS_TEXT[status] ?? 'Error'}`;
  const body = new TextEncoder().encode(`<html><head><title>${line}</title></head><body><h2>${line}</h2><p>${message}</p></body></html>`);
  return { status, headers: [['content-type', 'text/html;charset=utf-8'], ['content-length', String(body.length)]], body };
}

/** Listing paths whose items the gateway filters and pages itself. */
const LISTINGS = [/^\/systems$/, /^\/systems\/[^/]+\/(subsystems|datastreams|controlstreams)$/, /^\/datastreams$/, /^\/controlstreams$/,
  /^\/collections\/[^/]+\/items$/];

export class Gateway {
  constructor(private readonly host: GatewayHost) {}

  private get srv(): Server {
    return this.host.server();
  }

  // --- permissions (FR-93, §9.3) -------------------------------------------------------------------
  canRead(a: Account, systemId: string): boolean {
    const line = this.srv.store.lineage(systemId);
    if (!line.length) return false;
    for (const s of line) {
      const w = workspaceOf(s.uid);
      if (w !== null && w !== a.user) return false;
      if (isRestrictedUid(s.uid) && !readsEmissions(a.role)) return false;
    }
    return true;
  }

  canWrite(a: Account, systemId: string): boolean {
    if (!this.canRead(a, systemId)) return false;
    const line = this.srv.store.lineage(systemId);
    if (!isService(a.user)) return line.some((s) => workspaceOf(s.uid) === a.user);
    if (line.some((s) => s.owner === a.user)) return true;
    return a.user === 'svc-importer' && line.some((s) => s.uid === UID.barge);
  }

  canCreateSystem(a: Account, parentId: string | null): boolean {
    if (!isService(a.user)) return false;
    if (parentId === null) return a.user === 'svc-importer' || a.user === 'svc-replay';
    const p = this.srv.store.systems.get(parentId);
    if (!p) return true; // the server answers 404
    if (p.uid === UID.models) return a.user !== 'svc-importer' && a.user !== 'svc-replay';
    return this.canWrite(a, parentId);
  }

  /** The system a path is under, or null when it names none (or one the server does not know). */
  private systemOf(seg: string[]): string | null {
    const st = this.srv.store;
    const [a, b] = seg;
    if (!b) return null;
    if (a === 'systems') return st.systems.has(b) ? b : null;
    if (a === 'datastreams') return this.srv.datastreamAny(b)?.system ?? null;
    if (a === 'observations') return this.srv.datastreamAny(b.slice(0, Math.max(0, b.lastIndexOf('-'))))?.system ?? null;
    if (a === 'controlstreams') return st.controlstreams.get(b)?.system ?? null;
    if (a === 'commands') {
      const c = st.commands.get(b);
      return c ? st.controlstreams.get(c.cs)?.system ?? null : null;
    }
    return null;
  }

  /** What the gateway decides before forwarding: null to forward, or its own refusal. */
  private authorize(a: Account, method: string, seg: string[], q: URLSearchParams): HttpResponse | null {
    // SRD §17: nothing is replaced or deleted except by Reset instance (D-200).
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      return refusal(405, `${method} is not allowed: nothing is replaced or deleted except by Reset instance`);
    }
    const sys = this.systemOf(seg);
    if (sys !== null && !this.canRead(a, sys)) return refusal(404, `no resource at /${seg.join('/')}`); // absent, not refused (FR-93)
    const last = seg[seg.length - 1];
    if (method === 'POST') {
      if (seg.length === 1 && seg[0] === 'systems' && !this.canCreateSystem(a, null)) return refusal(403, 'not allowed to create a system');
      if (seg[0] === 'systems' && seg.length === 3 && sys !== null) {
        if (last === 'subsystems' && !this.canCreateSystem(a, sys)) return refusal(403, 'not allowed to create a system here');
        if ((last === 'datastreams' || last === 'controlstreams') && !this.canWrite(a, sys)) return refusal(403, `not allowed to create ${last} here`);
      }
      if (sys !== null && (last === 'observations' || last === 'status') && !this.canWrite(a, sys)) return refusal(403, 'not allowed to write here');
    }
    if (method === 'GET' && seg[0] === 'controlstreams' && last === 'commands' && q.has('subscribe') && q.get('subscribe') !== '0') {
      // Subscriptions go to the server's internal receiver endpoint, for service accounts only (§9.5).
      if (!isService(a.user) || sys === null || !this.canWrite(a, sys)) return refusal(403, 'only a receiver subscribes to its control stream');
    }
    return null;
  }

  // --- one request ---------------------------------------------------------------------------------------
  async handle(req: HttpRequest): Promise<HttpResponse> {
    const tap = this.host.tap;
    const headers = new Map<string, string>();
    for (const [k, v] of req.headers) headers.set(k.toLowerCase(), v);
    const method = req.method.toUpperCase();
    const model = headers.get('x-tap-model') || undefined;
    const who: ComponentId = model ? 'models' : 'client';
    const quiet = headers.get('x-tap-quiet') === '1';
    const hopText = headers.get('x-tap-hop') ?? '0';
    const chain: Chain = tap.newChain(headers.get('x-tap-chain') ?? null, /^\d+$/.test(hopText) ? parseInt(hopText, 10) : 0);
    const opts = { model, quiet, chain };
    const rel = req.path || '/';
    const ask = `${method} ${rel}${req.query ? '?' + req.query : ''}`;
    const body = req.body ?? new Uint8Array(0);
    const shownHeaders = [...headers].filter(([k]) => k === 'authorization' || k === 'content-type').map(([k, v]) => `${k}: ${v}`);
    const text = body.length ? new TextDecoder().decode(body.length > 4000 ? body.subarray(0, 4000) : body) : '';
    tap.emit(who, 'gateway', letterFor(method, rel), model ? `${model}: ${ask}` : ask,
      [ask, ...shownHeaders].join('\n') + (text ? '\n\n' + text : ''), opts);

    let res: HttpResponse;
    const account = this.host.accounts.authenticate(headers.get('authorization'));
    const seg = rel.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const q = new URLSearchParams(req.query);
    const listing = (method === 'GET' || method === 'HEAD') && LISTINGS.some((re) => re.test('/' + seg.join('/')));
    if (!account) {
      res = refusal(401, 'valid credentials are needed'); // without WWW-Authenticate (D-153)
    } else {
      res = this.authorize(account, method, seg, q) ?? await this.forward(req, account, seg, q, listing, { id: 'gateway', model }, chain);
    }
    res.headers = res.headers.filter(([k]) => k.toLowerCase() !== 'www-authenticate'); // never the browser's own dialog
    if (res.stream) res.stream = this.relayStream(res.stream, who, model, quiet);
    const ctype = res.headers.find(([k]) => k === 'content-type')?.[1] ?? '';
    const bodyText = res.stream ? 'push subscription open: one command per line (application/x-ndjson)'
      : new TextDecoder().decode(res.body.length > 4000 ? res.body.subarray(0, 4000) : res.body);
    tap.emit('gateway', who, letterForResponse(res.status, rel, ctype), model ? `${model}: ${res.status} ${rel}` : `${res.status} ${rel}`, bodyText, opts);
    return res;
  }

  private async forward(req: HttpRequest, a: Account, seg: string[], q: URLSearchParams, listing: boolean,
    from: { id: ComponentId; model?: string }, chain: Chain): Promise<HttpResponse> {
    const api = this.host.api();
    if (!listing) return api.handle(req, { from, chain });
    // A listing: ask for all of it, remove what this account may not see, and page what is left.
    const limit = Math.max(1, Number(q.get('limit') ?? DEFAULT_LIMIT) || DEFAULT_LIMIT);
    const offset = Math.max(0, Number(q.get('offset') ?? 0) || 0);
    const fq = new URLSearchParams(q);
    fq.set('limit', '1000000');
    fq.set('offset', '0');
    const res = await api.handle({ ...req, query: fq.toString() }, { from, chain });
    if (res.status !== 200) return res;
    const j = JSON.parse(new TextDecoder().decode(res.body));
    const items = (j.items as any[]).filter((it) => {
      const sys = it['system@id'] ?? (seg[0] === 'systems' ? it.id : null);
      return sys === null || this.canRead(a, sys);
    });
    const links: unknown[] = [];
    if (offset + limit < items.length) {
      const nq = new URLSearchParams(q);
      nq.set('offset', String(offset + limit));
      nq.set('limit', String(limit));
      links.push({ href: `${(req.origin + (req.rootPath || '')).replace(/\/+$/, '')}/${seg.join('/')}?${nq}`, rel: 'next', type: 'application/json' });
    }
    const out = new TextEncoder().encode(JSON.stringify({ items: items.slice(offset, offset + limit), links }));
    return { status: 200, headers: [...res.headers.filter(([k]) => k !== 'content-length'), ['content-length', String(out.length)]], body: out };
  }

  /** Pushes come back through the gateway: each is captured on its second hop, gateway → receiver. */
  private relayStream(inner: PushStream, who: ComponentId, model: string | undefined, quiet: boolean): PushStream {
    const outer = new PushStream();
    const dec = new TextDecoder();
    inner.attach({
      chunk: (b) => {
        const line = dec.decode(b).trim();
        this.host.tap.emit('gateway', who, 'K', `${model ? `${model}: ` : ''}push ${summary(line)}`, line, { push: true, model, quiet });
        outer.write(b);
      },
      end: () => outer.end(),
    });
    outer.onCancel = () => inner.cancel();
    return outer;
  }
}

function summary(line: string): string {
  try {
    const p = JSON.parse(line).parameters ?? {};
    const s = Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 30 ? v.slice(0, 27) + '…' : JSON.stringify(v)}`).join(', ');
    return s.length > 120 ? s.slice(0, 117) + '…' : s;
  } catch {
    return 'command';
  }
}

function letterFor(method: string, path: string): Letter {
  const p = path.replace(/\/+$/, '');
  if (p.startsWith('/demonstrator/referee/')) return 'I';
  if (method === 'POST' && p.endsWith('/commands')) return 'K';
  if (method === 'POST' && (p.endsWith('/observations') || p.endsWith('/status'))) return 'O';
  return 'Q';
}

function letterForResponse(status: number, path: string, ctype: string): Letter {
  if (status >= 400) return 'H';
  const p = path.replace(/\/+$/, '');
  if (p.startsWith('/demonstrator/referee/')) return 'I';
  if (p === '/profile.json') return 'P';
  if (ctype.includes('swe+json') || (p.endsWith('/observations') && !ctype.includes('ndjson'))) return 'O';
  return 'D';
}
