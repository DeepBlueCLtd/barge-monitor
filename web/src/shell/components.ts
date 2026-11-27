// The six components of SRD §3 (4.7) and their four zones (docs/v4-interfaces.md §1), with
// the words the flowchart and the detail panel show for each. There is no replay controller
// and no access gateway (4.7), and the 4.1 collection platform, logger store and store adapter
// are retired (plan Phase 8, D-320).
import type { ZoneId } from './palette';

export type ComponentId = 'folder' | 'importer' | 'server' | 'models' | 'scilibs' | 'client';

export interface ComponentInfo {
  id: ComponentId;
  code: string;
  name: string;
  /** One-line role on the card (VS-12). */
  role: string;
  zone: ZoneId;
  /** Revealed as value-add (FR-74, FR-75): only Models and the display client. The importer is not marked. */
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
    id: 'importer', code: 'C-03', name: 'CSV importer', role: 'reads the CSV · a module of the server', zone: 'back', valueAdd: false,
    does: "The only code that understands the CSV files. It lists the folder, publishes an archive catalogue (each file's name, size, date, hash, span and status), and on an import command reads a file and writes every row in bulk into the data server's store, each file as its own dataset. Overlapping files are kept apart; a changed file becomes a new dataset and the old one is kept, superseded.",
    why: "New build · back end: written for this system. In a developed system it is a module of OpenSensorHub, written against its extension interface, so its writes happen inside the server rather than over HTTP. It is the one place that would change if the files did.",
  },
  server: {
    id: 'server', code: 'C-04', name: 'Data server', role: 'OpenSensorHub · OGC Connected Systems', zone: 'third', valueAdd: false,
    does: 'OpenSensorHub, an open-source server for OGC API – Connected Systems: authentication and permissions, discovery, systems, datastreams, observations, control streams and command delivery, and the store behind them, served over HTTP to the display client and the models alike. A Java server cannot run in a browser, so here a stand-in takes its place and serves the same interface.',
    why: 'Third-party libraries: off the shelf, openly maintained, not our code. The system adopts it as shipped; the CSV importer is the module written for it.',
  },
  models: {
    id: 'models', code: 'C-05', name: 'Models', role: 'process systems', zone: 'back', valueAdd: true,
    does: "Core models and empty slots, each an OGC process system in its own worker, registered over the data server's own HTTP interface, processing each dataset as soon as it is imported, and taking commands pushed on their control streams.",
    why: 'New build · back end.',
  },
  scilibs: {
    id: 'scilibs', code: 'C-07', name: 'Scientific libraries', role: 'numpy, scikit-learn', zone: 'third', valueAdd: false,
    does: 'numpy and scikit-learn: the numerical work inside the models (cleaning, means, change detection, correlation, clustering). Used by the models only.',
    why: 'Third-party libraries: off the shelf, openly maintained, not our code. The models call them; nothing else does.',
  },
  client: {
    id: 'client', code: 'C-08', name: 'Display client', role: 'self-configuring UI', zone: 'front', valueAdd: true,
    does: "The real system's screen: login, the Dataset selector, its own replay clock, views and Favourites.",
    why: 'New build · front end.',
  },
};

export const COMPONENT_IDS = Object.keys(COMPONENTS) as ComponentId[];

export const isComponentId = (id: unknown): id is ComponentId => typeof id === 'string' && id in COMPONENTS;

export const nameOf = (id: string) => COMPONENTS[id as ComponentId]?.name ?? id;

/** How a flow is carried (FR-65): HTTP, pushed, inside the server, a file read or a library call. */
export type Via = 'HTTP' | 'push' | 'HTTP · push' | 'inside the server' | 'file' | 'call';

/** SRD §3.1 (4.7): which letters cross each directed flow, and how each is carried (FR-65). */
export const FLOWS: { src: ComponentId; dst: ComponentId; letters: string[]; via: Via }[] = [
  { src: 'importer', dst: 'folder', letters: ['S'], via: 'file' },
  { src: 'folder', dst: 'importer', letters: ['L'], via: 'file' },
  { src: 'importer', dst: 'server', letters: ['I'], via: 'inside the server' },
  { src: 'server', dst: 'importer', letters: ['K'], via: 'push' },
  { src: 'client', dst: 'server', letters: ['Q', 'K'], via: 'HTTP' },
  { src: 'server', dst: 'client', letters: ['D', 'P', 'O', 'H'], via: 'HTTP' },
  { src: 'server', dst: 'models', letters: ['D', 'O', 'H', 'K'], via: 'HTTP · push' },
  { src: 'models', dst: 'server', letters: ['Q', 'O', 'I'], via: 'HTTP' },
  { src: 'models', dst: 'scilibs', letters: ['I'], via: 'call' },
  { src: 'scilibs', dst: 'models', letters: ['I'], via: 'call' },
];
