// A message icon (VS-14): a circle bearing its letter in the letter's colour (VS-08).
import { LETTERS } from './messages';
import { INK } from './palette';

/** A message: a circle bearing its letter (VS-14); selected, a tinted fill and a halo; failed, a broken ring and a cross. */
export function Glyph({ letter, failed = false, selected = false, size = 30 }: { letter: string; failed?: boolean; selected?: boolean; size?: number }) {
  const c = LETTERS[letter as keyof typeof LETTERS]?.colour ?? INK;
  const r = size / 2;
  return (
    <svg width={size + 8} height={size + 8} viewBox={`${-r - 4} ${-r - 4} ${size + 8} ${size + 8}`} aria-hidden="true" className="glyph">
      {selected && <circle r={r + 3.5} fill={c} opacity={0.22} />}
      <circle r={r - 1.5} fill={selected ? `${c}2e` : '#fff'} stroke={c} strokeWidth={2.4} strokeDasharray={failed ? '6 4' : undefined} />
      <text y={6} textAnchor="middle" fill={c} fontSize={17} fontWeight={700} fontFamily="'Patrick Hand', sans-serif">{letter}</text>
      {failed && <path d={`M${r - 7},${-r + 1} l7,7 m0,-7 l-7,7`} stroke="#b91c1c" strokeWidth={2.4} strokeLinecap="round" />}
    </svg>
  );
}
