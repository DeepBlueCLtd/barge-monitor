// The display client's HTTP. Relative URLs only (FR-04): pointing the client at a
// real server is a change of API_BASE alone. The credentials are held here, in
// memory only, and go on every request as Basic authentication (FR-98); they are
// dropped on lock and on restart (FR-46, FR-99). Every request carries an
// `x-tap-chain` header so that the messages it causes can be found by chain
// (docs/v4-interfaces.md §2); the header decides nothing in the server.
import { API_BASE, HANDSHAKE_HOP_MS } from '../config';
import { drawClock } from '../shell/drawclock';
import { bus, handshakeChains, userChains } from '../shell/messages';

/** No answer at all: the server is down or starting (§9.1). */
export class NetworkFailure extends Error {}
/** 401: the credentials were refused (FR-101). */
export class Unauthorized extends Error {}
/** The client was locked or restarted while the request was out. */
export class Closed extends Error {}

export class HttpError extends Error {
  constructor(public path: string, public status: number) {
    super(`${path}: HTTP ${status}`);
  }
}

/** One command status report, as `/controlstreams/{id}/status` lists it (§9.1). */
export interface StatusReport {
  id: string;
  'command@id': string;
  statusCode: string;
  reportTime?: string;
  message?: string;
}

/**
 * Each command's outcome: its latest status report other than PENDING, by command id (D-199, revising D-164).
 * OpenSensorHub stores the sender's PENDING when the POST answers, about 5 s after it was sent, which is often
 * after the receiver's COMPLETED; the latest report alone would read PENDING.
 */
export function commandOutcomes(reports: StatusReport[]): Map<string, StatusReport> {
  const out = new Map<string, StatusReport>();
  for (const r of reports) {
    if (r.statusCode === 'PENDING') continue;
    const prev = out.get(r['command@id']);
    if (!prev || (Date.parse(r.reportTime ?? '') || 0) >= (Date.parse(prev.reportTime ?? '') || 0)) out.set(r['command@id'], r);
  }
  return out;
}

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
  chain: string;
}

let sessions = 0;

function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

export class ClientHttp {
  closed = false;
  readonly prefix = `dc${++sessions}-`;
  private seq = 0;
  private authorization: string | null;
  /** Requests in flight, so that a lock stops them (FR-99). */
  private inflight = new Set<AbortController>();
  /** True while answering a viewer's action: those requests' chains are marked (gold ring). */
  userAction = false;
  /**
   * True during the handshake (FR-42a, D-107): each request is sent only when the reply to the
   * one before has been drawn arriving, so the flowchart shows the exchange in its true order.
   */
  paced = false;
  /** Every request, as it is sent (for the client's own status line). */
  onRequest: ((r: { chain: string; method: string; path: string }) => void) | null = null;

  constructor(user: string, password: string) {
    this.authorization = basic(user, password);
  }

  /** Discard the credentials and stop every request (FR-99, FR-46). */
  close() {
    this.closed = true;
    this.authorization = null;
    for (const a of this.inflight) a.abort();
    this.inflight.clear();
  }

  /** True if the chain was started by this display client. */
  owns(chain: string | null | undefined): boolean {
    return !!chain && chain.startsWith(this.prefix);
  }

  /** Wait, on the drawing clock, until a chain's reply has been drawn arriving at the display client. */
  private async drawn(chain: string): Promise<void> {
    // With capture off nothing is drawn, so there is nothing to wait for.
    const giveUp = performance.now() + 4 * HANDSHAKE_HOP_MS + 1500;
    for (;;) {
      if (this.closed) throw new Closed('the display client was locked or restarted');
      const end = bus.replyArrival(chain);
      if (end != null ? drawClock.now() >= end : performance.now() > giveUp && !drawClock.frozen.value) return;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  async request<T = any>(method: string, path: string, params: Record<string, string> = {}, body?: unknown, ctype = 'application/json'): Promise<Reply<T>> {
    if (this.closed || !this.authorization) throw new Closed('the display client was locked or restarted');
    const q = new URLSearchParams(params).toString();
    const chain = `${this.prefix}${++this.seq}`;
    if (this.userAction) {
      userChains.add(chain);
      if (userChains.size > 500) userChains.delete(userChains.values().next().value!);
    }
    const paced = this.paced;
    if (paced) {
      handshakeChains.add(chain);
      if (handshakeChains.size > 500) handshakeChains.delete(handshakeChains.values().next().value!);
    }
    this.onRequest?.({ chain, method, path });
    const abort = new AbortController();
    this.inflight.add(abort);
    let r: Response;
    try {
      r = await fetch(API_BASE + path + (q ? `?${q}` : ''), {
        method,
        headers: { authorization: this.authorization, 'x-tap-chain': chain, ...(body !== undefined ? { 'content-type': ctype } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: abort.signal,
        cache: 'no-store',
      });
    } catch {
      this.inflight.delete(abort);
      if (this.closed) throw new Closed('the display client was locked or restarted');
      throw new NetworkFailure('the server did not answer');
    }
    let text: string;
    try {
      text = await r.text();
    } catch {
      this.inflight.delete(abort);
      if (this.closed) throw new Closed('the display client was locked or restarted');
      throw new NetworkFailure('the answer was cut off');
    }
    this.inflight.delete(abort);
    if (this.closed) throw new Closed('the display client was locked or restarted');
    if (paced) await this.drawn(chain);
    if (r.status === 401) throw new Unauthorized('the name or password was not accepted');
    // JSON whatever the Content-Type says (D-196): OpenSensorHub labels some of its JSON "auto".
    const ctypeIn = r.headers.get('content-type') ?? '';
    let parsed: any = text;
    if (text && (ctypeIn.includes('json') || /^\s*[[{]/.test(text))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: r.status, headers: r.headers, body: parsed, chain };
  }

  /** GET; a status other than 200 is an HttpError. */
  async get<T = any>(path: string, params?: Record<string, string>): Promise<T> {
    const r = await this.request<T>('GET', path, params);
    if (r.status !== 200) throw new HttpError(path, r.status);
    return r.body;
  }

  /** GET every page of a listing, following its rel="next" link (FR-23). */
  async all<T = any>(path: string, params: Record<string, string> = {}, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let p: Record<string, string> = { limit: '1000', ...params };
    for (let page = 0; page < maxPages; page++) {
      const body: any = await this.get(path, p);
      const items: T[] = Array.isArray(body) ? body : body?.items ?? [];
      out.push(...items);
      const href: string | undefined = Array.isArray(body) ? undefined : body?.links?.find((l: any) => l.rel === 'next')?.href;
      if (!href || !items.length) return out;
      p = Object.fromEntries(new URLSearchParams(href.includes('?') ? href.slice(href.indexOf('?') + 1) : ''));
    }
    return out;
  }

  /**
   * Send a command (FR-27, AT-39): every parameter, and never waited on. The server holds the
   * POST for about five seconds; the display follows the state datastream, not this answer.
   */
  command(controlstream: string, parameters: Record<string, unknown>, failed?: (e: unknown) => void): void {
    void this.request('POST', `controlstreams/${controlstream}/commands`, {}, { parameters }).catch((e) => failed?.(e));
  }
}
