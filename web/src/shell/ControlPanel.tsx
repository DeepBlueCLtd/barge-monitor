// The control panel (§6.5): it belongs to the demonstrator shell, not the
// real system. It stands in for what happens to a deployment: a server taken
// down, a sensor not fitted, a product withdrawn or added.
import { runtime } from './runtime';
import { useStore } from './store';

export function ControlPanel({ onRestartClient }: { onRestartClient: () => void }) {
  const st = useStore(runtime.control);
  const server = useStore(runtime.server);
  if (!st) return null;
  const rows = st.fields;
  const byName = new Map(rows.map((r) => [r.name, r]));
  return (
    <div className="control-panel" aria-label="Control panel">
      <div className="row buttons">
        <button onClick={onRestartClient} data-testid="restart-client">Restart client</button>
        <button onClick={() => runtime.send('restart-server')} data-testid="restart-server" className={st.pending ? 'attention' : ''}>Restart server</button>
        {server === 'down'
          ? <button onClick={() => runtime.send('up')} data-testid="server-up">Bring server up</button>
          : <button onClick={() => runtime.send('down')} data-testid="server-down">Take server down</button>}
        <span className={`server-state ${server}`} data-testid="server-state">Server: {server}{st.instance ? ` · instance ${st.instance}` : ''}
          {server === 'waiting' && st.progress ? ` · indexing ${st.progress.indexed.toLocaleString()} of ${st.progress.stored.toLocaleString()} records` : ''}</span>
      </div>
      {st.pending && <p className="pending" role="status" data-testid="pending">Changes pending: they apply at the next server start. Restart the server.</p>}
      <details>
        <summary>Fields the server publishes</summary>
        <table className="fields-table">
          <thead><tr><th>Field</th><th>Kind</th><th>Inputs</th><th>Published now</th><th>At next start</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const blocked = r.on_next_start && !r.published_next_start;
              return (
                <tr key={r.name} className={r.published_now !== r.published_next_start ? 'changing' : ''}>
                  <td>{r.label}{r.essential ? ' ★' : ''}{r.extra ? ' (new)' : ''}</td>
                  <td>{r.kind} · {r.type}</td>
                  <td>{r.inputs.map((i) => byName.get(i)?.label ?? i).join(', ') || '—'}</td>
                  <td>{r.published_now ? 'yes' : 'no'}</td>
                  <td>{r.published_next_start ? 'yes' : blocked ? 'no (an input is off)' : 'no'}</td>
                  <td><label className="switch"><input type="checkbox" checked={r.on_next_start} aria-label={`toggle ${r.name}`}
                    onChange={(e) => runtime.send('field', { name: r.name, on: e.target.checked })} /> on</label></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <label className="switch"><input type="checkbox" checked={st.lie_about_profile} data-testid="profile-lie"
          onChange={(e) => runtime.send('profile-lie', e.target.checked)} /> Misconfigured server: claim the profile even when the offering cannot meet it (AT-07)</label>
        <p className="hint">★ essential in the declared profile. Raw parameters apply to both sensors. The store always keeps everything the sensors measure.</p>
      </details>
    </div>
  );
}
