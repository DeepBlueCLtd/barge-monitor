// The opening panel (SRD §9.8, FR-123..FR-126): the data server as the eight subsystems
// we would write ourselves, a switch to adopt OpenSensorHub instead, and what we write
// either way. Crisp, not sketched (VS-18). Nothing in it is gold and nothing is marked
// as ours (FR-121); no number is shown (FR-124, §16).
import { opening, SUBSYSTEMS, WRITTEN_EITHER_WAY } from '../shell/opening';
import { useStore } from '../shell/store';

export function OpeningPanel() {
  const phase = useStore(opening.phase);
  const adopted = useStore(opening.adopted);
  const highlighted = useStore(opening.highlighted);
  return (
    <div className="opening-panel" data-testid="opening-panel" data-adopted={adopted ? 'true' : 'false'}>
      <header className="detail-head">
        <h2 data-testid="detail-title">Data server</h2>
        {/* FR-125: once handed over, the savings stay until a component is clicked or this is closed. */}
        {phase === 'adopted' && (
          <button className="close" aria-label="Close the detail panel" data-testid="detail-close" onClick={() => opening.dismissPanel()}>×</button>
        )}
      </header>
      {/* FR-123, FR-126: the switch, until hand-over; there is no way back. */}
      {phase !== 'adopted' && (
        <div className="opening-switch" role="radiogroup" aria-label="The data server" data-testid="opening-switch">
          <button role="radio" aria-checked={!adopted} className={`switch-option${adopted ? '' : ' on'}`} disabled={adopted}
            data-testid="switch-build">Build it ourselves</button>
          <button role="radio" aria-checked={adopted} className={`switch-option${adopted ? ' on' : ''}`} disabled={adopted}
            data-testid="switch-adopt" onClick={() => opening.adopt()}>Adopt OpenSensorHub</button>
        </div>
      )}
      <p className="opening-lead" data-testid="opening-lead">
        {adopted ? 'OpenSensorHub covers all of these.' : 'Written ourselves, the data server is eight subsystems, each with its own data to keep.'}
      </p>
      <table className="opening-table" data-testid="opening-table">
        <thead>
          <tr><th>Subsystem</th><th>What it does</th><th>Keeps data in</th>{adopted && <th className="tick-col">Covered</th>}</tr>
        </thead>
        <tbody>
          {SUBSYSTEMS.map((s) => (
            <tr key={s.id} data-testid={`row-${s.id}`} className={highlighted === s.id ? 'highlighted' : undefined} aria-current={highlighted === s.id || undefined}>
              <td><b>{s.name}</b></td>
              <td>{s.does}</td>
              <td>{s.keeps}</td>
              {adopted && <td className="tick" data-testid="tick" aria-label="covered by OpenSensorHub">✓</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <section>
        <h3 className="small-caps">Written by us either way</h3>
        <ul className="plain either-way" data-testid="written-either-way">
          {WRITTEN_EITHER_WAY.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </section>
    </div>
  );
}
