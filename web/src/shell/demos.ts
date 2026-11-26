// Failure demos: the control panel's switches as one-click scenarios, each
// with what to watch for. They belong to the demonstrator shell, like the
// control panel: they stand in for what happens to a deployment (a server
// taken down, a source removed, a misconfigured server).
import { runtime } from './runtime';
import { selectComponent } from './selection';
import { Store } from './store';

export interface DemoStep {
  /** The button that takes this step. */
  label: string;
  run: () => void;
  /** What the viewer should watch for once it has run. */
  watch: string;
}

export interface Demo {
  id: string;
  title: string;
  /** One line for the menu: what it shows. */
  shows: string;
  steps: DemoStep[];
}

const EXTRAS = ['precipitation_type', 'pressure_tendency_3h', 'readings_removed'];
const field = (name: string, on: boolean) => runtime.send('field', { name, on });

/** Every switch back to how the page started: all fields but the extras on, an honest server, running. */
export function putEverythingBack() {
  for (const f of runtime.control.value?.fields ?? []) field(f.name, !f.extra);
  runtime.send('profile-lie', false);
  runtime.send(runtime.server.value === 'down' ? 'up' : 'restart-server');
}

export const DEMOS: Demo[] = [
  {
    id: 'down', title: 'The server goes down', shows: 'No answer at all: the client says so, the store carries on',
    steps: [
      {
        label: 'Take the server down', run: () => runtime.send('down'),
        watch: 'Requests now stop at the boundary with a cross: no server answers. The display client says the server is unreachable and marks its data stale. The logger store keeps taking records.',
      },
      {
        label: 'Bring the server up', run: () => runtime.send('up'),
        watch: 'The server starts in waiting mode: 503 with Retry-After (H) while the store adapter rebuilds its index. It has a new instance identifier, so the display client clears its state and repeats its handshake. No records were lost.',
      },
    ],
  },
  {
    id: 'restart', title: 'The server restarts', shows: 'Waiting mode, a new instance, the client starts again by itself',
    steps: [{
      label: 'Restart the server', run: () => runtime.send('restart-server'),
      watch: 'While the store adapter rebuilds its index every request gets 503 with Retry-After (H). The new instance identifier tells the display client to clear its state and repeat its handshake. The server enforces nothing.',
    }],
  },
  {
    id: 'essential', title: 'An essential source is missing', shows: 'The client starts degraded and says exactly what is missing',
    steps: [{
      label: 'Switch air temperature off and restart the server',
      run: () => {
        field('air_temperature', false);
        runtime.send('restart-server');
      },
      watch: 'The server no longer offers air temperature, so it stops claiming the declared profile. After its handshake the display client starts degraded: one warning names every missing source, and each view that needs one says unavailable instead of drawing an empty chart.',
    }],
  },
  {
    id: 'extra', title: 'Fields the client has never seen', shows: 'New sources appear with no new display code',
    steps: [{
      label: 'Switch the three extra fields on and restart the server',
      run: () => {
        EXTRAS.forEach((n) => field(n, true));
        runtime.send('restart-server');
      },
      watch: 'A Category, a Quantity and a Count the display client was never told about. After its handshake they appear as dashed chips. Select one: it is drawn by its schema type alone.',
    }],
  },
  {
    id: 'lie', title: 'A misconfigured server', shows: 'A false claim is caught, not trusted',
    steps: [{
      label: 'Remove air temperature but still claim the profile',
      run: () => {
        field('air_temperature', false);
        runtime.send('profile-lie', true);
        runtime.send('restart-server');
      },
      watch: 'The server claims the declared profile while discovery contradicts it. The display client checks the claim against what discovery offers and rejects the server.',
    }],
  },
];

/** The demo in progress and the step it has reached (the banner under the title shows it). */
export const activeDemo = new Store<{ demo: Demo; done: number } | null>(null);

export function startDemo(demo: Demo) {
  activeDemo.set({ demo, done: 0 });
  takeStep();
}

export function takeStep() {
  const a = activeDemo.value;
  if (!a || a.done >= a.demo.steps.length) return;
  // The display client is where every one of these shows; nothing moves unless the clock runs.
  selectComponent('client');
  runtime.send('play');
  a.demo.steps[a.done].run();
  activeDemo.set({ demo: a.demo, done: a.done + 1 });
}

export function endDemo(restore: boolean) {
  if (restore) putEverythingBack();
  activeDemo.set(null);
}
