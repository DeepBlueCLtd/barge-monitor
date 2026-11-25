// The display client's screen (SRD §8.1), inside the monitor frame. Before login,
// the login screen only (FR-97). After login, from top to bottom: a status strip
// with the analyst's name and Lock; the dataset picker; the replay bar; the field
// chips, period presets and clustering; the views; the data of interest list.
// It is deliberately small and generic. It draws what discovery finds and
// nothing else: which sources a user sees is decided by the server.
//
// The demonstrator's demo credentials are passed in by the shell (FR-102): a
// developed system never pre-populates credentials, and this file knows no account.
import { FormEvent, useEffect, useState } from 'react';
import { RATES } from '../config';
import { useStore } from '../shell/store';
import { essentialLabel } from './discovery';
import { problemText, RESOLUTIONS } from './fields';
import { iso, PERIODS } from './plan';
import { CatalogueEntry, clientSession, DisplayClientSession, DoiItem } from './session';
import { PanelGrid } from './views/PanelGrid';
import { ClusterView, ErrorBarView, HeatmapView, LineView, OpenedView } from './views/views';

export interface DemoAccount {
  user: string;
  password: string;
  /** What the account is for, in a few words. */
  note: string;
}

export function DisplayClient({ demoAccounts = [] }: { demoAccounts?: DemoAccount[] }) {
  const session = clientSession;
  const phase = useStore(session.phase);
  if (phase === 'login' || phase === 'locked') return <Login session={session} demoAccounts={demoAccounts} locked={phase === 'locked'} />;
  return <Main session={session} />;
}

// --- login and lock (FR-97 to FR-102, VS-24) ------------------------------------------------------------------
function Login({ session, demoAccounts, locked }: { session: DisplayClientSession; demoAccounts: DemoAccount[]; locked: boolean }) {
  const error = useStore(session.loginError);
  const [user, setUser] = useState(locked ? session.user.value ?? '' : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (u: string, p: string) => {
    setBusy(true);
    await session.login(u, p);
    setBusy(false);
    setPassword('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void go(user, password);
  };
  return (
    <div className="dc dc-login" data-testid={locked ? 'dc-locked' : 'dc-login'}>
      <h3>{locked ? 'Locked' : 'Weather display'}</h3>
      <p className="dc-login-lede">{locked ? 'The screen was locked and everything on it was cleared. Log in again to continue where you were.' : 'Log in to see the recordings.'}</p>
      <form onSubmit={submit} className="dc-login-form">
        <label>Name <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" data-testid="login-user" /></label>
        <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" data-testid="login-password" /></label>
        <button className="dc-btn primary" type="submit" disabled={busy || !user} data-testid="login-submit">{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      {error && <p className="dc-login-error" aria-live="assertive" data-testid="login-error">{error}</p>}
      {demoAccounts.length > 0 && (
        <div className="dc-demo-creds" data-testid="demo-credentials">
          <p className="dc-demo-label">Demo credentials</p>
          {demoAccounts.map((a) => (
            <div key={a.user} className="dc-demo-row">
              <code>{a.user}</code> <code>{a.password}</code> <span>{a.note}</span>
              <button className="dc-btn small" disabled={busy} onClick={() => {
                setUser(a.user);
                void go(a.user, a.password);
              }} data-testid={`demo-login-${a.user}`}>Log in</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- after login ---------------------------------------------------------------------------------------------
function Main({ session }: { session: DisplayClientSession }) {
  const phase = useStore(session.phase);
  const user = useStore(session.user);
  const discovery = useStore(session.discovery);
  const stale = useStore(session.stale);
  const notices = useStore(session.notices);
  const view = useStore(session.view);
  const loading = useStore(session.loading);
  const opened = useStore(session.opened);
  return (
    <div className={`dc${stale ? ' is-stale' : ''}`} data-testid="dc" data-phase={phase}>
      <div className="dc-status">
        <span data-testid="dc-user">Logged in as <b>{user}</b></span>
        <span className="dc-phase" data-testid="dc-phase">{phase === 'handshake' ? 'Discovering what the server offers…' : phase === 'unreachable' ? 'Server not answering' : ''}</span>
        <button className="dc-btn small" onClick={() => session.lock()} data-testid="dc-lock">Lock</button>
      </div>
      {phase === 'unreachable' && (
        <div className="dc-banner bad" data-testid="dc-unreachable" aria-live="polite">The server is not answering. What is shown is stale; the client will discover the server again as soon as it answers.</div>
      )}
      {discovery?.rejected && <div className="dc-rejected" data-testid="dc-rejected">{discovery.rejected} Nothing is shown from a server whose description cannot be trusted.</div>}
      {notices.map((n) => (
        <div key={n.id} className={n.bad ? 'dc-banner bad' : 'dc-banner'} data-testid="dc-notice" aria-live="polite">
          {n.text} <button className="close small" aria-label="Dismiss" onClick={() => session.dismiss(n.id)}>×</button>
        </div>
      ))}
      {!discovery ? <div className="dc-waiting" data-testid="dc-handshake">Discovering what the server offers…</div> : discovery.rejected ? null : (
        <>
          <DatasetPicker session={session} />
          <ReplayBar session={session} />
          {discovery.problems.length > 0 && (
            <div className="dc-warning" data-testid="dc-fixed-missing">Missing from the server: {discovery.problems.map((p) => essentialLabel(p.essential)).join(', ')}.</div>
          )}
          {loading && !view ? <div className="dc-waiting short" data-testid="dc-loading">Opening {loading}: waiting for the models to set it up…</div> : view ? (
            <>
              {view.problems.length > 0 && (
                <div className="dc-warning" data-testid="dc-degraded">
                  <b>Degraded:</b> this dataset is missing {problemText(view.problems)}. Views that need {view.problems.length === 1 ? 'it' : 'them'} cannot show {view.problems.length === 1 ? 'it' : 'them'}; other datasets are not affected.
                </div>
              )}
              <Selectors session={session} />
              {opened && <OpenedView opened={opened} onClose={() => session.closeOpened()} />}
              <PanelGrid panels={[
                { id: 'line', x: 0, y: 0, w: 6, h: 9, minW: 3, minH: 5, node: <LineView session={session} /> },
                { id: 'errorbars', x: 6, y: 0, w: 6, h: 9, minW: 3, minH: 5, node: <ErrorBarView session={session} /> },
                { id: 'heatmap', x: 0, y: 9, w: 6, h: 8, minW: 3, minH: 5, node: <HeatmapView session={session} /> },
                { id: 'clusters', x: 6, y: 9, w: 6, h: 8, minW: 3, minH: 5, node: <ClusterView session={session} /> },
              ]} />
            </>
          ) : <div className="dc-waiting short" data-testid="dc-no-dataset">No dataset is open. Choose one above.</div>}
          <DoiPanel session={session} />
        </>
      )}
    </div>
  );
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const STATUS_WORDS: Record<string, string> = {
  'not-imported': 'not imported', importing: 'importing', imported: 'imported', changed: 'changed since import', superseded: 'superseded',
};

/** FR-103: every file in the data folder, from the importer's catalogue. */
function DatasetPicker({ session }: { session: DisplayClientSession }) {
  const cat = useStore(session.catalogue);
  const replay = useStore(session.replay);
  const importing = useStore(session.importing);
  const loading = useStore(session.loading);
  return (
    <section className="dc-picker" data-testid="dataset-picker">
      <div className="dc-row-head">
        <span className="dc-label">Datasets</span>
        <button className="dc-btn small" onClick={() => session.rescan()} data-testid="rescan">Rescan</button>
      </div>
      <table>
        <thead><tr><th>File</th><th>Size</th><th>Modified</th><th>Status</th><th>Span</th><th /></tr></thead>
        <tbody>
          {cat.map((e) => {
            const current = !!e.dataset && replay?.dataset === e.dataset;
            const busy = importing?.file === e.file || e.status === 'importing';
            return (
              <tr key={`${e.file}|${e.sha256}`} className={`${current ? 'current' : ''} ${e.status}`} data-testid="dataset-row" data-file={e.file} data-status={e.status} data-dataset={e.dataset}>
                <td className="mono">{e.file}{current && <span className="dc-tag" data-testid="current-tag">open</span>}</td>
                <td className="num">{mb(e.size)}</td>
                <td>{e.modified.slice(0, 16).replace('T', ' ')}</td>
                <td data-testid="dataset-status">
                  {e.status === 'superseded' || e.status === 'changed' ? <b className="dc-mark">{STATUS_WORDS[e.status]}</b> : STATUS_WORDS[e.status] ?? e.status}
                  {busy && (importing?.file === e.file ? ` ${Math.round(importing.pct)}%` : e.pct != null ? ` ${e.pct}%` : '')}
                  {busy && <progress max={100} value={importing?.file === e.file ? importing.pct : e.pct ?? 0} data-testid="import-progress" />}
                </td>
                <td>{e.start != null && e.end != null ? `${iso(e.start).slice(5, 16).replace('T', ' ')} to ${iso(e.end).slice(5, 16).replace('T', ' ')}` : '–'}</td>
                <td>
                  <button className="dc-btn small" disabled={busy || current || loading === e.dataset && !!e.dataset} onClick={() => session.open(e)} data-testid={`open-${e.file}`}>
                    {e.status === 'imported' || e.status === 'superseded' ? 'Open' : 'Import and open'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** FR-90: play/pause, rate, and a timeline of the current dataset. The bar shows what the state datastream says. */
function ReplayBar({ session }: { session: DisplayClientSession }) {
  const s = useStore(session.replay);
  const sent = useStore(session.sent);
  const [drag, setDrag] = useState<number | null>(null);
  if (!s || !s.dataset) return <div className="dc-replay" data-testid="replay-bar" data-playing="false">No dataset is loaded.</div>;
  const pos = drag ?? s.time;
  return (
    <div className="dc-replay" data-testid="replay-bar" data-playing={String(s.playing)} data-rate={String(s.rate)} data-dataset={s.dataset} data-time={iso(s.time)}>
      <button className={`dc-btn${s.playing ? '' : ' primary'}`} onClick={() => (s.playing ? session.pause() : session.play())} data-testid="dc-play">
        {s.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <span className="dc-rates" aria-label="Rate">
        {RATES.map((r) => (
          <button key={r} className={`dc-btn small${s.rate === r ? ' on' : ''}`} aria-pressed={s.rate === r} onClick={() => session.setRate(r)} data-testid={`dc-rate-${r}`}>{r}×</button>
        ))}
      </span>
      <input type="range" className="dc-timeline" min={s.start} max={s.end} step={1} value={pos} data-testid="dc-timeline" aria-label="Replay position"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag != null) session.seek(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag != null) session.seek(drag);
          setDrag(null);
        }} />
      <span className="dc-time mono" data-testid="dc-time">{iso(pos).replace('T', ' ').replace('Z', '')}</span>
      <span className="dc-sent" data-testid="dc-sent">{sent ? `${sent.split(' ')[0]} sent…` : s.at_end ? 'at the end' : ''}</span>
      <span className="dc-dataset" title={s.dataset}>{s.dataset.replace(/-[0-9a-f]{8}$/, '')}</span>
    </div>
  );
}

/** FR-53 to FR-55: the field chips of this dataset, the period presets and clustering. */
function Selectors({ session }: { session: DisplayClientSession }) {
  const view = useStore(session.view);
  const sel = useStore(session.selection);
  if (!view) return null;
  return (
    <>
      <div className="dc-row">
        <span className="dc-label">Fields</span>
        <div className="chips" data-testid="chips">
          {view.props.map((p) => (
            <button key={p.key} className={`chip${sel.fields.includes(p.key) ? ' on' : ''}${p.declared ? '' : ' optional'}`} aria-pressed={sel.fields.includes(p.key)}
              title={`${p.type}${p.uom ? `, ${p.uom}` : ''}${p.declared ? '' : ', not in the declared profile: drawn by its type'}`}
              onClick={() => session.toggleField(p.key)} data-testid="chip" data-key={p.key} data-type={p.type}>{p.label}</button>
          ))}
        </div>
      </div>
      <div className="dc-row">
        <span className="dc-label">Period</span>
        <div className="presets">
          {PERIODS.map((p) => (
            <button key={p.id} className={`preset${sel.period === p.id ? ' on' : ''}`} aria-pressed={sel.period === p.id} onClick={() => session.setPeriod(p.id)} data-testid={`preset-${p.id}`}>{p.label}</button>
          ))}
        </div>
        <span className="dc-label">Clustering</span>
        <div className="presets">
          {['A', 'B', 'C'].map((a) => (
            <button key={a} className="preset" onClick={() => void session.cluster(a)} data-testid={`cluster-${a}`}>{a}</button>
          ))}
        </div>
      </div>
    </>
  );
}

// --- data of interest (FR-104 to FR-108) ---------------------------------------------------------------------
function DoiPanel({ session }: { session: DisplayClientSession }) {
  const items = useStore(session.dois);
  const view = useStore(session.view);
  useStore(session.catalogue);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [res, setRes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const sel = useStore(session.selection);
  useEffect(() => setRes(session.currentRes()), [sel, view, session]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const err = await session.saveDoi(label, note, res);
    setError(err);
    if (!err) {
      setLabel('');
      setNote('');
    }
  };
  const pick = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id].slice(-2));
  const byId = (id: string) => items.find((x) => x.id === id);
  return (
    <section className="dc-doi" data-testid="doi-panel">
      <div className="dc-row-head"><span className="dc-label">Data of interest</span></div>
      {view && (
        <form className="dc-doi-save" onSubmit={save}>
          <input placeholder="Name" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="doi-label" />
          <input placeholder="Why it was kept (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="doi-note" />
          <input className="mono" value={res} onChange={(e) => setRes(e.target.value)} title={`Resolution, as an ISO 8601 duration: ${RESOLUTIONS.join(', ')}`} data-testid="doi-resolution" size={6} />
          <button className="dc-btn small" type="submit" data-testid="doi-save">Save as data of interest</button>
        </form>
      )}
      {error && <p className="dc-doi-error" data-testid="doi-error">{error}</p>}
      {!items.length ? <p className="dc-note-plain" data-testid="doi-empty">None saved yet.</p> : (
        <ul className="dc-doi-list">
          {items.map((it) => <DoiRow key={it.id} item={it} picked={picked.includes(it.id)} onPick={() => pick(it.id)} session={session} />)}
        </ul>
      )}
      {picked.length === 2 && byId(picked[0]) && byId(picked[1]) && (
        <button className="dc-btn small" onClick={() => void session.compare(byId(picked[0])!, byId(picked[1])!)} data-testid="doi-compare-button">Compare the two on elapsed time</button>
      )}
    </section>
  );
}

function DoiRow({ item, picked, onPick, session }: { item: DoiItem; picked: boolean; onPick: () => void; session: DisplayClientSession }) {
  const r = item.record;
  const greyed = item.greyed;
  return (
    <li className={greyed ? 'greyed' : ''} data-testid="doi-item" data-label={r.label} data-greyed={greyed ? 'true' : 'false'}>
      <input type="checkbox" checked={picked} disabled={!!greyed} onChange={onPick} aria-label={`Pick ${r.label} to compare`} data-testid="doi-pick" />
      <b>{r.label}</b> <span>{r.dataset.file} · {r.start.slice(5, 16).replace('T', ' ')} to {r.end.slice(5, 16).replace('T', ' ')} · {r.resolution}</span>
      {r.note && <i> · {r.note}</i>}
      {greyed && <span className="dc-greyed" data-testid="doi-greyed">{greyed}</span>}
      <span className="dc-doi-actions">
        <button className="dc-btn small" disabled={!!greyed} onClick={() => void session.openDoi(item)} data-testid="doi-open">Open</button>
        <button className="dc-btn small" onClick={() => void session.removeDoi(item)} data-testid="doi-remove">Remove</button>
      </span>
    </li>
  );
}

export type { CatalogueEntry };
