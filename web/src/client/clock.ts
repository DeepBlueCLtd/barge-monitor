// The display client's own replay clock (SRD §8.6, docs/v4-interfaces.md §8). There is
// no replay on the server: open, play, pause, rate and seek change only this clock, and
// send no command. While playing, the replay time advances by `rate` replay seconds per
// real second; at the end of the dataset the clock pauses and says so (FR-88). Play at
// the end starts again from the start.
import { Rate, RATES } from '../config';
import { Store } from '../shell/store';

export interface ReplayState {
  /** The client's current dataset id. */
  dataset: string;
  /** Its span, Unix seconds, from the catalogue. */
  start: number;
  end: number;
  /** The replay time, Unix seconds, within [start, end]. */
  time: number;
  rate: Rate;
  playing: boolean;
  atEnd: boolean;
}

const STEP_MS = 100;

export class ReplayClock {
  /** The clock as shown; null while no dataset is open. Updated about ten times a second while playing. */
  readonly state = new Store<ReplayState | null>(null);
  /** Called once when the replay reaches the end of the dataset and pauses. */
  onEnd: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private held = false;

  /**
   * D-362: the demonstrator's Pause holds the whole system, this clock included: while held the replay time does not
   * advance, whether playing or not, and it carries on from the same time when let go. Playing stays as it was.
   */
  hold(on: boolean) {
    if (on === this.held) return;
    if (on) this.advance();
    this.held = on;
    this.last = performance.now();
  }

  /** Open a dataset: time at its start, paused (interfaces §8). The rate is kept. */
  open(dataset: string, start: number, end: number, time = start) {
    const rate = this.state.value?.rate ?? 1;
    this.stop();
    this.state.set({ dataset, start, end, time: Math.min(Math.max(time, start), end), rate, playing: false, atEnd: false });
  }

  close() {
    this.stop();
    this.state.set(null);
  }

  play() {
    const s = this.state.value;
    if (!s || s.playing) return;
    this.state.set({ ...s, time: s.atEnd || s.time >= s.end ? s.start : s.time, playing: true, atEnd: false });
    this.last = performance.now();
    this.timer = setInterval(() => this.step(), STEP_MS);
  }

  pause() {
    const s = this.state.value;
    if (!s) return;
    this.advance();
    this.stop();
    this.state.set({ ...this.state.value!, playing: false });
  }

  setRate(rate: number) {
    const s = this.state.value;
    if (!s || !(RATES as readonly number[]).includes(rate)) return;
    this.advance();
    this.state.set({ ...this.state.value!, rate: rate as Rate });
  }

  /** FR-87: move within the current dataset; it changes only what this client shows. */
  seek(t: number) {
    const s = this.state.value;
    if (!s) return;
    this.last = performance.now();
    this.state.set({ ...s, time: Math.min(Math.max(t, s.start), s.end), atEnd: false });
  }

  /** The replay time now. */
  now(): number {
    this.advance();
    return this.state.value?.time ?? 0;
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Bring the replay time up to real time, quietly (no store update unless it reaches the end). */
  private advance() {
    const s = this.state.value;
    if (!s || !s.playing || this.held) return;
    const now = performance.now();
    const t = s.time + ((now - this.last) / 1000) * s.rate;
    this.last = now;
    if (t >= s.end) {
      this.stop();
      this.state.set({ ...s, time: s.end, playing: false, atEnd: true });
      this.onEnd?.();
      return;
    }
    this.state.value = { ...s, time: t };
  }

  private step() {
    this.advance();
    const s = this.state.value;
    if (s?.playing) this.state.set({ ...s });
  }
}
