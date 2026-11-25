// Every other component (FR-73): what it does, which zone it belongs to and
// why, which letters it sends and receives, and live counters of the messages
// drawn on each of its flows.
import { COMPONENTS, ComponentId, FLOWS, nameOf } from '../shell/components';
import { Glyph } from '../shell/Glyph';
import { bus } from '../shell/messages';
import { runtime } from '../shell/runtime';
import { useStore } from '../shell/store';

export function ComponentDetail({ id }: { id: ComponentId }) {
  const c = COMPONENTS[id];
  const control = useStore(runtime.control) as (Record<string, unknown> & { folder?: FolderFile[]; import_rate?: number | null }) | null;
  // The 4.6 control state (docs/v4-interfaces.md §13.4); read defensively while the back ends move to it.
  const folder = Array.isArray(control?.folder) ? control!.folder : null;
  return (
    <div className="component-detail" data-testid={`detail-${id}`}>
      <h3>What it does</h3>
      <p>{c.does}</p>
      <h3>Zone</h3>
      <p>{c.why}</p>
      {runtime.kind === 'standin' && id !== 'client' && (
        <p className="standin-note">In this session it runs in the JavaScript stand-in, which serves the same interface; the stand-in is demonstrator scaffolding, not part of the system.</p>
      )}
      {id === 'folder' && <FolderFiles files={folder} />}
      {id === 'importer' && typeof control?.import_rate === 'number' && (
        <p className="live" data-testid="import-rate">Last import: {Math.round(control.import_rate).toLocaleString()} rows a second.</p>
      )}
      <h3>Messages</h3>
      <Counters id={id} />
    </div>
  );
}

interface FolderFile { file: string; size?: number; modified?: string; status?: string; pct?: number | null }

/** FR-109: the data folder's files, with sizes, dates and statuses; the system never writes to it. */
function FolderFiles({ files }: { files: FolderFile[] | null }) {
  return (
    <>
      <h3>Files</h3>
      {files?.length ? (
        <table className="letters-table" data-testid="folder-files">
          <thead><tr><th>File</th><th>Size</th><th>Modified</th><th>Status</th></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.file}>
                <td className="mono">{f.file}</td>
                <td className="num">{f.size != null ? `${(f.size / 1e6).toFixed(1)} MB` : '–'}</td>
                <td>{f.modified ?? '–'}</td>
                <td>{f.status ?? '–'}{f.status === 'importing' && f.pct != null ? ` ${Math.round(f.pct)}%` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="hint">The file list appears once the back end has listed the folder.</p>}
      <p className="hint">The system never writes, renames or deletes anything in this folder.</p>
    </>
  );
}

/** Which letters a component sends and receives on each of its flows, with live counts of those drawn. */
export function Counters({ id }: { id: ComponentId }) {
  const counts = useStore(bus.counts);
  const flows = FLOWS.filter((f) => f.src === id || f.dst === id);
  return (
    <table className="letters-table" data-testid="counters">
      <thead><tr><th>Direction</th><th>With</th><th>Letters</th><th>Drawn so far</th></tr></thead>
      <tbody>
        {flows.map((f) => {
          const out = f.src === id;
          const other = out ? f.dst : f.src;
          return (
            <tr key={`${f.src}>${f.dst}`}>
              <td>{out ? 'sends to' : 'receives from'}</td>
              <td>{nameOf(other)}</td>
              <td className="letters">{f.letters.map((l) => <Glyph key={l} letter={l} size={22} />)}</td>
              <td className="num">{f.letters.map((l) => `${l} ${(counts[`${f.src}>${f.dst}:${l}`] ?? 0).toLocaleString()}`).join(' · ')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
