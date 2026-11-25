// The message strip (FR-68, FR-70, VS-18): crisp, not sketched, because it
// carries the evidence. A clicked message shows its letter and name, whether it
// meets a public standard, its sender and receiver, and its contents in
// monospace. In the display client's panel, until a message is clicked, it
// shows the store query (S) the current selection caused, found by the chain
// the client's request carried, with the chain of messages that selection sends.
import { useEffect, useState } from 'react';
import { clientSession } from '../client/session';
import { nameOf } from '../shell/components';
import { Glyph } from '../shell/Glyph';
import { bus, LETTERS, Message } from '../shell/messages';
import { selectedMessage } from '../shell/selection';
import { useStore } from '../shell/store';

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
    case 'client>server': return `${m.letter} to the data server`;
    case 'server>adapter': return 'S to the store adapter';
    case 'adapter>store': return "S read of the logger files, found through the adapter's index";
    case 'store>adapter': return 'L records back up';
    case 'adapter>server': return 'I columns to the data server';
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
      <p className="strip-summary">{m.summary}</p>
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

/** The display client's default: the S the current selection causes, and its chain (FR-70, AT-17). */
function SelectionQuery() {
  useBusVersion();
  const session = useStore(clientSession);
  const last = useStore(session.lastRead);
  const raw = session.plan.some((r) => r.raw);
  // Found by chain: an S the data server made while answering one of this selection's requests.
  // The selection's own read comes first; polls then repeat the chain once per simulated second.
  const s = bus.find((m) => m.letter === 'S' && m.src === 'server' && (m.dst as string) === 'adapter' /* 4.1 store query: withdrawn in 4.6, to be removed with the display-client rework */ && session.http.seqOf(m.chain) >= session.planSeq)[0] ?? null;
  if (s) {
    const chain = bus.chain(s.chain!);
    return (
      <div className="strip" style={{ borderColor: LETTERS.S.colour }} data-testid="message-strip" data-letter="S">
        <Head m={s} note="built from the current selection" />
        <div className="strip-body">
          <pre className="mono" data-testid="message-content">{pretty(s.content)}</pre>
          <div className="strip-chain">
            <h4>This selection sends</h4>
            <p data-testid="strip-chain">{describeChain(chain)}.</p>
            <p className="strip-empty">The query asks for whole records: Connected Systems has no per-field filter, so the display client picks its fields from what comes back.
              Then, once per simulated second, a poll from the last reading received repeats this chain for the new records.</p>
          </div>
        </div>
      </div>
    );
  }
  // A period read from summary datastreams makes no store query: say so (FR-29).
  const chain = last ? bus.chain(last.chain) : [];
  const q = chain.find((m) => m.src === 'client');
  return (
    <div className="strip neutral" data-testid="message-strip" data-letter="none">
      <header className="strip-head"><h3>Store query</h3>
        <span className="strip-meta">{' · '}internal, no public standard · from Data server to Store adapter</span></header>
      <div className="strip-body">
        <p className="strip-empty" data-testid="strip-no-s">
          {!session.config.value ? 'No selection yet: the display client has not made its handshake (press ▶ Play).'
            : !session.plan.length ? 'No store query: no field is selected, so the display client reads no observations.'
              : raw ? 'No store query captured yet for this selection: it appears with the next poll.'
                : `No store query for this selection: periods longer than an hour read summary datastreams published by the models (${session.plan.map((r) => r.ds.outputName).join(', ')}), not raw records, and none of these requests caused an S.`}
        </p>
        {q && chain.length > 0 && (
          <div className="strip-chain">
            <h4>This selection sends</h4>
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
  return selectionDefault ? <SelectionQuery /> : null;
}
