// The failure-demo menu in the top bar and the banner that says what to watch (FR-79a).
// Every disabled button says why (FR-125a).
import { useEffect, useRef, useState } from 'react';
import { activeDemo, DEMOS, endDemo, startDemo, takeStep } from './demos';
import { useStore } from './store';

/** `reason`, when set, is why the menu cannot open yet (FR-125a). */
export function DemoMenu({ reason = null }: { reason?: string | null }) {
  const [open, setOpen] = useState(false);
  const a = useStore(activeDemo);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const busy = a?.running || a?.restoring ? 'Wait: a failure demo is still taking a step' : null;
  const why = reason ?? busy;
  return (
    <div className="demo-menu" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="demo-menu"
        {...(why ? { disabled: true, title: why, 'aria-describedby': reason ? 'control-reason' : 'demo-busy' } : {})}>Failure demos ▾</button>
      {busy && !reason && <span id="demo-busy" className="sr-only">{busy}</span>}
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
  const busy = a.restoring ? 'Putting everything back…' : a.running ? 'Taking the step…' : null;
  const wait = busy ? { disabled: true, title: `Wait: ${busy.replace('…', '').toLowerCase()} first`, 'aria-describedby': 'demo-status' } : {};
  return (
    <div className="demo-banner" role="status" data-testid="demo-banner" data-demo={demo.id} data-running={String(!!a.running)} data-restoring={String(!!a.restoring)}>
      <p><b>{demo.title}.</b> <span data-testid="demo-watch">{demo.steps[done - 1]?.watch}</span>{a.found && <> <b data-testid="demo-found">{a.found}</b></>}
        {busy && <> <span id="demo-status" className="demo-busy" data-testid="demo-busy">{busy}</span></>}</p>
      <div className="demo-actions">
        {next && <button className="btn primary" data-testid="demo-next" onClick={() => void takeStep()} {...wait}>{next.label}</button>}
        <button className="btn" data-testid="demo-reset" onClick={() => void endDemo(true)} {...(a.restoring ? wait : {})}>Put everything back</button>
        <button className="btn" aria-label="Close this banner and leave things as they are" data-testid="demo-close" onClick={() => void endDemo(false)}>×</button>
      </div>
    </div>
  );
}
