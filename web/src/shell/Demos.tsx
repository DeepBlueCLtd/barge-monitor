// The failure-demo menu in the top bar and the banner that says what to watch.
import { useEffect, useRef, useState } from 'react';
import { activeDemo, DEMOS, endDemo, startDemo, takeStep } from './demos';
import { useStore } from './store';

export function DemoMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="demo-menu" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="demo-menu">Failure demos ▾</button>
      {open && (
        <ul className="demo-list" role="menu">
          {DEMOS.map((d) => (
            <li key={d.id} role="none">
              <button role="menuitem" data-testid={`demo-${d.id}`} onClick={() => {
                setOpen(false);
                startDemo(d);
              }}>
                <b>{d.title}</b>
                <span>{d.shows}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DemoBanner() {
  const a = useStore(activeDemo);
  if (!a) return null;
  const { demo, done } = a;
  const next = demo.steps[done];
  return (
    <div className="demo-banner" role="status" data-testid="demo-banner">
      <p><b>{demo.title}.</b> <span data-testid="demo-watch">{demo.steps[done - 1]?.watch}</span>{a.found && <> <b data-testid="demo-found">{a.found}</b></>}</p>
      <div className="demo-actions">
        {next && <button className="btn primary" data-testid="demo-next" onClick={() => void takeStep()}>{next.label}</button>}
        <button className="btn" data-testid="demo-reset" onClick={() => endDemo(true)}>Put everything back</button>
        <button className="btn" aria-label="Close this banner and leave things as they are" onClick={() => endDemo(false)}>×</button>
      </div>
    </div>
  );
}
