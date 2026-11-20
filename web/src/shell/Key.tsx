import { LETTERS } from './messages';

export function Key() {
  return (
    <div className="key" aria-label="Message key">
      {Object.entries(LETTERS).map(([l, v]) => (
        <span key={l} className="key-item"><span className="letter" style={{ background: v.colour }}>{l}</span>{v.standard}</span>
      ))}
    </div>
  );
}
