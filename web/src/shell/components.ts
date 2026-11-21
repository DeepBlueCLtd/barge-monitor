// The eight components and their zones (SRD §3, docs/v4-interfaces.md §1),
// with the words the flowchart and the detail panel show for each.
import type { ZoneId } from './palette';

export type ComponentId = 'platform' | 'store' | 'adapter' | 'server' | 'models' | 'fastapi' | 'scilibs' | 'client';

export interface ComponentInfo {
  id: ComponentId;
  code: string;
  name: string;
  /** One-line role on the card (VS-12). */
  role: string;
  zone: ZoneId;
  /** Revealed as value-add on first click (FR-75). */
  valueAdd: boolean;
  /** FR-73: what it does. */
  does: string;
  /** FR-73: why it belongs to its zone. */
  why: string;
}

export const COMPONENTS: Record<ComponentId, ComponentInfo> = {
  platform: {
    id: 'platform', code: 'C-01', name: 'Collection platform', role: 'sim time', zone: 'world', valueAdd: false,
    does: 'The uncrewed electric barge, shuttling between two wharves day and night, with weather sensors at the bow and the stern. Each sensor reports seven parameters once per simulated second, written to the logger as fixed-width records. It records no position.',
    why: 'World: it stands in for the physical barge and its sensors. It is demonstrator scaffolding with a seeded, simulated canal and weather, and its manifest is the ground truth the models are scored against.',
  },
  store: {
    id: 'store', code: 'C-02', name: 'Logger store', role: 'append-only files', zone: 'legacy', valueAdd: false,
    does: 'The old data logger: fixed-width text records, bow and stern in separate files rolling over daily, time in its own unit and epoch, coded values, no index, records appended while being read. It keeps receiving records while the data server is down or restarting.',
    why: 'Legacy: it is the store we do not control and never alter. The architecture has to work in front of it as it is (claim C1).',
  },
  adapter: {
    id: 'adapter', code: 'C-03', name: 'Store adapter', role: 'only reader · holds the index', zone: 'back', valueAdd: false,
    does: "The only code that understands the logger's format. It holds its own index (time to file and offset), answers the data server's store queries (S), reads the records through the index (S to the store, L records back) and returns columns (I). The index is rebuilt from the store on every restart.",
    why: 'New build · back end: written for this system, and the one place that would change if the store did (AT-03).',
  },
  server: {
    id: 'server', code: 'C-04', name: 'Data server', role: 'OGC Connected Systems', zone: 'back', valueAdd: false,
    does: 'OGC API – Connected Systems: discovery, systems, datastreams, observations, control streams and commands.',
    why: 'New build · back end: a standard interface over the awkward store.',
  },
  models: {
    id: 'models', code: 'C-05', name: 'Models', role: 'process systems', zone: 'back', valueAdd: true,
    does: 'Core models and empty slots, each an OGC process system in its own worker.',
    why: 'New build · back end.',
  },
  fastapi: {
    id: 'fastapi', code: 'C-06', name: 'FastAPI', role: 'ASGI web framework', zone: 'third', valueAdd: false,
    does: "FastAPI with Starlette: the ASGI framework for the data server's HTTP interface. It routes each request, validates its parameters and serves the OpenAPI definition. The committed OpenAPI master is the source of truth; a test asserts that FastAPI serves the same.",
    why: 'Third-party libraries: off-the-shelf, openly maintained, not our code. The data server is written against it; the display client only ever sees HTTP.',
  },
  scilibs: {
    id: 'scilibs', code: 'C-07', name: 'Scientific libraries', role: 'numpy, scipy, sklearn', zone: 'third', valueAdd: false,
    does: 'numpy, pandas, scipy and scikit-learn: the numerical work inside the models (cleaning, means, change detection, correlation, clustering). Used by the models only.',
    why: 'Third-party libraries: off-the-shelf, openly maintained, not our code. The models call them; nothing else does.',
  },
  client: {
    id: 'client', code: 'C-08', name: 'Display client', role: 'self-configuring UI', zone: 'front', valueAdd: true,
    does: "The real system's screen: handshake, self-configuration, graphs and clusters.",
    why: 'New build · front end.',
  },
};

export const COMPONENT_IDS = Object.keys(COMPONENTS) as ComponentId[];

export const nameOf = (id: string) => COMPONENTS[id as ComponentId]?.name ?? id;

/** SRD §3.1: which letters cross each directed flow. */
export const FLOWS: { src: ComponentId; dst: ComponentId; letters: string[] }[] = [
  { src: 'platform', dst: 'store', letters: ['L'] },
  { src: 'adapter', dst: 'store', letters: ['S'] },
  { src: 'store', dst: 'adapter', letters: ['L'] },
  { src: 'server', dst: 'adapter', letters: ['S'] },
  { src: 'adapter', dst: 'server', letters: ['I'] },
  { src: 'models', dst: 'fastapi', letters: ['Q', 'O', 'I'] },
  { src: 'fastapi', dst: 'models', letters: ['D', 'O', 'H', 'I'] },
  { src: 'models', dst: 'scilibs', letters: ['I'] },
  { src: 'scilibs', dst: 'models', letters: ['I'] },
  { src: 'fastapi', dst: 'server', letters: ['I'] },
  { src: 'server', dst: 'fastapi', letters: ['I'] },
  { src: 'client', dst: 'fastapi', letters: ['Q', 'K'] },
  { src: 'fastapi', dst: 'client', letters: ['D', 'P', 'O', 'H'] },
];
