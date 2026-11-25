// Message capture (FR-66, FR-67; tap.py): one tap at every component boundary
// of SRD §3.1. It records a copy of what crosses, with the letter of the
// standard it meets (SRD §5), and never changes either side's behaviour.
// Messages caused by one request share a chain and are numbered by hop.
// Credentials are redacted here, once, centrally (FR-16a, docs/v4-interfaces.md §9.4).
import { pyJson } from './py';
import { realNow } from './time';

export type ComponentId = 'folder' | 'importer' | 'replay' | 'server' | 'gateway' | 'models' | 'scilibs' | 'client';
export type Letter = 'Q' | 'D' | 'O' | 'K' | 'P' | 'H' | 'S' | 'L' | 'I';

export interface Captured {
  id: number | string;
  t: number; // real seconds when captured (§3)
  replay_t?: number;
  src: ComponentId;
  dst: ComponentId;
  letter: Letter;
  summary: string;
  content: string;
  failed?: boolean;
  push?: boolean;
  chain: string | null;
  hop: number;
  model?: string;
}

export const MAX_CONTENT = 4000;

const AUTH_LINE = /(authorization["']?\s*[:=]\s*["']?)([^"'\r\n,}]*)/gi;
const PASSWORD = /("password"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** FR-16a: the value of every Authorization header and every JSON `password` member, as ****. */
export function redact(s: string): string {
  return s.replace(AUTH_LINE, (_, k) => `${k}****`).replace(PASSWORD, (_, k) => `${k}"****"`);
}

function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = /^(password|authorization)$/i.test(k) ? '****' : scrub(x);
    }
    return out;
  }
  return v;
}

export function clip(content: unknown): string {
  if (content === null || content === undefined) return '';
  const s = redact(typeof content === 'string' ? content : pyJson(scrub(content)));
  return s.length <= MAX_CONTENT ? s : s.slice(0, MAX_CONTENT) + `… (${s.length} characters in all)`;
}

/** Messages caused by one request share a chain, numbered by hop. */
export interface Chain {
  id: string;
  hop: number;
}

export interface EmitOptions {
  failed?: boolean;
  model?: string;
  quiet?: boolean;
  push?: boolean;
  chain?: Chain | null;
}

export class Tap {
  enabled = true; // false switches capture off entirely (AT-18)
  counts: Record<string, number> = {};
  buffer: Captured[] = [];
  /** The replay time now, when a dataset is loaded (for the shell's strip only). */
  replayTime: () => number | null = () => null;
  private ids = 0;

  nextId(): number {
    return ++this.ids;
  }

  count(src: ComponentId, dst: ComponentId, letter: Letter, n = 1): void {
    if (!this.enabled) return;
    const key = `${src}>${dst}:${letter}`;
    this.counts[key] = (this.counts[key] ?? 0) + n;
  }

  emit(src: ComponentId, dst: ComponentId, letter: Letter, summary: string, content?: unknown, opts: EmitOptions = {}): void {
    if (!this.enabled) return;
    this.count(src, dst, letter);
    if (opts.quiet) return;
    const ch = opts.chain ?? null;
    const rt = this.replayTime();
    const m: Captured = {
      id: this.nextId(), t: realNow(), src, dst, letter, summary: redact(summary), content: clip(content),
      chain: ch ? ch.id : null, hop: ch ? ++ch.hop : 0,
    };
    if (rt !== null) m.replay_t = rt;
    if (opts.failed) m.failed = true;
    if (opts.push) m.push = true;
    if (opts.model) m.model = opts.model;
    this.buffer.push(m);
    if (this.buffer.length > 20000) this.buffer.splice(0, this.buffer.length - 20000); // nobody is draining
  }

  drain(): Captured[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /** A new chain; `id` is the client's own (x-tap-chain) when it sent one. */
  newChain(id: string | null = null, hop = 0): Chain {
    return { id: id || `c${this.nextId()}`, hop };
  }
}
