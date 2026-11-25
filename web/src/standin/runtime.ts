// The running stand-in back end (FR-06a; docs/v4-interfaces.md §13): the data
// folder, the CSV importer, the replay controller, the data server's stand-in,
// the access gateway in front of it, and the core models. The store outlives
// server restarts; Reset instance deletes it (FR-50a). Freeze holds every
// request and push, and the replay clock (§4). Free of DOM, worker and Node
// globals: it runs in the stand-in worker and in the Node harness (PR-04).
import { Accounts, DEMO_ACCOUNTS, readsEmissions, serviceAccount } from './accounts';
import { Api, HttpRequest, HttpResponse } from './api';
import { START_S } from './constants';
import { CATALOGUE, Offering } from './fields';
import type { Folder } from './folder';
import { Gateway } from './gateway';
import { Importer } from './importer';
import { Analysis } from './models/analysis';
import { Api as ModelApi, Model } from './models/csmodel';
import { DataCleanse } from './models/dataCleanse';
import { Runner } from './models/runner';
import { Summaries } from './models/summaries';
import { ReplayController } from './replay';
import { Server } from './server';
import { Store } from './store';
import { Tap } from './tap';
import { sleep } from './time';

export interface Progress {
  stage: string;
  detail: string;
  pct: number;
}

export type ServerStatus = 'running' | 'starting' | 'down';

function password(user: string): string {
  return DEMO_ACCOUNTS.find(([u]) => u === user)![1];
}

export class Runtime {
  readonly tap = new Tap();
  readonly accounts = new Accounts();
  store = new Store();
  offering = new Offering(); // what the next server start will publish
  lieAboutProfile = false;
  server: Server | null = null;
  status: ServerStatus = 'down';
  frozen = false;
  readonly api: Api;
  readonly gateway: Gateway;
  importer!: Importer;
  replay!: ReplayController;
  runners: Runner[] = [];
  private thawWaiters: (() => void)[] = [];
  private startSeq = 0;

  constructor(readonly folder: Folder) {
    const rt = this;
    this.api = new Api({ get server() { return rt.server!; }, tap: this.tap, accounts: this.accounts });
    this.gateway = new Gateway({ server: () => rt.server!, api: () => rt.api, tap: this.tap, accounts: this.accounts });
    this.tap.replayTime = () => (this.replay?.dataset ? this.replay.time : null);
    this.makeComponents();
  }

  private makeComponents(): void {
    this.importer = new Importer({
      tap: this.tap, folder: this.folder, account: () => this.accounts.byUser.get('svc-importer')!, thawed: () => this.thawed(),
    });
    this.replay = new ReplayController(new ModelApi({
      user: 'svc-replay', password: password('svc-replay'), component: 'replay', tap: this.tap, send: (r) => this.handleInternal(r),
    }), () => this.frozen);
    const models: Model[] = [new DataCleanse(), new Summaries(), new Analysis()];
    this.runners = models.map((m) => {
      const user = serviceAccount(m.id);
      m.senderReadsEmissions = (u) => {
        const role = u ? this.accounts.role(u) : null; // D-152: the sender's role, from the delivered assignment
        return role !== null && readsEmissions(role);
      };
      return new Runner(m, new ModelApi({ user, password: password(user), model: m.id, component: 'models', tap: this.tap, send: (r) => this.handle(r) }));
    });
  }

  /** Startup: the server, the importer's listing, the silent import of Mission A, the replay at its start (FR-15, FR-77). */
  async boot(progress?: (p: Progress) => void, silentImport = true): Promise<void> {
    progress?.({ stage: 'server', detail: 'starting the data server (OpenSensorHub stand-in)', pct: 10 });
    this.startServerNow();
    await this.importer.attach(this.server!, true);
    this.replay.start();
    for (const r of this.runners) r.start();
    if (silentImport) {
      const a = [...this.importer.files.keys()].find((f) => /^MISSION_A_/i.test(f));
      if (a) {
        progress?.({ stage: 'import', detail: `importing ${a} (silently, FR-15)`, pct: 30 });
        const id = await this.importer.importFile(a, true);
        const d = this.importer.datasets.get(id)!;
        progress?.({ stage: 'replay', detail: `loading ${id}, paused at its start`, pct: 80 });
        while (!this.replay.ready) await sleep(0.02);
        await this.replay.loadAtStartup({ id, start: d.start, end: d.end });
      }
    }
    progress?.({ stage: 'ready', detail: 'running', pct: 100 });
  }

  // --- the seam ------------------------------------------------------------------------------------
  /** Resolves at once, or when Freeze is released, in the order asked (§4). */
  thawed(): Promise<void> {
    if (!this.frozen) return Promise.resolve();
    return new Promise((r) => this.thawWaiters.push(r));
  }

  private async gate(): Promise<boolean> {
    await this.thawed();
    return this.status === 'running' && this.server !== null;
  }

  /** A request from the display client or a model: through the access gateway (§9.5). null: no answer (down, starting). */
  async handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!(await this.gate())) return null;
    return this.gateway.handle(req);
  }

  /** A request from a module inside the server (the replay controller): not through the gateway. */
  async handleInternal(req: HttpRequest): Promise<HttpResponse | null> {
    if (!(await this.gate())) return null;
    return this.api.handle(req);
  }

  /** The replay clock follows real time (§4). */
  tick(dt: number): void {
    this.replay.advance(dt);
  }

  tickMessage() {
    return { messages: this.tap.drain(), server: this.status, replay: this.replay.view() };
  }

  // --- the server's lifecycle (FR-47, FR-49) -------------------------------------------------------------------
  private startServerNow(): void {
    this.server = new Server({ tap: this.tap, accounts: this.accounts, thawed: () => this.thawed() }, this.store, this.offering, this.lieAboutProfile);
    this.status = 'running';
  }

  private stopServer(): void {
    this.server?.stop();
    this.server = null;
  }

  /** A start takes about a second, during which connections are refused (§9.1). */
  private async startServer(): Promise<void> {
    const seq = ++this.startSeq;
    this.stopServer();
    this.status = 'starting';
    await sleep(START_S);
    if (seq !== this.startSeq) return;
    this.startServerNow();
    await this.importer.attach(this.server!);
  }

  // --- control actions (§13.3) ---------------------------------------------------------------------------
  async control(action: string, arg?: unknown) {
    const a = (arg ?? {}) as Record<string, unknown>;
    switch (action) {
      case 'restart-server':
      case 'up':
        void this.startServer();
        break;
      case 'down':
        this.startSeq++;
        this.stopServer();
        this.status = 'down';
        break;
      case 'field': {
        if (!CATALOGUE.has(String(a.name))) throw new Error(`unknown field ${a.name}`);
        this.offering.on[String(a.name)] = !!a.on;
        break;
      }
      case 'profile-lie':
        this.lieAboutProfile = typeof arg === 'object' && arg !== null ? !!a.on : !!arg;
        break;
      case 'capture':
        this.tap.enabled = typeof arg === 'object' && arg !== null ? !!a.on : !!arg;
        break;
      case 'freeze': {
        const on = typeof arg === 'object' && arg !== null ? !!a.on : !!arg;
        this.frozen = on;
        if (!on) for (const w of this.thawWaiters.splice(0)) w();
        break;
      }
      case 'reset-instance': {
        // FR-50a: stop, delete the whole store, start empty. The data folder is untouched; no silent import until reload.
        this.replay.stop();
        for (const r of this.runners) r.stop();
        this.store = new Store();
        this.makeComponents();
        await this.startServer();
        this.replay.start();
        for (const r of this.runners) r.start();
        break;
      }
      case 'set-role':
        this.accounts.setRole(String(a.user), String(a.role));
        break;
      case 'state':
        break;
      default:
        throw new Error(`unknown control action ${action}`);
    }
    return this.controlState();
  }

  /** What the control panel and status show (§13.4). */
  controlState() {
    const live = this.server ? this.server.offering : null;
    const fields = [...CATALOGUE.values()].map((f) => ({
      name: f.name, label: f.label, kind: f.kind, inputs: [...f.inputs], extra: f.extra, essential: f.essential, type: f.swe_type,
      on_next_start: this.offering.on[f.name], published_next_start: this.offering.published(f.name), published_now: !!(live && live.published(f.name)),
    }));
    const pending = fields.some((r) => r.published_now !== r.published_next_start)
      || (this.server !== null && this.server.lieAboutProfile !== this.lieAboutProfile);
    const models = this.runners.map((r) => {
      const sys = this.store.systemByUid(r.model.uid);
      const rsys = this.store.systemByUid(r.model.restrictedUid);
      return {
        id: r.model.id, label: r.model.label, phase: r.phase, detail: r.detail, max_rate: r.model.maxRate,
        datastreams: [...this.store.datastreams.values()].filter((d) => d.system === sys?.id || d.system === rsys?.id)
          .map((d) => (d.system === rsys?.id ? `restricted/${d.outputName}` : d.outputName)),
      };
    });
    return {
      server: this.status, fields, pending, lie_about_profile: this.lieAboutProfile,
      folder: [...this.importer.files.values()].map((f) => ({ file: f.file, size: f.size, modified: f.modified, status: f.status, dataset: f.dataset, pct: f.pct })),
      datasets: [...this.importer.datasets.values()].map((d) => ({ id: d.id, file: d.file, start: d.start, end: d.end, superseded: d.superseded })),
      replay: this.replay.view(), models,
      accounts: this.accounts.list(),
      capture_counts: { ...this.tap.counts },
      backend: 'standin' as const, frozen: this.frozen, import_rate: this.importer.importRate,
    };
  }
}
