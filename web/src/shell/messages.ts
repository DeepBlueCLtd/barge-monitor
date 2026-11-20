// Captured messages (FR-47, FR-48) and their place on the flowchart.
// Every message is kept until it has crossed its edge; none is sampled.
import { HOP_S } from '../config';
import { simClock } from './clock';
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
  Q: { standard: 'OGC API – Connected Systems request', colour: '#2563eb' },
  D: { standard: 'Discovery resource: landing page, conformance, SensorML system and datastream descriptions, SWE Common schema', colour: '#7c3aed' },
  O: { standard: 'Observations, SWE Common JSON', colour: '#059669' },
  K: { standard: 'Command on a Connected Systems control stream', colour: '#d97706' },
  P: { standard: 'Declared profile, validated by JSON Schema', colour: '#db2777' },
  H: { standard: 'Plain HTTP status (RFC 9110)', colour: '#dc2626' },
  L: { standard: "Legacy fixed-width record (the logger's own format)", colour: '#78716c' },
  I: { standard: 'Internal typed object, no public standard', colour: '#475569' },
};

let seq = 0;
const chainBase = new Map<string, number>();

class MessageBus {
  live = new Store<Message[]>([]);
  counts = new Store<Record<string, number>>({});
  total = 0;

  add(list: Omit<Message, 'id'>[]) {
    if (!list.length) return;
    const now = simClock.displayNow();
    const added: Message[] = list.map((m) => {
      const id = `m${++seq}`;
      let base = m.t;
      if (m.chain) {
        if (!chainBase.has(m.chain)) chainBase.set(m.chain, m.t);
        base = chainBase.get(m.chain)!;
      }
      const start = Math.max(base + (m.hop ?? 0) * HOP_S, Math.min(m.t, now));
      return { ...m, id, start };
    });
    const counts = { ...this.counts.value };
    added.forEach((m) => (counts[`${m.src}>${m.dst}:${m.letter}`] = (counts[`${m.src}>${m.dst}:${m.letter}`] ?? 0) + 1));
    this.total += added.length;
    this.counts.set(counts);
    this.live.set(this.prune([...this.live.value, ...added]));
  }

  /** Drop messages that have finished crossing (kept while paused: they stay clickable). */
  prune(list = this.live.value): Message[] {
    const now = simClock.displayNow();
    const keep = list.filter((m) => (m.start ?? 0) + HOP_S * 1.5 > now);
    if (chainBase.size > 5000) chainBase.clear();
    return keep;
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
