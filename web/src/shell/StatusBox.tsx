// Below the flowchart (§9.1): the god's-eye note (FR-68a), the status box and the message key
// (VS-08, VS-10). The status mirrors the display client's own replay clock, read in the page
// (interfaces §8).
import { clientSession } from '../client/session';
import { iso } from '../client/plan';
import { Glyph } from './Glyph';
import { bus, LETTER_ORDER, LETTERS } from './messages';
import { runtime } from './runtime';
import { StepState } from './startup';
import { useStore } from './store';

const STEP_MARK: Record<StepState, string> = { pending: '○', active: '…', done: '✓', failed: '✗' };

const CLIENT_PHASE: Record<string, string> = {
  login: 'Not logged in', locked: 'Locked', handshake: 'Handshake', ready: 'Configured', unreachable: 'Server unreachable', rejected: 'Server rejected',
};

type Box = [number, number, number, number];

export function StatusBox({ rect }: { rect: Box }) {
  // D-360: after Adopt the flowchart is on screen while the back end starts; until the server answers the status
  // box shows the startup's named steps, and a stall, in place of its rows (NFR-10a, §13.7).
  const starting = useStore(runtime.progress).stage !== 'ready';
  return starting ? <StartupStatus rect={rect} /> : <StatusRows rect={rect} />;
}

/**
 * NFR-10a, D-360: the named startup steps, in the status box. Each step is one line, the active one with what it is
 * doing; a step that stalls (or fails) says so, with what the viewer can do. The flowchart stays mounted.
 */
function StartupStatus({ rect }: { rect: Box }) {
  const steps = useStore(runtime.startup.steps);
  const stall = useStore(runtime.startup.stall);
  const failure = useStore(runtime.failure);
  return (
    <section className="status-box panel-box startup-strip" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Status"
      data-testid="status-box" role="status" aria-live="polite">
      <h2 className="box-title">Status</h2>
      <p className="starting" data-testid="startup-strip">Starting the {runtime.kind === 'python' ? 'Python back end' : 'JavaScript stand-in'}</p>
      <ol className="steps" data-testid="startup-steps" aria-label="Startup steps">
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.state}`} data-testid={`step-${s.id.replace(' ', '-')}`} data-state={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
            <span className="mark" aria-hidden="true">{STEP_MARK[s.state]}</span>
            <b>{s.id}</b>
            {s.state === 'active' && <span className="step-detail">{s.detail || s.what}</span>}
          </li>
        ))}
      </ol>
      {stall && (
        <div className="stall" role="alert" data-testid="stall" data-step={stall.step}>
          <p><b>{stall.message}</b></p>
          <ul>{stall.advice.map((a) => <li key={a}>{a}</li>)}</ul>
          <button className="btn" onClick={() => location.reload()} data-testid="stall-reload">Reload</button>
        </div>
      )}
      {failure && !stall?.failed && <p className="error">Could not start: {failure}</p>}
    </section>
  );
}

function StatusRows({ rect }: { rect: Box }) {
  const server = useStore(runtime.server);
  const control = useStore(runtime.control);
  const phase = useStore(clientSession.phase);
  const user = useStore(clientSession.user);
  const replay = useStore(clientSession.clock.state);
  const view = useStore(clientSession.view);
  useStore(clientSession.discovery);
  const instance = control?.instance ?? '';
  const file = replay ? clientSession.catalogue.value.find((e) => e.dataset === replay.dataset)?.file ?? replay.dataset : null;
  const degraded = !!view?.problems.length;
  const rows: [string, React.ReactNode, string][] = [
    ['Analyst', phase === 'locked' ? 'Locked' : phase === 'login' ? 'Not logged in' : user ?? '–', 'analyst-state'],
    ['Dataset', file ?? 'None', 'dataset-state'],
    ['Replay', !replay ? 'Paused' : replay.atEnd ? 'At the end' : replay.playing ? 'Playing' : 'Paused', 'sim-state'],
    ['Replay time', replay ? iso(replay.time).slice(5, 19).replace('T', ' ') : '–', 'replay-state'],
    ['Rate', replay ? `${replay.rate}×` : '–', 'speed-state'],
    ['Server', server === 'running' ? `Ready${instance ? ` · start ${instance}` : ''}` : server === 'waiting' ? 'Starting' : 'Down', 'server-state'],
    ['Client', degraded && phase === 'ready' ? 'Degraded' : CLIENT_PHASE[phase] ?? phase, 'client-state'],
    ['Essentials', phase === 'ready' ? (clientSession.essentialsText() === 'All present' ? <span className="good">All present</span> : <span className="bad">{clientSession.essentialsText()}</span>) : '–', 'essentials-state'],
    ['Back end', runtime.kind === 'python' ? 'Python' : 'JavaScript stand-in', 'backend-state'],
  ];
  return (
    <section className="status-box panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Status" data-testid="status-box">
      <h2 className="box-title">Status</h2>
      <dl>
        {rows.map(([k, v, id]) => (
          <div key={k} className="status-row"><dt>{k}</dt><dd data-testid={id}>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

/**
 * FR-122: in the adoption opening the status shows only "Opening": nothing runs yet. While the illustrative traffic is
 * drawn it says so (D-361), so that its icons are not taken for a running system.
 */
export function OpeningStatus({ rect, illustrative = false }: { rect: Box; illustrative?: boolean }) {
  return (
    <section className="status-box panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Status" data-testid="status-box">
      <h2 className="box-title">Status</h2>
      <p className="status-opening" data-testid="status-opening">Opening{illustrative && <span className="status-illustrative" data-testid="status-illustrative"> · illustrative traffic</span>}</p>
    </section>
  );
}

/**
 * FR-68a: the architecture view is a god's-eye view, said in one line so it is not mistaken for a permission leak. Beneath
 * it, what is counted but not drawn (D-283, D-321): registering, the silent import, and the models' reads and writes
 * while they process a dataset. Their runs-log entries and their calls into the scientific libraries are drawn.
 */
export function GodsEyeNote({ rect }: { rect: Box }) {
  const control = useStore(runtime.control);
  const drawn = useStore(bus.counts);
  const captured = control?.capture_counts ?? {};
  let quiet = 0;
  for (const [k, n] of Object.entries(captured)) quiet += Math.max(0, n - (drawn[k] ?? 0));
  return (
    <section className="gods-eye panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="God's-eye view">
      <p data-testid="gods-eye"><b>God’s-eye view:</b> every message is drawn, the models’ CO₂ traffic included, whoever is logged in. The display client’s own messages carry only what its user may read.</p>
      <p className="counted" data-testid="counted-not-drawn" data-count={quiet}>Counted, not drawn: {quiet.toLocaleString('en-GB')} (registering, the silent import, the models’ reads and writes while processing).</p>
    </section>
  );
}

export function MessageKey({ rect }: { rect: Box }) {
  return (
    <section className="message-key panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Message key">
      <h2 className="box-title">Message key</h2>
      <ul>
        {LETTER_ORDER.map((l) => (
          <li key={l} data-testid={`key-${l}`}>
            <Glyph letter={l} size={22} />
            <span>{LETTERS[l].key}</span>
          </li>
        ))}
        <li data-testid="key-user">
          <Glyph letter="Q" size={22} user />
          <span>Caused by your click</span>
        </li>
      </ul>
    </section>
  );
}
