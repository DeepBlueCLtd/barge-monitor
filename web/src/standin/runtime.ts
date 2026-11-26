// The running stand-in back end (FR-06a; runtime.py, bridge.py): the
// simulation clock, the logger store loaded with the pre-calculated history
// and continued by the platform, the data server's lifecycle and the
// core models. The store and platform run continuously; the data
// server is started, restarted, taken down and brought up around them
// (FR-18, FR-47, FR-49). Field toggles are pending until the next server
// start (FR-51). Free of DOM, worker and Node globals: it runs in the
// stand-in worker and, for the contract suite, in Node (PR-04).
//
// 4.7 (plan Phase 4): the server behaves as a configured stock OpenSensorHub
// (docs/v4-interfaces.md §9): accounts and roles, commands pushed to
// subscribers, no 503 and no instance identifier.
import { Accounts } from './accounts';
import { Api, HttpRequest, HttpResponse } from './api';
import { CLOCK_DEFAULT_RATE, CLOCK_RATES, SENSORS, URN } from './constants';
import { CATALOGUE, Offering } from './fields';
import { DataCleanse } from './models/dataCleanse';
import { Model, ModelApi, Runner } from './models/csmodel';
import { Summaries } from './models/summaries';
import { Analysis } from './models/analysis';
import { Platform } from './platform';
import { ControlstreamRec, Hub, StatusReport, Store } from './resources';
import { Server } from './server';
import { LoggerStore } from './store';
import { Tap } from './tap';

/** The simulation clock (clock.py): starts off; the host's monotonic time only paces it (FR-13, FR-77). */
export class SimClock {
  private sim: number;
  private rate = CLOCK_DEFAULT_RATE;
  private isPlaying = false;
  private last: number;

  constructor(start: number, private readonly host: () => number) {
    this.sim = start;
    this.last = host();
  }

  now(): number {
    const h = this.host();
    if (this.isPlaying) this.sim += Math.max(0, h - this.last) * this.rate;
    this.last = h;
    return this.sim;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  play() {
    this.now();
    this.isPlaying = true;
  }

  pause() {
    this.now();
    this.isPlaying = false;
  }

  setRate(rate: number) {
    if (!CLOCK_RATES.includes(rate)) throw new Error(`rate must be one of ${JSON.stringify(CLOCK_RATES)}`);
    this.now();
    this.rate = rate;
  }

  state() {
    return { t: this.now(), rate: this.rate, playing: this.isPlaying, rates: CLOCK_RATES, default_rate: CLOCK_DEFAULT_RATE };
  }
}

export interface HistoryManifest {
  seed: number;
  code_hash?: string;
  days: number;
  end_t: number;
  files: { name: string; bytes: number; gz: number }[];
  capture_counts?: Record<string, number>;
}

export interface History {
  manifest: HistoryManifest;
  files: Map<string, Uint8Array>;
}

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

/** The core models, run in-process on the simulation clock (local_models.py), each with its service account. */
class LocalModels {
  readonly runners: Runner[] = [];
  private busy = new Set<Runner>();

  constructor(private readonly rt: Runtime, models: Model[]) {
    for (const m of models) this.add(m);
  }

  add(m: Model): Runner {
    // The same HTTP requests as a model in its own worker makes, handed straight to the HTTP layer.
    const r = new Runner(m, new ModelApi(m.id, `svc-${m.id}`, (req) => this.rt.handle(req), this.rt));
    this.runners.push(r);
    return r;
  }

  private async one(r: Runner): Promise<void> {
    try {
      await r.tick(this.rt.clock.playing);
    } catch (e) { // a broken model never stops the others (FR-33)
      r.phase = 'failed';
      r.detail = `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`;
    }
    this.rt.phases.set(r.model.id, { label: r.model.label, phase: r.phase, detail: r.detail });
  }

  /** Step every model that is not still busy with its last step. */
  tick(): void {
    for (const r of this.runners) {
      if (this.busy.has(r)) continue;
      this.busy.add(r);
      void this.one(r).finally(() => this.busy.delete(r));
    }
  }

  /** Step every model once and wait for them all (startup). */
  async tickAll(): Promise<void> {
    await Promise.all(this.runners.filter((r) => !this.busy.has(r)).map((r) => {
      this.busy.add(r);
      return this.one(r).finally(() => this.busy.delete(r));
    }));
  }

  get live(): boolean {
    return this.runners.every((r) => r.phase === 'live');
  }
}

export class Runtime {
  readonly clock: SimClock;
  readonly tap: Tap;
  readonly logger = new LoggerStore();
  readonly store = new Store(); // created resources and their observations: they outlive restarts (D-11)
  readonly accounts = new Accounts(); // the server's accounts and user-to-role assignment (§9.3)
  readonly hub = new Hub(); // push subscriptions (§9.2)
  readonly phases = new Map<string, { label: string; phase?: string; detail?: string }>(); // what each model says of itself
  readonly platform: Platform;
  readonly api: Api;
  readonly models: LocalModels;
  offering = new Offering(); // what the next server start will publish
  lieAboutProfile = false; // a misconfigured server, for AT-07/AT-08
  server: Server | null = null;
  serverStarts = 0;
  down = false;
  /** How long a command's POST is held before it is answered, in real seconds (§9.1). */
  holdS = 5;

  constructor(readonly seed: number, history: History, hostSeconds: () => number,
    private readonly realSeconds: () => number = () => Date.now() / 1000) {
    const m = history.manifest;
    if (m.seed !== seed) throw new Error(`the history is for seed ${m.seed}, not ${seed}`);
    this.clock = new SimClock(m.end_t, hostSeconds);
    this.tap = new Tap(() => this.now());
    // FR-15, FR-06d: the pre-calculated files are the store's contents.
    for (const name of [...history.files.keys()].sort()) this.logger.load(name, history.files.get(name)!);
    for (const [k, v] of Object.entries(m.capture_counts ?? {})) this.tap.counts[k] = (this.tap.counts[k] ?? 0) + v;
    this.platform = new Platform(this.logger, this.tap, seed, m.end_t);
    this.api = new Api(this);
    this.startServer();
    this.models = new LocalModels(this, [new DataCleanse(), new Summaries(), new Analysis()]);
  }

  now(): number {
    return this.clock.now();
  }

  /** Real time, Unix seconds: the stamp on commands and status reports (§9.1). */
  real(): number {
    return this.realSeconds();
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  /** Answering requests. While starting (the index rebuilt) and while down the server answers nothing (§9.1). */
  get running(): boolean {
    return !this.down && this.server !== null && this.server.ready;
  }

  /**
   * Startup: build the index and let the core models catch up their backlog, before the flowchart
   * appears (FR-15). Their calls are counted, not drawn.
   */
  async catchUp(progress?: (p: Progress) => void): Promise<void> {
    const srv = this.server!;
    while (!srv.indexStep()) {
      const p = srv.progress();
      progress?.({ stage: 'index', detail: `store adapter: indexing ${p.indexed} of ${p.stored} records`, pct: 90 + Math.round((4 * p.indexed) / p.stored) });
    }
    for (let i = 0; i < 1000 && !this.models.live; i++) {
      await this.models.tickAll();
      const r = this.models.runners.find((x) => x.phase !== 'live');
      progress?.({ stage: 'models', detail: r ? `${r.model.label}: ${r.detail || r.phase}` : 'models live', pct: 95 });
    }
    this.tap.drain(); // nothing drawn from before the flowchart appears
  }

  /** Bring the store up to the clock; let a starting server rebuild its index; step the models. */
  tick(): void {
    if (this.clock.playing) this.platform.sampleUntil(this.clock.now() + 1);
    if (this.server && !this.down) {
      if (!this.server.ready) this.server.indexStep();
      else this.server.adapter.indexStep(); // the index follows the growing store (FR-21)
    }
    this.models.tick();
  }

  serverStatus(): 'running' | 'waiting' | 'down' {
    return this.down ? 'down' : this.server && this.server.ready ? 'running' : 'waiting';
  }

  /** What the page needs every 100 ms (docs/v4-interfaces.md §13.2). */
  tickMessage() {
    return { messages: this.tap.drain(), clock: this.clock.state(), server: this.serverStatus(), pending_commands: {} };
  }

  /** One request through the seam; null when the server is starting or down (no answer: network failure). */
  handle(req: HttpRequest): Promise<HttpResponse | null> {
    return this.api.handle(req);
  }

  // --- commands: pushed to subscribers (§9.1, §9.2) ------------------------------------------------
  push(cs: ControlstreamRec, cmd: Record<string, unknown>): number {
    const subs = this.hub.subscribers(cs.id);
    for (const s of subs) {
      const who = s.account.component === 'models' ? 'models' : 'client';
      const p = Object.entries(cmd.parameters as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ');
      this.tap.emit('server', who, 'K', `${s.model ? s.model + ': ' : ''}push: ${p}`.slice(0, 120), cmd, { model: s.model ?? undefined, push: true });
      s.put(cmd);
    }
    return subs.length;
  }

  commandStatus(cmdId: string, code: string, message = ''): StatusReport {
    const cmd = this.store.commands.get(cmdId)!;
    const report: StatusReport = { id: this.store.ids.next('status'), 'command@id': cmdId, statusCode: code,
      reportTime: new Date(Math.round(this.real() * 1000)).toISOString() };
    if (message) report.message = message;
    cmd.status.push(report);
    const list = this.store.statusReports.get(cmd['controlstream@id']) ?? [];
    list.push(report);
    this.store.statusReports.set(cmd['controlstream@id'], list);
    return report;
  }

  // --- server lifecycle (FR-47, FR-49) ------------------------------------------------------
  startServer(): void {
    this.hub.closeAll(); // every subscription ends when the server stops (§9.2)
    this.serverStarts += 1;
    this.down = false;
    this.server = new Server(this, this.serverStarts, this.offering, this.tap);
  }

  /** A control action (docs/v4-interfaces.md §13.3); returns the control state. */
  control(action: string, arg?: unknown) {
    switch (action) {
      case 'play': this.clock.play(); break;
      case 'pause': this.clock.pause(); break;
      case 'rate': this.clock.setRate(Number(arg)); break;
      case 'restart-server':
      case 'up': this.startServer(); break;
      case 'down':
        this.hub.closeAll();
        this.down = true;
        this.server = null;
        break;
      case 'field': {
        const a = arg as { name: string; on: boolean };
        if (!CATALOGUE.has(a?.name)) throw new Error(`unknown field ${a?.name}`);
        this.offering.on[a.name] = !!a.on;
        break;
      }
      case 'profile-lie': this.lieAboutProfile = !!arg; break;
      case 'capture': this.tap.enabled = !!arg; break;
      case 'set-role': {
        const a = arg as { user: string; role: string };
        this.accounts.setRole(a.user, a.role);
        break;
      }
      case 'state': break;
      default: throw new Error(`unknown control action ${action}`);
    }
    return this.controlState();
  }

  /** What the control panel and status show (FR-49..FR-52; runtime.control_state). */
  controlState() {
    const live = this.server ? this.server.offering : null;
    const fields = [...CATALOGUE.values()].map((f) => ({
      name: f.name, label: f.label, kind: f.kind, inputs: [...f.inputs], extra: f.extra, essential: f.essential, type: f.swe_type,
      on_next_start: this.offering.on[f.name], published_next_start: this.offering.published(f.name),
      published_now: !!(live && live.published(f.name)),
    }));
    const pending = fields.some((r) => r.published_now !== r.published_next_start)
      || (this.server !== null && this.server.lieAboutProfile !== this.lieAboutProfile);
    const home = this.store.systemByUid(URN + 'process:models');
    const models = [...this.store.systems.values()].filter((s) => home && s.parent === home.id).map((s) => {
      const id = s.uid.split(':').pop()!;
      const mine = new Set([...this.store.systems.values()].filter((x) => x.id === s.id || x.parent === s.id).map((x) => x.id));
      return { id, label: s.label, ...(this.phases.get(id) ?? {}),
        datastreams: [...this.store.datastreams.values()].filter((d) => mine.has(d.system) && !d.replaced).map((d) => d.outputName) };
    });
    return {
      server: this.serverStatus(),
      // The shell's own count of server starts (god's-eye): the server serves no instance identifier (§9.1).
      instance: this.server ? `${this.seed}-${this.server.number}` : null,
      progress: this.server ? this.server.progress() : null,
      fields, pending, lie_about_profile: this.lieAboutProfile,
      clock: this.clock.state(),
      store: { bytes: this.logger.totalBytes(), files: this.logger.listFiles().length, records: this.platform.nextT * SENSORS.length },
      capture_counts: { ...this.tap.counts },
      models,
      accounts: this.accounts.state(),
      backend: 'standin' as const,
    };
  }
}
