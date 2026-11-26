// Message capture (FR-66, FR-67; tap.py): one tap at every component boundary
// of SRD §3.1. It records a copy of what crosses, with the letter of the
// standard it meets (SRD §5), and never changes either side's behaviour.
// Messages caused by one HTTP request (or one model call) share a chain and
// are numbered by hop (docs/v4-interfaces.md §3).
import { pyJson } from './py';

export type ComponentId = 'platform' | 'store' | 'adapter' | 'server' | 'models' | 'scilibs' | 'client';
export type Letter = 'Q' | 'D' | 'O' | 'K' | 'P' | 'H' | 'S' | 'L' | 'I';

export interface Captured {
  id: number | string;
  t: number;
  src: ComponentId;
  dst: ComponentId;
  letter: Letter;
  summary: string;
  content: string;
  failed: boolean;
  chain: string | null;
  hop: number;
  model?: string;
  push?: boolean;
}

export const MAX_CONTENT = 4000;

/**
 * Credentials never reach a captured message (§9.4, FR-16a; tap.redact): the value of
 * `Authorization` becomes `****`, and so does any JSON member named `password`.
 */
export function redact(text: string): string {
  return text.replace(/^(authorization:[ \t]*)[^\r\n]*/gim, '$1****').replace(/("password"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"****"');
}

export function clip(content: unknown): string {
  if (content === null || content === undefined) return '';
  const s = redact(typeof content === 'string' ? content : pyJson(content));
  return s.length <= MAX_CONTENT ? s : s.slice(0, MAX_CONTENT) + `… (${s.length} characters in all)`;
}

interface Chain {
  id: string;
  hop: number;
}

export interface EmitOptions {
  failed?: boolean;
  model?: string;
  quiet?: boolean;
  push?: boolean;
}

export class Tap {
  recording = true; // false while history loads: counts only
  enabled = true; // false switches capture off entirely (AT-18)
  counts: Record<string, number> = {};
  buffer: Captured[] = [];
  private ids = 0;
  private chain: Chain | null = null;

  constructor(private readonly now: () => number) {}

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
    if (!this.recording || opts.quiet) return;
    const ch = this.chain;
    this.buffer.push({
      id: this.nextId(), t: this.now(), src, dst, letter, summary, content: clip(content), failed: !!opts.failed,
      chain: ch ? ch.id : null, hop: ch ? ++ch.hop : 0, ...(opts.model ? { model: opts.model } : {}), ...(opts.push ? { push: true } : {}),
    });
  }

  drain(): Captured[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /** Start a chain (tap.begin_chain). Returns the chain it replaces, to restore with endChain. */
  beginChain(id: string | null, hop = 0): Chain | null {
    const prev = this.chain;
    this.chain = { id: id || `c${this.nextId()}`, hop };
    return prev;
  }

  /** The current chain's id (tap.chain_id). */
  chainId(): string | null {
    return this.chain ? this.chain.id : null;
  }

  /** End the current chain; returns its last hop (tap.end_chain). */
  endChain(prev: Chain | null): number {
    const hop = this.chain ? this.chain.hop : 0;
    this.chain = prev;
    return hop;
  }
}
