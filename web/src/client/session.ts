// One run of the display client (§8): handshake, self-configuration, the
// current selection, reading and polling, and commands to the clustering model.
// It runs whether or not the monitor is on screen, because the display client is
// a component of the system whose messages are drawn on the flowchart. Restart
// client discards it and starts a new one (FR-46).
//
// Everything here waits on the simulation clock (FR-13): nothing is requested
// before Play is pressed or while paused (AT-19), polling happens once per
// simulated second (FR-63), and waits for a downed server are counted in
// simulated seconds (FR-49).
//
// 4.7 (docs/v4-interfaces.md §9.1): the server has no instance identifier and no
// 503. After any period of unreachability the client repeats the handshake (FR-48);
// so it does when a datastream it found is no longer there (a restart with a new
// offering). Observations are asked for with f=application/swe+json, paged by offset.
//
// The bridge to 4.7's models (D-286): the client shows Mission A (handshake.ts). A clustering
// command carries the selection as an unsaved data of interest (§10.3, §11): Mission A, the
// selected bow fields, the period within the dataset, at the resolution the period reads. The
// cluster view and change marks follow Analysis's latest *complete* run in runs__{Mission A}.
import { nextSimSecond, SIM_EPOCH_UNIX, simClock } from '../shell/clock';
import { runtime } from '../shell/runtime';
import { Store } from '../shell/store';
import { Configuration, Datastream, handshake, SweField } from './handshake';
import { Closed, ClientHttp, HttpError, NetworkFailure } from './http';
import { PeriodId, periodOf, properties, Property, Read, readingPlan, RES_S, runStream } from './plan';

export type Row = Record<string, any> & { time: string; _t: number };
export type Phase = 'waiting-play' | 'waiting-models' | 'handshake' | 'configured' | 'degraded' | 'rejected' | 'waiting' | 'unreachable' | 'error';

export interface Selection {
  props: string[]; // property keys, in the order selected
  period: PeriodId;
  algorithm: string;
}

export interface Run {
  run_id: string;
  algorithm?: string;
  fields?: string;
  period?: string;
  window_start?: string;
  window_end?: string;
  clusters?: number;
  score_clusters?: number | null;
  score_changes?: number | null;
  scored_against?: string;
  illustrative?: boolean;
  command_id?: string;
  [k: string]: unknown;
}

export const toSim = (iso: string) => Date.parse(iso) / 1000 - SIM_EPOCH_UNIX;

/** One record keyed by field name (application/swe+json); an observation resource's result is flattened the same way.
 * A missing value arrives as "NaN" (§9.1); the views take it as no value. */
function toRow(x: any): Row {
  const flat = x && typeof x.result === 'object' && x.result ? { time: x.phenomenonTime ?? x.resultTime, ...x.result } : x;
  const row: Row = { ...flat, _t: toSim(flat.time ?? flat.phenomenonTime ?? flat.resultTime) };
  for (const k of Object.keys(row)) if (row[k] === 'NaN') row[k] = null;
  return row;
}
const SWE = 'application/swe+json';
const PAGE = 100_000;
/** Every parameter, on every command (§9.1): what the 4.1 client does not choose is sent at its default. */
const CLUSTERING_DEFAULTS = { clusters: 4, sensitivity: 5 };
/** The resolution a period reads (§11, FR-94a): readings up to an hour, minute means up to a day, then hourly means. */
const DOI_RESOLUTION: Record<PeriodId, string> = { PT1M: 'PT1S', PT1H: 'PT1S', PT6H: 'PT1M', P1D: 'PT1M', P7D: 'PT1H', P28D: 'PT1H' };
const BOW = 'urn:x-barge:sensor:bow';
const isoMs = (t: number) => new Date((SIM_EPOCH_UNIX + t) * 1000).toISOString();
const isoS = (t: number) => new Date(Math.round(SIM_EPOCH_UNIX + t) * 1000).toISOString().replace('.000Z', 'Z');

// Analysis re-runs every ten simulated minutes; a minute's lag in noticing is fine. While a
// command's run is awaited, the client looks every second.
const RUN_POLL_S = 60;
// A datastream the profile gives no resolution is polled once a simulated minute.
const NATIVE_POLL_S = 60;

export class ClientSession {
  readonly http = new ClientHttp();
  phase = new Store<Phase>('waiting-play');
  banner = new Store<string | null>(null);
  config = new Store<Configuration | null>(null);
  props = new Store<Property[]>([]);
  selection = new Store<Selection>({ props: [], period: 'PT1M', algorithm: 'B' });
  /** Bumped when data, the run or the clusters change: views redraw. */
  version = new Store(0);
  stale = new Store(false);
  run = new Store<Run | null>(null);
  commandNote = new Store<string | null>(null);
  /** The handshake in progress: how many requests so far, and the latest (null when none is under way). */
  handshakeStep = new Store<{ n: number; path: string } | null>(null);
  /** The latest observation read for the current selection: the message strip follows its chain (FR-70). */
  lastRead = new Store<{ chain: string; raw: boolean; outputName: string } | null>(null);

  data = new Map<string, Row[]>(); // datastream id -> rows for the current period
  clusters: Row[] = [];
  changes: Row[] = [];
  plan: Read[] = [];
  /** The first chain sequence of the current plan's reads: the message strip looks at those chains (FR-70). */
  planSeq = Infinity;

  private closed = false;
  /** Bumped by every change of fields or period; the data are current when loadedGen matches. */
  private gen = 1;
  private loadedGen = 0;
  private commandDirty = true;
  private woken = false; // a selection changed: act now, without waiting for the next simulated second
  private lastRunPoll = -Infinity;
  private lastPoll = new Map<string, number>(); // datastream id -> simulated time of its last poll
  private awaitingRun = false;
  /** The id of the last accepted command: the run that answers it carries it as command_id. */
  private commandId: string | null = null;
  /** The server did not answer at some point since the last handshake: handshake again once it does (FR-48). */
  private lost = false;
  private lastListed = -Infinity;

  constructor() {
    void this.main();
  }

  close() {
    this.closed = true;
    this.http.closed = true;
  }

  /** Views unavailable in degraded mode, from the profile's `views` of each missing essential (FR-45). */
  unavailableViews(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const p of this.config.value?.problems ?? []) {
      for (const v of p.essential.views ?? []) out.set(v, [...(out.get(v) ?? []), `${p.essential.label ?? p.essential.field} (${p.reason})`]);
    }
    return out;
  }

  selectedProps(): Property[] {
    const all = new Map(this.props.value.map((p) => [p.key, p]));
    return this.selection.value.props.map((k) => all.get(k)).filter((p): p is Property => !!p && !p.unavailable);
  }

  /** FR-53..FR-55: any change of fields, period or algorithm re-reads and sends one command. */
  select(change: Partial<Selection>) {
    const next = { ...this.selection.value, ...change };
    this.selection.set(next);
    if (change.props || change.period) this.gen++;
    this.commandDirty = true;
    // A user action is answered at once, playing or paused (FR-79): the round trip is
    // drawn now rather than at the next simulated second.
    this.woken = true;
  }

  toggleProp(key: string) {
    const cur = this.selection.value.props;
    this.select({ props: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  }

  private bump() {
    this.version.set(this.version.value + 1);
  }

  private async main() {
    const cancelled = () => this.closed;
    while (!this.closed) {
      try {
        if (!this.config.value) {
          // AT-19: the client is part of the system; it starts when the clock does.
          if (!simClock.playing) this.phase.set('waiting-play');
          await nextSimSecond(cancelled);
          if (this.closed) return;
          // The core models register their own datastreams (FR-28); a handshake before they are
          // live would rightly find essentials missing. Wait for them, on the simulation clock.
          if (!runtime.coreModelsLive()) {
            this.phase.set('waiting-models');
            continue;
          }
          await this.configure();
          if (this.phase.value === 'rejected') {
            // A rejected server is not used; wait until it changes (or Restart client).
            await this.waitForChange();
            continue;
          }
        }
        await nextSimSecond(() => cancelled() || this.woken);
        if (this.closed) return;
        const woken = this.woken;
        this.woken = false;
        this.http.userAction = woken;
        if (this.loadedGen !== this.gen) await this.load();
        else if (!woken) await this.poll();
        if (this.commandDirty) await this.command();
        await this.pollRun();
        await this.checkListing();
        if (woken && !simClock.playing) await this.awaitRunWhilePaused();
        this.http.userAction = false;
        if (this.lost) {
          // FR-48: after any period of unreachability, repeat the handshake.
          this.lost = false;
          this.reset('The server answers again: handshaking again.');
        }
      } catch (e) {
        if (e instanceof Closed || this.closed) return;
        if (e instanceof HttpError && e.status === 404 && e.path.startsWith('observations')) {
          // A datastream found at the handshake is no longer there: the server restarted with another offering.
          this.reset('A source the client found is no longer offered: handshaking again.');
        } else if (e instanceof NetworkFailure) {
          // FR-49: keep the last data, marked stale; retry on the simulation clock.
          this.lost = true;
          this.stale.set(true);
          this.phase.set('unreachable');
          this.banner.set('Server unreachable: showing the last data received, marked stale. Retrying every simulated second.');
          await nextSimSecond(cancelled);
        } else {
          console.warn('display client:', e);
          this.banner.set(e instanceof HttpError ? `The server refused a request: ${e.message}` : `Error: ${String(e)}`);
          await nextSimSecond(cancelled);
        }
      }
    }
  }

  private reset(note: string) {
    this.config.set(null);
    this.props.set([]);
    this.data.clear();
    this.clusters = [];
    this.changes = [];
    this.plan = [];
    this.run.set(null);
    this.lost = false;
    this.loadedGen = 0;
    this.commandDirty = true;
    this.stale.set(false);
    this.banner.set(note);
    this.phase.set('handshake');
    this.bump();
  }

  private async configure() {
    this.phase.set('handshake');
    // Each handshake request waits for the reply before it to be drawn arriving (D-89).
    this.http.paced = true;
    this.http.onPaced = (n, path) => this.handshakeStep.set({ n, path });
    let config: Configuration;
    try {
      config = await handshake(this.http);
    } finally {
      this.http.paced = false;
      this.handshakeStep.set(null);
    }
    this.banner.set(null);
    this.config.set(config);
    const props = properties(config);
    this.props.set(props);
    // Default selection: the profile's raw essentials (bow air temperature and wind speed).
    const rawEssentials = new Set((config.profile?.essentials ?? []).filter((e) => e.resolution === 'raw').map((e) => e.field));
    const defaults = props.filter((p) => !p.unavailable && rawEssentials.has(p.name)).map((p) => p.key);
    const keep = this.selection.value.props.filter((k) => props.some((p) => p.key === k && !p.unavailable));
    this.selection.set({ ...this.selection.value, props: keep.length ? keep : defaults });
    this.phase.set(config.rejected ? 'rejected' : config.problems.length || !config.claimed ? 'degraded' : 'configured');
    this.loadedGen = 0;
    this.commandDirty = true;
    this.bump();
  }

  /**
   * D-286: Mission A's datastreams keep their identifiers when the server restarts with another offering (their schema
   * changes in place), so a 404 no longer tells the client. Every ten simulated seconds it looks whether a datastream
   * listed at its handshake has gone from the listing (the logger's `weather`, made again for each offering).
   */
  private async checkListing() {
    const now = simClock.now();
    if (now - this.lastListed < 10) return;
    this.lastListed = now;
    const known = this.config.value?.listed ?? [];
    if (!known.length) return;
    const r = await this.http.request<any>('GET', 'datastreams', { limit: '10000' });
    if (r.status !== 200) return;
    const ids = new Set((r.body?.items ?? []).map((d: any) => d.id));
    if (known.some((id) => !ids.has(id))) this.reset('The server changed: handshaking again.');
  }

  /** A rejected server: look once a simulated second whether it has changed (it went away, or the datastreams it lists did). */
  private async waitForChange() {
    const known = (this.config.value?.datastreams ?? []).map((d) => d.id);
    for (;;) {
      await nextSimSecond(() => this.closed);
      if (this.closed) throw new Closed('');
      try {
        const r = await this.http.request<any>('GET', 'datastreams', { limit: '10000' });
        const now = new Set((r.body?.items ?? []).map((d: any) => d.id));
        if (this.lost || r.status !== 200 || known.some((id) => !now.has(id))) { // a source it found has gone
          this.reset('The server changed: handshaking again.');
          return;
        }
      } catch (e) {
        if (!(e instanceof NetworkFailure)) throw e;
        this.lost = true;
      }
    }
  }

  /** FR-54: one set of requests for the selection and period. */
  private async load() {
    const gen = this.gen;
    const seq = this.http.nextSeq;
    const sel = this.selection.value;
    const plan = readingPlan(this.selectedProps(), sel.period);
    const now = simClock.now();
    const t0 = now - periodOf(sel.period).seconds;
    const data = new Map<string, Row[]>();
    for (const r of plan) {
      data.set(r.ds.id, await this.read(r.ds, `${isoS(t0)}/${isoS(now)}`, r.raw));
      if (gen !== this.gen) return; // the selection changed meanwhile: start again
    }
    this.plan = plan;
    this.lastPoll = new Map(plan.map((r) => [r.ds.id, now]));
    this.data = data;
    this.loadedGen = gen;
    this.planSeq = seq;
    this.bump();
  }

  private async read(ds: Datastream, phenomenonTime: string, raw: boolean): Promise<Row[]> {
    const out: Row[] = [];
    // SWE JSON carries no next link: page by offset until a page comes back short (§9.1).
    for (let page = 0, offset = 0; page < 30; page++, offset += PAGE) {
      const r = await this.http.get<any>(`datastreams/${ds.id}/observations`,
        { f: SWE, phenomenonTime, limit: String(PAGE), ...(offset ? { offset: String(offset) } : {}) });
      this.lastRead.set({ chain: r.chain, raw, outputName: ds.outputName });
      if (r.status !== 200) throw new HttpError(`observations of ${ds.outputName}`, r.status, r.body);
      const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.items ?? [];
      for (const x of rows) out.push(toRow(x));
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /** FR-63: once per simulated second, from the last reading received onwards. */
  private async poll() {
    const sel = this.selection.value;
    const now = simClock.now();
    const cut = now - periodOf(sel.period).seconds;
    let changed = false;
    for (const r of this.plan) {
      // Poll each datastream only as often as it can change: raw records every simulated
      // second (FR-63), 1-minute means every minute, hourly means every hour.
      const every = RES_S[r.ds.resolution] ?? NATIVE_POLL_S;
      const polled = this.lastPoll.get(r.ds.id) ?? -Infinity;
      if (now - polled < every) continue;
      this.lastPoll.set(r.ds.id, now);
      const have = this.data.get(r.ds.id) ?? [];
      const last = have.length ? have[have.length - 1]._t : now - 1;
      const rows = await this.read(r.ds, `${isoMs(last + 0.001)}/..`, r.raw);
      if (this.loadedGen !== this.gen) return;
      const fresh = rows.filter((x) => x._t > last);
      const kept = have[0] && have[0]._t < cut ? have.filter((x) => x._t >= cut) : have;
      if (fresh.length || kept !== have) {
        this.data.set(r.ds.id, fresh.length ? kept.concat(fresh) : kept);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  /** FR-55: one command (K) to Analysis's clustering control stream for the current selection. */
  private async command() {
    const cs = this.config.value?.clustering;
    const props = this.selectedProps();
    if (!cs || !props.length || this.unavailableViews().has('clusters')) {
      this.commandDirty = false;
      return;
    }
    const sel = this.selection.value;
    const doi = this.doi(props, sel.period);
    if (!doi) { // nothing of the selection in Mission A's period: the cluster view keeps Analysis's latest run
      this.commandDirty = false;
      return;
    }
    const parameters = { ...CLUSTERING_DEFAULTS, algorithm: sel.algorithm, doi: JSON.stringify(doi) };
    this.commandDirty = false;
    this.commandNote.set(null);
    this.commandId = null;
    this.awaitingRun = true;
    // The server holds the answer for about 5 s (§9.1); the sender never waits on it (FR-27, AT-39): the run that
    // answers the command is found by polling, as before.
    this.http.request<any>('POST', `controlstreams/${cs.id}/commands`, {}, { parameters }).then((r) => {
      if (r.status >= 400) this.commandNote.set(`Command refused (HTTP ${r.status})`);
      else if (r.status === 202) this.commandNote.set('No model is listening: the command was dropped.');
      else this.commandId = r.body?.id ?? null;
    }, () => { this.commandDirty = true; });
  }

  /** The selection as an unsaved data of interest (§11; D-286): the bow's fields in Mission A, over the period. */
  private doi(props: Property[], period: PeriodId): Record<string, unknown> | null {
    const ds = this.config.value?.dataset;
    const fields = props.filter((p) => p.sources.some((s) => s.ds.systemUid === BOW && s.ds.outputName === 'weather')).map((p) => p.name);
    if (!ds || !fields.length) return null;
    const now = simClock.now();
    const start = Math.max(now - periodOf(period).seconds, toSim(ds.start));
    const end = Math.min(now, toSim(ds.end));
    if (end - start < 60) return null;
    return {
      version: 1, label: 'selection', dataset: { file: ds.file, size: ds.size, modified: ds.modified, sha256: ds.sha256 },
      start: isoS(start), end: isoS(end), resolution: DOI_RESOLUTION[period], aggregation: 'as-stored',
      sources: [{ system: BOW, output: 'weather', fields }],
    };
  }

  /** After a user action while paused: look for the command's run a few times, then stop (AT-19). */
  private async awaitRunWhilePaused() {
    for (let i = 0; i < 6 && this.awaitingRun && !this.closed && !simClock.playing && !this.woken; i++) {
      await new Promise((r) => setTimeout(r, 700));
      await this.pollRun();
    }
  }

  /** The cluster view and change marks follow the latest run (docs/v4-interfaces.md §6). */
  private async pollRun() {
    const now = simClock.now();
    if (!this.awaitingRun && now - this.lastRunPoll < RUN_POLL_S) return;
    this.lastRunPoll = now;
    const config = this.config.value;
    const runs = config && runStream(config, 'runs');
    if (!runs) return;
    const r = await this.http.get<any>(`datastreams/${runs.id}/observations`, { f: SWE, resultTime: 'latest' });
    if (r.status !== 200) return;
    const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.items ?? [];
    const row = rows.length ? toRow(rows[rows.length - 1]) : undefined;
    // 4.7 (D-286): a run is read once complete; its data range is its start and end.
    if (!row || row.status !== 'complete' || row.run_id === this.run.value?.run_id) return;
    const sel = this.selection.value;
    const latest: Run = { ...row, run_id: String(row.run_id), window_start: row.start, window_end: row.end, period: sel.period,
      illustrative: runtime.kind === 'standin' } as Run;
    this.awaitingRun = false;
    const clusters = runStream(config!, 'clusters');
    const changes = runStream(config!, 'changes');
    this.clusters = clusters ? await this.readRun(clusters, latest) : [];
    this.changes = changes ? await this.readRun(changes, latest) : [];
    this.run.set(latest);
    this.bump();
  }

  /** A run's outputs: appended, never replaced (FR-28a), so those in the run's data range that carry its run_id. */
  private async readRun(ds: Datastream, run: Run): Promise<Row[]> {
    const range = run.window_start && run.window_end ? `${run.window_start}/${run.window_end}` : undefined;
    const r = await this.http.get<any>(`datastreams/${ds.id}/observations`, { f: SWE, limit: String(PAGE), ...(range ? { phenomenonTime: range } : {}) });
    const rows: any[] = r.status === 200 && Array.isArray(r.body) ? r.body : [];
    return rows.map(toRow).filter((x) => x.run_id === run.run_id);
  }

  /** The rows read for a property in the current plan. */
  series(p: Property): { field: SweField; rows: Row[] } | null {
    for (const r of this.plan) {
      const i = r.props.indexOf(p);
      if (i >= 0) return { field: r.fields[i], rows: this.data.get(r.ds.id) ?? [] };
    }
    // Matched by key, in case the property objects were rebuilt.
    for (const r of this.plan) {
      const i = r.props.findIndex((q) => q.key === p.key);
      if (i >= 0) return { field: r.fields[i], rows: this.data.get(r.ds.id) ?? [] };
    }
    return null;
  }
}

/** The current display client. Restart client replaces it (FR-46). */
export const clientSession = new Store<ClientSession>(new ClientSession());

export function restartClient() {
  clientSession.value.close();
  clientSession.set(new ClientSession());
}
