// The control panel (§7.4, FR-49 to FR-52, FR-50a, §13.5). It belongs to the
// demonstrator shell, not the system: it stands in for what happens to a
// deployment (a server taken down, a field switched off, a misconfigured server,
// the store reset) and for OpenSensorHub's own administration screen.
import { useState } from 'react';
import { runtime } from './runtime';
import { Store, useStore } from './store';

/** Whether messages are captured (FR-66): on at load. */
export const captureOn = new Store(true);

/** Roles the admin stub assigns (FR-114, FR-115): the owner assigns roles, and never edits them. */
const ROLES: [string, string][] = [['owner', 'Owner'], ['viewer-emissions', 'Viewer with emissions'], ['viewer', 'Viewer (weather only)']];

export function ControlPanel({ onClose }: { onClose: () => void }) {
  const st = useStore(runtime.control);
  const server = useStore(runtime.server);
  const [confirm, setConfirm] = useState(false);
  const byName = new Map((st?.fields ?? []).map((r) => [r.name, r]));
  const capture = useStore(captureOn);
  const imported = (st?.datasets ?? []).length;
  const send = (action: string, arg?: unknown) => void runtime.control(action, arg).catch(() => undefined);
  return (
    <aside className="drawer" aria-label="Control panel" data-testid="control-panel">
      <div className="drawer-head">
        <h2>Control panel</h2>
        <button className="close" aria-label="Close the control panel" onClick={onClose}>×</button>
      </div>
      <p className="hint">Part of the demonstrator, not the system. Works frozen or not. Failure demos, in the top bar, set these switches for you.</p>
      <div className="row">
        {server === 'down'
          ? <button className="btn" onClick={() => send('up')} data-testid="server-up">Bring server up</button>
          : <button className="btn" onClick={() => send('down')} data-testid="server-down">Take server down</button>}
        <button className="btn" onClick={() => send('restart-server')} data-testid="cp-restart-server">Restart server</button>
        <span className={`server-pill ${server}`} data-testid="drawer-server-state">Server {server}</span>
        <label className="switch"><input type="checkbox" checked={capture} data-testid="capture"
          onChange={(e) => {
            captureOn.set(e.target.checked);
            send('capture', { on: e.target.checked });
          }} /> Capture messages</label>
      </div>
      <div className="row">
        {!confirm ? <button className="btn" onClick={() => setConfirm(true)} data-testid="reset-instance">Reset instance…</button> : (
          <div className="confirm" data-testid="reset-confirm">
            <p><b>Reset instance?</b> This stops the server and deletes its whole store: {imported} imported dataset{imported === 1 ? '' : 's'}, every model result,
              and every analyst's data of interest. Nothing is deleted record by record, and the data folder is untouched. Mission A is not imported again until the page is reloaded.</p>
            <button className="btn primary" onClick={() => {
              setConfirm(false);
              send('reset-instance');
            }} data-testid="reset-confirm-yes">Delete the store and restart</button>
            <button className="btn" onClick={() => setConfirm(false)} data-testid="reset-confirm-no">Keep it</button>
          </div>
        )}
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
                      <td><input type="checkbox" checked={r.on_next_start} aria-label={`toggle ${r.name}`} data-testid={`field-${r.name}`}
                        onChange={(e) => send('field', { name: r.name, on: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <label className="switch"><input type="checkbox" checked={st.lie_about_profile} data-testid="profile-lie"
            onChange={(e) => send('profile-lie', { on: e.target.checked })} /> Misconfigured server: claim the declared profile even when what it publishes cannot meet it</label>
          <p className="hint">A toggle takes effect only at the next server start; what is stored is unchanged. Raw parameters switch both sensors together. A model output whose inputs are off is not published.</p>
          <h3>OpenSensorHub administration (stand-in)</h3>
          <p className="hint">Stands in for OpenSensorHub's own administration screen, where the owner assigns each account a role (FR-115). A change takes effect at the account's next request (D-151).</p>
          <table className="fields-table" data-testid="admin-stub">
            <thead><tr><th>Account</th><th>Role</th></tr></thead>
            <tbody>
              {(st.accounts ?? []).filter((a) => !a.user.startsWith('svc-')).map((a) => (
                <tr key={a.user}>
                  <td className="mono">{a.user}</td>
                  <td>
                    <select value={a.role} data-testid={`set-role-${a.user}`} onChange={(e) => send('set-role', { user: a.user, role: e.target.value })}>
                      {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </aside>
  );
}
