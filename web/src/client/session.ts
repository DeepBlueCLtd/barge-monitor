// The display client's state (SRD §8, docs/v4-interfaces.md §8 and §11): login and lock
// (FR-97 to FR-102), the handshake (FR-42 to FR-48), the Dataset selector (FR-103), its
// own replay clock (§8.6), live data up to the replay time (FR-63), the field list and
// degraded mode per dataset (FR-43, FR-45), "results being prepared" (FR-35b), clustering
// (FR-35a, FR-55) and data of interest, shown as Favourites (FR-104 to FR-108).
//
// It knows the data server only through discovery: no identifier, field or source is
// written into it, and nothing in it depends on who is logged in. A source the server
// refuses (403) is simply left out (FR-118, D-225).
//
// Nothing sensitive is kept in the browser (FR-100): the credentials live in the
// ClientHttp object, in memory, and every list and value is dropped on lock.
import { IDLE_LOCK_MS, POLL_MS } from '../config';
import { Store } from '../shell/store';
import { ReplayClock } from './clock';
import {
  controlFields, Discovery, DatastreamInfo, essentialLabel, fetchSchemas, findControlStreamByInput, findDatastream, handshake, readable, systemByUid,
} from './discovery';
import { buildView, datasetDatastreams, DatasetView, essentialFor, outputOf, Property, RES_SECONDS, Resolution, RESOLUTIONS, Source, sourceAt } from './fields';
import { Closed, ClientHttp, commandOutcomes, HttpError, NetworkFailure, StatusReport, Unauthorized } from './http';
import { iso, parseIso, PeriodId, periodOf, readableUntil, statsRes, windowOf } from './plan';

export type Phase = 'login' | 'handshake' | 'ready' | 'unreachable' | 'rejected' | 'locked';

export type Value = number | string | boolean | null;
export interface Row {
  t: number;
  [k: string]: Value;
}

/** Catalogue statuses whose `records` is a real count (D-197): `not-imported` and `importing` carry 0. */
const COUNTED = new Set(['imported', 'changed', 'superseded']);
/** Statuses whose dataset can be opened (FR-21a: a superseded dataset still opens). */
const OPENABLE = new Set(['imported', 'superseded']);

export interface CatalogueEntry {
  file: string;
  size: number;
  modified: string;
  sha256: string;
  dataset: string;
  start: number | null;
  end: number | null;
  records: number | null;
  status: string;
  pct: number | null;
}

export interface Notice {
  id: number;
  bad: boolean;
  text: string;
}

export interface Selection {
  fields: string[];
  period: PeriodId;
}

/** A data of interest record (FR-94; contracts/schemas/data-of-interest.json). */
export interface DoiRecord {
  version: 1;
  label: string;
  note?: string;
  dataset: { file: string; size: number; modified: string; sha256: string };
  start: string;
  end: string;
  resolution: string;
  aggregation: 'as-stored' | 'mean' | 'min' | 'max';
  sources: { system: string; output: string; fields: string[] }[];
  run?: string;
  created: { at: string; by: string };
}

export interface DoiItem {
  id: string;
  record: DoiRecord;
  /** FR-96, FR-96a: why it cannot be opened now, or null. */
  greyed: string | null;
}

export interface DoiSeries {
  label: string;
  uom: string | null;
  type: string;
  rows: { t: number; v: number | string | null }[];
}

export interface Opened {
  kind: 'open' | 'compare';
  title: string;
  /** Per record: its label, dataset, span and series; on elapsed time when comparing (FR-107). */
  records: { item: DoiItem; start: number; res: Resolution; series: DoiSeries[] }[];
  /** The resolution compared at: the coarser of the two (FR-107). */
  res?: Resolution;
  checksum: string;
}

export interface AnalysisResult {
  runId: string;
  algorithm: string;
  start: number;
  end: number;
  clusters: Row[];
  changes: Row[];
}

/** One model's progress on the current dataset, from its runs log (FR-35b). */
export interface RunLog {
  ds: DatastreamInfo;
  /** The label of the system that publishes it. */
  label: string;
  /** Each run's latest entry. */
  runs: Map<string, Row>;
  /** The latest entry of all. */
  latest: Row | null;
}

/** The current data window, as the Favourites popup shows it and saves it (FR-104). */
export interface DataWindow {
  file: string;
  start: number;
  end: number;
  resolution: Resolution;
  fields: string[];
  run: string | null;
}

/** The analyst's place, kept while locked so unlocking restores it (FR-99). Nothing of it is stored in the browser. */
interface Place {
  user: string;
  dataset: string | null;
  time: number | null;
  rate: number;
  selection: Selection;
}

const DEFAULT_SELECTION: Selection = { fields: [], period: '1h' };
const SWE = 'application/swe+json';
/** The workspace's datastream of data of interest (interfaces §11). */
const DOI_OUTPUT = 'data-of-interest';
const STATUS_WATCH_S = 12;
/** While results are being prepared or an action's effect is awaited, the client looks this often (D-304). */
const WATCH_EVERY_MS = 2000;

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && v !== 'NaN' ? Number(v) : null);

/** A SWE JSON record to a row: times to Unix seconds, "NaN" to NaN (FR-26). */
function toRow(o: Record<string, unknown>): Row {
  const r: Row = { t: parseIso(String(o.time)) };
  for (const [k, v] of Object.entries(o)) {
    if (k === 'time') continue;
    r[k] = v === 'NaN' ? NaN : (v as Value);
  }
  return r;
}

export const runNumber = (run: Value | undefined) => {
  const m = /(\d+)$/.exec(String(run ?? ''));
  return m ? Number(m[1]) : 0;
};

/** A short, stable digest of what a view draws, so that a regenerated record can be compared with the original (AT-45). */
export function digest(series: DoiSeries[]): string {
  let h = 2166136261;
  const text = series.map((s) => `${s.label}:${s.rows.map((r) => `${r.t}=${typeof r.v === 'number' ? r.v.toFixed(6) : r.v}`).join(',')}`).join('|');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

interface Cache {
  rows: Row[];
  /** The window start the rows were read from, and the phenomenon time read up to. */
  from: number;
  to: number;
  /** The run the rows belong to, for a model's results. */
  run: string | null;
}

let noticeSeq = 0;

export class DisplayClientSession {
  phase = new Store<Phase>('login');
  user = new Store<string | null>(null);
  loginError = new Store<string | null>(null);
  discovery = new Store<Discovery | null>(null);
  catalogue = new Store<CatalogueEntry[]>([]);
  /** The client's own replay clock (§8.6). */
  readonly clock = new ReplayClock();
  /** The current dataset's fields and problems (FR-43, FR-45); null while none is open. */
  view = new Store<DatasetView | null>(null);
  selection = new Store<Selection>(DEFAULT_SELECTION);
  /** Bumped whenever data arrives, so the views redraw. */
  data = new Store(0);
  analysis = new Store<AnalysisResult | null>(null);
  /** The current dataset's runs logs, as last read (FR-35b). */
  runs = new Store<RunLog[]>([]);
  notices = new Store<Notice[]>([]);
  /** A file being imported, with its progress (FR-103): shown on the Dataset selector button. */
  importing = new Store<{ file: string; pct: number } | null>(null);
  /** A dataset asked for and not yet open. */
  opening = new Store<string | null>(null);
  dois = new Store<DoiItem[]>([]);
  opened = new Store<Opened | null>(null);
  /** The data shown may be out of date: the server stopped answering (AT-11). */
  stale = new Store(false);
  /** The latest observation request for the selection: the message strip follows its chain (FR-70). */
  lastRead = new Store<{ chain: string; outputName: string } | null>(null);
  /** How long without input before locking (FR-99). */
  idleMs = IDLE_LOCK_MS;
  lastInput = Date.now();

  http: ClientHttp | null = null;
  private place: Place | null = null;
  private cache = new Map<string, Cache>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Until then the client follows an action's effect, or results being prepared, even while paused (D-304). */
  private watchUntil = 0;
  private lastWatch = 0;
  private statusWatch: { cs: string; since: number; until: number }[] = [];
  private statusSeen = new Set<string>();
  private wantHandshake = false;
  /**
   * A dataset whose models' outputs, awaited at the handshake, have since appeared: discovery is repeated for it
   * (FR-44) while it is the open dataset. Opening another dataset first leaves it pending, and it is asked for
   * again if that dataset is opened again (D-352): it is not a handshake the other dataset needs (AT-44).
   */
  private handshakeFor: string | null = null;
  private lastHandshake = 0;
  private lastRetry = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const touch = () => {
        this.lastInput = Date.now();
      };
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) window.addEventListener(ev, touch, { passive: true, capture: true });
    }
    this.clock.onEnd = () => {
      this.notify('The replay reached the end of the dataset and paused.');
      void this.act(async (http) => {
        await this.readData(http, false);
        await this.readAnalysis(http, false);
      });
    };
  }

  // --- notices -------------------------------------------------------------------------------------------------
  notify(text: string, bad = false) {
    const n = { id: ++noticeSeq, bad, text };
    this.notices.set([...this.notices.value.slice(-3), n]);
    setTimeout(() => this.notices.set(this.notices.value.filter((x) => x.id !== n.id)), bad ? 20_000 : 8_000);
  }

  dismiss(id: number) {
    this.notices.set(this.notices.value.filter((x) => x.id !== id));
  }

  // --- login, lock and restart (FR-97 to FR-102, FR-46) -----------------------------------------------------
  async login(user: string, password: string): Promise<boolean> {
    this.stop();
    this.loginError.set(null);
    const http = new ClientHttp(user, password);
    this.http = http;
    this.lastInput = Date.now();
    const place = this.place && this.place.user === user ? this.place : null;
    this.user.set(user);
    const ok = await this.connect(true);
    if (!ok) {
      if (this.http !== http || http.closed) this.user.set(place ? place.user : null);
      return false;
    }
    this.place = null;
    if (place) this.selection.set(place.selection);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    // After login: the place restored, else the default dataset, open and paused (interfaces §8; FR-85).
    const entry = place?.dataset ? this.catalogue.value.find((e) => e.dataset === place.dataset) : this.defaultEntry();
    if (entry && this.live(http)) await this.openDataset(http, entry.dataset, place?.dataset === entry.dataset ? place.time : null);
    if (place) this.clock.setRate(place.rate);
    return true;
  }

  /** The dataset opened after login: the first file of the catalogue that is imported. */
  private defaultEntry(): CatalogueEntry | undefined {
    return this.catalogue.value.find((e) => e.status === 'imported' && e.dataset);
  }

  /** FR-99: blank everything, discard the credentials, stop every request. Unlocking needs the password, and restores the place. */
  lock() {
    if (this.phase.value === 'login' || this.phase.value === 'locked') return;
    const user = this.user.value;
    const s = this.clock.state.value;
    this.place = user ? { user, dataset: s?.dataset ?? null, time: s ? this.clock.now() : null, rate: s?.rate ?? 1, selection: this.selection.value } : null;
    this.stop();
    this.blank();
    this.phase.set('locked');
  }

  /** FR-46: discard everything, credentials included, and return to the login screen. */
  restart() {
    this.place = null;
    this.stop();
    this.blank();
    this.user.set(null);
    this.loginError.set(null);
    this.selection.set(DEFAULT_SELECTION);
    this.phase.set('login');
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.http?.close();
    this.http = null;
    this.busy = false;
  }

  private blank() {
    this.clock.close();
    this.discovery.set(null);
    this.catalogue.set([]);
    this.view.set(null);
    this.cache.clear();
    this.analysis.set(null);
    this.runs.set([]);
    this.notices.set([]);
    this.importing.set(null);
    this.opening.set(null);
    this.dois.set([]);
    this.opened.set(null);
    this.stale.set(false);
    this.lastRead.set(null);
    this.statusWatch = [];
    this.watchUntil = 0;
    this.data.set(this.data.value + 1);
  }

  private live(http: ClientHttp | null): http is ClientHttp {
    return !!http && http === this.http && !http.closed;
  }

  /** Run a viewer's action: its requests' messages wear the gold ring on the flowchart. */
  private async act<T>(fn: (http: ClientHttp) => Promise<T>): Promise<T | undefined> {
    const http = this.http;
    if (!this.live(http)) return undefined;
    http.userAction = true;
    try {
      return await fn(http);
    } catch (e) {
      this.failed(e);
      return undefined;
    } finally {
      http.userAction = false;
    }
  }

  /** What a failed request means for the client. */
  private failed(e: unknown) {
    if (e instanceof Closed) return;
    if (e instanceof Unauthorized) {
      if (this.phase.value === 'login' || this.phase.value === 'locked') return;
      // The credentials no longer work: back to the login screen, saying only that (FR-101).
      this.restart();
      this.loginError.set('Please log in again.');
      return;
    }
    if (e instanceof NetworkFailure) {
      if (this.phase.value === 'ready' || this.phase.value === 'handshake') {
        this.phase.set('unreachable');
        this.stale.set(true);
      }
      return;
    }
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) {
      // Something in use is no longer there, or no longer readable, for this user: discover again (FR-48, FR-116).
      this.wantHandshake = true;
      return;
    }
    console.warn(e);
  }

  // --- the handshake (FR-42 to FR-48) -----------------------------------------------------------------------
  /** A full handshake, then the catalogue and the data of interest; the current dataset is rebuilt. */
  async connect(first = false): Promise<boolean> {
    const http = this.http;
    if (!this.live(http)) return false;
    this.phase.set('handshake');
    this.lastHandshake = Date.now();
    this.wantHandshake = false;
    this.handshakeFor = null;
    let d: Discovery;
    try {
      d = await handshake(http);
    } catch (e) {
      if (e instanceof Unauthorized) {
        if (first) {
          // FR-101: say only that the name or password was wrong, never which.
          this.stop();
          this.phase.set(this.place ? 'locked' : 'login');
          this.loginError.set('The name or password is wrong.');
          return false;
        }
        this.failed(e);
        return false;
      }
      if (e instanceof Closed) return false;
      this.phase.set('unreachable');
      this.stale.set(true);
      return first;
    }
    if (!this.live(http)) return false;
    this.discovery.set(d);
    if (d.rejected) {
      this.phase.set('rejected');
      this.stale.set(false);
      return true;
    }
    try {
      await this.readCatalogue(http);
      await this.markDatasets(http);
      await this.readDois(http);
      const s = this.clock.state.value;
      if (s) {
        // The current dataset may have gone (Reset instance): then none is open.
        if (this.catalogue.value.some((e) => e.dataset === s.dataset && OPENABLE.has(e.status))) await this.applyDataset(http, s.dataset);
        else this.closeDataset();
      }
    } catch (e) {
      this.failed(e);
      if (this.phase.value !== 'handshake') return this.phase.value !== 'login';
    }
    if (!this.live(http)) return false;
    this.stale.set(false);
    this.phase.set('ready');
    return true;
  }

  // --- the catalogue and the Dataset selector (FR-103) ------------------------------------------------------
  private catalogueDs(): DatastreamInfo | null {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('datasets') && x.kind !== 'controlstream');
    return d && e ? findDatastream(d, e.system, e.datastream) : null;
  }

  /** The importer's control stream: the one the profile names beside its catalogue. */
  private importCs() {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('datasets') && x.kind === 'controlstream');
    return d && e ? d.controlstreams.find((c) => c.systemUid === e.system && c.inputName === e.datastream) ?? null : null;
  }

  private async readCatalogue(http: ClientHttp) {
    const ds = this.catalogueDs();
    if (!ds) return;
    const rows: any[] = await http.get(`datastreams/${ds.id}/observations`, { f: SWE, limit: '100000' });
    if (!this.live(http)) return;
    // Append-only: the latest observation per file version is its status (interfaces §7).
    const byKey = new Map<string, CatalogueEntry>();
    for (const o of rows ?? []) {
      const e: CatalogueEntry = {
        file: o.file, size: Number(o.size), modified: o.modified, sha256: o.sha256, dataset: o.dataset ?? '',
        start: o.start && o.start !== 'NaN' ? parseIso(o.start) : null, end: o.end && o.end !== 'NaN' ? parseIso(o.end) : null,
        // records is 0 until the file is imported: a count only for a status that names a dataset (D-197).
        records: COUNTED.has(o.status) ? numberOrNull(o.records) : null, status: o.status, pct: numberOrNull(o.pct),
      };
      byKey.set(`${e.file}|${e.sha256}`, e);
    }
    this.catalogue.set([...byKey.values()].sort((a, b) => a.file.localeCompare(b.file) || a.modified.localeCompare(b.modified)));
  }

  /** Datasets marked degraded in the Dataset selector (FR-103): each dataset's per-dataset essentials of sensors. */
  degraded = new Store<Map<string, string>>(new Map());

  private async markDatasets(http: ClientHttp) {
    const d = this.discovery.value;
    if (!d) return;
    const out = new Map<string, string>();
    for (const e of this.catalogue.value) {
      if (!e.dataset || !OPENABLE.has(e.status)) continue;
      const own = (d.profile?.essentials ?? []).filter((x) => x.scope === 'dataset' && !systemByUid(d, x.system)?.assetType.includes('Process'));
      const list = own.map((x) => findDatastream(d, x.system, x.datastream.replace('{dataset}', e.dataset))).filter((x): x is DatastreamInfo => !!x);
      await fetchSchemas(http, d, list);
      const missing = own.filter((x) => {
        const ds = findDatastream(d, x.system, x.datastream.replace('{dataset}', e.dataset));
        return !ds || !d.schemas.get(ds.id)?.some((f) => f.name === x.field);
      });
      if (missing.length) out.set(e.dataset, missing.map(essentialLabel).join(', '));
    }
    this.degraded.set(out);
  }

  /** FR-103: open a file. An imported one becomes the current dataset at once; one not imported is imported first. */
  open(e: CatalogueEntry) {
    if (e.status === 'importing' || this.importing.value) return;
    if (e.dataset && OPENABLE.has(e.status)) {
      void this.act((http) => this.openDataset(http, e.dataset, null));
      return;
    }
    const cs = this.importCs();
    if (!cs) return;
    void this.act(async (http) => http.command(cs.id, { action: 'import', file: e.file }, undefined, (x) => this.commandFailed(x)));
    this.importing.set({ file: e.file, pct: 0 });
    this.watchStatus(cs.id);
    this.watch(600);
  }

  rescan() {
    const cs = this.importCs();
    if (!cs) return;
    void this.act(async (http) => http.command(cs.id, { action: 'rescan', file: '' }, undefined, (x) => this.commandFailed(x)));
    this.watchStatus(cs.id);
    this.watch(6);
  }

  /** An import in progress: its percentage from the catalogue; once imported, a full handshake, then open it (FR-44, AT-41). */
  private async followImport(http: ClientHttp) {
    const imp = this.importing.value;
    if (!imp) return;
    const e = this.catalogue.value.filter((x) => x.file === imp.file).pop();
    if (!e) return;
    if (e.status === 'importing') this.importing.set({ file: imp.file, pct: e.pct ?? 0 });
    else if (e.status === 'imported' && e.dataset) {
      this.importing.set(null);
      this.notify(`${e.file} imported.`);
      await this.connect();
      if (this.live(http)) await this.openDataset(http, e.dataset, null);
    }
  }

  private commandFailed(e: unknown) {
    if (e instanceof NetworkFailure) {
      this.notify('The server did not answer the command.', true);
      this.importing.set(null);
    }
    this.failed(e);
  }

  // --- the current dataset (FR-43, FR-45, FR-84) --------------------------------------------------------------
  /** Make a dataset current: its clock at its start (or the place restored), paused; its field list without a full handshake. */
  private async openDataset(http: ClientHttp, dataset: string, time: number | null) {
    const e = this.catalogue.value.find((x) => x.dataset === dataset);
    if (!e || e.start == null || e.end == null) return;
    this.opening.set(dataset);
    this.clock.open(dataset, e.start, e.end, time ?? e.start);
    this.opened.set(null);
    this.analysis.set(null);
    this.runs.set([]);
    this.cache.clear();
    await this.applyDataset(http, dataset);
  }

  private closeDataset() {
    this.clock.close();
    this.view.set(null);
    this.cache.clear();
    this.analysis.set(null);
    this.runs.set([]);
    this.data.set(this.data.value + 1);
  }

  /** The current dataset: its datastreams' schemas once, then its field list and essentials (FR-43, FR-45). */
  private async applyDataset(http: ClientHttp, dataset: string) {
    const d = this.discovery.value;
    if (!d) return;
    // A dataset discovery has not seen (imported since the handshake) needs the full handshake first (FR-44).
    if (!datasetDatastreams(d, dataset).length) {
      this.wantHandshake = true;
      this.watch(30);
      return;
    }
    await fetchSchemas(http, d, datasetDatastreams(d, dataset));
    if (!this.live(http)) return;
    await this.readRuns(http, buildView(d, dataset));
    const v = buildView(d, dataset, this.completeSystems());
    const keep = new Set(v.props.map((p) => p.key));
    const sel = this.selection.value;
    let fields = sel.fields.filter((k) => keep.has(k));
    if (!fields.length) fields = v.props.filter((p) => p.declared && p.byRes.PT1S).slice(0, 2).map((p) => p.key);
    this.view.set(v);
    this.opening.set(null);
    if (fields.join() !== sel.fields.join()) this.selection.set({ ...sel, fields });
    this.cache.clear();
    if (v.awaited.length || this.preparing().length) this.watch(600);
    await this.readData(http, true);
    await this.readAnalysis(http, true);
  }

  // --- results being prepared (FR-35b) ------------------------------------------------------------------------
  /** Read every runs log of the dataset (generically: the client does not know the models). */
  private async readRuns(http: ClientHttp, v: DatasetView | null = this.view.value) {
    const d = this.discovery.value;
    if (!d || !v) return;
    const out: RunLog[] = [];
    await Promise.all(v.runLogs.map(async (ds) => {
      const r = await http.request<any[]>('GET', `datastreams/${ds.id}/observations`, { f: SWE, limit: '100000' });
      if (r.status === 403 || r.status === 404) throw new HttpError(`runs of ${ds.outputName}`, r.status);
      if (r.status !== 200) return;
      const runs = new Map<string, Row>();
      let latest: Row | null = null;
      for (const o of r.body ?? []) {
        const row = toRow(o);
        runs.set(String(row.run_id), row);
        if (!latest || row.t >= latest.t) latest = row;
      }
      out.push({ ds, label: d.systems.get(ds.systemId)?.label ?? ds.systemUid, runs, latest });
    }));
    if (!this.live(http)) return;
    const before = this.completeRuns();
    this.runs.set(out.sort((a, b) => a.label.localeCompare(b.label)));
    const after = this.completeRuns();
    // A run in progress is followed to its end, playing or paused (D-304).
    if (this.preparing().length) this.watch(600);
    // A run newly complete: rows of an earlier run are no longer the ones shown (FR-35).
    if ([...after].some((x) => !before.has(x))) {
      this.cache.clear();
      this.reload = true;
      if (this.view.value) {
        const nv = buildView(d, v.id, this.completeSystems());
        // A model's output awaited at the handshake, and now complete: discover it (FR-44).
        if (v.awaited.some((e) => this.completeSystems().has(e.system))) this.handshakeFor = v.id;
        else this.view.set(nv);
      }
    }
  }

  /** Every run the client can see complete on the current dataset. */
  completeRuns(): Set<string> {
    const out = new Set<string>();
    for (const l of this.runs.value) for (const [id, r] of l.runs) if (r.status === 'complete') out.add(id);
    return out;
  }

  /** The systems (unique ids) with a complete run on the current dataset. */
  completeSystems(): Set<string> {
    const out = new Set<string>();
    for (const l of this.runs.value) if ([...l.runs.values()].some((r) => r.status === 'complete')) out.add(l.ds.systemUid);
    return out;
  }

  /** FR-35b: the models still preparing the current dataset, with how far each has got. */
  preparing(): { label: string; pct: number | null; system: string }[] {
    const out: { label: string; pct: number | null; system: string }[] = [];
    for (const l of this.runs.value) {
      if (l.latest?.status === 'processing') out.push({ label: l.label, pct: numberOrNull(l.latest.pct), system: l.ds.systemUid });
    }
    const d = this.discovery.value;
    for (const e of this.view.value?.awaited ?? []) {
      if (out.some((x) => x.system === e.system)) continue;
      out.push({ label: (d && systemByUid(d, e.system)?.label) ?? e.system, pct: null, system: e.system });
    }
    return out;
  }

  /** The systems whose per-dataset essentials for a view are still awaited (FR-35b). */
  awaitedSystems(view: string): string[] {
    return (this.view.value?.awaited ?? []).filter((e) => e.views?.includes(view)).map((e) => e.system);
  }

  /** The run a model's results are shown from: the latest complete run among those the rows carry (FR-35). */
  private chooseRun(rows: Row[]): string | null {
    const complete = this.completeRuns();
    let best: string | null = null;
    for (const r of rows) {
      const id = String(r.run_id ?? '');
      if (!id || (complete.size && !complete.has(id))) continue;
      if (!best || runNumber(id) > runNumber(best)) best = id;
    }
    return best;
  }

  // --- reading up to the replay time (FR-63, FR-63b) ----------------------------------------------------------
  /** The datastreams the views use now: each selected field at the period's resolution, and its summary for error bars. */
  inUse(): { prop: Property; src: Source; res: Resolution; use: 'line' | 'stats' }[] {
    const v = this.view.value;
    if (!v) return [];
    const sel = this.selection.value;
    const out: { prop: Property; src: Source; res: Resolution; use: 'line' | 'stats' }[] = [];
    for (const key of sel.fields) {
      const p = v.props.find((x) => x.key === key);
      if (!p) continue;
      const at = sourceAt(p, periodOf(sel.period).res);
      if (at) out.push({ prop: p, src: at.src, res: at.res, use: 'line' });
      const st = p.byRes[statsRes(sel.period)];
      if (st?.stats) out.push({ prop: p, src: st, res: statsRes(sel.period), use: 'stats' });
    }
    return out;
  }

  /** The current period's window, ending at the replay time. */
  window(): [number, number] | null {
    const s = this.clock.state.value;
    if (!s || !this.view.value) return null;
    return windowOf(this.selection.value.period, s.time, s.start);
  }

  /** Rows of a datastream within the window. */
  rows(src: Source): Row[] {
    const c = this.cache.get(src.ds.id);
    const w = this.window();
    if (!c || !w) return [];
    return c.rows.filter((r) => r.t >= w[0] && r.t <= w[1]);
  }

  /**
   * Read every datastream in use (FR-63): the whole window when `full`, otherwise from what was read before up to
   * the replay time. One request per datastream, every real second while playing, whatever the rate (AT-37); never
   * beyond the replay time (FR-63b).
   */
  private async readData(http: ClientHttp, full: boolean) {
    const s = this.clock.state.value;
    const w = this.window();
    if (!s || !w) return;
    const now = this.clock.now();
    const seen = new Set<string>();
    const tasks: Promise<void>[] = [];
    for (const u of this.inUse()) {
      const id = u.src.ds.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const until = Math.max(w[0], readableUntil(now, u.res));
      const c = this.cache.get(id);
      const fresh = full || !c || c.from > w[0] || c.to > until;
      const from = fresh ? w[0] : Math.min(until, c!.to + 1);
      tasks.push((async () => {
        const r = await http.request<any[]>('GET', `datastreams/${id}/observations`, { f: SWE, phenomenonTime: `${iso(from)}/${iso(until)}`, limit: '200000' });
        this.lastRead.set({ chain: r.chain, outputName: u.src.ds.outputName });
        if (r.status !== 200) throw new HttpError(`observations of ${u.src.ds.outputName}`, r.status);
        if (!this.live(http)) return;
        let rows = (r.body ?? []).map(toRow);
        let run: string | null = null;
        if (u.src.runs) {
          run = this.chooseRun(fresh ? rows : [...(c?.rows ?? []), ...rows]);
          rows = rows.filter((x) => String(x.run_id) === run);
        }
        // Another run than the rows held: the whole window is read again at the next tick (FR-35).
        if (!fresh && c && c.run !== run) this.reload = true;
        const old = fresh || (c && c.run !== run) ? [] : c?.rows ?? [];
        const lastT = old.length ? old[old.length - 1].t : -Infinity;
        const merged = [...old, ...rows.filter((x) => x.t > lastT)];
        this.cache.set(id, { rows: merged.filter((x) => x.t >= w[0] - 3600), from: fresh ? w[0] : c!.from, to: until, run });
      })());
    }
    await Promise.all(tasks);
    if (this.live(http)) this.data.set(this.data.value + 1);
  }

  /** The latest complete Analysis run on this dataset, and its clusters and changes up to the replay time (FR-35, FR-60). */
  private async readAnalysis(http: ClientHttp, full: boolean) {
    const d = this.discovery.value;
    const v = this.view.value;
    const s = this.clock.state.value;
    if (!d || !v || !s) return;
    const clustersOut = outputOf(essentialFor(d, 'clusters', 'cluster')?.datastream ?? 'clusters');
    const changesOut = outputOf(essentialFor(d, 'changes', 'strength')?.datastream ?? 'changes');
    // Every system that publishes clusters for this dataset, and its runs log: the latest complete run of any of them.
    let best: { log: RunLog; row: Row } | null = null;
    for (const c of v.results.get(clustersOut) ?? []) {
      const log = this.runs.value.find((l) => l.ds.systemId === c.systemId);
      for (const row of log?.runs.values() ?? []) {
        if (row.status === 'complete' && (!best || row.t > best.row.t)) best = { log: log!, row };
      }
    }
    if (!best) {
      if (this.analysis.value) this.analysis.set(null);
      return;
    }
    const { log, row } = best;
    const runId = String(row.run_id);
    const start = parseIso(String(row.start ?? iso(s.start)));
    const end = parseIso(String(row.end ?? iso(s.end)));
    const until = Math.min(end, Math.floor(this.clock.now()));
    const old = this.analysis.value;
    const same = !full && old?.runId === runId;
    const lastT = (rows: Row[]) => (rows.length ? rows[rows.length - 1].t : start - 1);
    const of = (out: string) => (v.results.get(out) ?? []).find((x) => x.systemId === log.ds.systemId);
    const read = async (ds: DatastreamInfo | undefined, have: Row[]): Promise<Row[]> => {
      if (!ds) return [];
      const from = same ? Math.min(until, lastT(have) + 1) : start;
      if (until < start) return [];
      const r = await http.request<any[]>('GET', `datastreams/${ds.id}/observations`, { f: SWE, phenomenonTime: `${iso(from)}/${iso(until)}`, limit: '200000' });
      if (r.status !== 200) throw new HttpError(`observations of ${ds.outputName}`, r.status);
      const got = (r.body ?? []).map(toRow).filter((x) => String(x.run_id) === runId);
      const keep = same ? have : [];
      const t0 = lastT(keep);
      return [...keep, ...got.filter((x) => x.t > t0 || !keep.length)];
    };
    const [clusters, changes] = await Promise.all([read(of(clustersOut), old?.clusters ?? []), read(of(changesOut), old?.changes ?? [])]);
    if (!this.live(http)) return;
    this.analysis.set({ runId, algorithm: String(row.algorithm ?? ''), start, end, clusters, changes });
  }

  // --- the poll (FR-63, FR-63a) --------------------------------------------------------------------------------
  private async tick() {
    const http = this.http;
    if (!this.live(http)) return;
    // FR-99: lock after a period without input.
    if (Date.now() - this.lastInput > this.idleMs) {
      this.lock();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      const phase = this.phase.value;
      const want = this.wantHandshake || (this.handshakeFor !== null && this.handshakeFor === this.view.value?.id);
      if (phase === 'unreachable' || (want && phase === 'ready')) {
        // FR-48: after any period of unreachability, repeat the handshake; so after a source in use went away.
        if (Date.now() - this.lastRetry > 2000 && Date.now() - this.lastHandshake > 2500) {
          this.lastRetry = Date.now();
          await this.connect();
        }
        return;
      }
      if (phase !== 'ready') return;
      const playing = !!this.clock.state.value?.playing;
      const now = Date.now();
      const watching = now < this.watchUntil && now - this.lastWatch >= WATCH_EVERY_MS - 50;
      if (watching) this.lastWatch = now;
      if (watching && (this.importing.value || this.statusWatch.length)) {
        await this.readCatalogue(http);
        await this.followImport(http);
      }
      if (watching) await this.readStatus(http);
      if (!this.live(http) || !this.view.value) return;
      if (playing || watching) {
        await this.readRuns(http);
        // A model that has not yet declared its outputs for the dataset (no runs log at the handshake): discover again (FR-44).
        const logs = new Set(this.runs.value.map((l) => l.ds.systemUid));
        if ((this.view.value?.awaited ?? []).some((e) => !logs.has(e.system)) && Date.now() - this.lastHandshake > 4000) this.handshakeFor = this.view.value!.id;
        if (!this.preparing().length && !this.reload && !this.importing.value && !this.statusWatch.length && !this.awaitingCommand) this.watchUntil = 0;
      }
      if (playing || this.reload) {
        // A run newly complete is shown at once, playing or paused (FR-35, D-304).
        const full = this.reload;
        this.reload = false;
        await this.readData(http, full);
        await this.readAnalysis(http, full);
      } else if (watching) await this.readAnalysis(http, false);
    } catch (e) {
      this.failed(e);
    } finally {
      this.busy = false;
    }
  }

  private awaitingCommand = false;
  /** A run became complete: the views read again, even while paused. */
  private reload = false;

  private watch(seconds: number) {
    this.watchUntil = Math.max(this.watchUntil, Date.now() + seconds * 1000);
    this.lastWatch = 0;
  }

  /** Read the command status of a control stream for a few seconds: a rejection is shown with its message (FR-27). */
  private watchStatus(cs: string) {
    this.statusWatch.push({ cs, since: Date.now() - 2000, until: Date.now() + STATUS_WATCH_S * 1000 });
    this.watch(STATUS_WATCH_S);
  }

  private async readStatus(http: ClientHttp) {
    const now = Date.now();
    this.statusWatch = this.statusWatch.filter((w) => w.until > now);
    for (const cs of new Set(this.statusWatch.map((w) => w.cs))) {
      const items: StatusReport[] = await http.all(`controlstreams/${cs}/status`);
      for (const it of commandOutcomes(items).values()) {
        const at = Date.parse(it.reportTime ?? '') || 0;
        if (this.statusSeen.has(it.id) || !this.statusWatch.some((w) => w.cs === cs && at >= w.since)) continue;
        this.statusSeen.add(it.id);
        if (it.statusCode === 'REJECTED' || it.statusCode === 'FAILED') {
          this.notify(`${it.statusCode === 'REJECTED' ? 'Rejected' : 'Failed'}: ${it.message ?? 'no reason given'}`, true);
          this.importing.set(null);
          this.awaitingCommand = false;
        }
      }
    }
  }

  // --- the replay bar (FR-90): the client's own clock; no command is sent (AT-33) ------------------------------
  play() {
    this.clock.play();
  }

  /** Pause; the views are brought up to the replay time where it paused (one read, then nothing while paused). */
  pause() {
    if (!this.clock.state.value?.playing) return;
    this.clock.pause();
    void this.act(async (http) => {
      await this.readData(http, false);
      await this.readAnalysis(http, false);
    });
  }

  setRate(rate: number) {
    this.clock.setRate(rate);
  }

  /** FR-87: seek within the current dataset; only what this client shows changes (AT-36). */
  seek(t: number) {
    this.clock.seek(t);
    void this.act(async (http) => {
      await this.readData(http, true);
      await this.readAnalysis(http, true);
    });
  }

  // --- fields, periods, clustering (FR-53 to FR-55, FR-35a) ------------------------------------------------------
  toggleField(key: string) {
    const sel = this.selection.value;
    const fields = sel.fields.includes(key) ? sel.fields.filter((k) => k !== key) : [...sel.fields, key];
    this.selection.set({ ...sel, fields });
    void this.act((http) => this.readData(http, true));
  }

  setPeriod(period: PeriodId) {
    this.selection.set({ ...this.selection.value, period });
    void this.act((http) => this.readData(http, true));
  }

  /** The current selection's sources at a resolution: each field's datastream, by system unique id and output name (§11). */
  currentSources(res?: Resolution): { system: string; output: string; fields: string[] }[] {
    const out = new Map<string, { system: string; output: string; fields: string[] }>();
    const v = this.view.value;
    if (!v) return [];
    for (const key of this.selection.value.fields) {
      const p = v.props.find((x) => x.key === key);
      const src = p && (res ? p.byRes[res] : sourceAt(p, periodOf(this.selection.value.period).res)?.src);
      if (!src) continue;
      const k = `${src.ds.systemUid}|${src.output}`;
      const o = out.get(k) ?? { system: src.ds.systemUid, output: src.output, fields: [] };
      o.fields.push(src.field.name);
      out.set(k, o);
    }
    return [...out.values()];
  }

  /** The current selection's resolution: the coarsest its fields are read at. */
  currentRes(): Resolution {
    const rs = this.inUse().filter((u) => u.use === 'line').map((u) => u.res);
    return rs.reduce<Resolution>((a, r) => (RES_SECONDS[r] > RES_SECONDS[a] ? r : a), periodOf(this.selection.value.period).res);
  }

  /** The current data window (FR-104): dataset, period, resolution, fields and, where a datastream holds runs, the run. */
  dataWindow(): DataWindow | null {
    const s = this.clock.state.value;
    const w = this.window();
    const e = s && this.catalogue.value.find((x) => x.dataset === s.dataset);
    if (!s || !w || !e) return null;
    const res = this.currentRes();
    const v = this.view.value!;
    const props = this.selection.value.fields.map((k) => v.props.find((p) => p.key === k)).filter((p): p is Property => !!p);
    const runs = new Set(props.map((p) => p.byRes[res]).filter((x): x is Source => !!x?.runs).map((x) => this.cache.get(x.ds.id)?.run).filter((x): x is string => !!x));
    return { file: e.file, start: Math.floor(w[0]), end: Math.floor(w[1]), resolution: res, fields: props.map((p) => p.label), run: runs.size ? [...runs].sort((a, b) => runNumber(a) - runNumber(b)).pop()! : null };
  }

  async cluster(algorithm: string) {
    const d = this.discovery.value;
    const w = this.window();
    const s = this.clock.state.value;
    if (!d || !w || !s) return;
    const cs = findControlStreamByInput(d, 'clustering');
    if (!cs) {
      this.notify('Clustering is not offered by this server.', true);
      return;
    }
    const sources = this.currentSources();
    if (!sources.length) {
      this.notify('Select at least one field to cluster.', true);
      return;
    }
    await this.act(async (http) => {
      const fields = await controlFields(http, cs);
      const params: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.name === 'algorithm') params.algorithm = algorithm;
        else if (f.name === 'doi') {
          // §11: an unsaved data of interest names its dataset by file and sha256, from the catalogue.
          const e = this.catalogue.value.find((x) => x.dataset === s.dataset)!;
          params.doi = JSON.stringify({
            version: 1, label: 'selection', dataset: { file: e.file, size: e.size, modified: e.modified, sha256: e.sha256 },
            start: iso(w[0]), end: iso(w[1]), resolution: this.currentRes(), aggregation: 'as-stored', sources,
          });
        } else {
          // Every other parameter at the middle of its bounds, from the control stream's schema (FR-27).
          const iv = f.constraint?.intervals?.[0];
          params[f.name] = Math.round(iv ? (iv[0] + iv[1]) / 2 : 1);
        }
      }
      http.command(cs.id, params, undefined, (x) => this.commandFailed(x));
    });
    this.notify(`Clustering ${algorithm} sent to the models.`);
    this.awaitingCommand = true;
    this.watchStatus(cs.id);
    this.watch(120);
    setTimeout(() => {
      this.awaitingCommand = false;
    }, 120_000);
  }

  // --- data of interest, on screen Favourites (FR-104 to FR-108; interfaces §11) --------------------------------
  private workspace(): DatastreamInfo | null {
    const d = this.discovery.value;
    const user = this.user.value;
    if (!d || !user) return null;
    // The analyst's own workspace (FR-95), by the naming of interfaces §6.
    const ws = [...d.systems.values()].find((s) => s.uid.endsWith(`:workspace:${user}`));
    return ws ? d.datastreams.find((x) => x.systemId === ws.id && x.outputName === DOI_OUTPUT) ?? null : null;
  }

  /**
   * The workspace's `data-of-interest` datastream, made at the first save (interfaces §11): a user may create under
   * their own workspace only (§9.3). Creating it again answers `201` with the existing `Location` (§9.1).
   */
  private async workspaceStream(http: ClientHttp): Promise<DatastreamInfo | null> {
    const have = this.workspace();
    const d = this.discovery.value;
    const user = this.user.value;
    if (have || !d || !user) return have;
    const sys = [...d.systems.values()].find((s) => s.uid.endsWith(`:workspace:${user}`));
    if (!sys) return null;
    const def = (n: string) => `https://deepbluecltd.github.io/barge-monitor/def/${n}`;
    const schema = {
      type: 'DataRecord', label: 'Data of interest', fields: [
        { type: 'Time', name: 'time', label: 'Saved at', definition: 'http://www.opengis.net/def/property/OGC/0/SamplingTime', uom: { href: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian' } },
        { type: 'Text', name: 'doi_id', label: 'Record', definition: def('doi_id') },
        { type: 'Category', name: 'action', label: 'Action', definition: def('doi_action'), constraint: { type: 'AllowedTokens', values: ['save', 'remove'] } },
        { type: 'Text', name: 'record', label: 'Data of interest (JSON)', definition: def('data_of_interest') },
      ],
    };
    const r = await http.request('POST', `systems/${sys.id}/datastreams`, {},
      { name: 'Data of interest', outputName: DOI_OUTPUT, schema: { obsFormat: 'application/swe+json', recordSchema: schema } });
    const id = r.location?.split('/').filter(Boolean).pop();
    if (r.status >= 300 || !id) return null;
    const info: DatastreamInfo = { id, outputName: DOI_OUTPUT, systemId: sys.id, systemUid: sys.uid, fromModel: false };
    d.datastreams.push(info);
    return info;
  }

  private async readDois(http: ClientHttp) {
    const ws = this.workspace();
    if (!ws) {
      this.dois.set([]);
      return;
    }
    const rows: any[] = await http.get(`datastreams/${ws.id}/observations`, { f: SWE, limit: '100000' });
    if (!this.live(http)) return;
    const items = new Map<string, DoiRecord>();
    for (const o of rows ?? []) {
      if (o.action === 'remove') items.delete(o.doi_id);
      else {
        try {
          items.set(o.doi_id, JSON.parse(o.record));
        } catch {
          /* not a record */
        }
      }
    }
    await this.schemasOf(http, [...items.values()]);
    this.dois.set([...items.entries()].map(([id, record]) => ({ id, record, greyed: this.greyed(record) })));
  }

  /** The schemas of the datastreams records name, so that one the server now refuses is known (FR-96a). */
  private async schemasOf(http: ClientHttp, records: DoiRecord[]) {
    const d = this.discovery.value;
    if (!d) return;
    const list: DatastreamInfo[] = [];
    for (const r of records) {
      const ds = this.datasetOf(r);
      if (!ds) continue;
      for (const s of r.sources ?? []) {
        const x = findDatastream(d, s.system, `${s.output}__${ds}`);
        if (x) list.push(x);
      }
    }
    await fetchSchemas(http, d, list);
  }

  /** FR-96, FR-96a: a record whose dataset is not imported, or whose sources this user can no longer read. */
  greyed(r: DoiRecord): string | null {
    const d = this.discovery.value;
    if (!d) return null;
    const ds = this.datasetOf(r);
    if (!ds) return `Not imported: import ${r.dataset.file} to restore it.`;
    const gone = (r.sources ?? []).filter((s) => {
      const x = findDatastream(d, s.system, `${s.output}__${ds}`);
      return x && d.refused.has(x.id);
    });
    if (gone.length) return 'No longer permitted: a source it names is not available to you.';
    return null;
  }

  /** The dataset a record names, found again by the file's content hash (FR-96). */
  datasetOf(r: DoiRecord): string | null {
    const e = this.catalogue.value.find((x) => x.sha256 === r.dataset.sha256 && x.dataset && OPENABLE.has(x.status));
    return e?.dataset ?? null;
  }

  /** FR-104, FR-94a: save the current window; a resolution no datastream holds is refused, naming those that do. */
  async saveDoi(label: string, note: string, resolution: string): Promise<string | null> {
    const s = this.clock.state.value;
    const w = this.window();
    const v = this.view.value;
    if (!s || !w || !v) return 'Nothing to save: no dataset is open.';
    if (!label.trim()) return 'Give it a name.';
    const props = this.selection.value.fields.map((k) => v.props.find((p) => p.key === k)).filter((p): p is Property => !!p);
    if (!props.length) return 'Select at least one field.';
    const exist = RESOLUTIONS.filter((r) => props.every((p) => p.byRes[r]));
    if (!(RESOLUTIONS as string[]).includes(resolution) || !props.every((p) => p.byRes[resolution as Resolution])) {
      return `No datastream holds ${resolution || 'that resolution'} for these fields. Those that exist: ${exist.join(', ') || 'none in common'}.`;
    }
    const res = resolution as Resolution;
    const entry = this.catalogue.value.find((x) => x.dataset === s.dataset);
    if (!entry) return 'The dataset is not in the catalogue.';
    const record: DoiRecord = {
      version: 1, label: label.trim(), ...(note.trim() ? { note: note.trim() } : {}),
      dataset: { file: entry.file, size: entry.size, modified: entry.modified, sha256: entry.sha256 },
      start: iso(w[0]), end: iso(w[1]), resolution: res, aggregation: 'as-stored', sources: this.currentSources(res),
      created: { at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), by: this.user.value ?? '' },
    };
    // FR-94: the run, only where a datastream holds more than one.
    const withRuns = props.map((p) => p.byRes[res]).filter((x): x is Source => !!x?.runs);
    if (withRuns.length) {
      const run = this.dataWindowRun(withRuns);
      if (run) record.run = run;
    }
    const ws = await this.act((http) => this.workspaceStream(http));
    if (!ws) return 'The server offers no workspace to keep it in.';
    const id = `d-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const r = await this.act((http) => http.request('POST', `datastreams/${ws.id}/observations`, {},
      { time: iso(Date.now() / 1000), doi_id: id, action: 'save', record: JSON.stringify(record) }, SWE));
    if (!r || r.status >= 300) return `The server did not keep it (HTTP ${r?.status ?? 'no answer'}).`;
    await this.act((http) => this.readDois(http));
    this.notify(`Saved "${record.label}".`);
    return null;
  }

  /** The run shown for sources that hold runs, where their datastream holds more than one (FR-94). */
  private dataWindowRun(srcs: Source[]): string | null {
    const ids = new Set<string>();
    for (const l of this.runs.value) for (const id of l.runs.keys()) if (srcs.some((s) => s.ds.systemId === l.ds.systemId)) ids.add(id);
    if (ids.size < 2) return null;
    return srcs.map((s) => this.cache.get(s.ds.id)?.run).find((x): x is string => !!x) ?? null;
  }

  /** The current window is already saved: the star shows it (FR-104). */
  isSaved(): boolean {
    const s = this.clock.state.value;
    const w = this.window();
    const e = s && this.catalogue.value.find((x) => x.dataset === s.dataset);
    if (!s || !w || !e) return false;
    const res = this.currentRes();
    const sources = JSON.stringify(this.currentSources(res));
    return this.dois.value.some((it) => it.record.dataset.sha256 === e.sha256 && it.record.start === iso(w[0]) && it.record.end === iso(w[1])
      && it.record.resolution === res && JSON.stringify(it.record.sources) === sources);
  }

  async removeDoi(item: DoiItem) {
    const ws = this.workspace();
    if (!ws) return;
    await this.act((http) => http.request('POST', `datastreams/${ws.id}/observations`, {},
      { time: iso(Date.now() / 1000), doi_id: item.id, action: 'remove', record: '' }, SWE));
    if (this.opened.value?.records.some((r) => r.item.id === item.id)) this.opened.set(null);
    await this.act((http) => this.readDois(http));
  }

  /** FR-106: regenerate a record from the server exactly as it describes, whatever the current dataset. */
  private async regenerate(http: ClientHttp, item: DoiItem): Promise<{ start: number; res: Resolution; series: DoiSeries[] } | string> {
    const d = this.discovery.value!;
    const r = item.record;
    if (item.greyed) return item.greyed;
    const ds = this.datasetOf(r)!;
    if (!(RESOLUTIONS as string[]).includes(r.resolution)) return `No datastream holds ${r.resolution}. Those that exist: ${RESOLUTIONS.join(', ')}.`;
    const series: DoiSeries[] = [];
    for (const src of r.sources) {
      const info = findDatastream(d, src.system, `${src.output}__${ds}`);
      if (!info) return `${src.output} · ${ds} is not offered.`;
      await fetchSchemas(http, d, [info]);
      if (d.refused.has(info.id)) return 'No longer permitted: a source it names is not available to you.';
      const schema = d.schemas.get(info.id) ?? [];
      const got = await http.request<any[]>('GET', `datastreams/${info.id}/observations`, { f: SWE, phenomenonTime: `${r.start}/${r.end}`, limit: '200000' });
      if (got.status !== 200) return `${src.output} · ${ds} could not be read (HTTP ${got.status}).`;
      let rows = (got.body ?? []).map(toRow);
      if (schema.some((f) => f.name === 'run_id')) {
        const run = r.run ?? this.latestRunIn(rows);
        rows = rows.filter((x) => String(x.run_id) === run);
      }
      const sys = systemByUid(d, src.system);
      for (const f of src.fields) {
        const sf = schema.find((x) => x.name === f);
        series.push({
          label: `${sys?.label ?? src.system} · ${sf?.label ?? f}`, uom: sf?.uom?.code ?? null, type: sf?.type ?? 'Quantity',
          rows: rows.map((x) => ({ t: x.t, v: (x[f] ?? null) as number | string | null })),
        });
      }
    }
    return { start: parseIso(r.start), res: r.resolution as Resolution, series };
  }

  /** The highest-numbered run among rows (a record of a dataset not open: its runs log is not read). */
  private latestRunIn(rows: Row[]): string {
    return rows.map((x) => String(x.run_id)).reduce((a, b) => (runNumber(b) > runNumber(a) ? b : a), '');
  }

  async openDoi(item: DoiItem) {
    await this.act(async (http) => {
      const g = await this.regenerate(http, item);
      if (typeof g === 'string') {
        this.notify(g, true);
        return;
      }
      const r = item.record;
      this.opened.set({ kind: 'open', title: `${r.label} · ${r.dataset.file} · ${r.start} to ${r.end}`, records: [{ item, ...g }], checksum: digest(g.series) });
    });
  }

  /** FR-107: two records on elapsed time from each one's start, the finer brought to the coarser resolution. */
  async compare(a: DoiItem, b: DoiItem) {
    await this.act(async (http) => {
      const ga = await this.regenerate(http, a);
      const gb = await this.regenerate(http, b);
      if (typeof ga === 'string' || typeof gb === 'string') {
        this.notify(typeof ga === 'string' ? ga : String(gb), true);
        return;
      }
      const res = RES_SECONDS[ga.res] >= RES_SECONDS[gb.res] ? ga.res : gb.res;
      const step = RES_SECONDS[res];
      const bring = (g: { start: number; series: DoiSeries[] }): DoiSeries[] => g.series.map((s) => {
        const bins = new Map<number, { sum: number; n: number }>();
        for (const r of s.rows) {
          if (typeof r.v !== 'number' || !Number.isFinite(r.v)) continue;
          const k = Math.floor((r.t - g.start) / step) * step;
          const b0 = bins.get(k) ?? { sum: 0, n: 0 };
          b0.sum += r.v;
          b0.n++;
          bins.set(k, b0);
        }
        return { ...s, rows: [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([k, v]) => ({ t: k, v: v.sum / v.n })) };
      });
      const records = [
        { item: a, start: ga.start, res: ga.res, series: bring(ga) },
        { item: b, start: gb.start, res: gb.res, series: bring(gb) },
      ];
      this.opened.set({ kind: 'compare', title: `${a.record.label} and ${b.record.label}, on elapsed time`, records, res, checksum: digest(records.flatMap((r) => r.series)) });
    });
  }

  closeOpened() {
    this.opened.set(null);
  }

  /** The essentials of the current state, in words, for the shell's status. */
  essentialsText(): string {
    const d = this.discovery.value;
    if (!d) return '–';
    const all = [...d.problems, ...(this.view.value?.problems ?? [])];
    return all.length ? `${all.length} missing: ${all.map((p) => essentialLabel(p.essential)).join(', ')}` : 'All present';
  }

  /** What the views show now, for the end-to-end tests (AT-45, AT-70; D-306): read-only, nothing beyond the screen. */
  shown(): { dataset: string | null; time: number | null; lines: { key: string; rows: [number, Value][] }[]; clusters: [number, Value][]; run: string | null } {
    const s = this.clock.state.value;
    return {
      dataset: s?.dataset ?? null, time: s ? Math.floor(s.time) : null,
      lines: this.inUse().filter((u) => u.use === 'line').map((u) => ({ key: u.prop.key, rows: this.rows(u.src).map((r) => [r.t, r[u.src.field.name]] as [number, Value]) })),
      clusters: (this.analysis.value?.clusters ?? []).map((r) => [r.t, r.cluster]),
      run: this.analysis.value?.runId ?? null,
    };
  }
}

export const clientSession = new DisplayClientSession();
// Read-only views of what the client shows, and a second display client on the same server, for the end-to-end
// tests only (AT-45, AT-70; D-306). A second client is the same code, not on screen; nothing of it is stored.
(globalThis as { bargeClientShown?: () => unknown }).bargeClientShown = () => clientSession.shown();
(globalThis as { bargeNewClient?: () => DisplayClientSession }).bargeNewClient = () => new DisplayClientSession();
