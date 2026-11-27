// The detail panel before anything is clicked: what the demonstrator adopts
// rather than designs, what is written for this system, and what a developed
// system needs that is deliberately not here. Crisp, not sketched (VS-18).
// It marks nothing as value-add: the reveal does that (FR-74).

/** A decision this system did not have to make, and the default it adopted instead. */
const ADOPTED: [string, string, string][] = [
  ['The shape of the interface', 'OGC API – Connected Systems, Parts 1 and 2', 'systems, datastreams, observations, commands'],
  ['Discovery, paging, time filters', 'OGC API – Common and Features', 'landing page, conformance, paging'],
  ['Describing sensors and models', 'SensorML and SOSA terms', 'Platform, Sensor, process System'],
  ['Records, units and encodings', 'SWE Common 3.0, as JSON', 'every schema and observation'],
  ['Quality flags', 'QARTOD vocabulary', 'a flag beside each measurement'],
  ['Defining the interface', 'OpenAPI 3.1 and JSON Schema', 'committed masters, checked by tests'],
  ['Errors and credentials', 'HTTP itself (RFC 9110)', 'status codes, Basic authentication'],
  ['The data server', 'OpenSensorHub, off the shelf', 'a stand-in takes its place in the browser'],
  ['Numerical work', 'numpy and scikit-learn', 'cleaning, means, clustering'],
  ['The screen', 'React, ECharts, React Flow, CodeMirror', 'display, charts, flowchart, editor'],
];

const WRITTEN: [string, string][] = [
  ['Store adapter', "the only code that knows the logger's format"],
  ['Display client', 'handshake, self-configuration, generic views'],
  ['Models', 'a small library for models, and the models'],
];

/** In a developed system, deliberately not in this demonstrator. Names only. */
const NOT_HERE: [string, string][] = [
  ['OpenSensorHub itself', 'a stand-in serves the same interface here; to be confirmed against the real server'],
  ['The real logger store', 'shown over an awkward stand-in; to be confirmed against the real one'],
  ['Authentication and access control', 'the server checks demo accounts and roles; logins and their administration are not here'],
  ['Persistence', 'what models register and publish lives in memory here'],
  ['Deployment and operations', 'hosting, monitoring, backup, upgrades'],
  ['Real data volumes', 'performance beyond the history loaded here'],
  ['Push delivery', 'commands travel on a stream through the relay; publish/subscribe is not yet a published standard'],
  ['Replacing and deleting resources', 'models create resources; nothing is updated or removed, and the server refuses it'],
  ['Position', 'and every model that needs it'],
  ["The real display's screens", 'the client here is small and generic on purpose'],
  ["The real models' science", 'the three here stand in for it'],
  ['Security review and accreditation', ''],
  ['User documentation, training, support', ''],
];

export function Overview() {
  return (
    <div className="overview" data-testid="overview">
      <p className="invite">Click a component on the flowchart to see it here.</p>
      <p className="hint">Click a moving message to read it. Failure demos, in the top bar, break things on purpose.</p>
      <section>
        <h3 className="small-caps">Sensible defaults: adopted, not designed</h3>
        <table className="adopted" data-testid="adopted">
          <thead><tr><th>Decision we did not have to make</th><th>Adopted</th><th>Seen here as</th></tr></thead>
          <tbody>{ADOPTED.map(([need, what, where]) => <tr key={need}><td>{need}</td><td><b>{what}</b></td><td>{where}</td></tr>)}</tbody>
        </table>
      </section>
      <section>
          <h3 className="small-caps">Written for this system</h3>
          <ul className="plain written" data-testid="written">{WRITTEN.map(([n, t]) => <li key={n}><b>{n}</b><span>{t}</span></li>)}</ul>
      </section>
      <section>
          <h3 className="small-caps">Not in this demonstrator</h3>
          <ul className="plain not-here" data-testid="not-here">{NOT_HERE.map(([n, t]) => <li key={n}><b>{n}</b>{t && <span>{t}</span>}</li>)}</ul>
      </section>
    </div>
  );
}
