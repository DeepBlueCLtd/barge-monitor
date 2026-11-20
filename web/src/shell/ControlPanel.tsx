// The control panel (§7.4, FR-49..FR-52). It belongs to the demonstrator shell,
// not the system: it stands in for what happens to a deployment (a server taken
// down, a field switched off, a misconfigured server).
import { runtime } from './runtime';
import { useStore } from './store';

export function ControlPanel({ onClose }: { onClose: () => void }) {
  const st = useStore(runtime.control);
  const server = useStore(runtime.server);
  const byName = new Map((st?.fields ?? []).map((r) => [r.name, r]));
  return (
    <aside className="drawer" aria-label="Control panel" data-testid="control-panel">
      <div className="drawer-head">
        <h2>Control panel</h2>
        <button className="close" aria-label="Close the control panel" onClick={onClose}>×</button>
      </div>
      <p className="hint">Part of the demonstrator, not the system. Works whether the simulation is playing or paused (FR-79).</p>
      <div className="row">
        {server === 'down'
          ? <button className="btn" onClick={() => runtime.send('up')} data-testid="server-up">Bring server up</button>
          : <button className="btn" onClick={() => runtime.send('down')} data-testid="server-down">Take server down</button>}
        <span className={`server-pill ${server}`} data-testid="drawer-server-state">
          Server {server}{st?.instance ? ` · instance ${st.instance}` : ''}
        </span>
      </div>
      {!st ? <p>Waiting for the back end's state…</p> : (
        <>
          <h3>Fields the server publishes {st.pending && <span className="pending" data-testid="pending">changes pending until the next server start</span>}</h3>
          <div className="fields-scroll">
            <table className="fields-table">
              <thead><tr><th>Field</th><th>Kind</th><th>Published now</th><th>At next start</th><th>On</th></tr></thead>
              <tbody>
                {st.fields.map((r) => {
                  const blocked = r.on_next_start && !r.published_next_start;
                  const changing = r.published_now !== r.published_next_start;
                  return (
                    <tr key={r.name} className={changing ? 'changing' : ''}>
                      <td>{r.label}{r.essential ? ' (essential)' : ''}{r.extra ? ' (extra)' : ''}</td>
                      <td>{r.kind} · {r.type}{r.inputs.length ? <small> from {r.inputs.map((i) => byName.get(i)?.label ?? i).join(', ')}</small> : null}</td>
                      <td>{r.published_now ? 'yes' : 'no'}</td>
                      <td>{r.published_next_start ? 'yes' : blocked ? 'no (an input is off)' : 'no'}{changing ? ' · pending' : ''}</td>
                      <td><input type="checkbox" checked={r.on_next_start} aria-label={`toggle ${r.name}`}
                        onChange={(e) => runtime.send('field', { name: r.name, on: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="switch"><input type="checkbox" checked={st.lie_about_profile} data-testid="profile-lie"
            onChange={(e) => runtime.send('profile-lie', e.target.checked)} /> Misconfigured server: claim the declared profile even when what it publishes cannot meet it (AT-08)</label>
          <p className="hint">A toggle takes effect only at the next server start (FR-51); stored history is unchanged. Raw parameters switch both sensors together. A model output whose inputs are off is not published (FR-52).</p>
        </>
      )}
    </aside>
  );
}
