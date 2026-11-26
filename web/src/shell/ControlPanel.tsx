// The control panel (§7.4, FR-49..FR-52, FR-50a). It belongs to the demonstrator shell,
// not the system: it stands in for what happens to a deployment (a server taken
// down, a field switched off, a misconfigured server, an instance reset).
//
// Until the shell's own importer and data folder panels (plan Phase 8), it also shows
// the data folder as the importer's catalogue has it, and the last import's speed
// (FR-109, FR-110): god's-eye, from the control state, not from the server.
import { useState } from 'react';
import { ControlState, runtime } from './runtime';
import { useStore } from './store';

const STATUS: Record<string, string> = {
  'not-imported': 'not imported', importing: 'importing', imported: 'imported', changed: 'changed since import', superseded: 'superseded',
};

/** The data folder and the CSV importer, and Reset instance with its confirmation (FR-50a). */
function DataFolder({ st }: { st: ControlState }) {
  const [confirming, setConfirming] = useState(false);
  const files = st.folder ?? [];
  const datasets = st.datasets ?? [];
  const rate = st.import_rate;
  const models = (st.models ?? []).length;
  return (
    <section data-testid="data-folder">
      <h3>Data folder and CSV importer</h3>
      <table className="fields-table" data-testid="folder-table">
        <thead><tr><th>File</th><th>Size</th><th>Status</th><th>Dataset</th></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.file} data-file={f.file} data-status={f.status}>
              <td>{f.file}</td>
              <td>{(f.size / 1e6).toFixed(1)} MB</td>
              <td>{STATUS[f.status] ?? f.status}{f.status === 'importing' ? ` ${f.pct}%` : ''}</td>
              <td>{f.dataset || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint" data-testid="import-rate">
        {rate ? `Last import: ${rate.file}, ${rate.rows.toLocaleString('en-GB')} rows in ${rate.seconds.toFixed(2)} s, `
          + `${rate.rows_per_s.toLocaleString('en-GB')} rows/s${rate.silent ? ' (silently, at startup)' : ''}.` : 'Nothing imported yet.'}
        {' '}The system never writes to the data folder.
      </p>
      <div className="row">
        {!confirming
          ? <button className="btn" data-testid="reset-instance" onClick={() => setConfirming(true)}>Reset instance…</button>
          : (
            <div role="alertdialog" aria-labelledby="reset-title" aria-describedby="reset-what" data-testid="reset-confirm" className="confirm">
              <p id="reset-title"><b>Reset instance?</b></p>
              <div id="reset-what">
                <p>This deletes the data server’s whole store. Lost:</p>
                <ul>
                  <li>{datasets.length ? `every imported dataset (${datasets.length}: ${datasets.map((d) => d.id).join(', ')})` : 'every imported dataset (none now)'};</li>
                  <li>every model result{models ? ` (from ${models} models)` : ''};</li>
                  <li>all data of interest saved in users’ workspaces;</li>
                  <li>every command and its status.</li>
                </ul>
                <p>The data folder is untouched. Mission A is not imported again until the page is reloaded.</p>
              </div>
              <button className="btn primary" data-testid="reset-confirm-yes" onClick={() => { setConfirming(false); runtime.send('reset-instance'); }}>Reset instance</button>
              {' '}
              <button className="btn" data-testid="reset-confirm-no" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}
      </div>
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
        <button className="close" aria-label="Close the control panel" onClick={onClose}>×</button>
      </div>
      <p className="hint">Part of the demonstrator, not the system. Works whether the simulation is playing or paused. Failure demos, in the top bar, set these switches for you.</p>
      <div className="row">
        {server === 'down'
          ? <button className="btn" onClick={() => runtime.send('up')} data-testid="server-up">Bring server up</button>
          : <button className="btn" onClick={() => runtime.send('down')} data-testid="server-down">Take server down</button>}
        <span className={`server-pill ${server}`} data-testid="drawer-server-state">
          Server {server}{st?.instance ? ` · start ${st.instance}` : ''}
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
            onChange={(e) => runtime.send('profile-lie', e.target.checked)} /> Misconfigured server: claim the declared profile even when what it publishes cannot meet it</label>
          <p className="hint">A toggle takes effect only at the next server start; stored history is unchanged. Raw parameters switch both sensors together. A model output whose inputs are off is not published.</p>
          <DataFolder st={st} />
        </>
      )}
    </aside>
  );
}
