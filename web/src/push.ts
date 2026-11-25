// A push subscription shaped like a WebSocket (FR-02a, docs/v4-interfaces.md
// §9.2). A Service Worker cannot carry a WebSocket, so in the demonstrator a
// subscription is one long streaming response through the relay:
// `GET <base>controlstreams/{id}/commands?subscribe=1` with the Authorization
// header, answered with application/x-ndjson, one command JSON per line. In a
// developed system this is OpenSensorHub's WebSocket, with the same interface.

export interface PushMessageEvent {
  data: string;
}

export interface PushCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export class PushChannel {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = PushChannel.CONNECTING;
  onopen: ((e: Event | null) => void) | null = null;
  onmessage: ((e: PushMessageEvent) => void) | null = null;
  onclose: ((e: PushCloseEvent) => void) | null = null;
  onerror: ((e: Error) => void) | null = null;
  private abort = new AbortController();

  /**
   * @param url the control stream's commands URL, relative to the page (for example `api/controlstreams/040g/commands`);
   *            `subscribe=1` is added.
   * @param authorization the Authorization header value (`Basic …`)
   */
  constructor(readonly url: string, authorization: string, headers: Record<string, string> = {}) {
    void this.run(authorization, headers);
  }

  close(): void {
    if (this.readyState === PushChannel.CLOSED) return;
    this.readyState = PushChannel.CLOSING;
    this.abort.abort();
    this.finish(1000, 'closed by the client', true);
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === PushChannel.CLOSED) return;
    this.readyState = PushChannel.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  private async run(authorization: string, headers: Record<string, string>): Promise<void> {
    const target = this.url + (this.url.includes('?') ? '&' : '?') + 'subscribe=1';
    let res: Response;
    try {
      res = await fetch(target, { headers: { ...headers, authorization, accept: 'application/x-ndjson' }, signal: this.abort.signal, cache: 'no-store' });
    } catch (e) {
      if (this.readyState !== PushChannel.CLOSED) {
        this.onerror?.(e as Error);
        this.finish(1006, 'the server did not answer', false);
      }
      return;
    }
    if (!res.ok || !res.body) {
      this.onerror?.(new Error(`subscription refused: ${res.status}`));
      this.finish(1008, `HTTP ${res.status}`, false);
      return;
    }
    this.readyState = PushChannel.OPEN;
    this.onopen?.(null);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && this.readyState === PushChannel.OPEN) this.onmessage?.({ data: line });
        }
      }
      this.finish(1001, 'the server ended the subscription', true);
    } catch (e) {
      if (this.readyState !== PushChannel.CLOSED) {
        this.onerror?.(e as Error);
        this.finish(1006, 'the subscription was cut off', false);
      }
    }
  }
}
