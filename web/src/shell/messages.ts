// Captured messages (FR-66..FR-68) and their place on the flowchart.
// Every message is drawn: none is sampled or merged (FR-67). Each directed
// line has its own queue, so icons on one line travel one behind another,
// and a message's next hop sets off when its previous hop arrives.
import { HANDSHAKE_HOP_S, HOP_S } from '../config';
import { drawClock } from './drawclock';
import type { ComponentId } from './components';
import { LETTER_COLOURS } from './palette';
import { Store } from './store';

export type Letter = 'Q' | 'D' | 'O' | 'K' | 'P' | 'H' | 'S' | 'L' | 'I';

/** A captured message (docs/v4-interfaces.md §3), as the back end and the model workers post it. */
export interface Captured {
  id?: number | string;
  t: number; // when it was captured, real seconds (interfaces §3; never used for drawing)
  src: ComponentId;
  dst: ComponentId;
  letter: Letter;
  summary: string;
  content: string;
  failed?: boolean;
  chain?: string | null;
  hop?: number;
  model?: string;
  push?: boolean;
}

/** A message as the page holds it: a page-wide key and when it sets off on the flowchart. */
export interface Message extends Captured {
  key: string;
  start: number; // seconds on the drawing clock (drawclock.ts)
  dur: number; // seconds on its line
}

/** SRD §5: the nine letters, what each is and the standard it meets (FR-16: internal ones say so). */
export const LETTERS: Record<Letter, { name: string; key: string; standard: string; isPublic: boolean; colour: string }> = {
  Q: { name: 'Connected Systems request', key: 'Connected Systems request', standard: 'OGC API – Connected Systems', isPublic: true, colour: LETTER_COLOURS.Q },
  D: { name: 'Discovery resource', key: 'Discovery resource', standard: 'OGC API – Connected Systems, Features, Common; SensorML; SWE Common 3.0', isPublic: true, colour: LETTER_COLOURS.D },
  O: { name: 'Observations', key: 'Observations, SWE JSON', standard: 'SWE Common JSON (application/swe+json)', isPublic: true, colour: LETTER_COLOURS.O },
  K: { name: 'Command', key: 'Command', standard: 'OGC API – Connected Systems Part 2', isPublic: true, colour: LETTER_COLOURS.K },
  P: { name: 'Declared profile', key: 'Declared profile', standard: 'JSON Schema', isPublic: true, colour: LETTER_COLOURS.P },
  H: { name: 'HTTP status', key: 'HTTP status, 401, 403', standard: 'RFC 9110', isPublic: true, colour: LETTER_COLOURS.H },
  S: { name: 'File request', key: 'File request, internal', standard: 'internal, no public standard', isPublic: false, colour: LETTER_COLOURS.S },
  L: { name: 'Legacy CSV', key: 'Legacy CSV', standard: "the files' own format, no public standard", isPublic: false, colour: LETTER_COLOURS.L },
  I: { name: 'Internal object', key: 'Internal object', standard: 'internal typed object, no public standard', isPublic: false, colour: LETTER_COLOURS.I },
};
export const LETTER_ORDER: Letter[] = ['Q', 'D', 'O', 'K', 'P', 'H', 'S', 'L', 'I'];

// Scheduling on the flowchart, in real seconds on the drawing clock (D-302). If a line falls far
// behind, spacing is relaxed rather than letting the drawing lag ever
// further behind the system: every message is still drawn.
const GAP_S = HOP_S * 0.34;
const MAX_LAG_S = 6;
/** How many recent messages are kept for the message strip and chains (not for drawing). */
const RECENT = 4000;

let seq = 0;

class MessageBus {
  /** Messages on the flowchart now (until they arrive). */
  live = new Store<Message[]>([]);
  /** Messages drawn so far, per "src>dst:letter" (FR-73 live counters). */
  counts = new Store<Record<string, number>>({});
  /** Bumped whenever messages arrive; the message strip follows it. */
  version = new Store(0);
  total = 0;
  private recent: Message[] = [];
  private laneFree = new Map<string, number>();
  private userLaneFree = new Map<string, number>();
  private chainEnd = new Map<string, number>();

  /** For the handshake's chains: when the reply is drawn arriving back at the display client. */
  private replyEnd = new Map<string, number>();

  /** When a handshake chain's reply arrives at the display client on the flowchart, or null if not yet captured. */
  replyArrival(chain: string): number | null {
    return this.replyEnd.get(chain) ?? null;
  }

  private schedule(m: Captured, at: number): number {
    const lane = `${m.src}>${m.dst}`;
    let start = at;
    if (m.chain && this.chainEnd.has(m.chain)) start = Math.max(start, this.chainEnd.get(m.chain)!);
    // The handshake is drawn one hop after another, never queued behind other traffic: the
    // client itself waits for each reply to be drawn before it sends the next request.
    if (isHandshakeMessage(m)) {
      const end = start + HANDSHAKE_HOP_S;
      this.chainEnd.set(m.chain!, end);
      if (m.dst === 'client' || m.failed) this.replyEnd.set(m.chain!, end);
      if (this.replyEnd.size > 500) this.replyEnd.delete(this.replyEnd.keys().next().value!);
      return start;
    }
    const free = this.laneFree.get(lane) ?? -Infinity;
    // A viewer's own action is drawn at once, ahead of any queue on its lines.
    if (isUserMessage(m)) {
      // Spaced only among themselves, so a burst of them does not stack on one point.
      const own = Math.max(start, this.userLaneFree.get(lane) ?? -Infinity);
      this.userLaneFree.set(lane, own + GAP_S);
      if (m.chain) this.chainEnd.set(m.chain, own + HOP_S);
      return own;
    }
    const queued = Math.max(start, free);
    start = queued - at > MAX_LAG_S ? Math.max(start, at + MAX_LAG_S) : queued;
    this.laneFree.set(lane, Math.max(free, start + GAP_S));
    if (m.chain) this.chainEnd.set(m.chain, start + HOP_S);
    if (this.chainEnd.size > 5000) this.chainEnd.clear();
    return start;
  }

  add(list: Captured[]) {
    if (!list?.length) return;
    // Within a chain, hops play in order; otherwise in order of capture.
    const ordered = [...list].sort((a, b) => a.t - b.t || (a.chain ?? '').localeCompare(b.chain ?? '') || (a.hop ?? 0) - (b.hop ?? 0));
    // Drawn from when it reaches the page (D-302): the back end's capture time is not a drawing time.
    const at = drawClock.now();
    const added: Message[] = ordered.map((m) => ({ ...m, key: `m${++seq}`, start: this.schedule(m, at), dur: isHandshakeMessage(m) ? HANDSHAKE_HOP_S : HOP_S }));
    const counts = { ...this.counts.value };
    for (const m of added) counts[`${m.src}>${m.dst}:${m.letter}`] = (counts[`${m.src}>${m.dst}:${m.letter}`] ?? 0) + 1;
    this.total += added.length;
    this.counts.set(counts);
    this.recent.push(...added);
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
    this.live.set(this.prune([...this.live.value, ...added]));
    this.version.set(this.version.value + 1);
  }

  /** Drop messages that have arrived. */
  private prune(list = this.live.value): Message[] {
    const now = drawClock.now();
    return list.filter((m) => m.start + m.dur > now);
  }

  tick() {
    const before = this.live.value.length;
    const after = this.prune();
    if (after.length !== before) this.live.set(after);
  }

  /** Recent messages, oldest first, optionally filtered. */
  find(pred: (m: Message) => boolean): Message[] {
    return this.recent.filter(pred);
  }

  /** The most recent message matching, or null. */
  last(pred: (m: Message) => boolean): Message | null {
    for (let i = this.recent.length - 1; i >= 0; i--) if (pred(this.recent[i])) return this.recent[i];
    return null;
  }

  /** Every recent message of one chain, in hop order. */
  chain(id: string): Message[] {
    return this.recent.filter((m) => m.chain === id).sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0) || a.t - b.t);
  }
}

export const bus = new MessageBus();

// Read-only, for the end-to-end tests (decision D-273): how many captured messages reached the shell, per
// "src>dst:letter". Messages counted but not drawn (x-tap-quiet) never reach it, so a silent import adds nothing.
(globalThis as { bargeCaptured?: () => Record<string, number> }).bargeCaptured = () => ({ ...bus.counts.value });
// Read-only, for the end-to-end tests (AT-53, AT-55; D-306): the recent captured messages the shell holds, as drawn.
(globalThis as { bargeMessages?: () => Captured[] }).bargeMessages = () => bus.find(() => true)
  .map(({ src, dst, letter, summary, content, chain }) => ({ t: 0, src, dst, letter, summary, content, chain }));

/** Chains started by a viewer's own action in the display client: their icons wear a gold ring. */
export const userChains = new Set<string>();
export function isUserMessage(m: { chain?: string | null }): boolean {
  return !!m.chain && userChains.has(m.chain);
}

/** Chains of the display client's handshake: drawn in strict sequence, at the handshake's pace. */
export const handshakeChains = new Set<string>();
export function isHandshakeMessage(m: { chain?: string | null }): boolean {
  return !!m.chain && handshakeChains.has(m.chain);
}
