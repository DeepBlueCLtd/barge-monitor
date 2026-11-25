// The message strip (FR-68, FR-70, VS-18): crisp, not sketched, because it
// carries the evidence. A clicked message shows its letter and name, whether it
// meets a public standard, its sender and receiver, and its contents in
// monospace, with credentials shown as **** (FR-16a). In the display client's
// panel, until a message is clicked, it shows the client's latest request.
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { nameOf } from '../shell/components';
import { Glyph } from '../shell/Glyph';
import { bus, LETTERS, Message } from '../shell/messages';
import { selectedMessage } from '../shell/selection';
import { useStore } from '../shell/store';

/** FR-16a: credentials are never shown. The tap redacts them; the strip does so again, in case. */
export function redact(s: string): string {
  return s.replace(/(authorization:\s*)(?!\*{4})[^\n]+/gi, '$1****').replace(/("password"\s*:\s*)"[^"]*"/g, '$1"****"');
}

export function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/** A phrase for one hop of a chain, in the words of the mockup. */
function phrase(m: Message): string {
  const k = `${m.src}>${m.dst}`;
  switch (k) {
    case 'client>gateway': return `${m.letter} to the access gateway`;
    case 'gateway>server': return `${m.letter} on to the data server`;
    case 'server>gateway': return `${m.letter} back to the gateway`;
    case 'gateway>client': return `${m.letter} to the display`;
    case 'models>gateway': return `${m.letter} from the model to the gateway`;
    case 'gateway>models': return `${m.letter} back to the model`;
    default: return `${m.letter} from ${nameOf(m.src)} to ${nameOf(m.dst)}`;
  }
}

/** The chain as one line, consecutive repeats counted (every message is still listed in the count). */
export function describeChain(chain: Message[]): string {
  const parts: { p: string; n: number }[] = [];
  for (const m of chain) {
    const p = phrase(m);
    const last = parts[parts.length - 1];
    if (last && last.p === p) last.n++;
    else parts.push({ p, n: 1 });
  }
  // A pair of hops that repeats (one file read after another) is said once, with its count.
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const one = (x: { p: string; n: number }) => (x.n > 1 ? `${x.p} (×${x.n})` : x.p);
    let reps = 1;
    while (i + 2 * reps + 1 < parts.length && parts[i + 2 * reps].p === parts[i].p && parts[i + 2 * reps + 1].p === parts[i + 1].p
      && parts[i + 2 * reps].n === 1 && parts[i + 2 * reps + 1].n === 1 && parts[i].n === 1 && parts[i + 1].n === 1) reps++;
    if (reps > 1) {
      out.push(`${parts[i].p} → ${parts[i + 1].p} (×${reps}: once for each file)`);
      i += 2 * reps - 1;
    } else out.push(one(parts[i]));
  }
  return out.join(' → ');
}

/** Re-render when messages arrive, at most once a second: the strip is read, not watched. */
function useBusVersion(): number {
  const [v, setV] = useState(bus.version.value);
  useEffect(() => {
    let pending = false;
    return bus.version.subscribe((n) => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        setV(n);
      }, 1000);
    });
  }, []);
  return v;
}

function Head({ m, note }: { m: Message; note?: string }) {
  const L = LETTERS[m.letter];
  return (
    <header className="strip-head">
      <Glyph letter={m.letter} size={26} />
      <h3 style={{ color: L.colour }}>{L.name}</h3>
      <span className="strip-meta" data-testid="strip-meta">
        {' · '}{L.isPublic ? <>meets a public standard: {L.standard}</> : <>{L.standard}</>}
        {' · '}from {nameOf(m.src)} to {nameOf(m.dst)}{m.model ? ` (${m.model})` : ''}
        {m.failed ? ' · failed: no answer' : ''}{note ? ` · ${note}` : ''}
      </span>
    </header>
  );
}

/** A clicked message (FR-68). */
function Clicked({ m, onClose }: { m: Message; onClose: () => void }) {
  const chain = m.chain ? bus.chain(m.chain) : [];
  return (
    <div className="strip" style={{ borderColor: LETTERS[m.letter].colour }} data-testid="message-strip" data-letter={m.letter}>
      <Head m={m} />
      <button className="close small" aria-label="Clear the selected message" onClick={onClose}>×</button>
      <p className="strip-summary">{m.summary}</p>
      <div className="strip-body">
        <pre className="mono" data-testid="message-content">{pretty(redact(m.content))}</pre>
        {chain.length > 1 && (
          <div className="strip-chain">
            <h4>Its chain</h4>
            <p>{describeChain(chain)}.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** The display client's default: its latest request and the chain it caused (FR-70). */
function LatestRequest() {
  useBusVersion();
  const http = clientSession.http;
  const m = http ? bus.last((x) => x.src === 'client' && http.owns(x.chain)) : null;
  if (!m) {
    return (
      <div className="strip neutral" data-testid="message-strip" data-letter="none">
        <div className="strip-body"><p className="strip-empty" data-testid="strip-empty">
          {http ? 'The display client has sent nothing yet. While paused it polls nothing (FR-63a).' : 'The display client sends nothing before login (FR-97). Click any moving message to read it.'}
        </p></div>
      </div>
    );
  }
  const chain = bus.chain(m.chain!);
  return (
    <div className="strip" style={{ borderColor: LETTERS[m.letter].colour }} data-testid="message-strip" data-letter={m.letter}>
      <Head m={m} note="the display client's latest request" />
      <div className="strip-body">
        <pre className="mono" data-testid="message-content">{pretty(redact(m.content))}</pre>
        {chain.length > 1 && (
          <div className="strip-chain">
            <h4>Its chain</h4>
            <p data-testid="strip-chain">{describeChain(chain)}.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageStrip({ selectionDefault }: { selectionDefault: boolean }) {
  const picked = useStore(selectedMessage);
  if (picked) return <Clicked m={picked.m} onClose={() => selectedMessage.set(null)} />;
  return selectionDefault ? <LatestRequest /> : null;
}
