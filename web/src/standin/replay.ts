// The replay controller (C-09; docs/v4-interfaces.md §8, FR-84 to FR-89): holds
// the current dataset and the replay clock. It is a Connected Systems system
// (assetType Simulation) inside the server, under its own service account; it
// does not pass the gateway. It registers its `state` and `log` datastreams and
// its `replay` control stream, subscribes before it declares itself ready, and
// validates every command it is pushed: a rate above the slowest model's bound
// is REJECTED naming the bound and the model (FR-86, AT-35).
import { MODELS_READY_SKIP_S, RATES, SOSA, UID } from './constants';
import { Api, Command, Refused, Unavailable } from './models/csmodel';
import { M } from './swe';
import { iso, parseIso, realNow, sleep } from './time';

export interface ReplayDataset {
  id: string;
  start: number;
  end: number;
}

export interface ReplayView {
  time: number;
  dataset: string;
  start: number;
  end: number;
  position: number;
  rate: number;
  max_rate: number;
  max_rate_model: string;
  playing: boolean;
  at_end: boolean;
  run: string;
  models_ready: boolean;
}

function fmt(x: number): string {
  return String(x);
}

export class ReplayController {
  ready = false;
  stopped = false;
  dataset: ReplayDataset | null = null;
  time = 0;
  rate = 1;
  playing = false;
  atEnd = false;
  run = '';
  modelsReady = false;
  maxRate = Math.max(...RATES);
  maxRateModel = '';
  detail = '';
  private runs = new Map<string, number>();
  private csKey = '';
  private subscribed = false;
  private registeredOnce = false;
  private lastPublish = 0;
  private dirty = false;
  private loadedAt = 0;
  private readyFor = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly api: Api, private readonly frozen: () => boolean) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** The state, for the shell's status (the display client reads it over HTTP). */
  view(): ReplayView | null {
    const d = this.dataset;
    if (!d) return null;
    return {
      time: this.time, dataset: d.id, start: d.start, end: d.end, position: this.time, rate: this.rate, max_rate: this.maxRate,
      max_rate_model: this.maxRateModel, playing: this.playing, at_end: this.atEnd, run: this.run, models_ready: this.modelsReady,
    };
  }

  /** The replay clock: `rate` replay seconds per real second while playing and not frozen (§4). */
  advance(dt: number): void {
    if (!this.playing || !this.dataset || this.frozen()) return;
    this.time = Math.min(this.dataset.end, this.time + dt * this.rate);
    if (this.time >= this.dataset.end) {
      this.playing = false; // the end: pause and say so (FR-88)
      this.atEnd = true;
      this.dirty = true;
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.subscribed) await this.register();
        await this.checkModelsReady();
        const now = realNow();
        if (this.dataset && (this.dirty || (this.playing && now - this.lastPublish >= 1))) await this.publishState();
      } catch (e) {
        this.api.quiet = false;
        if (e instanceof Unavailable || e instanceof Refused) this.detail = String(e.message);
        else console.error(e);
      }
      await sleep(this.playing ? 0.1 : 0.25);
    }
  }

  // --- registering (§8): created at server start, subscribed before it is ready ---------------------
  private async register(): Promise<void> {
    const api = this.api;
    api.quiet = !this.registeredOnce;
    await api.createSystem({
      type: 'SimpleProcess', uniqueId: UID.replay, label: 'Replay controller', definition: SOSA + 'System', assetType: 'Simulation',
      description: 'Holds the current dataset and the replay clock (FR-84).',
    });
    await api.createDatastream(UID.replay, {
      name: 'Replay state', outputName: 'state', schema: M.record('Replay state', [
        M.time('time', 'Replay time'), M.text('dataset', 'Dataset'), M.time('start', 'Start of the dataset'), M.time('end', 'End of the dataset'),
        M.time('position', 'Position'), M.quantity('rate', 'Rate', '1'), M.quantity('max_rate', 'Highest rate the models sustain', '1'),
        M.text('max_rate_model', 'The model that sets it'), M.boolean('playing', 'Playing'), M.boolean('at_end', 'At the end'),
        M.text('run', 'Replay run'), M.boolean('models_ready', 'Every model has its datastreams for the dataset')]),
    });
    await api.createDatastream(UID.replay, {
      name: 'Replay log', outputName: 'log', schema: M.record('Replay log', [
        M.time('time', 'Real time it took effect'), M.text('command_id', 'Command'), M.category('action', 'Action', ['load', 'play', 'pause', 'seek']),
        M.text('dataset', 'Dataset'), M.quantity('rate', 'Rate', '1'), M.time('position', 'Replay time it took effect'),
        M.text('run', 'Replay run'), M.text('sender', 'Sender')]),
    });
    this.csKey = await api.createControlstream(UID.replay, {
      name: 'Replay', inputName: 'replay', schema: M.record('Replay', [
        M.category('action', 'Action', ['load', 'play', 'pause', 'seek']), M.text('dataset', 'Dataset'),
        { ...M.quantity('rate', 'Rate', '1'), constraint: { type: 'AllowedTokens', values: RATES } },
        M.time('position', 'Position')]),
    });
    await api.subscribe(this.csKey, (c) => this.onCommand(c), () => {
      this.subscribed = false; // the server stopped: resubscribe once it answers again (FR-48)
      this.ready = false;
    });
    this.subscribed = true;
    this.ready = true;
    this.registeredOnce = true;
    api.quiet = false;
    if (this.dataset) this.dirty = true;
  }

  // --- the rate bound (FR-86): the lowest max_rate declared by a model under Models -------------------------
  private async refreshMaxRate(): Promise<{ id: string; uid: string; label: string }[]> {
    const models = await this.api.findSystem(UID.models);
    if (!models) return [];
    const list = await this.api.get(`/systems/${models}/subsystems?f=application/sml%2Bjson&limit=1000`);
    let best = Math.max(...RATES);
    let who = '';
    const out: { id: string; uid: string; label: string }[] = [];
    for (const s of list.items as any[]) {
      out.push({ id: s.id, uid: s.uniqueId, label: s.label });
      for (const group of s.characteristics ?? []) {
        for (const c of group.characteristics ?? []) {
          if (c.name === 'max_rate' && typeof c.value === 'number' && c.value < best) {
            best = c.value;
            who = s.label;
          }
        }
      }
    }
    this.maxRate = best;
    this.maxRateModel = who;
    return out;
  }

  /** After a load: every model has created its datastreams for the dataset (§8). */
  private async checkModelsReady(): Promise<void> {
    const d = this.dataset;
    if (!d || this.modelsReady || this.readyFor === d.id + this.run) return;
    const models = await this.refreshMaxRate();
    const missing: string[] = [];
    for (const m of models) {
      const ds = await this.api.get(`/systems/${m.id}/datastreams?limit=10000`);
      if (!(ds.items as any[]).some((x) => String(x.outputName).endsWith(`__${d.id}`))) missing.push(m.label);
    }
    const waited = realNow() - this.loadedAt;
    if (!missing.length || waited >= MODELS_READY_SKIP_S) {
      if (missing.length) {
        this.detail = `models_ready: skipped ${missing.join(', ')} after ${MODELS_READY_SKIP_S} s`;
        await this.api.publish(`${UID.replay}|log`, {
          time: realNow(), command_id: '', action: 'load', dataset: d.id, rate: this.rate, position: this.time, run: this.run,
          sender: `models_ready: skipped ${missing.join(', ')}`,
        });
      }
      this.modelsReady = true;
      this.readyFor = d.id + this.run;
      this.dirty = true;
    }
  }

  private async publishState(): Promise<void> {
    const v = this.view();
    if (!v) return;
    this.dirty = false;
    this.lastPublish = realNow();
    await this.api.publish(`${UID.replay}|state`, { ...v });
  }

  // --- commands (§8) -------------------------------------------------------------------------------------------
  private onCommand(cmd: Command): void {
    this.queue = this.queue.then(() => this.apply(cmd)).catch((e) => {
      this.detail = String((e as Error)?.message ?? e);
    });
  }

  /** The importer's catalogue, folded by dataset: what can be loaded. */
  private async datasets(): Promise<Map<string, ReplayDataset>> {
    const key = await this.api.find(UID.importer, 'catalogue');
    const out = new Map<string, ReplayDataset>();
    if (!key) return out;
    const c = await this.api.read(key, -Infinity, Infinity);
    const ds = c.dataset as unknown[];
    const status = c.status as unknown[];
    for (let i = 0; i < c.t.length; i++) {
      const id = String(ds[i] ?? '');
      if (!id) continue;
      if (['imported', 'changed', 'superseded'].includes(String(status[i]))) {
        out.set(id, { id, start: (c.start as Float64Array)[i], end: (c.end as Float64Array)[i] });
      } else if (status[i] === 'importing' || status[i] === 'not-imported') out.delete(id);
    }
    return out;
  }

  private async apply(cmd: Command): Promise<void> {
    const api = this.api;
    const p = cmd.parameters ?? {};
    const reject = (msg: string) => api.commandStatus(this.csKey, cmd.id, 'REJECTED', msg);
    const action = String(p.action ?? '');
    if (!['load', 'play', 'pause', 'seek'].includes(action)) return reject(`action must be load, play, pause or seek, not ${action || 'empty'}`);
    const rate = Number(p.rate);
    if (!RATES.includes(rate)) return reject(`rate ${p.rate} is not one of ${RATES.join(', ')}`);
    await this.refreshMaxRate();
    if (rate > this.maxRate) return reject(`rate ${fmt(rate)} exceeds ${fmt(this.maxRate)}, the highest ${this.maxRateModel} sustains`);
    let target: ReplayDataset | null = this.dataset;
    let position = this.time;
    if (action === 'load') {
      const all = await this.datasets();
      const id = String(p.dataset ?? '');
      const d = all.get(id);
      if (!d) return reject(`dataset ${id || '(none)'} is not imported`);
      target = d;
      position = d.start;
    } else if (!target) return reject('no dataset is loaded');
    if (action === 'seek') {
      try {
        position = parseIso(String(p.position));
      } catch {
        return reject(`position ${p.position} is not a time`);
      }
      if (position < target!.start || position > target!.end) {
        return reject(`position ${p.position} is outside the dataset, ${iso(target!.start)} to ${iso(target!.end)}`);
      }
    }
    await api.commandStatus(this.csKey, cmd.id, 'ACCEPTED');
    this.rate = rate;
    if (action === 'load') this.load(target!, false);
    else if (action === 'seek') {
      this.time = position;
      this.atEnd = position >= target!.end;
      this.newRun(); // FR-87
    } else if (action === 'play') {
      if (!this.atEnd) this.playing = true;
    } else this.playing = false;
    this.dirty = true;
    // The log's time is the real time the command took effect; its position, the replay time (D-198).
    await api.publish(`${UID.replay}|log`, {
      time: realNow(), command_id: cmd.id, action, dataset: this.dataset!.id, rate: this.rate, position: this.time, run: this.run,
      sender: cmd.sender ?? '',
    });
    await this.publishState();
    await api.commandStatus(this.csKey, cmd.id, 'COMPLETED', action === 'play' && this.atEnd ? 'at the end of the dataset' : `${action} ${this.dataset!.id}`);
  }

  private newRun(): void {
    const d = this.dataset!;
    const n = (this.runs.get(d.id) ?? 0) + 1;
    this.runs.set(d.id, n);
    this.run = `r-${d.id}-${n}`;
  }

  /** Make a dataset current, paused at its start, with a new run. */
  load(d: ReplayDataset, quiet: boolean): void {
    void quiet;
    this.dataset = d;
    this.time = d.start;
    this.playing = false;
    this.atEnd = false;
    this.modelsReady = false;
    this.loadedAt = realNow();
    this.newRun();
    this.dirty = true;
  }

  /** At startup, before the first login: Mission A, paused at its start (FR-77). Quiet. */
  async loadAtStartup(d: ReplayDataset): Promise<void> {
    this.load(d, true);
    this.api.quiet = true;
    try {
      await this.publishState();
    } finally {
      this.api.quiet = false;
    }
  }
}
