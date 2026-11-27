// Failure demos (FR-79a, 4.7): one-click scenarios, each with a banner saying what to watch
// for and "Put everything back". They belong to the demonstrator shell, like the control
// panel: they stand in for what happens to a deployment (a server taken down or restarted, a
// source removed, a misconfigured server) and for what a person at the screen does (a wrong
// password, walking away, an overlapping file, a crafted request). The display client is
// driven as a viewer would drive it. Reused from the withdrawn 4.6 build (8157eef), read
// against 4.7: no replay controller, so no "rate above the models" demo; no gateway, so the
// crafted request is refused with 403; no Freeze.
import { commandOutcomes, StatusReport } from '../client/http';
import { CatalogueEntry, clientSession } from '../client/session';
import { API_BASE, IDLE_LOCK_MS } from '../config';
import { DEMO_LOGINS } from './demoAccounts';
import { runtime } from './runtime';
import { selectComponent } from './selection';
import { Store } from './store';

export interface DemoStep {
  /** The button that takes this step. */
  label: string;
  /** Runs the step; may answer with what was found, shown after the watch text. */
  run: () => Promise<string | void> | string | void;
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

/** The fields the display client has never seen (FR-50): off by default. */
export const EXTRAS = ['pressure_tendency_3h', 'readings_removed'];
const control = (action: string, arg?: unknown) => runtime.act(action, arg).catch(() => runtime.control.value);
const field = (name: string, on: boolean) => control('field', { name, on });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const password = (user: string) => DEMO_LOGINS.find((a) => a.user === user)!.password;

async function until(test: () => boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) return false;
    await sleep(200);
  }
  return true;
}

const serverRunning = () => runtime.server.value === 'running';

/** The display client on screen, logged in as `user`, with a dataset open. */
async function loggedIn(user = 'owner') {
  selectComponent('client');
  await until(serverRunning);
  const s = clientSession;
  if (s.user.value !== user || ['login', 'locked', 'rejected'].includes(s.phase.value)) {
    s.restart();
    await s.login(user, password(user));
  }
  await until(() => s.phase.value === 'ready' && !!s.clock.state.value, 60_000);
}

/** Playing, so that the client polls and notices what happens to the server (FR-63, FR-48); paused, it sends nothing. */
async function playing() {
  await loggedIn(clientSession.user.value ?? 'owner');
  const r = clientSession.clock.state.value;
  if (r && !r.playing) clientSession.play();
}

/**
 * A server start the display client is sure to notice (D-185): down until a polling client has seen no answer, then up.
 * A plain restart refuses connections for only a moment, which a client between polls can miss; then it would keep
 * what it discovered before, and a change of offering (a field switched, a misconfiguration) would not show.
 */
async function startSeen() {
  const watching = ['ready', 'handshake'].includes(clientSession.phase.value);
  if (watching && !clientSession.clock.state.value?.playing) clientSession.play();
  await control('down');
  if (watching) await until(() => clientSession.phase.value === 'unreachable', 10_000);
  await control('up');
  await until(serverRunning);
  if (watching) await until(() => clientSession.phase.value !== 'unreachable' && clientSession.phase.value !== 'handshake', 60_000);
}

/** Open a file in the display client from its catalogue, importing it first if need be (FR-103). */
async function openFile(match: RegExp) {
  await loggedIn(clientSession.user.value ?? 'owner');
  await until(() => clientSession.catalogue.value.some((e) => match.test(e.file)));
  const e = clientSession.catalogue.value.filter((x) => match.test(x.file)).pop();
  if (!e) return;
  clientSession.open(e);
  await until(() => !clientSession.importing.value && clientSession.clock.state.value?.dataset === latest(match)?.dataset, 180_000);
}

const latest = (match: RegExp): CatalogueEntry | undefined => clientSession.catalogue.value.filter((x) => match.test(x.file) && x.dataset).pop();

/**
 * Every switch back to how the page started, and the display client with it (AT-31): an honest server with every
 * field but the extras, the 5-minute idle lock, the server up and seen to start by the client; a client that refused
 * the server, or that a demo left logged out, locked or logged in as the friend, is restarted and logged in as the
 * owner, as a user would reload (D-210), with Mission A open.
 */
export async function putEverythingBack() {
  selectComponent('client'); // the display client is where each demo shows, and where it is restored
  clientSession.idleMs = IDLE_LOCK_MS;
  await control('profile-lie', { on: false });
  for (const f of runtime.control.value?.fields ?? []) if (f.on_next_start === f.extra) await field(f.name, !f.extra);
  await startSeen();
  const s = clientSession;
  if (s.phase.value !== 'ready' || s.user.value !== 'owner') {
    s.restart();
    await loggedIn('owner');
  }
  const a = latest(/^MISSION_A_/);
  if (a && s.clock.state.value?.dataset !== a.dataset) s.open(a);
  if (s.clock.state.value?.playing) s.pause();
}

/** FR-79a: the friend's crafted request for CO₂, sent with the friend's credentials, as a guest at the screen might. */
async function craftedRequest(): Promise<string> {
  const auth = (u: string) => 'Basic ' + btoa(`${u}:${password(u)}`);
  // The demonstrator, not the client, knows where CO₂ is: it looks, as the owner, quietly (a god's-eye view, FR-68a).
  const quiet = { authorization: auth('owner'), 'x-tap-quiet': '1' };
  const j = async (path: string, headers: Record<string, string>) => (await fetch(API_BASE + path, { headers, cache: 'no-store' })).json();
  const systems = (await j('systems?searchMembers=true&f=application/sml%2Bjson&limit=1000', quiet)).items as { id: string; uniqueId: string }[];
  const co2 = systems.find((s) => /:sensor:bow:co2$/.test(s.uniqueId));
  const dataset = clientSession.clock.state.value?.dataset ?? '';
  const ds = co2 ? ((await j(`systems/${co2.id}/datastreams?limit=1000`, quiet)).items as { id: string; outputName: string }[])
    .find((d) => d.outputName === `co2__${dataset}`) : null;
  const chain = `crafted-${Date.now()}`;
  const friend = { authorization: auth('friend'), 'x-tap-chain': chain };
  const r1 = ds ? await fetch(API_BASE + `datastreams/${ds.id}/observations?f=application/swe%2Bjson&limit=5`, { headers: friend, cache: 'no-store' }) : null;
  // A clustering command naming CO₂, as the friend, with a data of interest as the client's records name it (§11).
  const cs = ((await j('controlstreams?limit=1000', quiet)).items as { id: string; inputName: string }[]).find((c) => c.inputName === 'clustering');
  const e = clientSession.catalogue.value.find((x) => x.dataset === dataset);
  const t0 = clientSession.clock.state.value?.start ?? 0;
  const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
  const doi = { version: 1, label: 'crafted', dataset: e ? { file: e.file, size: e.size, modified: e.modified, sha256: e.sha256 } : dataset,
    start: iso(t0), end: iso(t0 + 3600), resolution: 'PT1M', aggregation: 'as-stored',
    sources: [{ system: 'urn:x-barge:sensor:bow:co2', output: 'co2', fields: ['co2'] }] };
  const sentAt = Date.now() - 1000;
  let verdict = 'no clustering control stream found';
  if (cs) {
    void fetch(API_BASE + `controlstreams/${cs.id}/commands`, {
      method: 'POST', headers: { ...friend, 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: { algorithm: 'A', doi: JSON.stringify(doi), clusters: 3, sensitivity: 5 } }),
    }).catch(() => undefined);
    verdict = 'no answer from the model yet';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const st = (await j(`controlstreams/${cs.id}/status?limit=10000`, quiet)).items as StatusReport[];
      // The outcome is the latest report other than PENDING (D-199).
      const mine = [...commandOutcomes(st).values()].filter((x) => Date.parse(x.reportTime ?? '') >= sentAt && (x.statusCode === 'REJECTED' || x.statusCode === 'COMPLETED'));
      if (mine.length) {
        verdict = `${mine[0].statusCode}: ${mine[0].message ?? ''}`;
        break;
      }
    }
  }
  return `Asked for CO₂ by its identifier, the server answered ${r1 ? r1.status : 'nothing'}${r1?.status === 403 ? ' (Forbidden)' : ''}. The command naming CO₂: ${verdict}.`;
}

export const DEMOS: Demo[] = [
  {
    id: 'down', title: 'The server goes down', shows: 'No answer at all: the client says so and marks its data stale',
    steps: [
      {
        label: 'Take the server down', run: async () => {
          await playing();
          await control('down');
        },
        watch: 'Requests now stop at the boundary with a cross: no server answers. The display client says the server is not answering and marks what it shows as stale.',
      },
      {
        label: 'Bring the server up', run: async () => {
          await control('up');
        },
        watch: 'The server starts, refusing connections while it does. Once it answers, the display client repeats its handshake, drawn one request at a time, and its views are fresh again.',
      },
    ],
  },
  {
    id: 'restart', title: 'The server restarts', shows: 'Connections refused while it starts; the client discovers it again by itself',
    steps: [{
      label: 'Restart the server', run: async () => {
        await playing();
        await control('restart-server');
      },
      watch: 'While it starts the server refuses connections, so requests stop at the boundary. Push subscriptions end and the importer and the models subscribe again. A display client that saw no answer repeats its handshake when the server answers; every identifier it holds is still good.',
    }],
  },
  {
    id: 'essential', title: 'An essential source is missing', shows: 'The dataset opens degraded and says exactly what is missing',
    steps: [{
      label: 'Switch air temperature off and restart the server', run: async () => {
        await playing();
        await field('air_temperature', false);
        await startSeen();
      },
      watch: 'The server no longer offers air temperature, in any dataset. After its handshake the display client opens the dataset degraded: one warning names every missing essential, and the views draw what is left. Compare "A misconfigured server": there the client refuses the server.',
    }],
  },
  {
    id: 'extra', title: 'Fields the client has never seen', shows: 'New sources appear after a client restart, with no new display code',
    steps: [
      {
        label: 'Switch the two extra fields on and restart the server', run: async () => {
          await loggedIn();
          for (const n of EXTRAS) await field(n, true);
          await startSeen();
        },
        watch: 'The server now publishes pressure tendency (a Quantity) and readings removed (a Count), which the display client was never told about. They come into its field list with the handshake.',
      },
      {
        label: 'Restart the client and log in', run: async () => {
          clientSession.restart();
          await loggedIn();
        },
        watch: 'After its handshake the new fields appear as chips. Select one: it is drawn by its schema type alone, with no new display code.',
      },
    ],
  },
  {
    id: 'lie', title: 'A misconfigured server', shows: 'A claim of the profile is checked, not trusted',
    steps: [{
      label: 'Publish the catalogue without its status, but still claim the profile', run: async () => {
        await playing();
        await control('profile-lie', { on: true });
        await startSeen();
      },
      watch: 'The server claims the declared profile, but its archive catalogue no longer has the status field the profile requires. The display client checks the claim against discovery itself and refuses the server at the handshake, naming the missing source. "Put everything back" restarts the client, as a user would reload.',
    }],
  },
  {
    id: 'password', title: 'A wrong password', shows: 'Refused, and nothing shown',
    steps: [{
      label: 'Log in with a wrong password', run: async () => {
        selectComponent('client');
        clientSession.restart();
        await clientSession.login('owner', 'not-the-password');
      },
      watch: 'The server answers 401 and the login screen says only that the name or password is wrong, not which. Nothing about the data is shown.',
    }],
  },
  {
    id: 'lock', title: 'The screen locks', shows: 'Views blank, requests stop, login needed',
    steps: [{
      label: 'Walk away (5 seconds stand in for 5 minutes)', run: async () => {
        await playing();
        clientSession.idleMs = 5000;
      },
      watch: 'Leave the mouse and keyboard alone. After 5 seconds without input (5 minutes in a deployment) the display client locks: every view and list is blanked, the credentials are discarded and no request is sent until someone logs in again.',
    }],
  },
  {
    id: 'overlap', title: 'An overlapping file', shows: 'Mission B and its re-export imported side by side, never mixed',
    steps: [
      {
        label: 'Open Mission B', run: () => openFile(/^MISSION_B_\d+\.csv$/),
        watch: 'The display client asks the importer to import Mission B, shows its progress on the Dataset selector button, then opens it. It gets datastreams of its own; the models process it at once.',
      },
      {
        label: 'Open Mission B (re-export)', run: () => openFile(/REEXPORT/),
        watch: 'The re-export overlaps Mission B in time and differs in a few readings. It is imported as a dataset of its own, in its own datastreams: the two are never mixed. Both stay in the Dataset selector.',
      },
    ],
  },
  {
    id: 'degraded', title: 'A degraded dataset', shows: 'Mission C opens degraded; other datasets are not affected',
    steps: [{
      label: 'Open Mission C', run: () => openFile(/^MISSION_C_/),
      watch: "Mission C's file has no stern wind speed column. The dataset opens degraded, naming the missing essential. Open Mission A again in the Dataset selector: it is not degraded.",
    }],
  },
  {
    id: 'friend', title: 'The friend logs in', shows: 'The same dataset, with no trace of CO₂ anywhere in the client',
    steps: [{
      label: 'Log in as the friend', run: async () => {
        clientSession.restart();
        await loggedIn('friend');
      },
      watch: 'The same build and the same dataset. The friend’s handshake may read each CO₂ stream’s title and schema, but is refused (403) its observations, so no chip, view, Favourite or source names CO₂, and none of the client’s own messages carries a CO₂ value. A stream’s title may be known, not its contents (D-351). The flowchart still shows the models’ CO₂ traffic: it is a god’s-eye view.',
    }],
  },
  {
    id: 'crafted', title: 'The friend asks for CO₂', shows: 'A crafted request: 403 from the server, and a command naming CO₂ rejected',
    steps: [{
      label: 'Send the crafted requests as the friend', run: async () => {
        await loggedIn('friend');
        return craftedRequest();
      },
      watch: 'The friend asks for a CO₂ datastream by its identifier, copied from somewhere, and sends a clustering command naming CO₂. The server answers 403: the friend may not read it. The model rejects the command, saying only that a requested source is not available.',
    }],
  },
];

/** The demo in progress and the step it has reached (the banner under the title shows it). */
export const activeDemo = new Store<{ demo: Demo; done: number; running: boolean; found?: string; restoring?: boolean } | null>(null);

export function startDemo(demo: Demo) {
  activeDemo.set({ demo, done: 0, running: false });
  void takeStep();
}

export async function takeStep() {
  const a = activeDemo.value;
  if (!a || a.running || a.done >= a.demo.steps.length) return;
  selectComponent('client');
  const step = a.demo.steps[a.done];
  activeDemo.set({ demo: a.demo, done: a.done + 1, running: true });
  let found: string | void;
  try {
    found = await step.run();
  } catch (e) {
    found = `The step failed: ${String((e as Error)?.message ?? e)}`;
  }
  const now = activeDemo.value;
  if (now?.demo === a.demo) activeDemo.set({ ...now, running: false, ...(found ? { found } : {}) });
}

/** "Put everything back" (restore) or close the banner and leave things as they are. */
export async function endDemo(restore: boolean) {
  const a = activeDemo.value;
  if (!restore) {
    activeDemo.set(null);
    return;
  }
  if (a) activeDemo.set({ ...a, restoring: true });
  try {
    await putEverythingBack();
  } finally {
    activeDemo.set(null);
  }
}
