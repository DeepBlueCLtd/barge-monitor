// Data server panel (FR-72, mockup 3): OpenSensorHub, with a stand-in here; the Connected
// Systems resources that describe this system, per dataset; the importer and workspace
// systems; authentication and permissions; why the standard fits; its gaps; what is not used.
// Reused from the withdrawn 4.6 build (8157eef) and read against 4.7: no replay controller and
// no access gateway; restricted resources are listed and refused with 403 (FR-93, D-221).
import { Fragment } from 'react';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';
import { Counters } from './ComponentDetail';

type Box = { id: string; x: number; y: number; w: number; title: string; sub: string };
const H = 52;

// Coordinates in an 980 x 330 drawing; two columns, Sensing and Models.
const BOXES: Box[] = [
  { id: 'platform', x: 110, y: 22, w: 170, title: 'Collection platform', sub: 'System · Platform' },
  { id: 'bow', x: 20, y: 100, w: 170, title: 'Bow sensor', sub: 'System · Sensor, its CO₂ analyser' },
  { id: 'stern', x: 210, y: 100, w: 170, title: 'Stern sensor', sub: 'System · Sensor, its CO₂ analyser' },
  { id: 'ds-bow', x: 20, y: 178, w: 170, title: 'weather · <dataset>', sub: 'one per dataset' },
  { id: 'ds-stern', x: 210, y: 178, w: 170, title: 'weather · <dataset>', sub: 'one per dataset' },
  { id: 'obs-s', x: 20, y: 256, w: 360, title: 'Observations', sub: 'one per sensor per second · SWE Common JSON' },
  { id: 'models', x: 530, y: 22, w: 340, title: 'Models', sub: 'System · asset type Process' },
  { id: 'cores', x: 530, y: 100, w: 340, title: 'Data cleanse · Summaries · Analysis', sub: 'a process system each' },
  { id: 'outs', x: 530, y: 178, w: 340, title: 'Output datastreams, per dataset', sub: 'cleaned, summaries, runs · <dataset>' },
  { id: 'obs-m', x: 530, y: 256, w: 340, title: 'Observations', sub: 'each run under its run_id' },
];
const box = (id: string) => BOXES.find((b) => b.id === id)!;
const cx = (b: Box) => b.x + b.w / 2;

/** Orthogonal connectors: parent bottom-centre to child top-centre. */
const LINKS: [string, string][] = [
  ['platform', 'bow'], ['platform', 'stern'], ['bow', 'ds-bow'], ['stern', 'ds-stern'], ['ds-bow', 'obs-s'], ['ds-stern', 'obs-s'],
  ['models', 'cores'], ['cores', 'outs'], ['outs', 'obs-m'],
];

function linkPath(a: Box, b: Box): string {
  const x1 = cx(a), y1 = a.y + H, x2 = b.id === 'obs-s' ? cx(a) : cx(b), y2 = b.y;
  const mid = (y1 + y2) / 2;
  return x1 === x2 ? `M${x1},${y1} V${y2 - 1}` : `M${x1},${y1} V${mid} H${x2} V${y2 - 1}`;
}

const ROLE_WORDS: Record<string, string> = { owner: 'Owner', 'viewer-emissions': 'Viewer with emissions', viewer: 'Viewer (weather only)' };

export function ServerDetail() {
  const st = useStore(runtime.control);
  const datasets = st?.datasets ?? [];
  const models = st?.models ?? [];
  const users = (st?.accounts ?? []).filter((a) => a.kind === 'user');
  const services = (st?.accounts ?? []).filter((a) => a.kind !== 'user');
  return (
    <div className="server-detail" data-testid="detail-server">
      <p className="lede" data-testid="server-osh">The data server is <b>OpenSensorHub</b>, adopted off the shelf. It cannot run in a browser, so a <b>stand-in</b> serves the same interface here, in {runtime.kind === 'python' ? 'the Python back end' : 'the JavaScript stand-in'}; whether a stock OpenSensorHub does everything shown is still to be confirmed (SRD §15).</p>
      <p className="lede">It describes this system in Connected Systems' own terms. Every box below is a standard resource. Each imported file is a dataset with datastreams of its own, so files never mix.</p>
      <div className="cs-diagram">
        <span className="cs-col-label" style={{ left: 20 }}>Sensing</span>
        <span className="cs-col-label" style={{ left: 530 }}>Models</span>
        <svg width="980" height="330" viewBox="0 0 980 330" aria-hidden="true" className="cs-links">
          <defs>
            <marker id="cs-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#374151" /></marker>
          </defs>
          {LINKS.map(([a, b]) => <path key={`${a}-${b}`} d={linkPath(box(a), box(b))} fill="none" stroke="#374151" strokeWidth={1.4} markerEnd="url(#cs-head)" />)}
        </svg>
        {BOXES.map((b) => (
          <Fragment key={b.id}>
            <div className="cs-box" style={{ left: b.x, top: b.y + 8, width: b.w, height: H }}>
              <b>{b.title}</b>
              <span>{b.sub}</span>
            </div>
          </Fragment>
        ))}
      </div>
      <h4 className="small-caps">Datasets in the store</h4>
      {datasets.length ? (
        <table className="letters-table" data-testid="server-datasets">
          <thead><tr><th>Dataset</th><th>File</th><th>Its datastreams</th></tr></thead>
          <tbody>{datasets.map((d) => (
            <tr key={d.id} data-dataset={d.id}><td className="mono">{d.id}{d.superseded ? ' (superseded)' : ''}</td><td className="mono">{d.file}</td>
              <td>weather and CO₂ per sensor; {models.map((m) => `${m.label} ${Array.isArray(m.datastreams) ? m.datastreams.filter((x) => x.endsWith(`__${d.id}`)).length : 0}`).join(', ')}</td></tr>
          ))}</tbody>
        </table>
      ) : <p className="hint" data-testid="server-empty">Nothing imported: the store is empty.</p>}
      <h4 className="small-caps">Also used</h4>
      <div className="also" data-testid="server-also">
        <div className="cs-box"><b>CSV importer</b><span>a System: catalogue, import control stream</span></div>
        <div className="cs-box"><b>Workspaces</b><span>a System per analyst: Favourites</span></div>
        <div className="cs-box"><b>Control streams and commands</b><span>pushed to the importer and each model</span></div>
      </div>
      <div className="why">
        <h4 className="small-caps">Authentication and permissions</h4>
        <p className="gaps" data-testid="server-auth">Every request and every push subscription needs credentials; without them, <b>401</b>. Accounts, roles and service accounts are OpenSensorHub's own, and permissions are granted per system and inherited by its datastreams. A user without permission for a system (the CO₂ analysers and every model's restricted subsystem, for a weather-only user) finds it <b>listed</b> and described, its streams' titles and schemas included, and gets <b>403</b> reading their contents: observations, commands and their status (FR-93, D-351). No account may read another's workspace. Receivers subscribe on the internal endpoint, for service accounts only (D-223).</p>
        <table className="letters-table" data-testid="server-accounts">
          <thead><tr><th>Account</th><th>Role</th></tr></thead>
          <tbody>
            {users.map((a) => <tr key={a.user}><td className="mono">{a.user}</td><td>{ROLE_WORDS[a.role] ?? a.label ?? a.role}</td></tr>)}
            <tr><td className="mono">{services.map((a) => a.user).join(', ') || 'svc-…'}</td><td>service accounts: each creates and appends only under its own systems</td></tr>
          </tbody>
        </table>
        <h4 className="small-caps">Why it fits</h4>
        <ul>
          <li>A platform carrying sensors is exactly its <b>Platform</b> and <b>Sensor</b> systems; the CO₂ analysers are subsystems, so they are restricted whole.</li>
          <li>No position needed: a system's <b>location is optional</b>.</li>
          <li>Models are first-class <b>process systems</b>, registered by <b>ordinary resource creation</b>, over the same interface the display client reads.</li>
          <li>Import and model settings are <b>commands</b>, pushed to the receiver, with their bounds in the control stream's schema.</li>
          <li>A restart needs nothing special: while it starts the server <b>answers nothing</b>, and a client that lost it repeats its handshake.</li>
        </ul>
        <p className="gaps" data-testid="server-gaps"><b>Gaps:</b> no standard aggregation, so summaries are datastreams of their own; no way to hide a system from discovery (restricted ones are listed, then refused); replacing and deleting must be refused by configuration (here the stand-in answers 405); a correlation matrix travels as text; push travels as a stream through the relay here, as OpenSensorHub's WebSocket would; whether a module can write in bulk is the next spike.</p>
        <p className="gaps" data-testid="server-unused"><b>Not used:</b> deployments, procedures, sampling features, system events and history, command feasibility, and replacing or deleting resources.</p>
      </div>
      <h4 className="small-caps">Messages</h4>
      <Counters id="server" />
    </div>
  );
}
