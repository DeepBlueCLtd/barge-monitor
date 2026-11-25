// Failure demos (FR-79a): one-click scenarios, each with what to watch for. They
// belong to the demonstrator shell, like the control panel: they stand in for what
// happens to a deployment (a server taken down, a source removed, a misconfigured
// server) and for what a person at the screen does (a wrong password, walking away,
// a crafted request). Replay is driven through the display client, as a viewer would.
import { clientSession, DisplayClientSession } from '../client/session';
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

const EXTRAS = ['pressure_tendency_3h'];
const control = (action: string, arg?: unknown) => runtime.control(action, arg).catch(() => runtime.controlState.value);
const field = (name: string, on: boolean) => control('field', { name, on });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const demo = (user: string) => DEMO_LOGINS.find((a) => a.user === user)!;

async function until(test: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) return false;
    await sleep(200);
  }
  return true;
}

/** The display client on screen, logged in as `user` (the owner unless a demo says otherwise). */
async function loggedIn(user = 'owner', s: DisplayClientSession = clientSession) {
  selectComponent('client');
  if (s.user.value !== user || s.phase.value === 'login' || s.phase.value === 'locked') {
    s.restart();
    await s.login(user, demo(user).password);
  }
  await until(() => s.phase.value === 'ready' && !!s.replay.value);
}

/** Playing, so that the client polls and notices what happens to the server (FR-63). */
async function playing() {
  await loggedIn(clientSession.user.value ?? 'owner');
  const r = clientSession.replay.value;
  if (r && !r.playing && !r.at_end) clientSession.play();
}

async function openFile(prefix: RegExp) {
  await loggedIn(clientSession.user.value ?? 'owner');
  await until(() => clientSession.catalogue.value.some((e) => prefix.test(e.file)));
  const e = clientSession.catalogue.value.filter((x) => prefix.test(x.file)).pop();
  if (e) clientSession.open(e);
}

/** Every switch back to how the page started. */
export async function putEverythingBack() {
  clientSession.idleMs = IDLE_LOCK_MS;
  if (runtime.controlState.value?.frozen) await runtime.freeze(false);
  await control('profile-lie', { on: false });
  for (const f of runtime.controlState.value?.fields ?? []) {
    if (f.on_next_start !== !f.extra) await field(f.name, !f.extra);
  }
  await control(runtime.server.value === 'down' ? 'up' : 'restart-server');
}

/** FR-79a: the friend's crafted request for CO₂, sent with the friend's credentials, as a guest at the screen might. */
async function craftedRequest(): Promise<string> {
  const auth = (u: string) => 'Basic ' + btoa(`${u}:${demo(u).password}`);
  const quiet = { authorization: auth('owner'), 'x-tap-quiet': '1' };
  const j = async (path: string, headers: Record<string, string>) => (await fetch(API_BASE + path, { headers, cache: 'no-store' })).json();
  // The demonstrator, not the client, knows where CO₂ is: it asks as the owner, quietly (a god's-eye view, FR-68a).
  const systems = (await j('collections/all_systems/items?limit=1000', quiet)).items as { id: string; properties: { uid: string } }[];
  const co2 = systems.find((s) => /:co2$/.test(s.properties.uid));
  const ds = co2 ? (await j(`systems/${co2.id}/datastreams?limit=1000`, quiet)).items?.[0] : null;
  const chain = `crafted-${Date.now()}`;
  const friend = { authorization: auth('friend'), 'x-tap-chain': chain };
  const r1 = ds ? await fetch(API_BASE + `datastreams/${ds.id}/observations?limit=5`, { headers: friend, cache: 'no-store' }) : null;
  // A clustering command naming a CO₂ field, as the friend.
  const cs = (await j('controlstreams?limit=1000', quiet)).items.find((c: { inputName: string }) => c.inputName === 'clustering');
  const dataset = runtime.replay.value?.dataset ?? '';
  const doi = { dataset, start: new Date((runtime.replay.value?.start ?? 0) * 1000).toISOString().replace('.000Z', 'Z'),
    end: new Date(((runtime.replay.value?.start ?? 0) + 600) * 1000).toISOString().replace('.000Z', 'Z'), resolution: 'PT1S',
    sources: [{ system: co2?.properties.uid ?? 'urn:x-barge:sensor:bow:co2', output: 'co2', fields: ['co2'] }] };
  const sentAt = Date.now() - 1000;
  void fetch(API_BASE + `controlstreams/${cs.id}/commands`, {
    method: 'POST', headers: { ...friend, 'content-type': 'application/json' },
    body: JSON.stringify({ parameters: { algorithm: 'A', doi: JSON.stringify(doi), clusters: 3, sensitivity: 5 } }),
  });
  let verdict = 'no answer from the model yet';
  await until(() => false, 1500);
  for (let i = 0; i < 20; i++) {
    const st = (await j(`controlstreams/${cs.id}/status?limit=10000`, quiet)).items as { statusCode: string; message?: string; reportTime: string }[];
    const mine = st.filter((x) => Date.parse(x.reportTime) >= sentAt && (x.statusCode === 'REJECTED' || x.statusCode === 'COMPLETED'));
    if (mine.length) {
      verdict = `${mine[0].statusCode}: ${mine[0].message ?? ''}`;
      break;
    }
    await sleep(500);
  }
  return `Asked by identifier, the server answered ${r1 ? r1.status : 'nothing'}${r1?.status === 404 ? ' (Not Found): to the friend it does not exist' : ''}. The command naming CO₂: ${verdict}.`;
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
        label: 'Bring the server up', run: () => void control('up'),
        watch: 'The server starts, refusing connections for about a second. Once it answers, the display client repeats its handshake, drawn one request at a time, and its views are fresh again.',
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
      watch: 'While it starts the server refuses connections, so requests stop at the boundary. Push subscriptions end and the receivers subscribe again. The display client repeats its handshake when the server answers.',
    }],
  },
  {
    id: 'essential', title: 'An essential source is missing', shows: 'The dataset opens degraded and says exactly what is missing',
    steps: [{
      label: 'Switch air temperature off and restart the server',
      run: async () => {
        await playing();
        await field('air_temperature', false);
        await control('restart-server');
      },
      watch: 'The server no longer offers air temperature. After its handshake the display client opens the dataset degraded: one warning names every missing essential, and the views draw what is left.',
    }],
  },
  {
    id: 'extra', title: 'Fields the client has never seen', shows: 'A new source appears after a client restart, with no new display code',
    steps: [
      {
        label: 'Switch pressure tendency on and restart the server',
        run: async () => {
          await loggedIn();
          for (const n of EXTRAS) await field(n, true);
          await control('restart-server');
        },
        watch: 'The server now publishes a field the display client was never told about. Nothing changes on screen yet: discovery happens at the handshake.',
      },
      {
        label: 'Restart the client and log in',
        run: async () => {
          clientSession.restart();
          await loggedIn();
        },
        watch: 'After its handshake the new field appears as a dashed chip. Select it: it is drawn by its schema type alone.',
      },
    ],
  },
  {
    id: 'lie', title: 'A misconfigured server', shows: 'A claim of the profile is checked, not trusted',
    steps: [{
      label: 'Remove air temperature but still claim the profile',
      run: async () => {
        await playing();
        await field('air_temperature', false);
        await control('profile-lie', { on: true });
        await control('restart-server');
      },
      watch: 'The server claims the declared profile while it no longer offers air temperature. The display client checks every essential against discovery itself, so the claim changes nothing: the dataset opens degraded, naming air temperature.',
    }],
  },
  {
    id: 'rate', title: 'A rate above what the models sustain', shows: 'The replay controller rejects it, naming the bound and the model',
    steps: [{
      label: 'Ask for 100×', run: async () => {
        await loggedIn(clientSession.user.value ?? 'owner');
        clientSession.setRate(100);
      },
      watch: 'The display client sends the command and does not wait. The replay controller rejects it, naming its bound and the model that sets it, and the display client shows the rejection. The rate is unchanged.',
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
      watch: 'Leave the mouse and keyboard alone. After 5 seconds of no input (5 minutes in a deployment) the client locks: every view and list is blanked, the credentials are discarded and no request is sent until someone logs in again.',
    }],
  },
  {
    id: 'overlap', title: 'An overlapping file', shows: 'Mission B and its re-export imported side by side, never mixed',
    steps: [
      {
        label: 'Open Mission B', run: () => openFile(/^MISSION_B_\d+\.csv$/),
        watch: 'The display client asks the importer to import Mission B, shows its progress, then loads it. It gets datastreams of its own.',
      },
      {
        label: 'Open Mission B (re-export)', run: () => openFile(/REEXPORT/),
        watch: 'The re-export overlaps Mission B by 18 hours and differs in a few readings. It is imported as a dataset of its own, in its own datastreams: the two are never mixed. Both stay in the picker.',
      },
    ],
  },
  {
    id: 'degraded', title: 'A degraded dataset', shows: 'Mission C opens degraded; other datasets are not affected',
    steps: [{
      label: 'Open Mission C', run: () => openFile(/^MISSION_C_/),
      watch: "Mission C's file has no stern wind speed column. The dataset opens degraded, naming the missing essential. Open Mission A again: it is not degraded.",
    }],
  },
  {
    id: 'friend', title: 'The friend logs in', shows: 'The same dataset, with no trace of CO₂ anywhere in the client',
    steps: [{
      label: 'Log in as the friend', run: async () => {
        clientSession.restart();
        await loggedIn('friend');
      },
      watch: 'The same build and the same dataset. The friend’s handshake finds no CO₂ system, so no chip, view, list entry or source names CO₂, and none of the client’s own messages carries it. The flowchart still shows the models’ CO₂ traffic: it is a god’s-eye view.',
    }],
  },
  {
    id: 'crafted', title: 'The friend asks for CO₂', shows: 'A crafted request: 404 from the server, and a command naming CO₂ rejected',
    steps: [{
      label: 'Send the crafted requests as the friend', run: async () => {
        await loggedIn('friend');
        return craftedRequest();
      },
      watch: 'The friend asks for a CO₂ datastream by its identifier, copied from somewhere, and sends a clustering command naming CO₂. The access gateway answers 404: to the friend it does not exist. The model rejects the command, saying only that a requested source is not available.',
    }],
  },
];

/** The demo in progress and the step it has reached (the banner under the title shows it). */
export const activeDemo = new Store<{ demo: Demo; done: number; found?: string } | null>(null);

export function startDemo(demo: Demo) {
  activeDemo.set({ demo, done: 0 });
  void takeStep();
}

export async function takeStep() {
  const a = activeDemo.value;
  if (!a || a.done >= a.demo.steps.length) return;
  selectComponent('client');
  const step = a.demo.steps[a.done];
  activeDemo.set({ demo: a.demo, done: a.done + 1 });
  const found = await step.run();
  const now = activeDemo.value;
  if (found && now?.demo === a.demo) activeDemo.set({ ...now, found });
}

export function endDemo(restore: boolean) {
  if (restore) void putEverythingBack();
  activeDemo.set(null);
}
