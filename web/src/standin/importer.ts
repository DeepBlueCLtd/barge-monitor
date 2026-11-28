// The CSV importer (FR-20 to FR-22, FR-109, FR-110; docs/v4-interfaces.md §7; importer.py, the
// reference). A module of the data server: it runs inside the server under its own service account
// (`svc-importer`) and writes in bulk into the server's store (FR-20a). It is the only code that
// understands the CSV files, through its parser (csv.ts; a port).
//
// At each server start it registers `urn:x-barge:importer` with the `catalogue` datastream and the
// `import` control stream and lists the folder; once the server answers, it subscribes on the
// internal endpoint, like any receiver, and validates each pushed command. An import parses the
// file, computes the QC flags (qc.ts), creates the dataset's datastreams under the sensors and the
// CO₂ analysers (CO₂ never in the weather record, FR-21c) and writes every row. A changed file is a
// new dataset; the earlier one is superseded and kept (FR-21a). Overlapping files stay apart (FR-21b).
//
// Capture (§2): importer ↔ folder (S, L), importer → server (I: one per 1,000 rows, and each
// catalogue observation), server → importer (K, push). Registering and listing at a server start,
// and the silent import of Mission A (FR-15), are counted, not drawn.
import catalogueJson from '../../../contracts/swe/catalogue-record.json';
import co2Json from '../../../contracts/swe/co2-record.json';
import importJson from '../../../contracts/swe/controlstreams/import.json';
import weatherJson from '../../../contracts/swe/weather-record.json';
import { basic, SERVICE_PASSWORD } from './accounts';
import type { HttpRequest, HttpResponse } from './api';
import { BULK_ROWS, SENSORS, SIM_EPOCH_UNIX, URN } from './constants';
import { datasetId, parseCsv, Parsed } from './csv';
import { QUANTITIES } from './fields';
import type { Folder, FolderEntry } from './folder';
import type { Gate } from './gate';
import { qcFlags } from './qc';
import type { ControlstreamRec, DatastreamRec, Store, SystemRec } from './resources';
import { LineReader } from './stream';
import type { DataRecord } from './swe';
import type { Tap } from './tap';
import { iso, parseIso } from './time';

export const IMPORTER_UID = URN + 'importer';
const ACCOUNT = 'svc-importer';
const SILENT_PREFIX = 'MISSION_A_';
export type FileStatus = 'not-imported' | 'importing' | 'imported' | 'changed' | 'superseded';

export interface DatasetInfo {
  id: string;
  file: string;
  size: number;
  modified: string;
  sha256: string;
  start: number; // simulated seconds, as the store keeps times
  end: number;
  records: number;
  superseded: boolean;
  fields: Record<string, string[]>;
}

export interface FileState {
  file: string;
  size: number;
  modified: string;
  status: FileStatus;
  dataset: string;
  pct: number;
}

export interface ImportRate {
  file: string;
  rows: number;
  seconds: number;
  rows_per_s: number;
  silent: boolean;
}

/** What the importer needs of the running back end. */
export interface ImporterRuntime {
  store: Store;
  tap: Tap;
  real(): number;
  commandStatus(cmdId: string, code: string, message?: string): unknown;
  handle(req: HttpRequest): Promise<HttpResponse | null>;
  /** The demonstrator's system hold (D-362): the importer stops at its next step while it is held. */
  gate: Gate;
}

/** A SWE Common master from contracts/swe, without its description (importer.master). */
function master(rec: unknown): DataRecord {
  const { description: _d, ...rest } = rec as DataRecord & { description?: string };
  return JSON.parse(JSON.stringify(rest)) as DataRecord;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The weather record master with the fields this file has (FR-21: a missing column is absent). */
function weatherSchema(names: string[], sensor: string): DataRecord {
  const rec = master(weatherJson);
  const keep = new Set(['time', ...names, ...names.map((n) => `${n}_qc`)]);
  return { ...rec, label: `${cap(sensor)} weather record`, fields: rec.fields.filter((f) => keep.has(f.name)) };
}

type Cols = Record<string, Float64Array | string[]>;

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class Importer {
  rate: ImportRate | null = null;
  datasets = new Map<string, DatasetInfo>();
  listing: FolderEntry[] = [];
  current = new Map<string, FileState>();
  subscribed = false;
  system: SystemRec | null = null;
  catalogue: DatastreamRec | null = null;
  cs: ControlstreamRec | null = null;
  private published = new Map<string, FileStatus>();
  private importing = new Set<string>();
  private generation = 0;
  private listener: object | null = null;

  constructor(private readonly rt: ImporterRuntime, readonly folder: Folder, private readonly parse: (b: Uint8Array) => Parsed = parseCsv) {}

  /** Forget everything imported: Reset instance deletes the whole store (FR-50a). */
  reset(): void {
    this.generation += 1;
    this.datasets = new Map();
    this.listing = [];
    this.current = new Map();
    this.published = new Map();
    this.importing = new Set();
    this.system = this.catalogue = this.cs = null;
    this.subscribed = false;
    this.listener = null;
  }

  private get tap(): Tap {
    return this.rt.tap;
  }

  // --- at each server start ----------------------------------------------------------------------
  /** Register inside the server, under the importer's service account, and list the folder (quiet). */
  async start(): Promise<void> {
    const st = this.rt.store;
    [this.system] = st.addSystem(IMPORTER_UID, 'CSV importer',
      'Lists the data folder and imports its CSV files in bulk, inside the server (a module of the data server, FR-20a).',
      'http://www.w3.org/ns/sosa/System', 'Equipment', null, ACCOUNT);
    [this.catalogue] = st.addDatastream(this.system.id, 'catalogue', 'Archive catalogue', master(catalogueJson), ACCOUNT);
    [this.cs] = st.addControlstream(this.system.id, 'import', 'Import a file', master(importJson), ACCOUNT);
    this.tap.emit('importer', 'server', 'I', 'register: catalogue datastream, import control stream',
      { system: IMPORTER_UID, datastreams: ['catalogue'], controlstreams: ['import'] }, { quiet: true });
    await this.rescan(true);
  }

  /** Mission A, imported silently before the server takes requests, once per page load (FR-15). */
  async silentImport(): Promise<void> {
    const entry = this.listing.find((f) => f.file.startsWith(SILENT_PREFIX));
    if (entry) await this.importFile(entry, true);
  }

  /**
   * Hold a push subscription to `import` on the internal endpoint (§9.2, D-223) until the server stops.
   * Made of the server's own request handling, with no network in between (FR-65). Resolves once the
   * subscription has opened (or was refused).
   */
  async listen(): Promise<void> {
    if (!this.cs) return;
    const me = (this.listener = {});
    const mark = (on: boolean) => {
      if (this.listener === me) this.subscribed = on;
    };
    const res = await this.rt.handle({
      method: 'GET', path: `/api-internal/controlstreams/${this.cs.id}/commands`, query: 'subscribe=1', body: null,
      headers: [['authorization', basic(ACCOUNT, SERVICE_PASSWORD)], ['x-tap-quiet', '1']], rootPath: '', origin: 'http://importer',
    });
    if (!res || res.status !== 200 || !res.stream) return mark(false);
    mark(true);
    const reader = new LineReader((line) => void this.onCommand(JSON.parse(line)));
    res.stream.attach({ chunk: (b) => reader.push(b), end: () => mark(false) });
  }

  // --- the folder (FR-20c) -------------------------------------------------------------------------
  async rescan(quiet = false): Promise<FolderEntry[]> {
    this.tap.emit('importer', 'folder', 'S', 'list', 'list the data folder', { quiet });
    this.listing = await this.folder.list();
    this.tap.emit('folder', 'importer', 'L', `listing: ${this.listing.length} files`,
      this.listing.map((f) => `${f.file}  ${f.size}  ${f.modified}`).join('\n'), { quiet });
    for (const f of this.listing) {
      if (this.importing.has(f.file)) continue;
      const ds = this.latestDataset(f.file);
      if (!ds) this.publish(f, 'not-imported', null, null, quiet);
      else if (Importer.same(ds, f)) this.publish(f, 'imported', ds, null, quiet);
      else this.publish(f, 'changed', ds, null, quiet);
    }
    return this.listing;
  }

  private static same(ds: { sha256: string; size: number; modified: string }, f: FolderEntry): boolean {
    return ds.sha256 === f.sha256 && ds.size === f.size && ds.modified === f.modified;
  }

  private latestDataset(file: string): DatasetInfo | null {
    const all = [...this.datasets.values()].reverse();
    return all.find((d) => d.file === file && !d.superseded) ?? null;
  }

  /** One catalogue observation (§7). `records` is 0 until the file is imported (D-197). */
  private publish(f: FolderEntry, status: FileStatus, ds: DatasetInfo | null, pct: number | null, quiet: boolean, force = false): void {
    const key = `${f.file}|${f.sha256}`;
    if (!force && this.published.get(key) === status) return;
    this.published.set(key, status);
    const named = ds !== null && (status === 'imported' || status === 'changed' || status === 'superseded');
    const row = {
      file: f.file, size: f.size, modified: parseIso(f.modified), sha256: f.sha256, dataset: named ? ds!.id : '',
      start: named ? ds!.start : NaN, end: named ? ds!.end : NaN, records: named ? ds!.records : 0, status,
      pct: pct ?? (named ? 100 : 0),
    };
    const now = this.rt.real() - SIM_EPOCH_UNIX; // the catalogue is stamped in real time
    this.rt.store.appendRow(this.catalogue!, now, row);
    if (status !== 'superseded') {
      this.current.set(f.file, { file: f.file, size: f.size, modified: f.modified, status, dataset: row.dataset, pct: row.pct });
    }
    const tail = pct !== null && status === 'importing' ? ` ${pct}%` : '';
    this.tap.emit('importer', 'server', 'I', `catalogue: ${f.file} ${status}${tail}`,
      { ...row, time: iso(now), modified: f.modified, start: named ? iso(row.start) : null, end: named ? iso(row.end) : null }, { quiet });
  }

  // --- commands (FR-27) ------------------------------------------------------------------------------
  private status(cid: string, code: string, message = ''): void {
    if (!this.rt.store.commands.has(cid)) return; // gone with Reset instance
    this.rt.commandStatus(cid, code, message);
    this.tap.emit('importer', 'server', 'I', `command status: ${code}${message ? ` (${message})` : ''}`,
      { 'command@id': cid, statusCode: code, message });
  }

  private async onCommand(cmd: { id: string; parameters?: Record<string, unknown> }): Promise<void> {
    await this.rt.gate.wait();
    const p = cmd.parameters ?? {};
    const cid = cmd.id;
    const action = p.action;
    const file = String(p.file ?? '').trim();
    if (action === 'rescan') {
      this.status(cid, 'ACCEPTED');
      try {
        await this.rescan();
      } catch (e) {
        return this.status(cid, 'FAILED', `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`);
      }
      return this.status(cid, 'COMPLETED', `${this.listing.length} files listed`);
    }
    if (action !== 'import') return this.status(cid, 'REJECTED', `action '${String(action)}' is not import or rescan`);
    const entry = this.listing.find((f) => f.file === file);
    if (!entry) return this.status(cid, 'REJECTED', `unknown file '${file}': not in the data folder`);
    if (this.importing.has(file)) return this.status(cid, 'REJECTED', `${file} is already importing`);
    this.status(cid, 'ACCEPTED');
    let ds: DatasetInfo;
    try {
      ds = await this.importFile(entry, false, (pct) => this.status(cid, 'EXECUTING', `${pct}%`));
    } catch (e) {
      return this.status(cid, 'FAILED', `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`);
    }
    this.status(cid, 'COMPLETED', `imported as ${ds.id}`);
  }

  // --- an import (FR-21, FR-21a, FR-21c) ---------------------------------------------------------------
  async importFile(entry: FolderEntry, quiet = false, report?: (pct: number) => void): Promise<DatasetInfo> {
    const { tap } = this;
    const st = this.rt.store;
    const file = entry.file;
    const prior = this.latestDataset(file);
    if (prior && Importer.same(prior, entry)) {
      for (let pct = 10; pct <= 100; pct += 10) report?.(pct);
      return prior; // already imported, unchanged
    }
    const gen = this.generation;
    this.importing.add(file);
    try {
      const t0 = performance.now();
      this.publish(entry, 'importing', null, 0, quiet);
      tap.emit('importer', 'folder', 'S', `read ${file}`, `read ${file}`, { quiet });
      const parsed = this.parse(await this.folder.read(file));
      const n = parsed.t.length;
      tap.emit('folder', 'importer', 'L', `${file}: ${n} rows`, [...parsed.firstRows, `… ${n} rows in all`].join('\n'), { quiet });
      if (!n) throw new Error(`${file} has no rows`);
      const dsid = datasetId(file, entry.sha256);
      const t = Float64Array.from(parsed.t, (x) => x - SIM_EPOCH_UNIX);
      const outs = this.datastreams(dsid, parsed);
      if (outs.some(([d]) => d.series.length)) throw new Error(`${dsid} already holds observations`);
      let written = 0;
      for (let k = 0; k < 10; k++) {
        const a = Math.floor((k * n) / 10);
        const b = Math.floor(((k + 1) * n) / 10);
        await this.rt.gate.wait(); // held (D-362): the import stops here, and carries on from this block
        if (gen !== this.generation) throw new Error('the store was reset during the import');
        const tt = t.subarray(a, b);
        for (const [d, cols] of outs) {
          const chunk: Record<string, ArrayLike<unknown>> = {};
          for (const [name, v] of Object.entries(cols)) chunk[name] = v.slice(a, b);
          st.appendCols(d, tt, chunk);
        }
        while (written < b) { // one captured message per 1,000 rows (FR-67)
          const upto = Math.min(b, written + BULK_ROWS);
          tap.emit('importer', 'server', 'I', `bulk write ${dsid}: rows written ${upto}/${n}`,
            { dataset: dsid, rows: [written + 1, upto], of: n, datastreams: outs.map(([d]) => d.outputName) }, { quiet });
          written = upto;
        }
        const pct = (k + 1) * 10;
        report?.(pct);
        if (pct < 100) this.publish(entry, 'importing', null, pct, quiet, true);
        await yieldNow(); // the server keeps answering while it imports
      }
      const fields: Record<string, string[]> = {};
      for (const s of SENSORS) fields[s] = QUANTITIES.filter((f) => parsed.values.has(`${s}:${f}`));
      const ds: DatasetInfo = { id: dsid, file, size: entry.size, modified: entry.modified, sha256: entry.sha256,
        start: t[0], end: t[n - 1], records: n, superseded: false, fields };
      this.datasets.set(dsid, ds);
      if (prior) { // FR-21a: the earlier version is kept, and marked
        prior.superseded = true;
        this.publish({ file: prior.file, size: prior.size, modified: prior.modified, sha256: prior.sha256 }, 'superseded', prior, null, quiet);
      }
      this.publish(entry, 'imported', ds, null, quiet);
      const seconds = Math.max((performance.now() - t0) / 1000, 1e-6);
      this.rate = { file, rows: n, seconds: Math.round(seconds * 1000) / 1000, rows_per_s: Math.round(n / seconds), silent: quiet };
      return ds;
    } catch (e) {
      if (gen === this.generation && this.catalogue) {
        const again = this.latestDataset(file);
        this.publish(entry, again ? 'changed' : 'not-imported', again, null, quiet, true);
      }
      throw e;
    } finally {
      this.importing.delete(file);
    }
  }

  /** The dataset's datastreams and their columns (§6), in the order importer.py makes them (same identifiers). */
  private datastreams(dsid: string, p: Parsed): [DatastreamRec, Cols][] {
    const st = this.rt.store;
    const out: [DatastreamRec, Cols][] = [];
    for (const s of SENSORS) {
      const names = QUANTITIES.filter((f) => p.values.has(`${s}:${f}`));
      if (names.length) {
        const sys = st.systemByUid(`${URN}sensor:${s}`)!;
        const [d] = st.addDatastream(sys.id, `weather__${dsid}`, `${cap(s)} weather · ${dsid}`, weatherSchema(names, s), ACCOUNT);
        out.push([d, this.columns(p, s, names)]);
      }
      if (p.values.has(`${s}:co2`)) {
        const sys = st.systemByUid(`${URN}sensor:${s}:co2`)!;
        const [d] = st.addDatastream(sys.id, `co2__${dsid}`, `${cap(s)} CO₂ · ${dsid}`, { ...master(co2Json), label: `${cap(s)} CO₂ record` }, ACCOUNT);
        out.push([d, this.columns(p, s, ['co2'])]);
      }
    }
    return out;
  }

  /** Readings in declared units, and their QC flags, computed on import (FR-32). */
  private columns(p: Parsed, sensor: string, names: string[]): Cols {
    const cols: Cols = {};
    for (const f of names) {
      const v = p.values.get(`${sensor}:${f}`)!;
      cols[f] = v;
      cols[`${f}_qc`] = qcFlags(f, v, p.variable.get(`${sensor}:${f}`) ?? null);
    }
    return cols;
  }

  // --- for the shell (§13.4) -------------------------------------------------------------------------
  folderState(): FileState[] {
    return [...this.current.values()];
  }

  datasetsState() {
    return [...this.datasets.values()].map((d) => ({ id: d.id, file: d.file, start: iso(d.start), end: iso(d.end), records: d.records, superseded: d.superseded }));
  }
}

/** No data folder: the importer lists nothing. */
export const EMPTY_FOLDER: Folder = {
  async list() {
    return [];
  },
  async read(file: string) {
    throw new Error(`${file}: no data folder`);
  },
};
