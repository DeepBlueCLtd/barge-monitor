// The opening panel (SRD 4.7 §9.8, FR-123 to FR-126; D-359): every component, as we would develop
// it ourselves, with what it does; an "Open Standards" button, which shows a short history of OGC API – Connected
// Systems and a tree of its entities, then "Custom Components" (back to the table) or "OpenSensorHub" (Adopt; D-363).
// Before Adopt nothing
// says which could be adopted; after it, a column says what became of each. Crisp, not sketched (VS-18). Nothing in
// it is gold and nothing is marked as ours (FR-121); no count or number is shown (FR-120,
// FR-124, §16).
import { LEAD_ADOPTED, LEAD_BUILD, opening, ROWS, SUBSYSTEM_IDS } from '../shell/opening';
import { useStore } from '../shell/store';
import { StandardsView } from './StandardsView';

export function OpeningPanel() {
  const phase = useStore(opening.phase);
  const adopted = useStore(opening.adopted);
  const highlighted = useStore(opening.highlighted);
  // D-360: each subsystem's row is ticked as its card lands in the Data server card, in the table's order; the other
  // rows say what became of them once every subsystem has landed.
  const landed = useStore(opening.landed);
  const all = landed >= SUBSYSTEM_IDS.length;
  const view = useStore(opening.view);
  if (phase === 'build' && view === 'standards') {
    return (
      <div className="opening-panel" data-testid="opening-panel" data-adopted="false" data-view="standards">
        <header className="detail-head">
          <h2 data-testid="detail-title">Open Standards</h2>
        </header>
        <StandardsView />
      </div>
    );
  }
  return (
    <div className="opening-panel" data-testid="opening-panel" data-adopted={adopted ? 'true' : 'false'} data-view="components">
      <header className="detail-head">
        <h2 data-testid="detail-title">The components</h2>
        {/* FR-125: once handed over, the savings stay until a component is clicked or this is closed. */}
        {phase === 'adopted' && (
          <button className="close" aria-label="Close the detail panel" data-testid="detail-close" onClick={() => opening.dismissPanel()}>×</button>
        )}
      </header>
      {/* FR-123, FR-126 (D-363): "Open Standards" leads to the choice; gone once Adopt is chosen, there is no way back. */}
      {phase === 'build' && (
        <button className="btn opening-standards" data-testid="open-standards" onClick={() => opening.showStandards()}>Open Standards</button>
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
                ? (SUBSYSTEM_IDS.indexOf(r.id as never) < landed
                  ? <td className="tick" data-testid="tick" aria-label="covered by OpenSensorHub">✓</td>
                  : <td className="tick-waiting" />)
                : all ? <td className="after" data-testid="after">{r.after}</td> : <td className="after-waiting" />)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
