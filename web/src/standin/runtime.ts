// The running stand-in back end (FR-06a; runtime.py, bridge.py): the data server's lifecycle,
// its store and its modules, and the core models. The data server is started, restarted, taken
// down and brought up (FR-47, FR-49). Field toggles are pending until the next server start
// (FR-51). Free of DOM, worker and Node globals: it runs in the stand-in worker and, for the
// contract suite, in Node (PR-04).
//
// The server behaves as a configured stock OpenSensorHub (docs/v4-interfaces.md §9): accounts and
// roles, commands pushed to subscribers, no 503 and no instance identifier. The CSV importer is a
// module of the data server (importer.ts): at each server start it registers and lists the data
// folder, and at the first start of a page load imports Mission A silently (FR-15); only then does
// the server answer. Reset instance (FR-50a) deletes the whole store and starts the server again,
// empty. There is no simulation clock, world or logger: the 4.1 remnants are retired (plan Phase 8,
// D-320).
import { Accounts } from './accounts';
import { Api, HttpRequest, HttpResponse } from './api';
import { URN } from './constants';
import { CATALOGUE, Offering } from './fields';
import { DataCleanse } from './models/dataCleanse';
import { Model, ModelApi, Runner } from './models/csmodel';
import { Summaries } from './models/summaries';
import { Analysis } from './models/analysis';
import type { Folder } from './folder';
import { Gate } from './gate';
import { EMPTY_FOLDER, Importer } from './importer';
import { ControlstreamRec, Hub, StatusReport, Store } from './resources';
import { Server } from './server';
import { Tap } from './tap';

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

/** The core models, run in-process (local_models.py), each with its service account. They follow no clock (§10.2). */
class LocalModels {
  readonly runners: Runner[] = [];
  private busy = new Set<Runner>();

  constructor(private readonly rt: Runtime, models: Model[]) {
    for (const m of models) this.add(m);
  }

  add(m: Model): Runner {
    // The same HTTP requests as a model in its own worker makes, handed straight to the HTTP layer. While the system is
    // held (D-362) a request waits before it is sent, and its answer before it is read, as a model worker's does.
    const r = new Runner(m, new ModelApi(m.id, `svc-${m.id}`, async (req) => {
      await this.rt.gate.wait();
      const res = await this.rt.handle(req);
      await this.rt.gate.wait();
      return res;
    }, this.rt));
    this.runners.push(r);
    return r;
  }

  private async one(r: Runner): Promise<void> {
    try {
      await r.step();
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

  /** Registered and subscribed: each model answers commands, and processes datasets as they come. */
  get ready(): boolean {
    return this.runners.every((r) => !['starting', 'subscribing'].includes(r.phase));
  }
}

export class Runtime {
  readonly tap: Tap;
  store = new Store(); // created resources and their observations: they outlive restarts (D-11), not Reset instance
  readonly accounts = new Accounts(); // the server's accounts and user-to-role assignment (§9.3)
  readonly hub = new Hub(); // push subscriptions (§9.2)
  readonly phases = new Map<string, { label: string; phase?: string; detail?: string }>(); // what each model says of itself
  readonly api: Api;
  readonly models: LocalModels;
  offering = new Offering(); // what the next server start will publish
  lieAboutProfile = false; // a misconfigured server, for AT-07/AT-08
  server: Server | null = null;
  serverStarts = 0;
  down = false;
  /** How long a command's POST is held before it is answered, in real seconds (§9.1). */
  holdS = 5;
  /** The CSV importer, a module of the data server (§7). */
  readonly importer: Importer;
  /** Mission A is imported silently once per page load, only when asked (D-366: `?mission-a`, for tests); not again
   * after Reset instance (FR-15, FR-50a). By default the page opens with no dataset loaded. */
  silentImport = false;
  instanceResets = 0;
  /** The demonstrator's system hold (D-362): the importer, the core models and pushed commands wait while it is held. */
  gate = new Gate();

  constructor(folder: Folder = EMPTY_FOLDER, private readonly realSeconds: () => number = () => Date.now() / 1000) {
    this.importer = new Importer(this, folder);
    this.tap = new Tap(() => this.real());
    this.api = new Api(this);
    this.startServer();
    this.models = new LocalModels(this, [new DataCleanse(), new Summaries(), new Analysis()]);
  }

  /** Real time, Unix seconds (there is no simulated time any more). */
  now(): number {
    return this.real();
  }

  /** Real time, Unix seconds: the stamp on commands and status reports (§9.1). */
  real(): number {
    return this.realSeconds();
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  /** Answering requests. While starting (its modules starting) and while down the server answers nothing (§9.1). */
  get running(): boolean {
    return !this.down && this.server !== null && this.server.ready;
  }

  /**
   * Startup: start the server's modules (the CSV importer, which imports Mission A silently), and let the core
   * models register and subscribe, before the flowchart appears (FR-15). Their calls are counted, not drawn.
   */
  async catchUp(progress?: (p: Progress) => void): Promise<void> {
    const srv = this.server!;
    progress?.({ stage: 'import', detail: `the CSV importer: listing the data folder${this.silentImport ? ' and importing Mission A' : ''}`, pct: 94 });
    srv.starting = true;
    await this.startModules(srv);
    // The models register and subscribe before the flowchart appears; they then process each dataset (§10.2).
    for (let i = 0; i < 1000 && !this.models.ready; i++) {
      await this.models.tickAll();
      const r = this.models.runners.find((x) => x.phase !== 'live');
      progress?.({ stage: 'models', detail: r ? `${r.model.label}: ${r.detail || r.phase}` : 'models live', pct: 95 });
    }
    this.tap.drain(); // nothing drawn from before the flowchart appears
  }

  /** Let a starting server start its modules; step the models. */
  tick(): void {
    const srv = this.server;
    if (srv && !this.down && !srv.ready && !srv.starting) {
      srv.starting = true;
      void this.startModules(srv);
    }
    if (!this.gate.isHeld) this.models.tick(); // held (D-362): no model takes a new step
  }

  // --- the server's modules: the CSV importer (§7) -----------------------------------------------
  /**
   * At each start: the importer registers and lists the folder, imports Mission A silently at the first
   * start of a page load (FR-15), and the server then answers. The importer subscribes once it does.
   */
  async startModules(srv: Server): Promise<void> {
    try {
      await this.importer.start();
      if (this.silentImport) {
        this.silentImport = false;
        await this.importer.silentImport();
      }
    } catch (e) { // a broken folder never stops the server
      this.tap.emit('importer', 'server', 'I', `importer: ${String((e as Error)?.message ?? e)}`, String(e), { quiet: true });
    }
    if (srv !== this.server || this.down) return;
    srv.ready = true;
    await this.importer.listen();
  }

  /** For the page's loading steps (§13.7): `import` while starting, then `ready` (or `down`). */
  startupPhase(): string {
    if (!this.server || this.down) return 'down';
    return this.server.phase();
  }

  /**
   * FR-50a: stop the server, delete its whole store, and start it again empty: no dataset imported, no results,
   * no data of interest. Nothing is deleted record by record, and the data folder is untouched. Mission A is not
   * imported again until the page is reloaded (FR-15). Identifiers keep counting (runtime.reset_instance).
   */
  resetInstance(): void {
    this.hub.closeAll();
    this.server = null;
    this.store = new Store(this.store.ids);
    this.importer.reset();
    this.instanceResets += 1;
    this.startServer();
  }

  serverStatus(): 'running' | 'waiting' | 'down' {
    return this.down ? 'down' : this.server && this.server.ready ? 'running' : 'waiting';
  }

  /** What the page needs every 100 ms (docs/v4-interfaces.md §13.2). */
  tickMessage() {
    return { messages: this.tap.drain(), server: this.serverStatus() };
  }

  /** One request through the seam; null when the server is starting or down (no answer: network failure). */
  handle(req: HttpRequest): Promise<HttpResponse | null> {
    return this.api.handle(req);
  }

  // --- commands: pushed to subscribers (§9.1, §9.2) ------------------------------------------------
  push(cs: ControlstreamRec, cmd: Record<string, unknown>): number {
    const subs = this.hub.subscribers(cs.id);
    for (const s of subs) {
      const who = s.account.component === 'models' || s.account.component === 'importer' ? s.account.component : 'client';
      const p = Object.entries(cmd.parameters as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ');
      // Held (D-362): the command waits in the server, and is written to the stream, and captured, when let go.
      this.gate.after(() => {
        this.tap.emit('server', who, 'K', `${s.model ? s.model + ': ' : ''}push: ${p}`.slice(0, 120), cmd, { model: s.model ?? undefined, push: true });
        s.put(cmd);
      });
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
      case 'profile-lie': this.lieAboutProfile = typeof arg === 'object' && arg !== null ? !!(arg as { on?: boolean }).on : !!arg; break;
      case 'capture': this.tap.enabled = !!arg; break;
      case 'reset-instance': this.resetInstance(); break;
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

  /**
   * A model's runs (FR-35b, interfaces §13.4; runtime._runs), god's-eye: the latest entry of each run in its runs logs,
   * the restricted one included.
   */
  private runs(systems: Set<string>): { dataset: string; run_id: string; status: string; pct: number | null }[] {
    const out = new Map<string, { dataset: string; run_id: string; status: string; pct: number | null }>();
    for (const d of this.store.datastreams.values()) {
      if (!systems.has(d.system) || d.replaced || !d.outputName.startsWith('runs__') || !d.series.length) continue;
      const n = d.series.length;
      const cols = d.series.take([...Array(n).keys()], ['run_id', 'status', 'pct']) as Record<string, ArrayLike<unknown>>;
      if (!cols.run_id) continue;
      for (let i = 0; i < n; i++) {
        const run = String(cols.run_id[i]);
        const pct = Number(cols.pct?.[i]);
        out.set(run, { dataset: d.outputName.slice('runs__'.length), run_id: run, status: String(cols.status?.[i] ?? ''),
          pct: Number.isFinite(pct) ? pct : null });
      }
    }
    return [...out.values()];
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
        datastreams: [...this.store.datastreams.values()].filter((d) => mine.has(d.system) && !d.replaced).map((d) => d.outputName),
        runs: this.runs(mine) };
    });
    return {
      server: this.serverStatus(),
      // The shell's own count of server starts (god's-eye): the server serves no instance identifier (§9.1).
      instance: this.server ? String(this.server.number) : null,
      fields, pending, lie_about_profile: this.lieAboutProfile,
      capture_counts: { ...this.tap.counts },
      capture: this.tap.enabled,
      models,
      accounts: this.accounts.state(),
      backend: 'standin' as const,
      folder: this.importer.folderState(),
      datasets: this.importer.datasetsState(),
      import_rate: this.importer.rate,
      importer: { subscribed: this.importer.subscribed, silent_done: !this.silentImport },
      resets: this.instanceResets,
    };
  }
}
