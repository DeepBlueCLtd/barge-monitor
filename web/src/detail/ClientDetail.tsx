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
          <div><h4>Datasets</h4><p>The Dataset selector lists the importer's catalogue. Open makes a dataset current; a file not imported is imported first.</p></div>
          <div><h4>Replay</h4><p>The client's own clock: play, pause, rate and seek send no command. It reads only up to its replay time.</p></div>
          <div><h4>Fields</h4><p>Built from discovery, per dataset. A field never seen before is drawn by its schema type; one the server refuses is left out.</p></div>
          <div><h4>Favourites</h4><p>Data of interest, kept on the server in the analyst's own workspace. Nothing is kept in the browser.</p></div>
        </aside>
      </div>
      <MessageStrip selectionDefault />
    </div>
  );
}
