// The adoption opening (SRD 4.6 §9.8, docs/v4-interfaces.md §12). With `?hand-made` in
// the URL the demonstrator opens on the data server drawn as eight subsystems we would
// write ourselves, beside the CSV importer, the replay controller, the access gateway
// and Models, which we write either way. Choosing
// "Adopt OpenSensorHub" merges them into the single Data server card, then hands over to
// the normal startup (FR-77) and starts the back end. Nothing runs before that (FR-122).
//
// The flag belongs to the demonstrator shell only (FR-119): it is read once, here, at
// load, and has no other effect. There is no way back in a session (FR-126).
import { OPENING_MERGE_MS } from '../config';
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
  /** FR-120: where it keeps its data ('—' for none). */
  keeps: string;
}

/** FR-120, in the table's order. */
export const SUBSYSTEMS: Subsystem[] = [
  { id: 'sub-webapi', name: 'Web API', role: 'endpoints', does: 'Connected Systems endpoints, discovery, paging, formats', keeps: '—' },
  { id: 'sub-registry', name: 'Registry', role: 'what exists', does: 'Systems, datastreams, schemas, control streams', keeps: 'a metadata database' },
  { id: 'sub-obsstore', name: 'Observation store', role: 'time series', does: 'Time-series storage, indexes, backups, growth', keeps: 'a time-series database' },
  { id: 'sub-query', name: 'Query engine', role: 'filters', does: 'Time filters, latest value, building responses', keeps: 'indexes' },
  { id: 'sub-commands', name: 'Commands', role: 'delivery', does: 'Control streams, delivery to receivers, status', keeps: 'a command log' },
  { id: 'sub-accounts', name: 'Accounts', role: 'users, roles', does: 'Users, passwords, roles, sessions', keeps: 'a user database' },
  { id: 'sub-permissions', name: 'Permissions', role: 'who sees what', does: 'Who may see what; hiding restricted systems', keeps: 'a policy store' },
  { id: 'sub-admin', name: 'Admin', role: 'settings', does: 'Settings, start, stop, health', keeps: 'configuration files' },
];

export const SUBSYSTEM_IDS = SUBSYSTEMS.map((s) => s.id);
export const isSubsystem = (id: unknown): id is SubsystemId => typeof id === 'string' && (SUBSYSTEM_IDS as string[]).includes(id);
export const subsystem = (id: SubsystemId) => SUBSYSTEMS.find((s) => s.id === id)!;

/** FR-123: written by us either way, in plain style (nothing marked: the reveal comes later, FR-74a). */
export const WRITTEN_EITHER_WAY = ['CSV importer', 'Replay controller', 'Access gateway', 'Models', 'Display client'];

export interface OpeningFlow {
  a: string;
  b: string;
  /** Both ways: a head at each end. */
  both?: boolean;
  path: [number, number][];
}

/** FR-120a: the flows of the opening, drawn as plain lines without letters, from the opening layout. */
export const OPENING_FLOWS: OpeningFlow[] = openingLayout.lines as OpeningFlow[];

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
 * - `merging`: the eight cards are moving into the Data server card (FR-124);
 * - `adopted`: handed over to the normal layout (FR-125). The back end has been started.
 */
export type OpeningPhase = 'off' | 'build' | 'merging' | 'adopted';

class Opening {
  readonly phase = new Store<OpeningPhase>(handMade ? 'build' : 'off');
  /** True once the viewer has chosen Adopt (from the start of the merge). */
  readonly adopted = new Store<boolean>(false);
  /** The subsystem whose table row is highlighted (FR-123). */
  readonly highlighted = new Store<SubsystemId | null>(null);
  /** The opening panel is in the detail panel: from load, and after hand-over until the viewer clicks a component or closes it (FR-125). */
  readonly panel = new Store<boolean>(handMade);
  private handOver: (() => void) | null = null;

  /** Before hand-over: nothing runs, nothing is revealed, other cards do nothing (FR-121..FR-123). */
  get active(): boolean {
    const p = this.phase.value;
    return p === 'build' || p === 'merging';
  }

  /** The App passes what to do at hand-over: start the back end (FR-125). */
  onHandOver(fn: () => void) {
    this.handOver = fn;
  }

  /** FR-124: Adopt OpenSensorHub. One way (FR-126). */
  adopt() {
    if (this.phase.value !== 'build') return;
    this.highlighted.set(null);
    this.adopted.set(true);
    if (prefersReducedMotion()) {
      this.finish();
      return;
    }
    this.phase.set('merging');
    setTimeout(() => this.finish(), OPENING_MERGE_MS);
  }

  private finish() {
    if (this.phase.value === 'adopted') return;
    this.phase.set('adopted');
    this.handOver?.();
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
