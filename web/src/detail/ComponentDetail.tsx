// Every other component (FR-73): what it does, which zone it belongs to and why, which
// letters it sends and receives, and live counters of the messages drawn on each of its
// flows. The data folder (FR-109) and the CSV importer (FR-110) add their own sections, read
// from the back end's control state (docs/v4-interfaces.md §13.4): god's-eye, not the system.
// Reused from the withdrawn 4.6 build (8157eef) less its replay controller and gateway.
import { COMPONENTS, ComponentId, FLOWS, nameOf } from '../shell/components';
import { Glyph } from '../shell/Glyph';
import { bus } from '../shell/messages';
import { FolderFile, runtime } from '../shell/runtime';
import { useStore } from '../shell/store';

export function ComponentDetail({ id }: { id: ComponentId }) {
  const c = COMPONENTS[id];
  return (
    <div className="component-detail" data-testid={`detail-${id}`}>
      <h3>What it does</h3>
      <p>{c.does}</p>
      <h3>Zone</h3>
      <p>{c.why}</p>
      {runtime.kind === 'standin' && (id === 'importer' || id === 'scilibs') && (
        <p className="standin-note" data-testid="standin-note">In this session it runs in the JavaScript stand-in, which serves the same interface; the stand-in is demonstrator scaffolding, not part of the system.</p>
      )}
      {id === 'folder' && <FolderFiles />}
      {id === 'importer' && <ImporterDetail />}
      <h3>Messages</h3>
      <Counters id={id} />
    </div>
  );
}

export const STATUS_WORDS: Record<string, string> = {
  'not-imported': 'not imported', importing: 'importing', imported: 'imported', changed: 'changed since import', superseded: 'superseded',
};

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** FR-109: the data folder's files, with sizes, dates and statuses; the system never writes to it. */
function FolderFiles() {
  const st = useStore(runtime.control);
  const files: FolderFile[] = st?.folder ?? [];
  return (
    <>
      <h3>Files</h3>
      {files.length ? (
        <table className="letters-table" data-testid="folder-table">
          <thead><tr><th>File</th><th>Size</th><th>Modified</th><th>Status</th></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={`${f.file}|${f.dataset}`} data-file={f.file} data-status={f.status}>
                <td className="mono">{f.file}</td>
                <td className="num">{mb(f.size)}</td>
                <td>{f.modified}</td>
                <td>{STATUS_WORDS[f.status] ?? f.status}{f.status === 'importing' ? ` ${Math.round(f.pct ?? 0)}%` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="hint">The file list appears once the CSV importer has listed the folder.</p>}
      <p className="hint" data-testid="folder-never-written">The system never writes, renames or deletes anything in this folder (FR-17a). Reset instance leaves it untouched.</p>
    </>
  );
}

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
  ['…_CO2 [ppm]', 'co2, in its own datastream', "ppm, under the sensor's CO₂ analyser (restricted)"],
  ['-9999, ////', 'missing', '"NaN", QC flag 9'],
];

/** FR-110: what the importer does; the catalogue; the column mapping; the last import's speed in rows per second. */
function ImporterDetail() {
  const st = useStore(runtime.control);
  const rate = st?.import_rate ?? null;
  const files: FolderFile[] = st?.folder ?? [];
  return (
    <>
      <h3>Catalogue</h3>
      <p>The importer's <code>catalogue</code> datastream: one observation per file at each change of status; the latest per file is its status. Its <code>import</code> control stream takes <code>action</code> (import or rescan) and <code>file</code>, pushed to it by the server.</p>
      <table className="letters-table" data-testid="importer-catalogue">
        <thead><tr><th>File</th><th>Status</th><th>Dataset</th></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={`${f.file}|${f.dataset}`} data-file={f.file} data-status={f.status}>
              <td className="mono">{f.file}</td>
              <td>{STATUS_WORDS[f.status] ?? f.status}{f.status === 'importing' ? ` ${Math.round(f.pct ?? 0)}%` : ''}</td>
              <td className="mono">{f.dataset || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="live" data-testid="import-rate">{rate
        ? `Last import: ${rate.file}, ${rate.rows.toLocaleString('en-GB')} rows in ${rate.seconds.toFixed(2)} s, `
          + `${Math.round(rate.rows_per_s).toLocaleString('en-GB')} rows/s${rate.silent ? ' (silently, at startup)' : ''}. Written in bulk, inside the server.`
        : 'No import measured yet.'}</p>
      <p className="hint" data-testid="silent-import">Mission A was imported silently at load, before the server took requests, and was not drawn (FR-15): nothing persists between visits. After Reset instance it is not imported again until the page is reloaded.</p>
      <h3>Column mapping</h3>
      <table className="letters-table" data-testid="column-mapping">
        <thead><tr><th>Column</th><th>Field</th><th>Conversion</th></tr></thead>
        <tbody>{MAPPING.map(([c, f, u]) => <tr key={c}><td className="mono">{c}</td><td>{f}</td><td>{u}</td></tr>)}</tbody>
      </table>
      <p className="hint">QC flags (QARTOD range and spike tests) are computed on import; nothing in a file is altered. A bulk import is drawn as one I message per thousand rows (FR-67).</p>
    </>
  );
}

/** Which letters a component sends and receives on each of its flows, how each is carried, and live counts of those drawn. */
export function Counters({ id }: { id: ComponentId }) {
  const counts = useStore(bus.counts);
  const flows = FLOWS.filter((f) => f.src === id || f.dst === id);
  return (
    <table className="letters-table" data-testid="counters">
      <thead><tr><th>Direction</th><th>With</th><th>Carried</th><th>Letters</th><th>Drawn so far</th></tr></thead>
      <tbody>
        {flows.map((f) => {
          const out = f.src === id;
          const other = out ? f.dst : f.src;
          return (
            <tr key={`${f.src}>${f.dst}`} data-flow={`${f.src}>${f.dst}`}>
              <td>{out ? 'sends to' : 'receives from'}</td>
              <td>{nameOf(other)}</td>
              <td>{f.via}</td>
              <td className="letters">{f.letters.map((l) => <Glyph key={l} letter={l} size={22} />)}</td>
              <td className="num">{f.letters.map((l) => `${l} ${(counts[`${f.src}>${f.dst}:${l}`] ?? 0).toLocaleString()}`).join(' · ')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
