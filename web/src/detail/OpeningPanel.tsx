// The opening panel (SRD 4.7 §9.8, FR-123 to FR-126; D-359): every component, as we would develop
// it ourselves, with what it does; a switch to adopt OpenSensorHub instead. Before Adopt nothing
// says which could be adopted; after it, a column says what became of each. Crisp, not sketched (VS-18). Nothing in
// it is gold and nothing is marked as ours (FR-121); no count or number is shown (FR-120,
// FR-124, §16).
import { LEAD_ADOPTED, LEAD_BUILD, opening, ROWS } from '../shell/opening';
import { useStore } from '../shell/store';

export function OpeningPanel() {
  const phase = useStore(opening.phase);
  const adopted = useStore(opening.adopted);
  const highlighted = useStore(opening.highlighted);
  return (
    <div className="opening-panel" data-testid="opening-panel" data-adopted={adopted ? 'true' : 'false'}>
      <header className="detail-head">
        <h2 data-testid="detail-title">The components</h2>
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
      <p className="opening-lead" data-testid="opening-lead">{adopted ? LEAD_ADOPTED : LEAD_BUILD}</p>
      <table className="opening-table" data-testid="opening-table">
        <thead>
          <tr><th>Component</th><th>What it does</th><th>Keeps data in</th>{adopted && <th className="tick-col">With OpenSensorHub</th>}</tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.id} data-testid={`row-${r.id}`} className={highlighted === r.id ? 'highlighted' : undefined} aria-current={highlighted === r.id || undefined}>
              <td><b>{r.name}</b></td>
              <td>{r.does}</td>
              <td>{r.keeps}</td>
              {adopted && (r.after === null
                ? <td className="tick" data-testid="tick" aria-label="covered by OpenSensorHub">✓</td>
                : <td className="after" data-testid="after">{r.after}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
