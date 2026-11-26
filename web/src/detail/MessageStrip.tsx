// The message strip (FR-68, FR-70, VS-18): crisp, not sketched, because it
// carries the evidence. A clicked message shows its letter and name, whether it
// meets a public standard, its sender and receiver, and its contents in
// monospace. In the display client's panel, until a message is clicked, it
// shows the display client's latest read for its selection, found by the chain
// its request carried, with the chain of messages that read caused.
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { nameOf } from '../shell/components';
import { Glyph } from '../shell/Glyph';
import { bus, LETTERS, Message } from '../shell/messages';
import { selectedMessage } from '../shell/selection';
import { useStore } from '../shell/store';

/**
 * Credentials are never shown (FR-16a, FR-68, interfaces §9.4). The tap redacts every captured message once, centrally;
 * the strip redacts again what it shows, so that a message made in the page (a request the relay could not deliver)
 * is held to the same rule.
 */
export function redact(text: string): string {
  return text.replace(/^(authorization:[ \t]*)[^\r\n]*/gim, '$1****')
    .replace(/("authorization"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"****"')
    .replace(/("password"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"****"')
    .replace(/\bBasic [A-Za-z0-9+/=]{4,}/g, 'Basic ****');
}

export function pretty(s: string): string {
  try {
    return redact(JSON.stringify(JSON.parse(s), null, 2));
  } catch {
    return redact(s);
  }
}

/** A phrase for one hop of a chain, in the words of the mockup. */
function phrase(m: Message): string {
  const k = `${m.src}>${m.dst}`;
  switch (k) {
    case 'client>server': return `${m.letter} to the data server`;
    case 'server>importer': return 'K pushed to the CSV importer';
    case 'importer>folder': return 'S to the data folder';
    case 'folder>importer': return 'L, the CSV, back to the importer';
    case 'importer>server': return 'I written in bulk, inside the server';
    case 'server>client': return `${m.letter} to the display`;
    case 'models>server': return `${m.letter} from the model to the data server`;
    case 'server>models': return `${m.letter} back to the model`;
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
      <p className="strip-summary">{redact(m.summary)}</p>
      <div className="strip-body">
        <pre className="mono" data-testid="message-content">{pretty(m.content)}</pre>
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

/** The display client's default: its latest read for the selection, and that read's chain (FR-70). */
function SelectionQuery() {
  useBusVersion();
  const last = useStore(clientSession.lastRead);
  const chain = last ? bus.chain(last.chain) : [];
  const q = chain.find((m) => m.src === 'client');
  if (!last || !q) {
    return (
      <div className="strip neutral" data-testid="message-strip" data-letter="none">
        <header className="strip-head"><h3>The selection's read</h3></header>
        <div className="strip-body">
          <p className="strip-empty" data-testid="strip-no-read">
            {clientSession.phase.value === 'login' || clientSession.phase.value === 'locked' ? 'Nothing is read before login: log in to the display client.'
              : 'No read captured yet for this selection: choose a field, or press Play.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="strip" style={{ borderColor: LETTERS[q.letter].colour }} data-testid="message-strip" data-letter={q.letter}>
      <Head m={q} note={`the selection's latest read, of ${last.outputName.replace('__', ' · ')}`} />
      <div className="strip-body">
        <pre className="mono" data-testid="message-content">{pretty(q.content)}</pre>
        <div className="strip-chain">
          <h4>This read sends</h4>
          <p data-testid="strip-chain">{describeChain(chain)}.</p>
          <p className="strip-empty">While playing, once a real second, the client asks for what is new up to its replay time, never beyond it.</p>
        </div>
      </div>
    </div>
  );
}

export function MessageStrip({ selectionDefault }: { selectionDefault: boolean }) {
  const picked = useStore(selectedMessage);
  if (picked) return <Clicked m={picked.m} onClose={() => selectedMessage.set(null)} />;
  return selectionDefault ? <SelectionQuery /> : null;
}
