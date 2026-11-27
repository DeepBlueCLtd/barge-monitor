// Illustrative traffic in the adoption opening (D-361; SRD FR-120a, FR-122; docs/v4-interfaces.md §12). While "Build it
// ourselves" is shown, message icons travel along the opening's lines in a few realistic sequences: a request, the
// subsystems it passes through, and its reply. Nothing runs: the sequences are made up here, in the page, from a fixed
// list. No request, worker or Service Worker is involved, nothing goes through the message bus (messages.ts), so nothing
// is counted, captured, listed in the message strip or clickable. The icons are the real ones (Glyph), with the real
// letters, so the opening reads like the system it describes. At the Adopt click the traffic stops at once: nothing new
// sets off and the icons in flight fade out quickly, before the cards start to move. With reduced motion there is none.
import { drawClock } from './drawclock';
import type { Pt } from './geometry';
import openingLayout from './layout-opening.json';
import type { Letter } from './messages';

type Hop = [from: string, to: string, letter: Letter];

/** A sequence of hops, each setting off when the one before it arrives. */
interface Flow {
  id: string;
  weight: number;
  hops: Hop[];
}

const W = 'sub-webapi', REG = 'sub-registry', OBS = 'sub-obsstore', QRY = 'sub-query', CMD = 'sub-commands',
  ACC = 'sub-accounts', PRM = 'sub-permissions', ADM = 'sub-admin';

/** The illustrative flows: plausible, not a simulation. Request first, then the work behind it, then the reply. */
export const MOCK_FLOWS: Flow[] = [
  // The display client asks for the latest readings: checked, filtered, read from the store and sent back.
  { id: 'client-latest', weight: 3, hops: [['client', W, 'Q'], [W, PRM, 'I'], [PRM, W, 'I'], [W, QRY, 'I'], [QRY, OBS, 'I'], [OBS, QRY, 'O'], [QRY, W, 'O'], [W, 'client', 'O']] },
  // The display client discovers what exists.
  { id: 'client-discovery', weight: 2, hops: [['client', W, 'Q'], [W, REG, 'I'], [REG, W, 'D'], [W, 'client', 'D']] },
  // A login: the account is checked, then its role.
  { id: 'client-login', weight: 1, hops: [['client', W, 'Q'], [W, PRM, 'I'], [PRM, ACC, 'I'], [ACC, PRM, 'I'], [PRM, W, 'I'], [W, 'client', 'H']] },
  // A request the user may not make: refused with a status.
  { id: 'client-refused', weight: 1, hops: [['client', W, 'Q'], [W, PRM, 'I'], [PRM, W, 'I'], [W, 'client', 'H']] },
  // The CSV importer reads a file from the data folder, then writes what it found and the readings.
  { id: 'import', weight: 2, hops: [['importer', 'folder', 'S'], ['folder', 'importer', 'L'], ['importer', REG, 'D'], ['importer', OBS, 'O'], ['importer', OBS, 'O']] },
  // A command to the importer, pushed by Commands, and its status back.
  { id: 'command-importer', weight: 1, hops: [['client', W, 'K'], [W, CMD, 'K'], [CMD, 'importer', 'K'], ['importer', CMD, 'I'], [CMD, W, 'I'], [W, 'client', 'H']] },
  // A model is told to run: it reads observations, calls the scientific libraries and publishes its results.
  { id: 'model-run', weight: 2, hops: [[CMD, 'models', 'K'], ['models', W, 'Q'], [W, QRY, 'I'], [QRY, OBS, 'I'], [OBS, QRY, 'O'], [QRY, W, 'O'], [W, 'models', 'O'], ['models', 'scilibs', 'I'], ['scilibs', 'models', 'I'], ['models', W, 'O'], [W, 'models', 'H']] },
  // The model's status back to Commands.
  { id: 'model-status', weight: 1, hops: [[CMD, 'models', 'K'], ['models', CMD, 'I'], [CMD, W, 'I']] },
  // Admin changes a setting.
  { id: 'admin-settings', weight: 1, hops: [[ADM, W, 'I'], [W, ADM, 'I']] },
];

interface Path {
  points: Pt[];
  cum: number[];
  length: number;
}
function path(points: Pt[]): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, cum, length: cum[cum.length - 1] };
}
/** Both directions of every opening line: a reply travels back along the line its request came by. */
const PATHS = new Map<string, Path>();
// The opening's lines (FR-120a), read from the layout itself: opening.ts imports this module.
for (const l of openingLayout.lines as { a: string; b: string; path: Pt[] }[]) {
  PATHS.set(`${l.a}>${l.b}`, path(l.path));
  PATHS.set(`${l.b}>${l.a}`, path([...l.path].reverse()));
}
for (const f of MOCK_FLOWS) for (const [a, b] of f.hops) if (!PATHS.has(`${a}>${b}`)) throw new Error(`mock traffic: no opening line ${a}>${b}`);

function pointOn(p: Path, f: number): Pt {
  const s = Math.max(0, Math.min(1, f)) * p.length;
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < s) i++;
  const seg = p.cum[i] - p.cum[i - 1] || 1;
  const g = (s - p.cum[i - 1]) / seg;
  const a = p.points[i - 1], b = p.points[i];
  return [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g];
}

/** A gentle pace (seconds): a hop's time grows with its line's length; flows start every few seconds, a few at once. */
const PACE = { perPx: 1 / 330, base: 0.45, min: 0.7, max: 2.2, pause: 0.15, gap: 0.5, every: [1.6, 2.8], concurrent: 4, fade: 0.25 } as const;
const hopDur = (p: Path) => Math.max(PACE.min, Math.min(PACE.max, PACE.base + p.length * PACE.perPx));

export interface MockIcon {
  key: string;
  letter: Letter;
  at: Pt;
  opacity: number;
}

interface Live {
  key: string;
  flow: number;
  letter: Letter;
  path: Path;
  start: number;
  dur: number;
}

let seq = 0;

class MockTraffic {
  private hops: Live[] = [];
  /** When each running flow's last hop arrives. */
  private flowEnds = new Map<number, number>();
  private laneFree = new Map<string, number>();
  private next = 0;
  private last = -1;
  private lastStep = -Infinity;
  private flowSeq = 0;
  /** When the traffic was stopped (the Adopt click), or null while it runs. */
  stoppedAt: number | null = null;

  /** Stop at once: nothing new sets off; what is in flight fades out (D-361). One way, as Adopt is (FR-126). */
  stop() {
    if (this.stoppedAt == null) this.stoppedAt = drawClock.now();
  }

  /** Whether anything is still drawn. */
  get done(): boolean {
    return this.stoppedAt != null && drawClock.now() > this.stoppedAt + PACE.fade;
  }

  private pick(): Flow {
    const choices = MOCK_FLOWS.map((f, i) => ({ f, i, w: i === this.last ? f.weight / 4 : f.weight }));
    let r = Math.random() * choices.reduce((n, c) => n + c.w, 0);
    for (const c of choices) if ((r -= c.w) <= 0) return (this.last = c.i, c.f);
    return MOCK_FLOWS[0];
  }

  private launch(now: number) {
    const flow = this.pick();
    const id = ++this.flowSeq;
    let ready = now;
    for (const [a, b, letter] of flow.hops) {
      const lane = `${a}>${b}`;
      const p = PATHS.get(lane)!;
      // One behind another on a line, as the real icons are (messages.ts).
      const start = Math.max(ready, this.laneFree.get(lane) ?? -Infinity);
      const dur = hopDur(p);
      this.laneFree.set(lane, start + PACE.gap);
      this.hops.push({ key: `mock${++seq}`, flow: id, letter, path: p, start, dur });
      ready = start + dur + PACE.pause;
    }
    this.flowEnds.set(id, ready);
  }

  /** Advance to `now` (seconds on the drawing clock) and say what is drawn. */
  step(now = drawClock.now()): MockIcon[] {
    if (this.stoppedAt == null) {
      // After a hidden tab (no animation frames), start afresh rather than with a burst.
      if (now - this.lastStep > 2) {
        this.hops = [];
        this.flowEnds.clear();
        this.laneFree.clear();
        this.next = now + 0.3;
      }
      for (const [id, end] of this.flowEnds) if (end <= now) this.flowEnds.delete(id);
      if (now >= this.next) {
        if (this.flowEnds.size < PACE.concurrent) this.launch(now);
        const [lo, hi] = PACE.every;
        this.next = now + lo + Math.random() * (hi - lo);
      }
    }
    this.lastStep = now;
    this.hops = this.hops.filter((h) => h.start + h.dur > now);
    const fade = this.stoppedAt == null ? 1 : Math.max(0, 1 - (now - this.stoppedAt) / PACE.fade);
    if (fade === 0) {
      this.hops = [];
      return [];
    }
    const out: MockIcon[] = [];
    for (const h of this.hops) {
      const f = (now - h.start) / h.dur;
      if (f < 0) continue;
      // Hops that had not set off when the traffic stopped never do.
      if (this.stoppedAt != null && h.start > this.stoppedAt) continue;
      out.push({ key: h.key, letter: h.letter, at: pointOn(h.path, f), opacity: fade });
    }
    return out;
  }
}

export const mockTraffic = new MockTraffic();
