// The guided tour strip (FR-66, FR-67, VS-25): numbered steps joined by arrows.
// It highlights only; its text tells the viewer what to press.
export const TOUR = [
  { title: 'The zones', short: 'simulated, legacy, new build and third-party', nodes: ['clock', 'world', 'barge', 'sensors', 'logger', 'adapter', 'server', 'fastapi', 'scilibs'],
    text: 'Four zones: simulated (dashed grey), legacy (orange), new build (blue) and third-party (violet). The demonstrator shell sits outside them.' },
  { title: 'One reading', short: 'sensor to store to server to display', nodes: ['sensors', 'logger', 'adapter', 'server', 'fastapi', 'relay', 'client'],
    text: 'Press play. A reading leaves the sensors as L (the logger\'s fixed-width record), is read by the store adapter, served by the Connected Systems server and reaches the display client as O (SWE Common JSON). Pause and click an icon to read it.' },
  { title: 'The handshake', short: 'restart the client, follow D and P', nodes: ['client', 'relay', 'fastapi', 'server'],
    text: 'Pause, then press "Restart client". Follow the D messages (discovery and schemas) and the P (the declared profile) as the client configures itself. Use "Step" to move one hop at a time.' },
  { title: 'Promote a product', short: 'a script becomes a process system', nodes: ['workspace', 'products', 'relay', 'server'],
    text: 'In the workspace, choose a "Promote" example and run it: it POSTs a system, a datastream and observations. Press "Restart client": the product appears under "Other sources", drawn by its schema type alone.' },
  { title: 'Server restart', short: '503s, a new instance, a fresh client', nodes: ['shell', 'server', 'relay', 'client'],
    text: 'Press "Restart server". While it rebuilds its index it answers H: 503 with Retry-After. Its instance identifier changes, and the client clears its state and repeats the handshake.' },
  { title: 'Degraded mode', short: 'switch off an essential field', nodes: ['shell', 'server', 'client'],
    text: 'Open the control panel, switch off air temperature, then restart the server. The client warns once, lists the unavailable essential sources, and disables the views that need them.' },
];

export function TourStrip({ step, setStep }: { step: number | null; setStep: (s: number | null) => void }) {
  return (
    <section className="tour" aria-label="Guided tour">
      <h3>How it works · guided tour</h3>
      <ol className="steps">
        {TOUR.map((s, i) => (
          <li key={s.title}>
            <button className={`step ${step === i ? 'on' : ''}`} onClick={() => setStep(step === i ? null : i)} aria-pressed={step === i}>
              <span className="num">{i + 1}</span>
              <span className="what"><b>{s.title}</b><small>{s.short}</small></span>
            </button>
            {i < TOUR.length - 1 && <span className="step-arrow" aria-hidden="true">→</span>}
          </li>
        ))}
      </ol>
      {step != null && <p className="tour-text" role="status">{TOUR[step].text}</p>}
    </section>
  );
}
