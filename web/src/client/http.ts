// The display client's HTTP. Relative URLs only (FR-04): pointing the client at a
// real server is a change of API_BASE alone. Every request carries an
// `x-tap-chain` header so the messages it causes inside the back end can be
// found by chain (FR-70, docs/v4-interfaces.md §3). The client does not draw its
// own messages: the back end captures both directions of the HTTP boundary.
//
// 4.7 (docs/v4-interfaces.md §9): every request carries Basic credentials; a body is
// read as JSON whatever its Content-Type says (D-196); refusals are HTML, so nothing
// is read from them but the status; there is no instance identifier and no 503.
//
// INTERIM (plan Phase 4): the Version 4.1 display client has no login yet, so it holds
// the demo owner's credentials in memory (labelled demo credentials, PR-07). The login
// of plan Phase 7 (FR-97) replaces this.
import { bus, handshakeChains, userChains } from '../shell/messages';
import { API_BASE } from '../config';
import { simClock } from '../shell/clock';

export class NetworkFailure extends Error {}
export class Closed extends Error {}

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
  chain: string;
}

let sessions = 0;

/** The demo owner's credentials, held in memory only (interim: plan Phase 7 brings the login). */
export const DEMO_OWNER = 'Basic ' + btoa('owner:demo-owner');

/** A body as JSON whenever it is JSON, whatever the Content-Type says (D-196); else the text. */
export function readBody(text: string): any {
  const s = text.trimStart();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export class ClientHttp {
  closed = false;
  readonly prefix = `dc${++sessions}-`;
  private seq = 0;
  authorization = DEMO_OWNER;
  /** Chains of observation requests, with the datastream read and whether it was raw (causing S). */
  onRequest: ((r: { chain: string; method: string; path: string; params: Record<string, string> }) => void) | null = null;

  /** True while answering a viewer's action: those requests' chains are marked (gold ring). */
  userAction = false;

  /**
   * True during the handshake: each request is sent only when the reply to the one before
   * has been drawn arriving, so the flowchart shows the exchange in its true order.
   */
  paced = false;
  /** Requests made by the current handshake so far. */
  onPaced: ((n: number, path: string) => void) | null = null;
  private pacedCount = 0;

  /** Wait, on the simulation clock, until a chain's reply has been drawn arriving at the client. */
  private async drawn(chain: string): Promise<void> {
    // With capture switched off nothing is drawn, so there is nothing to wait for.
    const giveUp = performance.now() + 2000;
    for (;;) {
      if (this.closed) throw new Closed('client restarted');
      const end = bus.replyArrival(chain);
      if (end != null ? simClock.now() >= end : performance.now() > giveUp) return;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /** The sequence number the next request's chain will carry. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  /** The sequence number of one of this client's chains, or -1. */
  seqOf(chain: string | null | undefined): number {
    return this.owns(chain) ? Number(chain!.slice(this.prefix.length)) : -1;
  }

  /** True if the chain was started by this display client. */
  owns(chain: string | null | undefined): boolean {
    return !!chain && chain.startsWith(this.prefix);
  }

  async request<T = any>(method: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<Reply<T>> {
    if (this.closed) throw new Closed('client restarted');
    const q = new URLSearchParams(params).toString();
    const chain = `${this.prefix}${++this.seq}`;
    if (this.userAction) {
      userChains.add(chain);
      if (userChains.size > 500) userChains.delete(userChains.values().next().value!);
    }
    this.onRequest?.({ chain, method, path, params });
    const paced = this.paced;
    if (paced) {
      handshakeChains.add(chain);
      if (handshakeChains.size > 500) handshakeChains.delete(handshakeChains.values().next().value!);
      this.onPaced?.(++this.pacedCount, path);
    } else this.pacedCount = 0;
    let r: Response;
    try {
      r = await fetch(API_BASE + path + (q ? `?${q}` : ''), {
        method,
        headers: { 'x-tap-chain': chain, authorization: this.authorization, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new NetworkFailure('the server did not answer');
    }
    if (this.closed) throw new Closed('client restarted');
    if (paced) await this.drawn(chain);
    return { status: r.status, headers: r.headers, body: readBody(await r.text()), chain };
  }

  async get<T = any>(path: string, params?: Record<string, string>): Promise<Reply<T>> {
    return this.request<T>('GET', path, params);
  }

  /** GET every page of a paged listing, following its rel="next" link (FR-23). */
  async all<T = any>(path: string, params: Record<string, string> = {}, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let p: Record<string, string> = { ...params };
    for (let page = 0; page < maxPages; page++) {
      const r = await this.get<any>(path, p);
      if (r.status !== 200) throw new HttpError(path, r.status, r.body);
      const items: T[] = Array.isArray(r.body) ? r.body : r.body?.items ?? [];
      out.push(...items);
      const next = nextLink(r);
      if (!next || !items.length) return out;
      p = { ...p, ...next };
    }
    return out;
  }
}

export class HttpError extends Error {
  constructor(public path: string, public status: number, public body: any) {
    super(`${path}: HTTP ${status}`);
  }
}

/** The query of a rel="next" link in the body's links. */
function nextLink(r: Reply<any>): Record<string, string> | null {
  const href: string | null = Array.isArray(r.body) ? null : r.body?.links?.find((l: any) => l.rel === 'next')?.href ?? null;
  if (!href) return null;
  const q = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  return Object.fromEntries(new URLSearchParams(q));
}
