// The adoption opening (SRD 4.7 §9.8, docs/v4-interfaces.md §12). With `?hand-made` in the
// URL the demonstrator opens on the data server as we would write it ourselves: a range of
// subsystem components to develop, the main ones drawn beside the CSV importer and Models,
// which we write either way. Choosing "Adopt OpenSensorHub" merges them into the single
// Data server card, one at a time, and hands over to the normal layout (FR-77, FR-125a). The back end starts at the
// Adopt click, while the cards merge, and its startup is shown in the flowchart's status box: the flowchart stays on
// screen throughout (D-360). Nothing runs before Adopt (FR-122).
//
// The flag belongs to the demonstrator shell only (FR-119): it is read once, here, at load,
// and has no other effect. There is no way back in a session (FR-126).
import { OPENING_MERGE } from '../config';
import openingLayout from './layout-opening.json';
import { selectedComponent } from './selection';
import { Store } from './store';

export type SubsystemId =
  | 'sub-webapi' | 'sub-registry' | 'sub-obsstore' | 'sub-query'
  | 'sub-commands' | 'sub-accounts' | 'sub-permissions' | 'sub-admin';

export interface Subsystem {
  id: SubsystemId;
  name: string;
  /** One-line role on the card, as every component card has (VS-12, VS-25). */
  role: string;
  /** FR-120: what it does. */
  does: string;
  /** FR-120: where it keeps its data ('—' for nowhere of its own). */
  keeps: string;
}

/** FR-120 (4.7), in the table's order: the main subsystem components, not all of them. */
export const SUBSYSTEMS: Subsystem[] = [
  { id: 'sub-webapi', name: 'Web API', role: 'endpoints', does: 'Connected Systems endpoints, discovery, paging, formats', keeps: '—' },
  { id: 'sub-registry', name: 'Registry', role: 'what exists', does: 'Systems, datastreams, schemas, control streams', keeps: 'a metadata database' },
  { id: 'sub-obsstore', name: 'Observation store', role: 'time series', does: 'Time-series storage, indexes, backups, growth', keeps: 'a time-series database' },
  { id: 'sub-query', name: 'Query engine', role: 'filters', does: 'Time filters, latest value, building responses', keeps: 'indexes' },
  { id: 'sub-commands', name: 'Commands', role: 'delivery', does: 'Control streams, delivery to receivers, status', keeps: 'a command log' },
  { id: 'sub-accounts', name: 'Accounts', role: 'users, roles', does: 'Users, passwords, roles, sessions', keeps: 'a user database' },
  { id: 'sub-permissions', name: 'Permissions', role: 'who sees what', does: 'Who may see and change what', keeps: 'a policy store' },
  { id: 'sub-admin', name: 'Admin', role: 'settings', does: 'Settings, start, stop, health', keeps: 'configuration files' },
];

export const SUBSYSTEM_IDS = SUBSYSTEMS.map((s) => s.id);
export const isSubsystem = (id: unknown): id is SubsystemId => typeof id === 'string' && (SUBSYSTEM_IDS as string[]).includes(id);
export const subsystem = (id: SubsystemId) => SUBSYSTEMS.find((s) => s.id === id)!;

/**
 * FR-123 (D-359): every component of the opening, in one table, in the order the flowchart shows them. Before
 * Adopt nothing says which could be adopted rather than written: that is not yet decided. After Adopt, `after` says
 * what became of each.
 */
export interface Row {
  id: string;
  name: string;
  does: string;
  keeps: string;
  /** After adopting OpenSensorHub: null for a subsystem it covers (a tick), otherwise what became of it. */
  after: string | null;
}
const own = (id: string, name: string, does: string, keeps: string, after: string): Row => ({ id, name, does, keeps, after });
export const ROWS: Row[] = [
  own('client', 'Display client', 'The screen: login, datasets, fields, charts, replay, favourites', 'the browser, for the session only', 'Written by us'),
  own('models', 'Models', 'Clean the readings, summarise them, find changes in the weather', 'the data server', 'Written by us'),
  own('importer', 'CSV importer', 'Reads each CSV file once and loads it as a dataset', 'the data server', 'Written by us'),
  ...SUBSYSTEMS.map((s) => ({ id: s.id, name: s.name, does: s.does, keeps: s.keeps, after: null })),
  own('scilibs', 'Scientific libraries', 'Numerical work for the models: arrays, statistics, clustering', '—', 'Adopted: numpy and scikit-learn'),
  own('folder', 'Data folder', "The legacy logger's CSV files, never altered", 'files', 'Unchanged'),
];
export const isRow = (id: unknown): id is string => typeof id === 'string' && ROWS.some((r) => r.id === id);

/** FR-123 (4.7, D-359): the lead before adoption. No count (FR-120, D-230), and no split between written and adopted. */
export const LEAD_BUILD = 'Written ourselves, the system is a range of components to develop. Which of them could be adopted rather than written is not yet decided.';
/** FR-124: the lead after Adopt. No number (§16). */
export const LEAD_ADOPTED = 'OpenSensorHub covers the data server\'s subsystems. The rest is written by us, or adopted as libraries.';

export interface OpeningLine {
  a: string;
  b: string;
  /** Both ways: a head at each end. */
  both?: boolean;
  path: [number, number][];
}

/** FR-120a: the flows of the opening, drawn as plain lines without letters, from the opening layout. */
export const OPENING_LINES: OpeningLine[] = openingLayout.lines as OpeningLine[];

/**
 * FR-124 (D-360): the merge's schedule, in ms from the Adopt click. The opening's lines fade and the Data server card
 * appears; the subsystem cards travel into it one at a time, in the table's order, each ticking its row as it lands; then
 * the rest settles into the normal layout and the normal arrows fade in.
 */
export const MERGE_SCHEDULE = (() => {
  const { intro, stagger, travel, settle } = OPENING_MERGE;
  const subs = SUBSYSTEM_IDS.map((id, i) => ({ id, start: intro + i * stagger, land: intro + i * stagger + travel }));
  const settleStart = subs[subs.length - 1].land;
  return { intro, subs, settleStart, settle, end: settleStart + settle };
})();
/** FR-124: how long the merge takes (about six seconds, D-360); with reduced motion it is immediate (AT-66). */
export const OPENING_MERGE_MS = MERGE_SCHEDULE.end;

/** FR-119: `?hand-made`, with any value or none, read once at load. */
export const handMade: boolean = (() => {
  try {
    return new URLSearchParams(location.search).has('hand-made');
  } catch {
    return false;
  }
})();

/**
 * Where the opening is:
 * - `off`: no flag; the demonstrator starts as FR-77 describes;
 * - `build`: "Build it ourselves" is shown; nothing runs (FR-122);
 * - `merging`: the subsystem cards are moving into the Data server card (FR-124);
 * - `adopted`: handed over to the normal layout and the normal startup (FR-125).
 */
export type OpeningPhase = 'off' | 'build' | 'merging' | 'adopted';

class Opening {
  readonly phase = new Store<OpeningPhase>(handMade ? 'build' : 'off');
  /** True once the viewer has chosen Adopt (from the start of the merge). */
  readonly adopted = new Store<boolean>(false);
  /** How many subsystem cards have landed in the Data server card (D-360): their rows are ticked, in the table's order. */
  readonly landed = new Store<number>(0);
  /** performance.now() at the Adopt click: the merge's clock (D-360). */
  mergeStart = 0;
  private onStart: (() => void) | null = null;
  /** The subsystem whose table row is highlighted (FR-123). */
  readonly highlighted = new Store<string | null>(null);
  /** The opening panel is in the detail panel: from load, and after hand-over until the viewer clicks a component or closes it (FR-125). */
  readonly panel = new Store<boolean>(handMade);

  /** Before hand-over: nothing runs, nothing is revealed, other cards do nothing (FR-121 to FR-123). */
  get active(): boolean {
    const p = this.phase.value;
    return p === 'build' || p === 'merging';
  }

  /** The App passes what to do at the Adopt click: start the back end, while the cards merge (FR-125, D-360). */
  onAdopt(fn: () => void) {
    this.onStart = fn;
  }

  /** FR-123: a subsystem card highlights its row. */
  highlight(id: string) {
    if (this.phase.value === 'build') this.highlighted.set(id);
  }

  /** FR-124: Adopt OpenSensorHub. One way (FR-126). */
  adopt() {
    if (this.phase.value !== 'build') return;
    this.highlighted.set(null);
    this.adopted.set(true);
    // D-360: the back end starts now, concurrently with the merge (its worker script and, in Python, Pyodide load
    // meanwhile); its startup shows in the status box after hand-over, never in place of the flowchart.
    this.onStart?.();
    if (prefersReducedMotion()) {
      this.finish();
      return;
    }
    this.mergeStart = performance.now();
    this.phase.set('merging');
    // Timers, not animation frames, so the merge ends even in a hidden tab.
    MERGE_SCHEDULE.subs.forEach((s, i) => setTimeout(() => this.land(i + 1), s.land));
    setTimeout(() => this.finish(), OPENING_MERGE_MS);
  }

  private land(n: number) {
    if (this.landed.value < n) this.landed.set(n);
  }

  private finish() {
    if (this.phase.value === 'adopted') return;
    this.land(SUBSYSTEM_IDS.length);
    this.phase.set('adopted');
  }

  /** The viewer closed the opening panel, or asked for the overview. */
  dismissPanel() {
    if (this.panel.value) this.panel.set(false);
  }
}

export const opening = new Opening();

// FR-125: after hand-over, the savings stay in the detail panel until a component is clicked.
selectedComponent.subscribe((id) => {
  if (id && opening.phase.value === 'adopted') opening.dismissPanel();
});

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
