// Below the flowchart (§9.1): the status box and the message key (VS-08, VS-10).
import { clientSession } from '../client/session';
import { isoSecond } from './drawclock';
import { Glyph } from './Glyph';
import { LETTER_ORDER, LETTERS } from './messages';
import { opening } from './opening';
import { runtime } from './runtime';
import { useStore } from './store';

const CLIENT_PHASE: Record<string, string> = {
  login: 'Login screen', locked: 'Locked', handshake: 'Handshake', ready: 'Configured', unreachable: 'Server unreachable', rejected: 'Server rejected',
  error: 'Error',
};

type Box = [number, number, number, number];

export function StatusBox({ rect }: { rect: Box }) {
  const phase = useStore(opening.phase);
  // FR-122: in the adoption opening the status shows only "Opening".
  if (phase === 'build' || phase === 'merging') {
    return (
      <section className="status-box panel-box" style={{ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }} aria-label="Status" data-testid="status-box">
        <h2 className="box-title">Status</h2>
        <p className="status-opening" data-testid="status-opening">Opening</p>
      </section>
    );
  }
  return <RunningStatus rect={rect} />;
}

/** §9.1: the logged-in analyst or locked, the current dataset, replay time, rate, back end, server, client and essentials. */
function RunningStatus({ rect }: { rect: Box }) {
  const replay = useStore(runtime.replay);
  const server = useStore(runtime.server);
  const phase = useStore(clientSession.phase);
  const user = useStore(clientSession.user);
  useStore(clientSession.discovery);
  const view = useStore(clientSession.view);
  const essentials = clientSession.essentialsText();
  const rows: [string, React.ReactNode, string][] = [
    ['Analyst', phase === 'locked' ? 'Locked' : phase === 'login' ? 'Not logged in' : user ?? '–', 'analyst-state'],
    ['Dataset', replay?.dataset ? <span title={replay.dataset}>{replay.dataset.replace(/-[0-9a-f]{8}$/, '')}</span> : 'None', 'dataset-state'],
    ['Replay time', replay ? `${isoSecond(replay.time).slice(5, 19).replace('T', ' ')} · ${replay.at_end ? 'at the end' : replay.playing ? 'playing' : 'paused'}` : '–', 'replay-state'],
    ['Rate', replay ? `${replay.rate}× (at most ${replay.max_rate}×, ${replay.max_rate_model})` : '–', 'rate-state'],
    ['Back end', runtime.kind === 'python' ? 'Python' : 'JavaScript stand-in', 'backend-state'],
    ['Server', server === 'running' ? 'Running' : server === 'starting' ? 'Starting' : 'Down', 'server-state'],
    ['Client', CLIENT_PHASE[phase] ?? phase, 'client-state'],
    ['Essentials', phase === 'ready' || phase === 'rejected' ? (essentials === 'All present' ? <span className="good">All present</span> : <span className="bad" title={essentials}>{essentials.split(':')[0]}{view ? '' : ''}</span>) : '–', 'essentials-state'],
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
