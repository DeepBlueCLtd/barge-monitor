// Below the flowchart (§9.1): the status box and the message key (VS-08, VS-10).
import { clientSession } from '../client/session';
import { simClock } from './clock';
import { Glyph } from './Glyph';
import { LETTER_ORDER, LETTERS } from './messages';
import { runtime } from './runtime';
import { useStore } from './store';

export const SPEED_LABELS: Record<number, string> = { 0.25: '¼×', 0.5: '½×', 1: '1×' };

const CLIENT_PHASE: Record<string, string> = {
  'waiting-play': 'Waiting for play', 'waiting-models': 'Waiting for models', handshake: 'Handshake', configured: 'Configured', degraded: 'Degraded',
  rejected: 'Server rejected', waiting: 'Waiting (503)', unreachable: 'Server unreachable', error: 'Error',
};

export function historyLabel(days: number | null): string {
  if (days == null) return 'none';
  if (days % 7 === 0) return days === 7 ? '1 week' : `${days / 7} weeks`;
  return `${days} days`;
}

type Box = [number, number, number, number];

export function StatusBox({ rect }: { rect: Box }) {
  const clock = useStore(simClock.state);
  const server = useStore(runtime.server);
  const control = useStore(runtime.control);
  const session = useStore(clientSession);
  const phase = useStore(session.phase);
  const config = useStore(session.config);
  const props = useStore(session.props);
  const missing = config?.problems.length ?? 0;
  const optional = props.filter((p) => !p.essential).length;
  const instance = control?.instance ?? '';
  const rows: [string, React.ReactNode, string][] = [
    ['Simulation', clock?.playing ? 'Playing' : 'Paused', 'sim-state'],
    ['Speed', SPEED_LABELS[clock?.rate ?? 0.5] ?? `${clock?.rate}×`, 'speed-state'],
    ['History', historyLabel(runtime.history.days), 'history-state'],
    ['Server', server === 'running' ? `Ready${instance ? ` · ${instance.slice(0, 6)}` : ''}` : server === 'waiting' ? 'Waiting (503)' : 'Down', 'server-state'],
    ['Client', CLIENT_PHASE[phase] ?? phase, 'client-state'],
    ['Essentials', config ? (missing ? <span className="bad">{missing} missing</span> : <span className="good">All present</span>) : '–', 'essentials-state'],
    ['Optional', config ? `${optional} source${optional === 1 ? '' : 's'}` : '–', 'optional-state'],
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
      </ul>
    </section>
  );
}
