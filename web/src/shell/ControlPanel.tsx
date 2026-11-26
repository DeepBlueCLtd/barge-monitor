// The control panel (§7.4, FR-49 to FR-52, FR-50a; docs/v4-interfaces.md §13.3 to §13.5). It
// belongs to the demonstrator shell, not the system: it stands in for what happens to a
// deployment (a server taken down, a field switched off, a misconfigured server, an instance
// reset) and for OpenSensorHub's own administration (the admin stub). Capture can be switched
// off to show it changes nothing (AT-18). There is no Freeze (4.7). The data folder and the
// importer's catalogue are on their own panels (FR-109, FR-110).
import { useState } from 'react';
import { ControlState, runtime } from './runtime';
import { useStore } from './store';

/** Reset instance, behind a confirmation naming what will be lost (FR-50a). */
function ResetInstance({ st }: { st: ControlState }) {
  const [confirming, setConfirming] = useState(false);
  const datasets = st.datasets ?? [];
  const models = (st.models ?? []).length;
  return (
    <section data-testid="reset-section">
      <h3>Reset instance</h3>
      {!confirming
        ? <button className="btn" data-testid="reset-instance" onClick={() => setConfirming(true)}>Reset instance…</button>
        : (
          <div role="alertdialog" aria-labelledby="reset-title" aria-describedby="reset-what" data-testid="reset-confirm" className="confirm">
            <p id="reset-title"><b>Reset instance?</b></p>
            <div id="reset-what">
              <p>This deletes the data server’s whole store: the server stops, and starts again empty. Lost:</p>
              <ul>
                <li>{datasets.length ? `every imported dataset (${datasets.length}: ${datasets.map((d) => d.id).join(', ')})` : 'every imported dataset (none now)'};</li>
                <li>every model result{models ? ` (from ${models} models)` : ''};</li>
                <li>all data of interest saved in the analysts’ workspaces (their Favourites);</li>
                <li>every command and its status.</li>
              </ul>
              <p>The data folder is untouched. Mission A is not imported again until the page is reloaded.</p>
            </div>
            <button className="btn primary" data-testid="reset-confirm-yes" onClick={() => { setConfirming(false); runtime.send('reset-instance'); }}>Reset instance</button>
            {' '}
            <button className="btn" data-testid="reset-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        )}
    </section>
  );
}

/** The admin stub (docs/v4-interfaces.md §13.5, FR-115): OpenSensorHub's own administration, stood in for. */
const USER_ROLES: [string, string][] = [['owner', 'Owner'], ['viewer-emissions', 'Viewer with emissions'], ['viewer', 'Viewer (weather only)']];

function Administration({ st }: { st: ControlState }) {
  const users = (st.accounts ?? []).filter((a) => a.kind === 'user');
  return (
    <section data-testid="admin-stub">
      <h3>OpenSensorHub administration (stand-in)</h3>
      <p className="hint">The owner assigns roles here (FR-115). The server reads the assignment on every request, so a change takes effect at the user’s next request (FR-116).</p>
      <table className="fields-table">
        <thead><tr><th>Account</th><th>Role</th></tr></thead>
        <tbody>
          {users.map((a) => (
            <tr key={a.user}>
              <td>{a.user}</td>
              <td>
                <select value={a.role} aria-label={`Role of ${a.user}`} data-testid={`set-role-${a.user}`}
                  onChange={(e) => runtime.send('set-role', { user: a.user, role: e.target.value })}>
                  {USER_ROLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ControlPanel({ onClose }: { onClose: () => void }) {
  const st = useStore(runtime.control);
  const server = useStore(runtime.server);
  const byName = new Map((st?.fields ?? []).map((r) => [r.name, r]));
  return (
    <aside className="drawer" aria-label="Control panel" data-testid="control-panel">
      <div className="drawer-head">
        <h2>Control panel</h2>
        <button className="close" aria-label="Close the control panel" data-testid="control-panel-close" onClick={onClose}>×</button>
      </div>
      <p className="hint">Part of the demonstrator, not the system. Failure demos, in the top bar, set these switches for you. Restart client and Restart server are in the top bar.</p>
      <div className="row">
        {server === 'down'
          ? <button className="btn" onClick={() => runtime.send('up')} data-testid="server-up">Bring server up</button>
          : <button className="btn" onClick={() => runtime.send('down')} data-testid="server-down">Take server down</button>}
        <span className={`server-pill ${server}`} data-testid="drawer-server-state">
          Server {server === 'waiting' ? 'starting' : server}{st?.instance ? ` · start ${st.instance}` : ''}
        </span>
      </div>
      {!st ? <p>Waiting for the back end's state…</p> : (
        <>
          <h3>Fields the server publishes {st.pending && <span className="pending" data-testid="pending">changes pending until the next server start</span>}</h3>
          <div className="fields-scroll">
            <table className="fields-table" data-testid="fields-table">
              <thead><tr><th>Field</th><th>Kind</th><th>Published now</th><th>At next start</th><th>On</th></tr></thead>
              <tbody>
                {st.fields.map((r) => {
                  const blocked = r.on_next_start && !r.published_next_start;
                  const changing = r.published_now !== r.published_next_start;
                  return (
                    <tr key={r.name} className={changing ? 'changing' : ''} data-field={r.name} data-now={String(r.published_now)} data-next={String(r.published_next_start)}>
                      <td>{r.label}{r.essential ? ' (essential)' : ''}{r.extra ? ' (extra)' : ''}</td>
                      <td>{r.kind} · {r.type}{r.inputs.length ? <small> from {r.inputs.map((i) => byName.get(i)?.label ?? i).join(', ')}</small> : null}</td>
                      <td>{r.published_now ? 'yes' : 'no'}</td>
                      <td>{r.published_next_start ? 'yes' : blocked ? 'no (an input is off)' : 'no'}{changing ? ' · pending' : ''}</td>
                      <td><input type="checkbox" checked={r.on_next_start} aria-label={`toggle ${r.name}`} data-testid={`field-${r.name}`}
                        onChange={(e) => runtime.send('field', { name: r.name, on: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="switch"><input type="checkbox" checked={st.lie_about_profile} data-testid="profile-lie"
            onChange={(e) => runtime.send('profile-lie', { on: e.target.checked })} /> Misconfigured server: publish the importer’s catalogue without its status, and still claim the declared profile (at the next start)</label>
          <p className="hint">A toggle takes effect only at the next server start (Restart server, or down and up); nothing stored is changed. Raw parameters switch both sensors together, in every dataset. A model output whose inputs are off is not published.</p>
          <label className="switch"><input type="checkbox" checked={st.capture !== false} data-testid="capture-toggle"
            onChange={(e) => runtime.send('capture', e.target.checked)} /> Capture messages: off, nothing is drawn or counted, and every output is the same (AT-18)</label>
          <ResetInstance st={st} />
          <Administration st={st} />
        </>
      )}
    </aside>
  );
}
