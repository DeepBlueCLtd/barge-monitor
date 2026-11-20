// A model card's live activity (Models panel): a busy indicator and the model's
// most recent messages as tokens. Both come from the real captured messages
// (FR-66): tokens are the last messages whose `model` is this model, pointing
// the way they travelled (to the data server, from it, to the scientific
// libraries, back from them). The busy indicator turns for half of each second
// while the simulation runs, and stands still when it is paused (FR-77).
import { useEffect, useState } from 'react';
import { simClock } from '../shell/clock';
import { Glyph } from '../shell/Glyph';
import { bus, LETTERS, type Message } from '../shell/messages';
import { useStore } from '../shell/store';
import { ModelInner } from './ModelInner';

const SHOWN = 6;
const ARROW: Record<string, string> = {
  'models>server': '→ server', 'server>models': '← server', 'models>scilibs': '→ libs', 'scilibs>models': '← libs',
};

export function ModelActivity({ model }: { model: string }) {
  useStore(bus.version);
  const clock = useStore(simClock.state);
  const playing = !!clock?.playing;
  const tokens = bus.find((m) => m.model === model).slice(-SHOWN);
  return (
    <>
      <ModelInner model={model} playing={playing} />
      <div className="model-activity" data-testid={`activity-${model}`}>
        <Busy on={playing} />
        <div className="model-tokens" aria-label="recent messages">
          {tokens.length ? tokens.map((m) => <Token key={m.key} m={m} />)
            : <span className="model-quiet">{playing ? 'waiting for its next step' : 'paused'}</span>}
        </div>
      </div>
    </>
  );
}

function Token({ m }: { m: Message }) {
  const lane = `${m.src}>${m.dst}`;
  return (
    <span className="model-token" title={`${LETTERS[m.letter]?.name ?? m.letter}: ${m.summary}`}>
      <Glyph letter={m.letter} failed={m.failed} size={18} />
      <span className="model-token-dir">{ARROW[lane] ?? lane}</span>
    </span>
  );
}

/** Turns for 0.5 s of every second while the simulation plays. */
function Busy({ on }: { on: boolean }) {
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (!on) {
      setSpin(false);
      return;
    }
    let off: ReturnType<typeof setTimeout> | undefined;
    const pulse = () => {
      setSpin(true);
      off = setTimeout(() => setSpin(false), 500);
    };
    pulse();
    const every = setInterval(pulse, 1000);
    return () => {
      clearInterval(every);
      if (off) clearTimeout(off);
    };
  }, [on]);
  return (
    <svg className={`busy${spin ? ' spinning' : ''}`} width={22} height={22} viewBox="0 0 22 22" role="img" aria-label={spin ? 'busy' : 'idle'}>
      <circle cx={11} cy={11} r={8} fill="none" stroke="#e7d39a" strokeWidth={3} />
      <path d="M11 3 A8 8 0 0 1 19 11" fill="none" stroke="#a16207" strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
}
