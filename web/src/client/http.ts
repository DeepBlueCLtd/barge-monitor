// The display client's HTTP (B-C14). Relative URLs only (FR-04). Every
// request and response is reported to the flowchart: the client's side of
// the boundary with the relay is tapped here.
import { API_BASE } from '../config';
import { simClock } from '../shell/clock';
import { bus } from '../shell/messages';

export class NetworkFailure extends Error {}
export class InstanceChanged extends Error {}

export interface Reply<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

let chains = 0;

export class ClientHttp {
  instance: string | null = null;
  closed = false;
  onInstanceChange: (() => void) | null = null;

  async request<T = any>(method: string, path: string, params?: Record<string, string>, body?: unknown): Promise<Reply<T>> {
    if (this.closed) throw new Error('client restarted');
    const q = new URLSearchParams(params ?? {}).toString();
    const shown = `${method} ${path}${q ? '?' + decodeURIComponent(q) : ''}`;
    const chain = `p${++chains}`;
    const letter = method === 'POST' && path.endsWith('/commands') ? 'K' : 'Q';
    const t = simClock.now();
    bus.add([{ t, src: 'client', dst: 'relay', letter, summary: shown, content: body ? JSON.stringify(body) : shown, chain, hop: 1 }]);
    let r: Response;
    try {
      r = await fetch(API_BASE + path + (q ? `?${q}` : ''), {
        method,
        headers: { 'x-tap-chain': chain, 'x-tap-hop': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      bus.add([{ t, src: 'relay', dst: 'client', letter: 'H', summary: `${shown}: network failure`, content: 'TypeError: Failed to fetch', failed: true, chain, hop: 3 }]);
      throw new NetworkFailure('the server did not answer');
    }
    const text = await r.text();
    const ctype = r.headers.get('content-type') ?? '';
    const hops = Number(r.headers.get('x-tap-hops') ?? 2);
    const respLetter = r.status >= 400 ? 'H' : path.endsWith('profile') ? 'P' : ctype.includes('swe+json') ? 'O' : path.includes('/commands') ? 'K' : 'D';
    bus.add([{ t, src: 'relay', dst: 'client', letter: respLetter, summary: `${r.status} ${path}`, content: text, chain, hop: hops + 1 }]);
    const inst = r.headers.get('x-server-instance');
    if (inst && this.instance && inst !== this.instance && !this.closed) {
      this.onInstanceChange?.();
      throw new InstanceChanged(`server instance changed from ${this.instance} to ${inst}`);
    }
    return { status: r.status, headers: r.headers, body: text && ctype.includes('json') ? JSON.parse(text) : (text as any) };
  }

  /** GET, waiting through waiting mode: 503 with Retry-After (FR-46). */
  async get<T = any>(path: string, params?: Record<string, string>, onWait?: (s: number) => void): Promise<Reply<T>> {
    for (;;) {
      const r = await this.request<T>('GET', path, params);
      if (r.status !== 503) return r;
      const wait = Number(r.headers.get('retry-after') ?? 2);
      onWait?.(wait);
      // Retry-After is HTTP time: real seconds (decision log D-33).
      await new Promise((res) => setTimeout(res, wait * 1000));
    }
  }
}
