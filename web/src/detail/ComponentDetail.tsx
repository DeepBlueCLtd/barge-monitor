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
  const counts = useStore(bus.counts);
  const control = useStore(runtime.control);
  const flows = FLOWS.filter((f) => f.src === id || f.dst === id);
  const store = control?.store;
  return (
    <div className="component-detail" data-testid={`detail-${id}`}>
      <h3>What it does</h3>
      <p>{c.does}</p>
      <h3>Zone</h3>
      <p>{c.why}</p>
      {runtime.kind === 'standin' && id !== 'client' && (
        <p className="standin-note">In this session it runs in the JavaScript stand-in, which serves the same interface; the stand-in is demonstrator scaffolding, not part of the system.</p>
      )}
      {id === 'store' && store && (
        <p className="live">Now holding {store.files.toLocaleString()} files, {(store.bytes / 1e6).toFixed(1)} MB, {store.records.toLocaleString()} records.</p>
      )}
      <h3>Messages</h3>
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
    </div>
  );
}
