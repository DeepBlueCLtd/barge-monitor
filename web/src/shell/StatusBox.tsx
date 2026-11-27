// Below the flowchart (§9.1): the god's-eye note (FR-68a), the status box and the message key
// (VS-08, VS-10). The status mirrors the display client's own replay clock, read in the page
// (interfaces §8).
import { clientSession } from '../client/session';
import { iso } from '../client/plan';
import { Glyph } from './Glyph';
import { bus, LETTER_ORDER, LETTERS } from './messages';
import { runtime } from './runtime';
import { useStore } from './store';

const CLIENT_PHASE: Record<string, string> = {
  login: 'Not logged in', locked: 'Locked', handshake: 'Handshake', ready: 'Configured', unreachable: 'Server unreachable', rejected: 'Server rejected',
};

type Box = [number, number, number, number];

export function StatusBox({ rect }: { rect: Box }) {
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
    <section className="status-box panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Status">
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
