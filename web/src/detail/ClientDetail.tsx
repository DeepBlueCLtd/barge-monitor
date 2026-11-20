// Display client panel (FR-70, mockup 1): a monitor frame holding the display
// client, short notes beside it, and the message strip beneath. Everything
// inside the frame is the delivered system; everything outside it is the
// demonstrator. The frame is a dark bezel with a stand, drawn plainly (VS-19).
import { DisplayClient } from '../client/DisplayClient';
import { MessageStrip } from './MessageStrip';

export function ClientDetail() {
  return (
    <div className="client-detail">
      <div className="monitor-row">
        <div className="monitor" data-testid="monitor">
          <div className="bezel">
            <div className="screen">
              <DisplayClient />
            </div>
          </div>
          <div className="neck" />
          <div className="foot" />
        </div>
        <aside className="notes">
          <h4>Handshake</h4>
          <p>Discovers the datastreams registered with the data server and checks them against the declared profile.</p>
          <h4>Fields</h4>
          <p>Built from discovery. A new model's stream appears here after a client restart, drawn by its schema type.</p>
          <h4>Period</h4>
          <p>Up to an hour reads raw records. Longer periods read summary datastreams.</p>
          <h4>Clustering</h4>
          <p>Each choice sends a command to the models.</p>
        </aside>
      </div>
      <MessageStrip selectionDefault />
    </div>
  );
}
