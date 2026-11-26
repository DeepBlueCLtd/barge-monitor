// Detail panels for the back end's components written for this system (§9.4):
// the CSV importer (FR-110), the replay controller (FR-91) and the access gateway
// (docs/v4-interfaces.md §9.5). Each reads the back end's control state (§13.4) and
// the captured messages; nothing here is part of the system.
import { RATES } from '../config';
import { isoSecond } from '../shell/drawclock';
import { bus } from '../shell/messages';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';
import { pretty } from './MessageStrip';

/** docs/v4-interfaces.md §5: how the importer maps the CSV columns. The only place the format is known (FR-20). */
const MAPPING: [string, string, string][] = [
  ['T_HS94', 'time', 'half-seconds since 1994-01-01T00:00:00Z → ISO 8601 UTC'],
  ['BOW_AT [dC], STN_AT [dC]', 'air_temperature', 'tenths of a degree → Cel'],
  ['…_RH [%]', 'relative_humidity', '%'],
  ['…_PR [hPa]', 'pressure', 'decimal comma → hPa'],
  ['…_AWS [kn]', 'apparent_wind_speed', 'knots → m/s'],
  ['…_AWD [deg]', 'apparent_wind_direction', 'deg; VRB → not evaluated'],
  ['…_SR [W/m2]', 'solar_irradiance', 'W/m2'],
  ['…_WT [dC]', 'water_temperature', 'tenths of a degree → Cel'],
  ['…_CO2 [ppm]', 'co2, in its own datastream', 'ppm, under the sensor\'s CO₂ analyser (restricted)'],
  ['-9999, ////', 'missing', '"NaN", QC flag 9'],
];

export function ImporterDetail() {
  const st = useStore(runtime.controlState);
  const ir = st?.import_rate as unknown;
  const rate = typeof ir === 'number' ? ir : ir && typeof ir === 'object' ? (ir as { rows_per_s?: number }).rows_per_s ?? null : null;
  const last = ir && typeof ir === 'object' ? ir as { rows?: number; seconds?: number; file?: string; silent?: boolean } : null;
  return (
    <div className="component-detail" data-testid="detail-importer-panel">
      <h3>Catalogue</h3>
      <p>The importer's <code>catalogue</code> datastream: one observation per file per change of status; the latest per file is its status. Its <code>import</code> control stream takes <code>action</code> (import or rescan) and <code>file</code>.</p>
      <table className="letters-table" data-testid="importer-catalogue">
        <thead><tr><th>File</th><th>Status</th><th>Dataset</th></tr></thead>
        <tbody>
          {(st?.folder ?? []).map((f) => (
            <tr key={`${f.file}${f.dataset}`}><td className="mono">{f.file}</td><td>{f.status}{f.status === 'importing' && f.pct != null ? ` ${f.pct}%` : ''}</td><td className="mono">{f.dataset || '–'}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="live" data-testid="import-rate">{rate != null
        ? `Last import${last?.file ? ` (${last.file}${last.silent ? ', silent' : ''})` : ''}: ${Math.round(rate).toLocaleString()} rows a second${last?.rows ? `, ${last.rows.toLocaleString()} rows in ${(last.seconds ?? 0).toFixed(1)} s` : ''}, written in bulk inside the server.` : 'No import measured yet.'}</p>
      <p className="hint" data-testid="silent-import">Mission A was imported silently at load, before the server took requests, and was not drawn (FR-15): nothing persists between visits. After Reset instance it is not imported again until the page is reloaded.</p>
      <h3>Column mapping</h3>
      <table className="letters-table" data-testid="column-mapping">
        <thead><tr><th>Column</th><th>Field</th><th>Conversion</th></tr></thead>
        <tbody>{MAPPING.map(([c, f, u]) => <tr key={c}><td className="mono">{c}</td><td>{f}</td><td>{u}</td></tr>)}</tbody>
      </table>
      <p className="hint">QC flags (QARTOD range and spike tests) are computed on import; nothing in a file is altered. A bulk import is drawn as one I message per thousand rows (FR-67).</p>
    </div>
  );
}

export function ReplayDetail() {
  const r = useStore(runtime.replay);
  useStore(bus.version);
  const pushes = bus.find((m) => m.src === 'server' && m.dst === 'replay' && m.letter === 'K').slice(-8).reverse();
  return (
    <div className="component-detail" data-testid="detail-replay-panel">
      <h3>Control stream <code>replay</code></h3>
      <p>Every command carries all four parameters: <code>action</code> (load, play, pause, seek), <code>dataset</code>, <code>rate</code> (one of {RATES.join(', ')}, at most the slowest model's bound) and <code>position</code>. The controller validates each and reports REJECTED naming the bound.</p>
      <h3>State</h3>
      {r ? (
        <table className="letters-table" data-testid="replay-state-table">
          <tbody>
            <tr><td>Dataset</td><td className="mono">{r.dataset}</td></tr>
            <tr><td>Span</td><td>{isoSecond(r.start)} to {isoSecond(r.end)}</td></tr>
            <tr><td>Replay time</td><td>{isoSecond(r.time)}</td></tr>
            <tr><td>Rate</td><td>{r.rate}× (at most {r.max_rate}×, set by {r.max_rate_model})</td></tr>
            <tr><td>Playing</td><td>{r.playing ? 'yes' : r.at_end ? 'no: at the end' : 'no'}</td></tr>
            <tr><td>Run</td><td className="mono">{r.run}</td></tr>
            <tr><td>Models ready</td><td>{r.models_ready ? 'yes' : 'not yet'}</td></tr>
          </tbody>
        </table>
      ) : <p className="hint">No dataset is loaded.</p>}
      <h3>Log: the latest commands pushed to it</h3>
      {pushes.length ? (
        <ul className="plain" data-testid="replay-log">{pushes.map((m) => <li key={m.key}><code>{pretty(m.content).slice(0, 200)}</code></li>)}</ul>
      ) : <p className="hint">No command yet. Its <code>log</code> datastream records every command applied, with its sender: <code>time</code> is the real time it took effect, <code>position</code> the replay time.</p>}
    </div>
  );
}

export function GatewayDetail() {
  const st = useStore(runtime.controlState);
  return (
    <div className="component-detail" data-testid="detail-gateway-panel">
      <h3>What it hides</h3>
      <ul>
        <li>CO₂ analysers: <code>urn:x-barge:sensor:*:co2</code></li>
        <li>Models' restricted outputs: <code>urn:x-barge:process:*:restricted</code></li>
        <li>Other users' workspaces: <code>urn:x-barge:workspace:*</code></li>
      </ul>
      <p>Each is left out of every listing, with its datastreams and control streams, and answers 404 by identifier. A user with no permission cannot tell it exists.</p>
      <h3>Accounts and roles</h3>
      <table className="letters-table" data-testid="gateway-accounts">
        <thead><tr><th>Account</th><th>Role</th></tr></thead>
        <tbody>{(st?.accounts ?? []).map((a) => <tr key={a.user}><td className="mono">{a.user}</td><td>{a.role}</td></tr>)}</tbody>
      </table>
      <p className="hint">Roles are read on every request, so a change in the administration takes effect at once (D-151). Push subscriptions are for service accounts only.</p>
    </div>
  );
}
