// The guided tour (FR-66, FR-67). It highlights only: the viewer does the rest.
export const TOUR = [
  { title: 'The zones', nodes: ['clock', 'world', 'barge', 'sensors', 'logger', 'adapter', 'server', 'fastapi', 'scilibs'],
    text: 'Four zones: simulated (green), legacy (amber), new build (blue) and third-party (violet). The demonstrator shell sits outside them.' },
  { title: 'One reading end to end', nodes: ['sensors', 'logger', 'adapter', 'server', 'fastapi', 'relay', 'client'],
    text: 'Press play. A reading leaves the sensors as L (the logger\'s fixed-width record), is read by the store adapter, served by the Connected Systems server and reaches the display client as O (SWE Common JSON). Pause and click an icon to read it.' },
  { title: 'The handshake', nodes: ['client', 'relay', 'fastapi', 'server'],
    text: 'Pause, then press "Restart client". Follow the D messages (discovery and schemas) and the P (the declared profile) as the client configures itself. Use "Step" to move one hop at a time.' },
  { title: 'A scientist\'s product promoted', nodes: ['workspace', 'products', 'relay', 'server'],
    text: 'In the workspace, choose a "Promote" example and run it: it POSTs a system, a datastream and observations. Press "Restart client": the product appears under "Other sources", drawn by its schema type alone.' },
  { title: 'A server restart', nodes: ['shell', 'server', 'relay', 'client'],
    text: 'Press "Restart server". While it rebuilds its index it answers H: 503 with Retry-After. Its instance identifier changes, and the client clears its state and repeats the handshake.' },
  { title: 'Degraded mode', nodes: ['shell', 'server', 'client'],
    text: 'In the control panel, switch off air temperature, then restart the server. The client warns once, lists the unavailable essential sources, and disables the views that need them.' },
];

export function Tour({ step, setStep }: { step: number | null; setStep: (s: number | null) => void }) {
  if (step == null) return <button onClick={() => setStep(0)}>Guided tour</button>;
  const s = TOUR[step];
  return (
    <div className="tour" role="dialog" aria-label="Guided tour">
      <b>{step + 1}/{TOUR.length}. {s.title}</b> <span>{s.text}</span>
      <span className="tour-nav">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < TOUR.length - 1 ? <button onClick={() => setStep(step + 1)}>Next</button> : null}
        <button onClick={() => setStep(null)}>End tour</button>
      </span>
    </div>
  );
}
