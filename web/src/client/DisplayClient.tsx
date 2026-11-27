// The display client's screen (SRD §8.1), inside the monitor frame. Before login,
// the login screen only (FR-97). After login, from top to bottom: a status strip with
// the analyst's name, the Dataset selector button, the Favourites button and Lock; the
// replay bar; the field chips, period presets and clustering; the views. The dataset
// list and the Favourites are popups (FR-127), not always on screen.
// It is deliberately small and generic. It draws what discovery finds and nothing
// else: which sources a user sees is decided by the server.
//
// The demonstrator's demo credentials are passed in by the shell (FR-102): a developed
// system never pre-populates credentials, and this file knows no account.
import { FormEvent, ReactNode, RefObject, useEffect, useRef, useState } from 'react';
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

// --- login and lock (FR-97 to FR-102) ---------------------------------------------------------------------------
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
        <button className="dc-btn primary" type="submit" disabled={busy || !user} data-testid="login-submit"
          title={busy ? 'Logging in: wait for the answer' : !user ? 'Enter a name first' : undefined}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      {error && <p className="dc-login-error" aria-live="assertive" data-testid="login-error">{error}</p>}
      {demoAccounts.length > 0 && (
        <div className="dc-demo-creds" data-testid="demo-credentials">
          <p className="dc-demo-label">Demo credentials: for this demonstrator only</p>
          {demoAccounts.map((a) => (
            <div key={a.user} className="dc-demo-row">
              <code>{a.user}</code> <code>{a.password}</code> <span>{a.note}</span>
              <button className="dc-btn small" disabled={busy} title={busy ? 'Logging in: wait for the answer' : undefined} onClick={() => {
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

// --- popups (FR-127) ---------------------------------------------------------------------------------------------
/**
 * A popup panel anchored to its button: it closes on Escape (focus back on the button), on a click outside it, or
 * when its main action is taken; it is used from the keyboard (focus moves into it when it opens). A non-modal dialog.
 */
function Popup({ open, onClose, anchor, label, testid, children }: {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLButtonElement>; label: string; testid: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closer = useRef(onClose);
  closer.current = onClose;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closer.current();
      anchor.current?.focus();
    };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) closer.current();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', down);
    const first = ref.current?.querySelector<HTMLElement>('button:not([disabled]), input, select, [tabindex]');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', down);
    };
  }, [open, anchor]);
  if (!open) return null;
  return (
    <dialog open ref={ref} className="dc-popup" aria-label={label} data-testid={testid}>
      {children}
    </dialog>
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
  const opening = useStore(session.opening);
  const opened = useStore(session.opened);
  const replay = useStore(session.clock.state);
  const handshakeRequest = useStore(session.handshakeRequest);
  return (
    <div className={`dc${stale ? ' is-stale' : ''}`} data-testid="dc" data-phase={phase} data-view={view?.id ?? ''}>
      <div className="dc-status">
        <span data-testid="dc-user">Logged in as <b>{user}</b></span>
        {discovery && !discovery.rejected && <DatasetSelector session={session} />}
        {discovery && !discovery.rejected && <Favourites session={session} />}
        <span className="dc-phase" data-testid="dc-phase">{phase === 'handshake' ? 'Discovering what the server offers…' : phase === 'unreachable' ? 'Server not answering' : ''}</span>
        {/* D-357: the request in hand during the handshake, for a viewer to follow the interrogation. */}
        {phase === 'handshake' && handshakeRequest && <code className="dc-handshake-request" data-testid="dc-handshake-request">{handshakeRequest}</code>}
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
          {discovery.problems.length > 0 && (
            <div className="dc-warning" data-testid="dc-fixed-missing">Missing from the server: {discovery.problems.map((p) => essentialLabel(p.essential)).join(', ')}.</div>
          )}
          {replay && <ReplayBar session={session} />}
          {opening && !view ? <div className="dc-waiting short" data-testid="dc-loading">Opening the dataset…</div> : view && replay ? (
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
          ) : (
            <>
              {opened && <OpenedView opened={opened} onClose={() => session.closeOpened()} />}
              <div className="dc-waiting short" data-testid="dc-no-dataset">No dataset is open. Choose one with the Dataset selector above.</div>
            </>
          )}
        </>
      )}
    </div>
  );
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const STATUS_WORDS: Record<string, string> = {
  'not-imported': 'not imported', importing: 'importing', imported: 'imported', changed: 'changed since import', superseded: 'superseded',
};
const span = (a: number, b: number) => `${iso(a).slice(5, 16).replace('T', ' ')} to ${iso(b).slice(5, 16).replace('T', ' ')}`;

/** FR-103: the button shows the current dataset, or the import in progress; the popup lists every file in the data folder. */
function DatasetSelector({ session }: { session: DisplayClientSession }) {
  const cat = useStore(session.catalogue);
  const replay = useStore(session.clock.state);
  const importing = useStore(session.importing);
  const degraded = useStore(session.degraded);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = replay ? cat.find((e) => e.dataset === replay.dataset) : undefined;
  const close = () => setOpen(false);
  // Overlapping datasets (FR-103): spans that share time with another imported dataset's.
  const imported = cat.filter((e) => e.dataset && e.start != null && e.end != null && (e.status === 'imported' || e.status === 'superseded'));
  const overlaps = (e: CatalogueEntry) => imported.filter((o) => o !== e && o.dataset !== e.dataset && e.start != null && e.end != null && o.start! < e.end && e.start < o.end!).map((o) => o.file);
  return (
    <span className="dc-anchor">
      <button ref={anchor} className="dc-btn small dc-dataset-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        data-testid="dataset-button" data-importing={importing ? 'true' : 'false'}>
        {importing ? <>Importing {importing.file} · <span data-testid="dataset-button-pct">{Math.round(importing.pct)} %</span></>
          : current ? <>Dataset: {current.file}</> : 'Choose a dataset'} ▾
      </button>
      <Popup open={open} onClose={close} anchor={anchor} label="Dataset selector" testid="dataset-popup">
        <div className="dc-row-head">
          <span className="dc-label">Datasets in the data folder</span>
          <button className="dc-btn small" onClick={() => session.rescan()} data-testid="rescan">Rescan</button>
        </div>
        <table className="dc-files">
          <thead><tr><th>File</th><th>Size</th><th>Modified</th><th>Status</th><th>Span</th><th /></tr></thead>
          <tbody>
            {cat.map((e) => {
              const isCurrent = !!e.dataset && replay?.dataset === e.dataset;
              const busy = importing?.file === e.file || e.status === 'importing';
              const over = overlaps(e);
              const bad = e.dataset ? degraded.get(e.dataset) : undefined;
              const openable = !!e.dataset && (e.status === 'imported' || e.status === 'superseded');
              return (
                <tr key={`${e.file}|${e.sha256}`} className={`${isCurrent ? 'current' : ''} ${e.status}`} data-testid="dataset-row" data-file={e.file} data-status={e.status} data-dataset={e.dataset}>
                  <td className="mono">{e.file}{isCurrent && <span className="dc-tag" data-testid="current-tag">open</span>}</td>
                  <td className="num">{mb(e.size)}</td>
                  <td>{e.modified.slice(0, 16).replace('T', ' ')}</td>
                  <td data-testid="dataset-status">
                    {e.status === 'superseded' || e.status === 'changed' ? <b className="dc-mark">{STATUS_WORDS[e.status]}</b> : STATUS_WORDS[e.status] ?? e.status}
                    {busy && ` ${Math.round(importing?.file === e.file ? importing.pct : e.pct ?? 0)} %`}
                    {busy && <progress max={100} value={importing?.file === e.file ? importing.pct : e.pct ?? 0} data-testid="import-progress" />}
                    {bad && <span className="dc-mark" data-testid="degraded-mark"> · degraded: missing {bad}</span>}
                    {over.length > 0 && <span className="dc-mark" data-testid="overlap-mark"> · overlaps {over.join(', ')}</span>}
                  </td>
                  <td>{e.start != null && e.end != null ? span(e.start, e.end) : '–'}</td>
                  <td>
                    <button className="dc-btn small" disabled={busy || isCurrent || (!!importing && !openable)}
                      title={busy ? 'Being imported: wait until it is done' : isCurrent ? 'This dataset is open already'
                        : importing && !openable ? 'Another file is being imported: one import at a time' : undefined} onClick={() => {
                      session.open(e);
                      close();
                      anchor.current?.focus();
                    }} data-testid={`open-${e.file}`}>
                      {openable ? 'Open' : 'Import and open'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Popup>
    </span>
  );
}

/** FR-90: play/pause, rate and a timeline of the current dataset, on the client's own clock (§8.6). No command is sent. */
function ReplayBar({ session }: { session: DisplayClientSession }) {
  const s = useStore(session.clock.state);
  useStore(session.selection);
  const offWhy = session.replayOff();
  const off = offWhy ? { disabled: true, title: offWhy, 'aria-describedby': 'dc-replay-off' } : {};
  const [drag, setDrag] = useState<number | null>(null);
  if (!s) return null;
  const pos = drag ?? s.time;
  const commit = () => {
    if (drag != null) session.seek(drag);
    setDrag(null);
  };
  return (
    <div className="dc-replay" data-testid="replay-bar" data-playing={String(s.playing)} data-rate={String(s.rate)} data-dataset={s.dataset}
      data-time={iso(s.time)} data-at-end={String(s.atEnd)}>
      <button className={`dc-btn${s.playing ? '' : ' primary'}`} onClick={() => (s.playing ? session.pause() : session.play())} data-testid="dc-play" {...off}>
        {s.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <span className="dc-rates" aria-label="Rate">
        {RATES.map((r) => (
          <button key={r} className={`dc-btn small${s.rate === r ? ' on' : ''}`} aria-pressed={s.rate === r} onClick={() => session.setRate(r)} data-testid={`dc-rate-${r}`} {...off}>{r}×</button>
        ))}
      </span>
      <input type="range" className="dc-timeline" min={s.start} max={s.end} step={1} value={Math.floor(pos)} data-testid="dc-timeline" aria-label="Replay position" {...off}
        onChange={(e) => setDrag(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
      <span className="dc-time mono" data-testid="dc-time">{iso(pos).replace('T', ' ').replace('Z', '')}</span>
      {offWhy && <span id="dc-replay-off" className="dc-sent" data-testid="dc-replay-off">{offWhy}</span>}
      <span className="dc-sent" data-testid="dc-at-end">{s.atEnd ? 'At the end of the dataset: paused' : ''}</span>
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

// --- Favourites: data of interest (FR-104 to FR-108) ------------------------------------------------------------
function Favourites({ session }: { session: DisplayClientSession }) {
  const items = useStore(session.dois);
  const view = useStore(session.view);
  const replay = useStore(session.clock.state);
  const sel = useStore(session.selection);
  useStore(session.catalogue);
  useStore(session.data);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [res, setRes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const close = () => setOpen(false);
  const win = view && replay ? session.dataWindow() : null;
  const saved = win ? session.isSaved() : false;
  useEffect(() => setRes(session.currentRes()), [sel, view, session, open]);
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
    <span className="dc-anchor">
      <button ref={anchor} className={`dc-btn small dc-star${saved ? ' saved' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        title={saved ? 'Favourites: the current data window is saved' : 'Favourites: save the current data window, or open a saved one'} data-testid="favourites-button" data-saved={String(saved)}>
        <span aria-hidden="true">{saved ? '★' : '☆'}</span> Favourites
      </button>
      <Popup open={open} onClose={close} anchor={anchor} label="Favourites" testid="favourites-popup">
        <section className="dc-doi-current" data-testid="doi-current">
          <div className="dc-row-head"><span className="dc-label">The current data window</span></div>
          {!win ? <p className="dc-note-plain">No dataset is open.</p> : (
            <>
              <dl className="dc-window">
                <dt>Dataset</dt><dd data-testid="window-dataset">{win.file}</dd>
                <dt>Period</dt><dd data-testid="window-period">{iso(win.start).replace('T', ' ').replace('Z', '')} to {iso(win.end).replace('T', ' ').replace('Z', '')}</dd>
                <dt>Resolution</dt><dd data-testid="window-resolution">{win.resolution}</dd>
                <dt>Fields</dt><dd data-testid="window-fields">{win.fields.join(', ') || 'none selected'}</dd>
                {win.run && <><dt>Run</dt><dd data-testid="window-run">{win.run}</dd></>}
              </dl>
              <form className="dc-doi-save" onSubmit={save}>
                <input placeholder="Name" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="doi-label" aria-label="Name" />
                <input placeholder="Why it was kept (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="doi-note" aria-label="Note" />
                <input className="mono" value={res} onChange={(e) => setRes(e.target.value)} aria-label="Resolution"
                  title={`Resolution, as an ISO 8601 duration: ${RESOLUTIONS.join(', ')}`} data-testid="doi-resolution" size={6} />
                <button className="dc-btn small" type="submit" data-testid="doi-save">Save</button>
              </form>
            </>
          )}
          {error && <p className="dc-doi-error" data-testid="doi-error">{error}</p>}
        </section>
        <section className="dc-doi" data-testid="doi-panel">
          <div className="dc-row-head"><span className="dc-label">Saved</span></div>
          {!items.length ? <p className="dc-note-plain" data-testid="doi-empty">None saved yet.</p> : (
            <ul className="dc-doi-list">
              {items.map((it) => <DoiRow key={it.id} item={it} picked={picked.includes(it.id)} onPick={() => pick(it.id)} session={session} onOpened={close} />)}
            </ul>
          )}
          {picked.length === 2 && byId(picked[0]) && byId(picked[1]) && (
            <button className="dc-btn small" onClick={() => {
              void session.compare(byId(picked[0])!, byId(picked[1])!);
              close();
            }} data-testid="doi-compare-button">Compare the two on elapsed time</button>
          )}
        </section>
      </Popup>
    </span>
  );
}

function DoiRow({ item, picked, onPick, session, onOpened }: { item: DoiItem; picked: boolean; onPick: () => void; session: DisplayClientSession; onOpened: () => void }) {
  const r = item.record;
  const greyed = item.greyed;
  return (
    <li className={greyed ? 'greyed' : ''} data-testid="doi-item" data-label={r.label} data-greyed={greyed ? 'true' : 'false'}>
      <input type="checkbox" checked={picked} disabled={!!greyed} title={greyed ? `Cannot be compared: ${greyed}` : undefined} onChange={onPick} aria-label={`Pick ${r.label} to compare`} data-testid="doi-pick" />
      <b>{r.label}</b> <span>{r.dataset.file} · {r.start.slice(5, 16).replace('T', ' ')} to {r.end.slice(5, 16).replace('T', ' ')} · {r.resolution}</span>
      {r.note && <i> · {r.note}</i>}
      {greyed && <span className="dc-greyed" data-testid="doi-greyed">{greyed}</span>}
      <span className="dc-doi-actions">
        <button className="dc-btn small" disabled={!!greyed} title={greyed ? `Cannot be opened: ${greyed}` : undefined} onClick={() => {
          void session.openDoi(item);
          onOpened();
        }} data-testid="doi-open">Open</button>
        <button className="dc-btn small" onClick={() => void session.removeDoi(item)} data-testid="doi-remove">Remove</button>
      </span>
    </li>
  );
}
