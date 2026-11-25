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
  ['Credentials, restarts, errors', 'HTTP itself (RFC 9110)', 'Basic authentication, 401, a refused connection while starting'],
  ['The data server', 'OpenSensorHub, off the shelf', 'a stand-in takes its place in the browser'],
  ['Authentication', "OpenSensorHub's own accounts and roles", 'login, screen lock; the gateway decides who may see CO₂'],
  ['Numerical work', 'numpy and scikit-learn', 'cleaning, means, clustering'],
  ['The screen', 'React, ECharts, React Flow, CodeMirror', 'display, charts, flowchart, editor'],
];

const WRITTEN: [string, string][] = [
  ['CSV importer', 'the only code that knows the CSV files; a module of the data server'],
  ['Replay controller', 'the current dataset and the replay clock, driven by commands'],
  ['Access gateway', 'in front of the data server: hides what a user may not see'],
  ['Display client', 'login, handshake, self-configuration, generic views'],
  ['Models', 'a small library for models, and the models'],
];

/** In a developed system, deliberately not in this demonstrator. Names only. */
const NOT_HERE: [string, string][] = [
  ['Hiding restricted systems in OpenSensorHub itself', 'OpenSensorHub cannot hide a system from a user; the gateway does it (S-AUTH finding)'],
  ['OpenSensorHub itself', 'a stand-in serves the same interface here; to be confirmed against the real server'],
  ["The client's real CSV files", 'shown over awkward synthetic ones; to be confirmed against the real ones'],
  ['Persistence', 'everything imported or published lives in memory here, and goes at reload'],
  ['Deployment and operations', 'hosting, monitoring, backup, upgrades'],
  ['Real data volumes', 'performance beyond the four files in the data folder here'],
  ['Replacing and deleting resources', 'models create resources; nothing is updated or removed'],
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
