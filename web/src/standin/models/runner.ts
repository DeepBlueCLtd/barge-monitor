// The runner (docs/v4-interfaces.md §10.2; csmodel.Runner): reads the replay
// state once per real second and runs the model on what it finds. It registers
// and subscribes before declaring the model ready (AT-38); creates a dataset's
// datastreams first, which is what the replay controller waits for
// (models_ready); and processes whole windows aligned to the dataset's start,
// up to the replay time, so outputs are the same at any rate (FR-35, AT-34).
// A broken model never stops the others (FR-33).
import { iso, realNow, sleep } from '../time';
import { Api, Command, DatasetCtx, Model, Refused, Rejected, ReplayState, Unavailable } from './csmodel';

/** Real milliseconds of processing per tick before the runner yields. */
const BUDGET_MS = 400;

export class Runner {
  phase = 'starting';
  detail = '';
  errors = 0;
  stopped = false;
  private subscribed = false;
  private registeredOnce = false;
  private unsubscribe: (() => void) | null = null;
  private prepared = new Set<string>();
  private progress = new Map<string, { run: string; done: number }>();
  private state: ReplayState | null = null;
  private cmdQueue: Promise<void> = Promise.resolve();

  constructor(readonly model: Model, readonly api: Api) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
  }

  /** How far the model has got with a dataset (for the shell). */
  doneUpTo(ds: string): number | null {
    return this.progress.get(ds)?.done ?? null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const t0 = realNow();
      await this.tick();
      await sleep(Math.max(0.05, 1 - (realNow() - t0)));
    }
  }

  private async tick(): Promise<void> {
    const { api, model: m } = this;
    try {
      if (!this.subscribed) {
        api.quiet = !this.registeredOnce; // registering at startup is counted, not drawn (§2)
        await m.setup(api);
        if (m.controlKey) {
          this.unsubscribe = await api.subscribe(m.controlKey, (c) => this.onCommand(c), () => {
            this.subscribed = false; // the server stopped: resubscribe once it answers again (FR-48)
            if (!this.stopped) this.phase = 'waiting';
          });
        }
        this.subscribed = true;
        this.registeredOnce = true;
        api.quiet = false;
        this.phase = 'ready'; // only now: the subscription is open (AT-38)
        this.detail = '';
      }
      const st = await api.replayState();
      this.state = st;
      if (!st || !st.dataset) {
        this.detail = 'no dataset loaded';
        return;
      }
      const ds: DatasetCtx = { id: st.dataset, start: st.start, end: st.end };
      if (!this.prepared.has(ds.id)) {
        await m.prepare(api, ds);
        this.prepared.add(ds.id);
      }
      let p = this.progress.get(ds.id);
      if (!p || p.run !== st.run) {
        // A new run (a load or a seek): the dataset's windows again, from the run's position (FR-87).
        const k = Math.floor((st.position - ds.start) / m.window);
        p = { run: st.run, done: ds.start + Math.max(0, k) * m.window };
        this.progress.set(ds.id, p);
      }
      const until = performance.now() + BUDGET_MS;
      while (!this.stopped && p.done < ds.end && performance.now() < until) {
        const t1 = Math.min(p.done + m.window, ds.end);
        if (t1 > st.time) break; // whole windows only, up to the replay time
        const ok = await m.process(api, ds, p.done, t1, st.run);
        if (!ok) break;
        p.done = t1;
      }
      this.phase = 'ready';
      this.detail = `${ds.id}: processed up to ${iso(p.done)}`;
    } catch (e) {
      api.quiet = false;
      if (e instanceof Unavailable) {
        this.phase = 'waiting';
        this.detail = `waiting: ${e.message}`;
      } else if (e instanceof Refused) {
        this.errors += 1;
        this.detail = `refused: ${e.message}`;
        if (e.status === 404) { // its resources have gone (Reset instance): register again
          api.forget();
          this.prepared.clear();
          this.subscribed = false;
          this.unsubscribe?.();
        }
      } else {
        this.phase = 'failed';
        this.detail = `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`;
        console.error(e);
      }
    }
  }

  /** A pushed command (§10.3): validated by the receiver, then applied; status reported each step. */
  private onCommand(cmd: Command): void {
    this.cmdQueue = this.cmdQueue.then(async () => {
      const { api, model: m } = this;
      const key = m.controlKey!;
      try {
        try {
          await m.validate(api, cmd, this.state);
        } catch (e) {
          if (e instanceof Rejected) {
            await api.commandStatus(key, cmd.id, 'REJECTED', e.message);
            return;
          }
          throw e;
        }
        await api.commandStatus(key, cmd.id, 'ACCEPTED');
        try {
          const msg = await m.apply(api, cmd, this.state);
          await api.commandStatus(key, cmd.id, 'COMPLETED', msg);
        } catch (e) {
          if (e instanceof Unavailable) throw e;
          await api.commandStatus(key, cmd.id, 'FAILED', `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`);
        }
      } catch (e) {
        this.detail = `command ${cmd.id}: ${(e as Error)?.message ?? e}`;
      }
    });
  }
}
