// A response body that never ends on its own: a push subscription's NDJSON
// stream (docs/v4-interfaces.md §9.2). The transport (the worker's port to
// the relay, the Node harness's chunked HTTP, or an in-process receiver)
// attaches a sink; chunks written before that are kept until it does.

export interface StreamSink {
  chunk(b: Uint8Array): void;
  end(): void;
}

export class PushStream {
  private pending: Uint8Array[] = [];
  private sink: StreamSink | null = null;
  ended = false;
  /** Called once when the receiver goes away (the transport cancels the stream). */
  onCancel: (() => void) | null = null;

  write(b: Uint8Array | string): void {
    if (this.ended) return;
    const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
    if (this.sink) this.sink.chunk(bytes);
    else this.pending.push(bytes);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.sink) this.sink.end();
  }

  attach(sink: StreamSink): void {
    this.sink = sink;
    for (const b of this.pending.splice(0)) sink.chunk(b);
    if (this.ended) sink.end();
  }

  /** The receiver has gone: stop writing, and let the server forget the subscription. */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    const f = this.onCancel;
    this.onCancel = null;
    f?.();
  }
}

/** Reads NDJSON lines from chunks. */
export class LineReader {
  private buf = '';
  private dec = new TextDecoder();
  constructor(private readonly onLine: (line: string) => void) {}
  push(b: Uint8Array): void {
    this.buf += this.dec.decode(b, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}
