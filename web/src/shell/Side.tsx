// The side column (VS-28): message key, zone legend and status summary.
import { simClock } from './clock';
import { LETTERS } from './messages';
import { ZONES } from './palette';
import { runtime } from './runtime';
import { clientStatus } from './status';
import { useStore } from './store';

const ZONE_NAMES: Record<string, string> = { simulated: 'Simulated', legacy: 'Legacy', new: 'New build', third: 'Third-party' };
const SHORT: Record<string, string> = {
  Q: 'Connected Systems request', D: 'Discovery resource', O: 'Observations, SWE JSON', K: 'Command, control stream',
  P: 'Declared profile', H: 'HTTP status (503 …)', L: 'Legacy fixed-width record', I: 'Internal object',
};

export function Side() {
  const clock = useStore(simClock.state);
  const control = useStore(runtime.control);
  const server = useStore(runtime.server);
  const client = useStore(clientStatus);
  const kind = useStore(runtime.backendKind);
  const rows: [string, string, string?, string?][] = [
    ['Simulation', clock?.playing ? 'Playing' : 'Paused'],
    ['Speed', `${clock?.rate ?? ''}×`],
    ['Sim time', simClock.iso().replace('T', ' ').replace('Z', ''), undefined, 'sim-now'],
    ['Backend', kind === 'simulation' ? 'JS simulation' : 'Python (Pyodide)', kind === 'simulation' ? 'warn' : undefined],
    ['History', runtime.historySource],
    ['Server', `${server === 'running' ? 'Ready' : server === 'waiting' ? 'Waiting (503)' : 'Down'}${control?.instance ? ` · ${control.instance}` : ''}`, server === 'running' ? undefined : 'warn'],
    ['Client', client.phase === 'running' ? 'Configured' : client.phase === 'degraded' ? 'Degraded' : client.phase[0].toUpperCase() + client.phase.slice(1), client.phase === 'running' ? undefined : 'warn'],
    ['Essentials', client.phase === 'starting' || client.phase === 'handshake' ? '…' : client.essentialsMissing ? `${client.essentialsMissing} unavailable` : 'All present', client.essentialsMissing ? 'warn' : 'ok'],
    ['Optional', `${client.optional} sources`],
  ];
  return (
    <aside className="side">
      <section className="side-card" aria-label="Message key">
        <h3>Message key</h3>
        {Object.entries(LETTERS).map(([l, v]) => (
          <div key={l} className="key-item" title={v.standard}>
            <span className="ring" style={{ borderColor: v.colour, color: v.colour }}>{l}</span>{SHORT[l]}
          </div>
        ))}
      </section>
      <section className="side-card" aria-label="Zones">
        <h3>Zones</h3>
        {Object.entries(ZONES).map(([z, s]) => (
          <div key={z} className="key-item"><span className={`swatch ${s.dashed ? 'dashed' : ''}`} style={{ background: s.fill, borderColor: s.hue }} />{ZONE_NAMES[z]}</div>
        ))}
      </section>
      <section className="side-card" aria-label="Status" data-testid="status-summary">
        <h3>Status</h3>
        <table className="status">
          <tbody>{rows.map(([k, v, tone, id]) => <tr key={k}><th>{k}</th><td className={tone} data-testid={id}>{v}</td></tr>)}</tbody>
        </table>
        {control?.pending && <p className="pending" role="status" data-testid="pending">Changes pending: restart the server to apply them.</p>}
      </section>
    </aside>
  );
}
