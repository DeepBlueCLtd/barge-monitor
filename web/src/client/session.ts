// One run of the display client (§8): handshake, self-configuration, the
// current selection, reading and polling, and commands to the clustering model.
// It runs whether or not the monitor is on screen, because the display client is
// a component of the system whose messages are drawn on the flowchart. Restart
// client discards it and starts a new one (FR-46).
//
// Everything here waits on the simulation clock (FR-13): nothing is requested
// before Play is pressed or while paused (AT-19), polling happens once per
// simulated second (FR-63), and waits for Retry-After or a downed server are
// counted in simulated seconds (FR-48, FR-49).
import { nextSimSecond, SIM_EPOCH_UNIX, simClock } from '../shell/clock';
import { runtime } from '../shell/runtime';
import { Store } from '../shell/store';
import { Configuration, Datastream, handshake, SweField } from './handshake';
import { Closed, ClientHttp, HttpError, InstanceChanged, NetworkFailure } from './http';
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

/** One record keyed by field name (application/swe+json); an observation resource's result is flattened the same way. */
function toRow(x: any): Row {
  const flat = x && typeof x.result === 'object' && x.result ? { time: x.phenomenonTime ?? x.resultTime, ...x.result } : x;
  return { ...flat, _t: toSim(flat.time ?? flat.phenomenonTime ?? flat.resultTime) };
}
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
            // A rejected server is not used; wait for a new instance (or Restart client).
            await this.waitForNewInstance();
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
        if (woken && !simClock.playing) await this.awaitRunWhilePaused();
        this.http.userAction = false;
        if (this.stale.value) {
          this.stale.set(false);
          this.banner.set(null);
          this.phase.set(this.config.value?.problems.length ? 'degraded' : 'configured');
        }
      } catch (e) {
        if (e instanceof Closed || this.closed) return;
        if (e instanceof InstanceChanged) {
          // FR-48: a new server start. Clear state and repeat the handshake.
          this.reset(`The server restarted (${e.message}): handshaking again.`);
        } else if (e instanceof NetworkFailure) {
          // FR-49: keep the last data, marked stale; retry on the simulation clock.
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
    this.http.instance = null;
    this.loadedGen = 0;
    this.commandDirty = true;
    this.stale.set(false);
    this.banner.set(note);
    this.phase.set('handshake');
    this.bump();
  }

  private async configure() {
    this.phase.set('handshake');
    const config = await handshake(this.http, (s) => {
      this.phase.set('waiting');
      this.banner.set(`The server is starting (HTTP 503): retrying after ${s} s, as Retry-After asks.`);
    });
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

  private async waitForNewInstance() {
    for (;;) {
      await nextSimSecond(() => this.closed);
      if (this.closed) throw new Closed('');
      try {
        await this.http.request('GET', '');
      } catch (e) {
        if (e instanceof InstanceChanged) {
          this.reset('The server restarted: handshaking again.');
          return;
        }
        if (!(e instanceof NetworkFailure)) throw e;
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
    let params: Record<string, string> = { phenomenonTime, limit: '100000' };
    for (let page = 0; page < 30; page++) {
      const r = await this.http.get<any>(`datastreams/${ds.id}/observations`, params);
      this.lastRead.set({ chain: r.chain, raw, outputName: ds.outputName });
      if (r.status !== 200) throw new HttpError(`observations of ${ds.outputName}`, r.status, r.body);
      const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.items ?? [];
      for (const x of rows) out.push(toRow(x));
      const link = r.headers.get('link');
      const next = link?.split(',').map((s) => s.match(/<([^>]+)>\s*;\s*rel="?next"?/)).find(Boolean);
      if (!next || !rows.length) break;
      params = Object.fromEntries(new URLSearchParams(next[1].split('?')[1] ?? ''));
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
    const parameters = { algorithm: sel.algorithm, fields: props.map((p) => p.name).join(','), period: sel.period };
    const r = await this.http.request<any>('POST', `controlstreams/${cs.id}/commands`, {}, { parameters });
    if (r.status === 503) return; // waiting mode: send it again on a later second
    this.commandDirty = false;
    if (r.status >= 400) {
      this.commandNote.set(`Command refused (HTTP ${r.status}): ${r.body?.refused ?? r.body?.description ?? JSON.stringify(r.body)}`);
      return;
    }
    this.commandNote.set(null);
    this.commandId = r.body?.id ?? null;
    this.awaitingRun = true;
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
    const r = await this.http.get<any>(`datastreams/${runs.id}/observations`, { resultTime: 'latest' });
    if (r.status !== 200) return;
    const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.items ?? [];
    const latest = rows.length ? (toRow(rows[rows.length - 1]) as unknown as Run) : undefined;
    if (!latest || latest.run_id === this.run.value?.run_id) return;
    if (!this.commandId || latest.command_id === this.commandId) this.awaitingRun = false;
    const clusters = runStream(config!, 'clusters');
    const changes = runStream(config!, 'changes');
    this.clusters = clusters ? await this.readAll(clusters) : [];
    this.changes = changes ? await this.readAll(changes) : [];
    this.run.set(latest);
    this.bump();
  }

  private async readAll(ds: Datastream): Promise<Row[]> {
    const rows = await this.http.all<any>(`datastreams/${ds.id}/observations`, { limit: '100000' });
    return rows.map(toRow);
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
