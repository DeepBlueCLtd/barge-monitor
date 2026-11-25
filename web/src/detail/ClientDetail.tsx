// Display client panel (FR-70, mockup 1): a monitor frame holding the display
// client, short notes beside it, and the message strip beneath. Everything
// inside the frame is the delivered system; everything outside it is the
// demonstrator. The frame is a dark bezel with a stand, drawn plainly (VS-19).
import { DisplayClient } from '../client/DisplayClient';
import { DEMO_LOGINS } from '../shell/demoAccounts';
import { MessageStrip } from './MessageStrip';

export function ClientDetail() {
  return (
    <div className="client-detail">
      <div className="monitor-row">
        <div className="monitor" data-testid="monitor">
          <div className="bezel">
            <div className="screen">
              <DisplayClient demoAccounts={DEMO_LOGINS} />
            </div>
          </div>
          <div className="neck" />
          <div className="foot" />
        </div>
        <aside className="notes">
          <div><h4>Login</h4><p>Nothing is shown before login. Credentials are held in memory only; the screen locks after 5 minutes without input.</p></div>
          <div><h4>Handshake</h4><p>Standard discovery after login, checked against the declared profile. Repeated after every import and after the server was unreachable.</p></div>
          <div><h4>Datasets</h4><p>From the importer's catalogue. Open sends load to the replay controller, or import first.</p></div>
          <div><h4>Replay</h4><p>Each action is one command, never waited on. The bar shows the replay controller's state.</p></div>
          <div><h4>Fields</h4><p>Built from discovery, per dataset. A field never seen before is drawn by its schema type.</p></div>
          <div><h4>Data of interest</h4><p>Kept on the server, in the analyst's own workspace. Nothing is kept in the browser.</p></div>
        </aside>
      </div>
      <MessageStrip selectionDefault />
    </div>
  );
}
