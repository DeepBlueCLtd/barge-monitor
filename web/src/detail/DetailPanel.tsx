// The detail panel (§9.4, FR-69..FR-73): the selected component, or an empty
// state inviting a click. Crisp, not sketched (VS-18).
import { COMPONENTS, ComponentId } from '../shell/components';
import { ZONES } from '../shell/palette';
import { revealed, selectComponent, selectedComponent, selectedMessage } from '../shell/selection';
import { useStore } from '../shell/store';
import { ClientDetail } from './ClientDetail';
import { ComponentDetail } from './ComponentDetail';
import { MessageStrip } from './MessageStrip';
import { ModelsDetail } from './ModelsDetail';
import { Overview } from './Overview';
import { ServerDetail } from './ServerDetail';

export function DetailPanel() {
  const id = useStore(selectedComponent);
  const msg = useStore(selectedMessage);
  return (
    <section className="detail" aria-label="Detail panel" data-testid="detail-panel" data-showing={id ?? 'none'}>
      {id ? <Panel id={id} /> : (
        <div className="detail-empty" data-testid="detail-empty">
          <Overview />
          {msg && <MessageStrip selectionDefault={false} />}
        </div>
      )}
    </section>
  );
}

const ZONE_EXTRA: Partial<Record<ComponentId, string>> = { server: 'OGC API – Connected Systems' };

function Panel({ id }: { id: ComponentId }) {
  const c = COMPONENTS[id];
  const gold = useStore(revealed).has(id);
  const z = ZONES[c.zone];
  return (
    <>
      <header className="detail-head">
        <h2 data-testid="detail-title">{gold ? '★ ' : ''}{c.name}</h2>
        <span className="zone-tag" style={{ color: z.text }}>{z.label.replace('New build · ', '')}{ZONE_EXTRA[id] ? ` · ${ZONE_EXTRA[id]}` : ''}</span>
        {gold && <span className="va-pill">our value-add</span>}
        <button className="close" aria-label="Close the detail panel" data-testid="detail-close" onClick={() => selectComponent(null)}>×</button>
      </header>
      <div className="detail-body">
        {id === 'client' ? <ClientDetail /> : id === 'models' ? <ModelsDetail /> : id === 'server' ? <ServerDetail /> : <ComponentDetail id={id} />}
      </div>
      {id !== 'client' && <MessageStrip selectionDefault={false} />}
    </>
  );
}
