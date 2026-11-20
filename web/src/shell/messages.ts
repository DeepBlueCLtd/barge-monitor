// Captured messages (FR-47, FR-48) and their place on the flowchart.
// Every message is kept until it has crossed its edge; none is sampled.
import { HOP_S } from '../config';
import { simClock } from './clock';
import { LETTER_COLOURS } from './palette';
import { Store } from './store';

export interface Message {
  id: string;
  t: number; // simulated time of capture
  src: string;
  dst: string;
  letter: string;
  summary: string;
  content: string;
  failed?: boolean;
  chain?: string | null;
  hop?: number;
  start?: number; // when it sets off on the flowchart (simulated seconds)
}

export const LETTERS: Record<string, { standard: string; colour: string }> = {
  Q: { standard: 'OGC API – Connected Systems request', colour: LETTER_COLOURS.Q },
  D: { standard: 'Discovery resource: landing page, conformance, SensorML system and datastream descriptions, SWE Common schema', colour: LETTER_COLOURS.D },
  O: { standard: 'Observations, SWE Common JSON', colour: LETTER_COLOURS.O },
  K: { standard: 'Command on a Connected Systems control stream', colour: LETTER_COLOURS.K },
  P: { standard: 'Declared profile, validated by JSON Schema', colour: LETTER_COLOURS.P },
  H: { standard: 'Plain HTTP status (RFC 9110)', colour: LETTER_COLOURS.H },
  L: { standard: "Legacy fixed-width record (the logger's own format)", colour: LETTER_COLOURS.L },
  I: { standard: 'Internal typed object, no public standard', colour: LETTER_COLOURS.I },
};

let seq = 0;
// Scheduling on the flowchart, in simulated seconds. Each line has a queue per
// direction so messages on the same line travel one behind another, never on
// top of each other; a message's next hop sets off when its previous hop
// arrives. If a line falls far behind, spacing is relaxed rather than letting
// the drawing lag ever further behind the system (every message is still drawn).
const GAP_S = HOP_S * 0.22;
const MAX_LAG_S = 6;
const laneFree = new Map<string, number>(); // "src>dst" -> earliest start for the next icon
const chainEnd = new Map<string, number>(); // chain -> when its latest hop arrives

class MessageBus {
  live = new Store<Message[]>([]);
  counts = new Store<Record<string, number>>({});
  total = 0;

  private schedule(m: Omit<Message, 'id'>): number {
    const lane = `${m.src}>${m.dst}`;
    let start = m.t;
    if (m.chain && chainEnd.has(m.chain)) start = Math.max(start, chainEnd.get(m.chain)!);
    const free = laneFree.get(lane) ?? -Infinity;
    const queued = Math.max(start, free);
    if (queued - m.t > MAX_LAG_S) start = Math.max(start, m.t + MAX_LAG_S); // relieve a backlog
    else start = queued;
    laneFree.set(lane, Math.max(free, start + GAP_S));
    if (m.chain) chainEnd.set(m.chain, start + HOP_S);
    if (chainEnd.size > 5000) chainEnd.clear();
    return start;
  }

  add(list: Omit<Message, 'id'>[]) {
    if (!list.length) return;
    const ordered = [...list].sort((a, b) => (a.chain ?? '').localeCompare(b.chain ?? '') || (a.hop ?? 0) - (b.hop ?? 0) || a.t - b.t);
    const added: Message[] = ordered.map((m) => ({ ...m, id: `m${++seq}`, start: this.schedule(m) }));
    const counts = { ...this.counts.value };
    added.forEach((m) => (counts[`${m.src}>${m.dst}:${m.letter}`] = (counts[`${m.src}>${m.dst}:${m.letter}`] ?? 0) + 1));
    this.total += added.length;
    this.counts.set(counts);
    this.live.set(this.prune([...this.live.value, ...added]));
  }

  /** Drop messages that have arrived (kept while paused: they stay clickable where they are). */
  prune(list = this.live.value): Message[] {
    const now = simClock.displayNow();
    return list.filter((m) => (m.start ?? 0) + HOP_S > now);
  }

  tick() {
    const before = this.live.value.length;
    const after = this.prune();
    if (after.length !== before) this.live.set(after);
  }

  setCounts(c: Record<string, number>) {
    this.counts.set({ ...c });
  }
}

export const bus = new MessageBus();
