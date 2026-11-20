// Live data for the client's panels: poll observations once per simulated
// second, from the last reading onwards (FR-63). A recorded placeholder for
// live delivery, not a tested design.
import { LIVE_WINDOW_S } from '../config';
import { SIM_EPOCH_UNIX, simClock } from '../shell/clock';
import { Store } from '../shell/store';
import type { Configuration, Datastream } from './handshake';
import { ClientHttp, InstanceChanged, NetworkFailure } from './http';

export type Row = Record<string, any> & { time: string };
export const toSim = (iso: string) => Date.parse(iso) / 1000 - SIM_EPOCH_UNIX;

const LIVE_OUTPUTS = new Set(['weather', 'derived']); // continuous datastreams
const RUN_OUTPUTS = new Set(['changes', 'clusters', 'correlation']); // refreshed when a new run appears

export class LiveData {
  rows = new Map<string, Row[]>();
  version = new Store(0);
  stale = new Store(false);
  runId: string | null = null;
  private busy = false;
  private lastSecond = -1;
  private unsub: (() => void) | null = null;

  constructor(private http: ClientHttp, private config: Configuration) {}

  private ds(): Datastream[] {
    return this.config.datastreams;
  }

  async start() {
    const now = simClock.now();
    const from = simClock.iso(now - LIVE_WINDOW_S);
    for (const d of this.ds()) {
      const live = LIVE_OUTPUTS.has(d.outputName);
      const params: Record<string, string> = live ? { phenomenonTime: `${from}/..`, limit: '20000' } : { limit: '20000' };
      if (d.outputName === 'runs') Object.assign(params, { resultTime: 'latest' });
      const r = await this.http.get<Row[]>(`datastreams/${d.id}/observations`, params);
      this.rows.set(d.id, r.status === 200 ? r.body : []);
      if (d.outputName === 'runs' && r.body?.length) this.runId = r.body[0].run_id;
    }
    this.version.set(this.version.value + 1);
    // Poll on the simulation clock: once for every simulated second that passes.
    const timer = setInterval(() => {
      const s = Math.floor(simClock.now());
      if (s !== this.lastSecond) {
        this.lastSecond = s;
        void this.poll();
      }
    }, 50);
    this.unsub = () => clearInterval(timer);
  }

  stop() {
    this.unsub?.();
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      let changed = false;
      for (const d of this.ds()) {
        if (!LIVE_OUTPUTS.has(d.outputName) && d.outputName !== 'runs') continue;
        const have = this.rows.get(d.id) ?? [];
        const last = have.length ? have[have.length - 1].time : null;
        const params: Record<string, string> = d.outputName === 'runs' ? { resultTime: 'latest' }
          : last ? { phenomenonTime: `${simClock.iso(toSim(last) + 1)}/..`, limit: '20000' } : { resultTime: 'latest' };
        const r = await this.http.request<Row[]>('GET', `datastreams/${d.id}/observations`, params);
        if (r.status !== 200) continue;
        if (d.outputName === 'runs') {
          if (r.body.length && r.body[0].run_id !== this.runId) {
            this.runId = r.body[0].run_id;
            this.rows.set(d.id, r.body);
            await this.refreshRunOutputs();
            changed = true;
          }
          continue;
        }
        if (r.body.length) {
          const cut = toSim(r.body[r.body.length - 1].time) - LIVE_WINDOW_S;
          this.rows.set(d.id, [...have, ...r.body].filter((x) => toSim(x.time) >= cut));
          changed = true;
        }
      }
      if (this.stale.value) this.stale.set(false);
      if (changed) this.version.set(this.version.value + 1);
    } catch (e) {
      if (e instanceof NetworkFailure) this.stale.set(true);
      else if (!(e instanceof InstanceChanged)) console.warn(e);
    } finally {
      this.busy = false;
    }
  }

  async refreshRunOutputs() {
    for (const d of this.ds()) {
      if (!RUN_OUTPUTS.has(d.outputName)) continue;
      const r = await this.http.request<Row[]>('GET', `datastreams/${d.id}/observations`, { limit: '20000' });
      if (r.status === 200) this.rows.set(d.id, r.body);
    }
    this.version.set(this.version.value + 1);
  }

  get(id: string): Row[] {
    return this.rows.get(id) ?? [];
  }
}
