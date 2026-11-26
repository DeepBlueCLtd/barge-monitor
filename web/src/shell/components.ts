// The seven components and their four zones (SRD 4.6 §3, docs/v4-interfaces.md §1),
// with the words the flowchart and the detail panel show for each. The adoption
// opening's eight subsystem cards are in opening.ts: they are not components of the
// system and no message ever names them.
import type { ZoneId } from './palette';

export type ComponentId = 'folder' | 'importer' | 'replay' | 'gateway' | 'server' | 'models' | 'scilibs' | 'client';

export interface ComponentInfo {
  id: ComponentId;
  code: string;
  name: string;
  /** One-line role on the card (VS-12). */
  role: string;
  zone: ZoneId;
  /** Revealed as value-add on first click (FR-75). The importer and replay controller are not (FR-74). */
  valueAdd: boolean;
  /** FR-73: what it does. */
  does: string;
  /** FR-73: why it belongs to its zone. */
  why: string;
}

export const COMPONENTS: Record<ComponentId, ComponentInfo> = {
  folder: {
    id: 'folder', code: 'C-02', name: 'Data folder', role: 'CSV files, never altered', zone: 'legacy', valueAdd: false,
    does: 'A folder of CSV files that scientists copy in, one recording per file: an unusual time format and epoch, units in the column headings, coded missing values, and the bow and stern sensors as separate column groups in one file. The system lists it and reads it; it never writes, renames or deletes anything in it.',
    why: 'Legacy: it is how the data arrive today, and the system works in front of it as it is. Nothing here changes the files or how they are made.',
  },
  importer: {
    id: 'importer', code: 'C-03', name: 'CSV importer', role: 'reads the CSV', zone: 'back', valueAdd: false,
    does: "The only code that understands the CSV files. It lists the folder, publishes an archive catalogue (each file's name, size, date, span and status), and on an import command reads a file and writes every row in bulk into the data server's store, each file as its own dataset. Overlapping files are kept apart; a changed file becomes a new dataset and the old one is kept.",
    why: "New build · back end: written for this system. In a developed system it is a module of the data server, written against OpenSensorHub's extension interface, so its writes happen inside the server rather than over HTTP. It is the one place that would change if the files did.",
  },
  replay: {
    id: 'replay', code: 'C-09', name: 'Replay controller', role: 'replay clock', zone: 'back', valueAdd: false,
    does: 'Holds the current dataset and the replay clock. It takes load, play, pause, rate and seek as commands pushed on its control stream, and publishes its state (dataset, span, replay time, rate) and a log of every command it applied. Live views and models read "up to replay time".',
    why: 'New build · back end: written for this system, a separate process with its own service account in a developed system, subscribed to its control stream like any receiver.',
  },
  gateway: {
    id: 'gateway', code: 'C-10', name: 'Access gateway', role: 'hides what a user may not see', zone: 'back', valueAdd: false,
    does: "Sits in front of the data server: every request from the display client and the models passes it, and the answers and pushed commands come back through it. It checks each request's credentials against the accounts, answering 401 itself; it removes restricted resources (the CO₂ sensors, restricted model outputs, other users' workspaces) from every listing and answers 404 under them; it lets users create and append only under their own systems; it refuses replacing and deleting (PUT, PATCH, DELETE) for every account with 405, since OpenSensorHub would allow them; and it reads each user's role on every request, so a role change takes effect at once.",
    why: 'New build · back end: written for this system, because a stock OpenSensorHub cannot hide a system from a user (S-AUTH finding). The importer and the replay controller are modules inside the server and do not pass it.',
  },
  server: {
    id: 'server', code: 'C-04', name: 'Data server', role: 'OpenSensorHub · OGC Connected Systems', zone: 'third', valueAdd: false,
    does: 'OpenSensorHub, an open-source server for OGC API – Connected Systems: authentication, discovery, systems, datastreams, observations, control streams and command delivery, and the store behind them, served over HTTP, through the access gateway, to the display client and the models alike. A Java server cannot run in a browser, so here a stand-in takes its place and serves the same interface.',
    why: 'Third-party libraries: off the shelf, openly maintained, not our code. The system adopts it as shipped; the CSV importer is the module written for it.',
  },
  models: {
    id: 'models', code: 'C-05', name: 'Models', role: 'process systems', zone: 'back', valueAdd: true,
    does: "Core models and empty slots, each an OGC process system in its own worker, registered over the data server's own HTTP interface and taking commands pushed on their control streams.",
    why: 'New build · back end.',
  },
  scilibs: {
    id: 'scilibs', code: 'C-07', name: 'Scientific libraries', role: 'numpy, scikit-learn', zone: 'third', valueAdd: false,
    does: 'numpy and scikit-learn: the numerical work inside the models (cleaning, means, change detection, correlation, clustering). Used by the models only.',
    why: 'Third-party libraries: off the shelf, openly maintained, not our code. The models call them; nothing else does.',
  },
  client: {
    id: 'client', code: 'C-08', name: 'Display client', role: 'self-configuring UI', zone: 'front', valueAdd: true,
    does: "The real system's screen: login, dataset picker, replay, views and data of interest.",
    why: 'New build · front end.',
  },
};

export const COMPONENT_IDS = Object.keys(COMPONENTS) as ComponentId[];

export const isComponentId = (id: unknown): id is ComponentId => typeof id === 'string' && id in COMPONENTS;

export const nameOf = (id: string) => COMPONENTS[id as ComponentId]?.name ?? id;

/** SRD §3.1: which letters cross each directed flow, and how each is carried (FR-65). */
export const FLOWS: { src: ComponentId; dst: ComponentId; letters: string[]; via: string }[] = [
  { src: 'importer', dst: 'folder', letters: ['S'], via: 'file request' },
  { src: 'folder', dst: 'importer', letters: ['L'], via: 'file contents' },
  { src: 'importer', dst: 'server', letters: ['I'], via: 'inside the server' },
  { src: 'server', dst: 'importer', letters: ['K'], via: 'push' },
  // The display client and the models reach the server only through the access gateway (interfaces §2, §9.5).
  { src: 'client', dst: 'gateway', letters: ['Q', 'K'], via: 'HTTP' },
  { src: 'gateway', dst: 'client', letters: ['D', 'P', 'O', 'H'], via: 'HTTP' },
  { src: 'models', dst: 'gateway', letters: ['Q', 'O', 'I'], via: 'HTTP' },
  { src: 'gateway', dst: 'models', letters: ['D', 'O', 'H', 'K'], via: 'HTTP; K pushed' },
  { src: 'gateway', dst: 'server', letters: ['Q', 'K', 'O', 'I'], via: 'HTTP' },
  { src: 'server', dst: 'gateway', letters: ['D', 'P', 'O', 'H', 'K'], via: 'HTTP; K pushed' },
  { src: 'server', dst: 'replay', letters: ['K'], via: 'push' },
  { src: 'replay', dst: 'server', letters: ['Q', 'O'], via: 'HTTP' },
  { src: 'models', dst: 'scilibs', letters: ['I'], via: 'calls' },
  { src: 'scilibs', dst: 'models', letters: ['I'], via: 'results' },
];
