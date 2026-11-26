// The display client's state (SRD §8, docs/v4-interfaces.md §11): login and lock
// (FR-97 to FR-102), the handshake (FR-42 to FR-48), the dataset picker (FR-103),
// the replay bar (FR-90), live data (FR-63), the field list and degraded mode per
// dataset (FR-43, FR-45), clustering (FR-35a, FR-55) and data of interest
// (FR-104 to FR-108). It knows the data server only through discovery: no
// identifier, field or source is written into it, and nothing in it depends on
// who is logged in. A user who may not see a source simply never discovers it.
//
// Nothing sensitive is kept in the browser (FR-100): the credentials live in the
// ClientHttp object, in memory, and every list and value is dropped on lock.
import { IDLE_LOCK_MS, POLL_MS } from '../config';
import { Store } from '../shell/store';
import {
  controlFields, Discovery, essentialLabel, fetchSchemas, findControlStream, findControlStreamByInput, findDatastream, handshake, systemByUid,
} from './discovery';
import { buildView, datasetDatastreams, DatasetView, essentialFor, Property, RES_SECONDS, Resolution, RESOLUTIONS, Source, sourceAt } from './fields';
import { Closed, ClientHttp, HttpError, NetworkFailure, Unauthorized } from './http';
import { iso, parseIso, PeriodId, periodOf, statsRes, windowOf } from './plan';

export type Phase = 'login' | 'handshake' | 'ready' | 'unreachable' | 'rejected' | 'locked' | 'error';

export type Value = number | string | boolean | null;
export interface Row {
  t: number;
  [k: string]: Value;
}

export interface ReplayState {
  time: number;
  dataset: string;
  start: number;
  end: number;
  rate: number;
  max_rate: number;
  max_rate_model: string;
  playing: boolean;
  at_end: boolean;
  run: string;
  models_ready: boolean;
}

/** Catalogue statuses whose `records` is a real count (D-197): `not-imported` and `importing` carry 0. */
const COUNTED = new Set(['imported', 'changed', 'superseded']);

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

/** The analyst's place, kept while locked so unlocking restores it (FR-99). No data, no names of datasets. */
interface Place {
  user: string;
  selection: Selection;
}

const DEFAULT_SELECTION: Selection = { fields: [], period: '1h' };
const STATUS_WATCH_S = 9;

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

const runNumber = (run: Value) => {
  const m = /(\d+)$/.exec(String(run ?? ''));
  return m ? Number(m[1]) : 0;
};

/** Rows in time order, one per time: where replay runs overlap, the latest run's (FR-35). */
function latestRun(rows: Row[]): Row[] {
  const byT = new Map<number, Row>();
  for (const r of rows) {
    const old = byT.get(r.t);
    if (!old || runNumber(r.run) >= runNumber(old.run)) byT.set(r.t, r);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** A short, stable digest of what a view draws, so that a regenerated record can be compared with the original (AT-45). */
export function digest(series: DoiSeries[]): string {
  let h = 2166136261;
  const text = series.map((s) => `${s.label}:${s.rows.map((r) => `${r.t}=${typeof r.v === 'number' ? r.v.toFixed(6) : r.v}`).join(',')}`).join('|');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

interface Cache {
  rows: Row[];
  from: number;
  to: number;
}

let noticeSeq = 0;

export class DisplayClientSession {
  phase = new Store<Phase>('login');
  user = new Store<string | null>(null);
  loginError = new Store<string | null>(null);
  discovery = new Store<Discovery | null>(null);
  catalogue = new Store<CatalogueEntry[]>([]);
  replay = new Store<ReplayState | null>(null);
  /** The current dataset's fields and problems (FR-43, FR-45); null while none is loaded. */
  view = new Store<DatasetView | null>(null);
  selection = new Store<Selection>(DEFAULT_SELECTION);
  /** Bumped whenever data arrives, so the views redraw. */
  data = new Store(0);
  analysis = new Store<AnalysisResult | null>(null);
  notices = new Store<Notice[]>([]);
  /** A file being imported, with its progress (FR-103). */
  importing = new Store<{ file: string; pct: number; status: string } | null>(null);
  /** A dataset asked for but not yet current (load sent, or the models still preparing it). */
  loading = new Store<string | null>(null);
  dois = new Store<DoiItem[]>([]);
  /** The dataset whose models were not yet ready when the last handshake was made (D-186). */
  private discoveredEarly: string | null = null;
  opened = new Store<Opened | null>(null);
  /** The data shown may be out of date: the server stopped answering (AT-11). */
  stale = new Store(false);
  /** A command sent and not yet reflected in the state datastream (AT-39): what the bar is waiting for. */
  sent = new Store<string | null>(null);
  /** How long without input before locking (FR-99); a failure demo shortens it. */
  idleMs = IDLE_LOCK_MS;
  /** Set by the demonstrator shell: true while Freeze holds everything (the client keeps no timers running meanwhile). */
  lastInput = Date.now();

  http: ClientHttp | null = null;
  private place: Place | null = null;
  private cache = new Map<string, Cache>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** Poll the state (and anything a command concerns) until then, even while paused: a command's effect is being awaited. */
  private watchUntil = 0;
  private statusWatch: { cs: string; since: number; until: number; seen: Set<string> }[] = [];
  private runsSeen = new Map<string, string>();
  private statusSeen = new Set<string>();
  /** What the viewer's latest commands asked for, until the state shows it: the next command carries it (FR-27: every parameter). */
  private intent: { rate?: number; dataset?: string } = {};
  private wantHandshake = false;
  private lastRetry = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      const touch = () => {
        this.lastInput = Date.now();
      };
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove']) window.addEventListener(ev, touch, { passive: true, capture: true });
    }
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
    this.user.set(user);
    this.lastInput = Date.now();
    const ok = await this.connect(true);
    if (!ok) return false;
    if (this.place && this.place.user === user) this.selection.set(this.place.selection);
    this.place = null;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    return true;
  }

  /** FR-99: blank everything, discard the credentials, stop every request. Unlocking needs the password, and restores the place. */
  lock() {
    if (this.phase.value === 'login' || this.phase.value === 'locked') return;
    const user = this.user.value;
    this.place = user ? { user, selection: this.selection.value } : null;
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
    this.discovery.set(null);
    this.catalogue.set([]);
    this.replay.set(null);
    this.view.set(null);
    this.cache.clear();
    this.analysis.set(null);
    this.notices.set([]);
    this.importing.set(null);
    this.loading.set(null);
    this.dois.set([]);
    this.opened.set(null);
    this.stale.set(false);
    this.sent.set(null);
    this.statusWatch = [];
    this.intent = {};
    this.runsSeen.clear();
    this.data.set(this.data.value + 1);
  }

  private live(http: ClientHttp | null): http is ClientHttp {
    return !!http && http === this.http && !http.closed;
  }

  /** Run a viewer's action: its requests' messages wear the gold ring on the flowchart. */
  private async user_<T>(fn: (http: ClientHttp) => Promise<T>): Promise<T | undefined> {
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

  /** A command that got no answer: say so, and treat it like any other failed request. */
  private commandFailed(e: unknown) {
    if (e instanceof NetworkFailure) {
      this.notify('The server did not answer the command.', true);
      this.sent.set(null);
      this.importing.set(null);
    }
    this.failed(e);
  }

  /** What a failed request means for the client. */
  private failed(e: unknown) {
    if (e instanceof Closed) return;
    if (e instanceof Unauthorized) {
      // Only credentials that had worked can stop working; a login in progress handles its own refusal.
      if (this.phase.value === 'login' || this.phase.value === 'locked' || this.phase.value === 'handshake') return;
      // The credentials no longer work: back to the login screen, saying only that (FR-101).
      this.restart();
      this.loginError.set('Please log in again.');
      return;
    }
    if (e instanceof NetworkFailure) {
      if (this.phase.value === 'ready') {
        this.phase.set('unreachable');
        this.stale.set(true);
      }
      return;
    }
    if (e instanceof HttpError && e.status === 404) {
      // Something in use is no longer there for this user: discover again (FR-48).
      this.wantHandshake = true;
      return;
    }
    console.warn(e);
  }

  // --- the handshake (FR-42 to FR-48) -----------------------------------------------------------------------
  /** A full handshake, then the state, the catalogue, the data of interest and the current dataset. */
  async connect(first = false): Promise<boolean> {
    const http = this.http;
    if (!this.live(http)) return false;
    this.phase.set('handshake');
    let d: Discovery;
    try {
      d = await handshake(http);
    } catch (e) {
      if (e instanceof Unauthorized) {
        if (first) {
          // FR-101: say only that the name or password was wrong, never which.
          this.stop();
          this.user.set(null);
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
      if (first) this.timer = setInterval(() => void this.tick(), POLL_MS);
      return first;
    }
    if (!this.live(http)) return false;
    this.discovery.set(d);
    this.wantHandshake = false;
    if (d.rejected) {
      this.phase.set('rejected');
      this.stale.set(false);
      return true;
    }
    try {
      await this.readState(http);
      // A handshake made while the models were still declaring the dataset's datastreams may have seen
      // only some of them: it is repeated once they are ready (FR-44, D-186).
      const st = this.replay.value;
      this.discoveredEarly = st && !st.models_ready ? st.dataset : null;
      await this.readCatalogue(http);
      await this.readDois(http);
      await this.applyDataset(http, this.replay.value?.dataset ?? null);
    } catch (e) {
      this.failed(e);
      if (this.phase.value !== 'handshake') return this.phase.value !== 'login';
    }
    if (!this.live(http)) return false;
    this.stale.set(false);
    this.phase.set('ready');
    return true;
  }

  // --- reading ------------------------------------------------------------------------------------------------
  private stateDs(): string | null {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('replay') && x.kind !== 'controlstream');
    return d && e ? findDatastream(d, e.system, e.datastream)?.id ?? null : null;
  }

  private replayCs() {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('replay') && x.kind === 'controlstream');
    return d && e ? findControlStream(d, e.system, e.datastream) : null;
  }

  private catalogueDs(): string | null {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('datasets'));
    return d && e ? findDatastream(d, e.system, e.datastream)?.id ?? null : null;
  }

  /** The importer's control stream: the one beside its catalogue. */
  private importCs() {
    const d = this.discovery.value;
    const e = d?.profile?.essentials.find((x) => x.views?.includes('datasets'));
    return d && e ? d.controlstreams.find((c) => c.systemUid === e.system) ?? null : null;
  }

  private async readState(http: ClientHttp) {
    const id = this.stateDs();
    if (!id) return;
    const rows: any[] = await http.get(`datastreams/${id}/observations`, { f: 'application/swe+json', resultTime: 'latest' });
    const o = rows?.[0];
    if (!o || !this.live(http)) return;
    const s: ReplayState = {
      time: parseIso(o.time), dataset: String(o.dataset ?? ''), start: parseIso(o.start), end: parseIso(o.end), rate: Number(o.rate),
      max_rate: Number(o.max_rate), max_rate_model: String(o.max_rate_model ?? ''), playing: !!o.playing, at_end: !!o.at_end,
      run: String(o.run ?? ''), models_ready: !!o.models_ready,
    };
    const old = this.replay.value;
    this.replay.set(s);
    const sent = this.sent.value;
    if (sent && this.reflects(sent, s)) this.sent.set(null);
    if (this.intent.rate === s.rate) delete this.intent.rate;
    if (this.intent.dataset === s.dataset) delete this.intent.dataset;
    if (old && s.at_end && !old.at_end) this.notify('The replay reached the end of the dataset and paused.');
    // A new run (a seek) or another dataset: the data held no longer follows the replay.
    if (old && (old.run !== s.run || old.dataset !== s.dataset)) {
      this.cache.clear();
      this.data.set(this.data.value + 1);
    }
  }

  private reflects(sent: string, s: ReplayState): boolean {
    const [action, arg] = sent.split(' ');
    if (action === 'play') return s.playing || s.at_end;
    if (action === 'pause') return !s.playing;
    if (action === 'rate') return s.rate === Number(arg);
    if (action === 'load') return s.dataset === arg;
    if (action === 'seek') return Math.abs(s.time - Number(arg)) < 120;
    return true;
  }

  private async readCatalogue(http: ClientHttp) {
    const id = this.catalogueDs();
    if (!id) return;
    const rows: any[] = await http.get(`datastreams/${id}/observations`, { f: 'application/swe+json', limit: '100000' });
    if (!this.live(http)) return;
    // Append-only: the latest observation per file version is its status (FR-20c).
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

  /** The current dataset: its datastreams' schemas once, then its field list and essentials (FR-43, FR-45). No full handshake. */
  private async applyDataset(http: ClientHttp, dataset: string | null) {
    const d = this.discovery.value;
    if (!d || !dataset) {
      this.view.set(null);
      return;
    }
    const s = this.replay.value;
    // The models create a dataset's datastreams when it is loaded; once they have, a handshake
    // that came before that has not seen them (FR-44), so it is repeated.
    const modelOutputs = datasetDatastreams(d, dataset).some((x) => x.fromModel);
    if (s && s.dataset === dataset && !s.models_ready) {
      this.loading.set(dataset);
      this.view.set(null);
      return;
    }
    if (s?.models_ready && s.dataset === dataset && this.discoveredEarly === dataset) {
      this.discoveredEarly = null;
      this.wantHandshake = true;
      this.loading.set(dataset);
      return;
    }
    if (!modelOutputs && s?.models_ready) {
      this.wantHandshake = true;
      this.loading.set(dataset);
      return;
    }
    await fetchSchemas(http, d, datasetDatastreams(d, dataset));
    if (!this.live(http)) return;
    const v = buildView(d, dataset);
    const keep = new Set(v.props.map((p) => p.key));
    const sel = this.selection.value;
    let fields = sel.fields.filter((k) => keep.has(k));
    if (!fields.length && !sel.fields.length) fields = v.props.filter((p) => p.declared && p.byRes.PT1S).slice(0, 2).map((p) => p.key);
    this.view.set(v);
    this.loading.set(null);
    if (fields.join() !== sel.fields.join()) this.selection.set({ ...sel, fields });
    this.analysis.set(null);
    this.runsSeen.clear();
    this.cache.clear();
    await this.readData(http, true);
  }

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

  window(): [number, number] | null {
    const s = this.replay.value;
    if (!s || !this.view.value) return null;
    return windowOf(this.selection.value.period, s.time, s.start);
  }

  /** Rows of a datastream within the window, the latest run where runs overlap. */
  rows(src: Source): Row[] {
    const c = this.cache.get(src.ds.id);
    const w = this.window();
    if (!c || !w) return [];
    return c.rows.filter((r) => r.t >= w[0] && r.t <= w[1]);
  }

  /**
   * Read every datastream in use (FR-63): the whole window when `full`, otherwise from the last
   * reading received up to the replay time. One request per datastream.
   */
  private async readData(http: ClientHttp, full: boolean) {
    const w = this.window();
    if (!w) return;
    const seen = new Set<string>();
    const tasks: Promise<void>[] = [];
    for (const u of this.inUse()) {
      const id = u.src.ds.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = this.cache.get(id);
      const fresh = full || !c || c.from > w[0];
      const from = fresh ? w[0] : Math.min(w[1], Math.max(w[0], (c!.rows.length ? c!.rows[c!.rows.length - 1].t : c!.to) + 1));
      // AT-37: one request per datastream in use every second, whatever the rate, even when nothing new can be there yet.
      tasks.push((async () => {
        const got: any[] = await http.get(`datastreams/${id}/observations`, { f: 'application/swe+json', phenomenonTime: `${iso(from)}/${iso(w[1])}`, limit: '200000' });
        if (!this.live(http)) return;
        const rows = (got ?? []).map(toRow);
        const old = fresh ? [] : this.cache.get(id)?.rows ?? [];
        const lastT = old.length ? old[old.length - 1].t : -Infinity;
        const merged = u.src.runs ? latestRun([...old, ...rows]) : [...old, ...rows.filter((r) => r.t > lastT)];
        this.cache.set(id, { rows: merged.filter((r) => r.t >= w[0] - 3600), from: fresh ? w[0] : c!.from, to: w[1] });
      })());
    }
    await Promise.all(tasks);
    if (this.live(http)) this.data.set(this.data.value + 1);
  }

  // --- the poll (FR-63, FR-63a) --------------------------------------------------------------------------------
  private async tick() {
    const http = this.http;
    if (!this.live(http) || this.busy) return;
    // FR-99: lock after a period without input.
    if (Date.now() - this.lastInput > this.idleMs && this.phase.value !== 'login') {
      this.lock();
      return;
    }
    this.busy = true;
    try {
      const phase = this.phase.value;
      if (phase === 'unreachable' || phase === 'rejected' || this.wantHandshake) {
        // FR-48: after any period of unreachability, repeat the handshake.
        if (Date.now() - this.lastRetry > 2000 || this.wantHandshake) {
          this.lastRetry = Date.now();
          this.wantHandshake = false;
          if (phase === 'rejected') return;
          await this.connect();
        }
        return;
      }
      if (phase !== 'ready') return;
      const s = this.replay.value;
      const now = Date.now();
      const watching = now < this.watchUntil;
      // FR-63a: while paused, nothing is polled, unless a command's effect is awaited.
      if (s?.playing || watching || this.loading.value || this.importing.value) await this.readState(http);
      if (!this.live(http)) return;
      if (this.importing.value || watching) await this.readCatalogue(http);
      await this.followImport(http);
      await this.followLoad(http);
      await this.readStatus(http);
      const st = this.replay.value;
      if (st?.playing || (watching && this.view.value)) {
        await this.readData(http, false);
        await this.readAnalysis(http);
      }
    } catch (e) {
      this.failed(e);
    } finally {
      this.busy = false;
    }
  }

  private watch(seconds = 4) {
    this.watchUntil = Math.max(this.watchUntil, Date.now() + seconds * 1000);
  }

  /** Read the command status of a control stream for a few seconds: a rejection is shown with its message (FR-27). */
  private watchStatus(cs: string) {
    this.statusWatch.push({ cs, since: Date.now() - 2000, until: Date.now() + STATUS_WATCH_S * 1000, seen: new Set() });
    this.watch(STATUS_WATCH_S);
  }

  private async readStatus(http: ClientHttp) {
    const now = Date.now();
    this.statusWatch = this.statusWatch.filter((w) => w.until > now);
    for (const cs of new Set(this.statusWatch.map((w) => w.cs))) {
      const items: any[] = await http.all(`controlstreams/${cs}/status`);
      for (const w of this.statusWatch.filter((x) => x.cs === cs)) {
        for (const it of items) {
          const at = Date.parse(it.reportTime ?? '') || 0;
          if (at < w.since || w.seen.has(it.id) || this.statusSeen.has(it.id)) continue;
          w.seen.add(it.id);
          this.statusSeen.add(it.id);
          if (it.statusCode === 'REJECTED' || it.statusCode === 'FAILED') {
            this.notify(`${it.statusCode === 'REJECTED' ? 'Rejected' : 'Failed'}: ${it.message ?? 'no reason given'}`, true);
            this.sent.set(null);
            this.importing.set(null);
            this.loading.set(null);
            this.intent = {};
            w.until = 0;
          }
        }
      }
    }
  }

  // --- the replay bar (FR-90): one command per action, every parameter, never waited on -------------------------
  private replayCommand(action: 'load' | 'play' | 'pause' | 'seek', over: Partial<{ dataset: string; rate: number; position: number }> = {}, label: string = action) {
    const cs = this.replayCs();
    const s = this.replay.value;
    if (!cs || !this.http || this.phase.value !== 'ready') return;
    void this.user_(async (http) => {
      http.command(cs.id, {
        action, dataset: over.dataset ?? this.intent.dataset ?? s?.dataset ?? '', rate: over.rate ?? this.intent.rate ?? s?.rate ?? 1,
        position: iso(over.position ?? s?.time ?? 0),
      }, (e) => this.commandFailed(e));
    });
    this.sent.set(label);
    if (over.rate !== undefined) this.intent.rate = over.rate;
    if (over.dataset !== undefined) this.intent.dataset = over.dataset;
    this.watchStatus(cs.id);
  }

  play() {
    this.replayCommand('play', {}, 'play');
  }

  pause() {
    this.replayCommand('pause', {}, 'pause');
  }

  setRate(rate: number) {
    const s = this.replay.value;
    this.replayCommand(s?.playing ? 'play' : 'pause', { rate }, `rate ${rate}`);
  }

  seek(t: number) {
    this.replayCommand('seek', { position: t }, `seek ${Math.round(t)}`);
  }

  // --- the dataset picker (FR-103) --------------------------------------------------------------------------------
  open(e: CatalogueEntry) {
    if (e.status === 'importing') return;
    // A changed file is imported again, as a new dataset (FR-21a); the earlier one stays openable.
    if (e.dataset && (e.status === 'imported' || e.status === 'superseded')) {
      this.loadDataset(e.dataset);
      return;
    }
    const cs = this.importCs();
    if (!cs) return;
    void this.user_(async (http) => http.command(cs.id, { action: 'import', file: e.file }, (x) => this.commandFailed(x)));
    this.importing.set({ file: e.file, pct: 0, status: 'sent' });
    this.watchStatus(cs.id);
  }

  rescan() {
    const cs = this.importCs();
    if (!cs) return;
    void this.user_(async (http) => http.command(cs.id, { action: 'rescan', file: '' }, (x) => this.commandFailed(x)));
    this.watchStatus(cs.id);
  }

  private loadDataset(dataset: string) {
    this.loading.set(dataset);
    this.replayCommand('load', { dataset }, `load ${dataset}`);
  }

  /** An import in progress: its percentage from the catalogue; once imported, load it (FR-103, AT-41). */
  private async followImport(_http: ClientHttp) {
    const imp = this.importing.value;
    if (!imp) return;
    const e = this.catalogue.value.filter((x) => x.file === imp.file).pop();
    if (!e) return;
    if (e.status === 'importing') this.importing.set({ file: imp.file, pct: e.pct ?? 0, status: 'importing' });
    else if (e.status === 'imported' && e.dataset) {
      this.importing.set(null);
      this.notify(`${e.file} imported as ${e.dataset}.`);
      this.loadDataset(e.dataset);
    }
  }

  /**
   * A dataset asked for: once the state says it is current and the models have created its
   * datastreams, build its field list. After an import, or whenever discovery has not yet seen
   * the models' datastreams for it, repeat the full handshake first (FR-44).
   */
  private async followLoad(http: ClientHttp) {
    const want = this.loading.value;
    const s = this.replay.value;
    if (!want || !s || s.dataset !== want || !s.models_ready) return;
    const d = this.discovery.value!;
    const seen = datasetDatastreams(d, want);
    if (!seen.length || !seen.some((x) => x.fromModel)) {
      await this.connect();
      return;
    }
    await this.applyDataset(http, want);
  }

  // --- fields, periods, clustering (FR-53 to FR-55, FR-35a) ------------------------------------------------------
  toggleField(key: string) {
    const sel = this.selection.value;
    const fields = sel.fields.includes(key) ? sel.fields.filter((k) => k !== key) : [...sel.fields, key];
    this.selection.set({ ...sel, fields });
    void this.user_((http) => this.readData(http, true));
  }

  setPeriod(period: PeriodId) {
    this.selection.set({ ...this.selection.value, period });
    void this.user_((http) => this.readData(http, true));
  }

  /** The current selection as an unsaved data of interest (FR-35a): dataset, span, resolution, sources. */
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

  async cluster(algorithm: string) {
    const d = this.discovery.value;
    const w = this.window();
    const s = this.replay.value;
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
    await this.user_(async (http) => {
      const fields = await controlFields(http, cs);
      const params: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.name === 'algorithm') params.algorithm = algorithm;
        else if (f.name === 'doi') {
          // §11: an unsaved data of interest names its dataset by file and sha256, from the catalogue (D-182).
          const e = this.catalogue.value.find((x) => x.dataset === s.dataset);
          const dataset = e ? { file: e.file, size: e.size, modified: e.modified, sha256: e.sha256 } : s.dataset;
          params.doi = JSON.stringify({ dataset, start: iso(w[0]), end: iso(w[1]), resolution: this.currentRes(), sources });
        }
        else {
          // Every other parameter at the middle of its bounds, from the control stream's schema (FR-27).
          const iv = f.constraint?.intervals?.[0];
          const v = iv ? (iv[0] + iv[1]) / 2 : 1;
          params[f.name] = f.type === 'Count' ? Math.round(Math.min(Math.max(3, iv?.[0] ?? 3), iv?.[1] ?? 3)) : Math.round(v);
        }
      }
      http.command(cs.id, params, (x) => this.commandFailed(x));
    });
    this.notify(`Clustering ${algorithm} sent to the models.`);
    this.watchStatus(cs.id);
    this.watch(15);
  }

  /** The latest Analysis run for this dataset, read from its runs log, and its clusters and changes (FR-35). */
  private async readAnalysis(http: ClientHttp) {
    const d = this.discovery.value;
    const v = this.view.value;
    if (!d || !v) return;
    const runsOut = essentialFor(d, 'clusters', 'run_id')?.datastream.split('__')[0] ?? 'runs';
    const clustersOut = essentialFor(d, 'clusters', 'cluster')?.datastream.split('__')[0] ?? 'clusters';
    const changesOut = essentialFor(d, 'changes', 'strength')?.datastream.split('__')[0] ?? 'changes';
    for (const runs of v.results.get(runsOut) ?? []) {
      const got: any[] = await http.get(`datastreams/${runs.id}/observations`, { f: 'application/swe+json', resultTime: 'latest' });
      const o = got?.[0];
      if (!o || this.runsSeen.get(runs.id) === o.run_id) continue;
      const first = !this.runsSeen.has(runs.id);
      this.runsSeen.set(runs.id, o.run_id);
      if (first && this.analysis.value) continue;
      const of = (out: string) => (v.results.get(out) ?? []).find((x) => x.systemId === runs.systemId);
      const read = async (ds: { id: string } | undefined) => {
        if (!ds) return [];
        const rows: any[] = await http.get(`datastreams/${ds.id}/observations`, { f: 'application/swe+json', phenomenonTime: `${o.start}/${o.end}`, limit: '200000' });
        return (rows ?? []).map(toRow).filter((r) => r.run_id === o.run_id);
      };
      const [clusters, changes] = await Promise.all([read(of(clustersOut)), read(of(changesOut))]);
      if (!this.live(http)) return;
      this.analysis.set({ runId: o.run_id, algorithm: o.algorithm ?? '', start: parseIso(o.start), end: parseIso(o.end), clusters, changes });
    }
  }

  // --- data of interest (FR-104 to FR-108; docs/v4-interfaces.md §11) -------------------------------------------
  private workspace() {
    const d = this.discovery.value;
    const user = this.user.value;
    if (!d || !user) return null;
    // The analyst's own workspace: the only one discovery shows them (FR-95).
    const ws = [...d.systems.values()].find((s) => s.uid.endsWith(`:workspace:${user}`));
    return ws ? d.datastreams.find((x) => x.systemId === ws.id) ?? null : null;
  }

  private async readDois(http: ClientHttp) {
    const ws = this.workspace();
    if (!ws) {
      this.dois.set([]);
      return;
    }
    const rows: any[] = await http.get(`datastreams/${ws.id}/observations`, { f: 'application/swe+json', limit: '100000' });
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
    this.dois.set([...items.entries()].map(([id, record]) => ({ id, record, greyed: this.greyed(record) })));
  }

  /** FR-96, FR-96a: a record whose dataset is not imported, or whose sources this user can no longer see. */
  greyed(r: DoiRecord): string | null {
    const d = this.discovery.value;
    if (!d) return null;
    const gone = (r.sources ?? []).filter((s) => !systemByUid(d, s.system));
    if (gone.length) return 'No longer permitted: a source it names is not available to you.';
    if (!this.datasetOf(r)) return `Not imported: import ${r.dataset.file} to restore it.`;
    return null;
  }

  /** The dataset a record names, found again by the file's content hash (FR-96). */
  datasetOf(r: DoiRecord): string | null {
    const e = this.catalogue.value.find((x) => x.sha256 === r.dataset.sha256 && x.dataset && x.status !== 'not-imported' && x.status !== 'importing');
    return e?.dataset ?? null;
  }

  /** FR-104, FR-94a: save the current selection; a resolution no datastream holds is refused, naming those that do. */
  async saveDoi(label: string, note: string, resolution: string): Promise<string | null> {
    const s = this.replay.value;
    const w = this.window();
    const v = this.view.value;
    const ws = this.workspace();
    if (!s || !w || !v || !ws) return 'Nothing to save: no dataset is loaded.';
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
    const runs = new Set(props.flatMap((p) => (p.byRes[res]?.runs ? this.rows(p.byRes[res]!).map((r) => String(r.run)) : [])));
    if (runs.size > 1) record.run = [...runs].sort((a, b) => runNumber(a) - runNumber(b)).pop();
    const id = `d-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const r = await this.user_((http) => http.request('POST', `datastreams/${ws.id}/observations`, {},
      { time: iso(Date.now() / 1000), doi_id: id, action: 'save', record: JSON.stringify(record) }, 'application/swe+json'));
    if (!r || r.status >= 300) return `The server did not keep it (HTTP ${r?.status ?? 'no answer'}).`;
    await this.user_((http) => this.readDois(http));
    this.notify(`Saved "${record.label}".`);
    return null;
  }

  async removeDoi(item: DoiItem) {
    const ws = this.workspace();
    if (!ws) return;
    await this.user_((http) => http.request('POST', `datastreams/${ws.id}/observations`, {},
      { time: iso(Date.now() / 1000), doi_id: item.id, action: 'remove', record: '' }, 'application/swe+json'));
    if (this.opened.value?.records.some((r) => r.item.id === item.id)) this.opened.set(null);
    await this.user_((http) => this.readDois(http));
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
      if (!d.schemas.has(info.id)) await fetchSchemas(http, d, [info]);
      const schema = d.schemas.get(info.id) ?? [];
      const got: any[] = await http.get(`datastreams/${info.id}/observations`, { f: 'application/swe+json', phenomenonTime: `${r.start}/${r.end}`, limit: '200000' });
      let rows = (got ?? []).map(toRow);
      if (schema.some((f) => f.name === 'run')) rows = r.run ? rows.filter((x) => x.run === r.run) : latestRun(rows);
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

  async openDoi(item: DoiItem) {
    await this.user_(async (http) => {
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
    await this.user_(async (http) => {
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
}

export const clientSession = new DisplayClientSession();
