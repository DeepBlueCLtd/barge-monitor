// The CSV importer (C-03; docs/v4-interfaces.md §7, FR-20 to FR-22): a module
// of the data server, the only code that understands the CSV files. It runs
// inside the server under its service account: it registers its system with a
// `catalogue` datastream and an `import` control stream, subscribes to that
// stream, lists the folder at every server start, and imports a file in bulk
// into its own datastreams (FR-21, FR-21b), writing CO₂ only into the CO₂
// analysers' datastreams (FR-21c). Its traffic is captured where §2 says:
// importer ↔ folder (S, L), importer → server (I), server → importer (K, push).
import type { Account } from './accounts';
import { BULK_ROWS, PREFIX, SENSORS, SOSA, UID } from './constants';
import { datasetId, parseCsv, Parsed } from './csv';
import { CO2, qcFlags, WEATHER } from './fields';
import type { Folder, FolderEntry } from './folder';
import type { Server } from './server';
import type { ControlstreamRec, DatastreamRec } from './store';
import { LineReader } from './stream';
import { Component, DataRecord, M, qcField, record, timeField, component } from './swe';
import type { Tap } from './tap';
import { iso, parseIso, realNow } from './time';

export type FileStatus = 'not-imported' | 'importing' | 'imported' | 'changed' | 'superseded';

export interface FileState {
  file: string;
  size: number;
  modified: string;
  sha256: string;
  status: FileStatus;
  dataset: string;
  pct: number;
  start?: number;
  end?: number;
  records?: number;
}

export interface DatasetInfo {
  id: string;
  file: string;
  size: number;
  modified: string;
  sha256: string;
  start: number;
  end: number;
  records: number;
  superseded: boolean;
  fields: Record<string, string[]>; // sensor -> weather fields present
}

export interface ImporterHost {
  tap: Tap;
  folder: Folder;
  account(): Account;
  thawed(): Promise<void>;
  /** The replay time now, for nothing but capture. */
}

export class Importer {
  files = new Map<string, FileState>();
  datasets = new Map<string, DatasetInfo>();
  importing: string | null = null;
  /** Rows per second of the last import (FR-110). */
  importRate: { rows: number; seconds: number; rows_per_s: number; file: string; silent: boolean } | null = null;
  ready = false;
  private server: Server | null = null;
  private catalogue: DatastreamRec | null = null;
  private control: ControlstreamRec | null = null;
  private listed: FolderEntry[] = [];

  constructor(private readonly host: ImporterHost) {}

  private get tap(): Tap {
    return this.host.tap;
  }

  // --- at every server start (§7) ----------------------------------------------------------------
  async attach(server: Server, quiet = false): Promise<void> {
    this.server = server;
    this.ready = false;
    const a = this.host.account();
    const sys = server.createSystem(a, {
      uid: UID.importer, label: 'CSV importer', featureType: SOSA + 'System', assetType: 'Equipment', smlType: 'PhysicalSystem',
      description: 'Imports CSV recordings from the data folder in bulk, inside the server (FR-20a).',
    }, null).id;
    const cat = server.createDatastream(a, sys, {
      name: 'Archive catalogue', outputName: 'catalogue',
      schema: M.record('Archive catalogue', [M.time('time', 'Observed'), M.text('file', 'File'), M.count('size', 'Size (bytes)'),
        M.time('modified', 'Modified'), M.text('sha256', 'Content hash (SHA-256)'), M.text('dataset', 'Dataset'),
        M.time('start', 'Start of the recording'), M.time('end', 'End of the recording'), M.count('records', 'Records'),
        M.category('status', 'Status', ['not-imported', 'importing', 'imported', 'changed', 'superseded']),
        M.count('pct', 'Percent imported', 0, 100)]),
    });
    this.catalogue = server.store.datastreams.get(cat.id)!;
    const cs = server.createControlstream(a, sys, {
      name: 'Import', inputName: 'import',
      schema: M.record('Import', [M.category('action', 'Action', ['import', 'rescan']), M.text('file', 'File (empty for rescan)')]),
    });
    this.control = server.store.controlstreams.get(cs.id)!;
    const stream = server.subscribe(a, this.control);
    const reader = new LineReader((line) => void this.onCommand(line));
    stream.attach({ chunk: (b) => reader.push(b), end: () => { /* the server stopped: attach() again at its next start */ } });
    this.tap.emit('importer', 'server', 'I', 'register: catalogue datastream, import control stream; subscribed',
      { system: UID.importer, datastreams: ['catalogue'], controlstreams: ['import'] }, { quiet });
    this.ready = true;
    await this.scan(true, quiet);
  }

  // --- listing the folder (FR-20c) ------------------------------------------------------------------
  async scan(all: boolean, quiet = false): Promise<void> {
    this.tap.emit('importer', 'folder', 'S', 'list', 'list', { quiet });
    const entries = await this.host.folder.list();
    this.listed = entries;
    this.tap.emit('folder', 'importer', 'L', `the listing: ${entries.length} files`,
      entries.map((e) => `${e.file}  ${e.size}  ${e.modified}`).join('\n'), { quiet });
    for (const e of entries) {
      const prev = this.files.get(e.file);
      const same = [...this.datasets.values()].find((d) => d.file === e.file && !d.superseded);
      let status: FileStatus;
      let dataset = '';
      if (prev?.status === 'importing') continue;
      if (same && same.sha256 === e.sha256 && same.size === e.size && same.modified === e.modified) {
        status = 'imported';
        dataset = same.id;
      } else if (same) {
        status = 'changed';
        dataset = same.id;
      } else status = 'not-imported';
      const st: FileState = { file: e.file, size: e.size, modified: e.modified, sha256: e.sha256, status, dataset, pct: status === 'not-imported' ? 0 : 100 };
      if (same) Object.assign(st, { start: same.start, end: same.end, records: same.records });
      const changed = !prev || prev.status !== st.status || prev.sha256 !== st.sha256 || prev.dataset !== st.dataset;
      this.files.set(e.file, st);
      if (all || changed) this.publish(st, quiet);
    }
  }

  /** One catalogue observation (§7): the latest per file is its current status. */
  private publish(st: FileState, quiet: boolean): void {
    if (!this.catalogue) return;
    const row = {
      file: st.file, size: st.size, modified: parseIso(st.modified), sha256: st.sha256, dataset: st.dataset,
      start: st.start ?? NaN, end: st.end ?? NaN, records: st.records ?? NaN, status: st.status, pct: st.pct,
    };
    this.catalogue.series.appendRow(realNow(), row);
    this.tap.emit('importer', 'server', 'I', `catalogue: ${st.file} ${st.status}${st.status === 'importing' ? ` ${st.pct}%` : ''}`,
      { ...row, modified: st.modified, start: st.start ? iso(st.start) : null, end: st.end ? iso(st.end) : null }, { quiet });
  }

  // --- commands (§7) ------------------------------------------------------------------------------------
  private async onCommand(line: string): Promise<void> {
    let cmd: { id: string; parameters: Record<string, unknown> };
    try {
      cmd = JSON.parse(line);
    } catch {
      return;
    }
    const p = cmd.parameters ?? {};
    const action = String(p.action ?? '');
    const file = String(p.file ?? '');
    if (action === 'rescan') {
      this.status(cmd.id, 'ACCEPTED');
      try {
        await this.scan(false);
        this.status(cmd.id, 'COMPLETED', `${this.listed.length} files listed`);
      } catch (e) {
        this.status(cmd.id, 'FAILED', String((e as Error)?.message ?? e));
      }
      return;
    }
    if (action !== 'import') return this.status(cmd.id, 'REJECTED', `action must be import or rescan, not ${action || 'empty'}`);
    const st = this.files.get(file);
    if (!st) return this.status(cmd.id, 'REJECTED', `unknown file ${file || '(none)'}: not in the data folder`);
    if (st.status === 'importing' || this.importing) {
      return this.status(cmd.id, 'REJECTED', `${this.importing ?? file} is already importing`);
    }
    if (st.status === 'imported') {
      this.status(cmd.id, 'ACCEPTED');
      return this.status(cmd.id, 'COMPLETED', `${file} is already imported as ${st.dataset}`);
    }
    this.status(cmd.id, 'ACCEPTED');
    try {
      const ds = await this.importFile(file, false, (pct) => this.status(cmd.id, 'EXECUTING', `${pct}%`));
      this.status(cmd.id, 'COMPLETED', `imported as ${ds}`);
    } catch (e) {
      this.status(cmd.id, 'FAILED', String((e as Error)?.message ?? e));
    }
  }

  private status(cmdId: string, code: string, message = ''): void {
    const s = this.server;
    if (!s || s.stopped || !this.control) return;
    try {
      s.reportStatus(this.control, { 'command@id': cmdId, statusCode: code, message });
      this.tap.emit('importer', 'server', 'I', `command status: ${code}${message ? ` (${message})` : ''}`, { 'command@id': cmdId, statusCode: code, message });
    } catch { /* the command has gone with a reset */ }
  }

  // --- importing a file in bulk (§7, FR-21) -------------------------------------------------------
  async importFile(file: string, quiet: boolean, onPct?: (pct: number) => void): Promise<string> {
    const server = this.server;
    if (!server) throw new Error('the server is not running');
    const entry = this.listed.find((e) => e.file === file);
    const st = this.files.get(file);
    if (!entry || !st) throw new Error(`unknown file ${file}`);
    const t0 = performance.now();
    this.importing = file;
    st.status = 'importing';
    st.pct = 0;
    this.publish(st, quiet);
    try {
      this.tap.emit('importer', 'folder', 'S', `read ${file}`, `read ${file}`, { quiet });
      const bytes = await this.host.folder.read(file);
      const parsed = parseCsv(bytes);
      const n = parsed.t.length;
      this.tap.emit('folder', 'importer', 'L', `${file}: ${n} rows`,
        [...parsed.comments, parsed.header, ...parsed.firstRows, `… ${n} rows in all`].join('\n'), { quiet });
      if (!n) throw new Error(`${file} has no rows`);
      const id = datasetId(file, entry.sha256);
      const a = this.host.account();
      // QC flags on import (FR-32), and the dataset's datastreams under the sensors and CO₂ analysers (FR-25).
      const targets: { ds: DatastreamRec; cols: Record<string, Float64Array> }[] = [];
      const fields: Record<string, string[]> = {};
      for (const s of SENSORS) {
        const present = WEATHER.filter((f) => parsed.values.has(`${s}:${f.name}`));
        fields[s] = present.map((f) => f.name);
        if (present.length) {
          const sys = server.store.systemByUid(UID.sensor(s))!;
          const comps: Component[] = [timeField()];
          const cols: Record<string, Float64Array> = {};
          for (const f of present) {
            comps.push(component(f, true), qcField(f));
            const v = parsed.values.get(`${s}:${f.name}`)!;
            cols[f.name] = v;
            cols[`${f.name}_qc`] = qcFlags(f.name, v, parsed.variable.get(`${s}:${f.name}`) ?? null);
          }
          const label = `${s === 'bow' ? 'Bow' : 'Stern'} weather record, ${id}`;
          const r = server.createDatastream(a, sys.id, { name: label, outputName: `weather__${id}`, schema: record(comps, label) as DataRecord });
          targets.push({ ds: server.store.datastreams.get(r.id)!, cols });
        }
        const co2 = parsed.values.get(`${s}:co2`);
        if (co2) {
          const sys = server.store.systemByUid(UID.co2(s))!;
          const label = `${s === 'bow' ? 'Bow' : 'Stern'} CO₂, ${id}`;
          const r = server.createDatastream(a, sys.id, {
            name: label, outputName: `co2__${id}`, schema: record([timeField(), component(CO2, true), qcField(CO2)], label) as DataRecord,
          });
          targets.push({ ds: server.store.datastreams.get(r.id)!, cols: { co2, co2_qc: qcFlags('co2', co2) } });
        }
      }
      // The bulk write: one captured I message per 1,000 rows (FR-67).
      if (targets.some((x) => x.ds.series.length)) throw new Error(`${id} already holds observations`);
      let lastPct = 0;
      for (let i0 = 0; i0 < n; i0 += BULK_ROWS) {
        const i1 = Math.min(n, i0 + BULK_ROWS);
        const t = parsed.t.subarray(i0, i1);
        for (const x of targets) {
          const chunk: Record<string, unknown> = { t };
          for (const [k, v] of Object.entries(x.cols)) chunk[k] = v.subarray(i0, i1);
          x.ds.series.append(chunk);
        }
        this.tap.emit('importer', 'server', 'I', `bulk write ${id}: rows written ${i1}/${n}`,
          { dataset: id, datastreams: targets.map((x) => `${x.ds.outputName} (${server.store.systems.get(x.ds.system)?.label})`), rows: [i0 + 1, i1], of: n }, { quiet });
        const pct = Math.floor((100 * i1) / n / 10) * 10;
        if (pct > lastPct && pct < 100) {
          lastPct = pct;
          st.pct = pct;
          this.publish(st, quiet);
          onPct?.(pct);
          await this.host.thawed();
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      // An earlier import of the same file name is superseded (FR-21a); it stays and stays openable.
      for (const d of this.datasets.values()) {
        if (d.file === file && !d.superseded) {
          d.superseded = true;
          this.publish({ file, size: d.size, modified: d.modified, sha256: d.sha256, status: 'superseded', dataset: d.id, pct: 100,
            start: d.start, end: d.end, records: d.records }, quiet);
        }
      }
      const start = parsed.t[0];
      const end = parsed.t[n - 1];
      this.datasets.set(id, { id, file, size: entry.size, modified: entry.modified, sha256: entry.sha256, start, end, records: n, superseded: false, fields });
      Object.assign(st, { status: 'imported', dataset: id, pct: 100, start, end, records: n });
      this.publish(st, quiet);
      const seconds = (performance.now() - t0) / 1000;
      this.importRate = { rows: n, seconds, rows_per_s: Math.round(n / Math.max(seconds, 1e-3)), file, silent: quiet };
      return id;
    } catch (e) {
      const same = [...this.datasets.values()].find((d) => d.file === file && !d.superseded);
      Object.assign(st, { status: same ? 'changed' : 'not-imported', pct: 0 });
      this.publish(st, quiet);
      throw e;
    } finally {
      this.importing = null;
    }
  }
}

export type { Parsed };
export { PREFIX };
