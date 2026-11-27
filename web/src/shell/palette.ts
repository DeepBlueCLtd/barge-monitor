// The palette (SRD §11.2, VS-06..VS-11). Every text and icon colour here is
// paired with the surface it sits on in contrastPairs(), and the e2e suite
// checks each pair (AT-22).
export const PAPER = '#fbfaf6'; // VS-06 warm off-white ground
export const CARD = '#ffffff';
export const INK = '#23262d'; // VS-06 near-black ink
export const MUTED = '#57534e';

/** VS-08: one colour per letter, shared by icon, key and message strip. */
export const LETTER_COLOURS: Record<string, string> = {
  Q: '#1d4ed8', // blue
  D: '#0f766e', // teal
  O: '#11703a', // green
  K: '#7e22ce', // purple
  P: '#1e3a8a', // navy
  H: '#b91c1c', // red
  S: '#a24b06', // amber
  L: '#7c4a1e', // brown
  I: '#4b5563', // grey
};

export type ZoneId = 'front' | 'third' | 'back' | 'legacy';

/** VS-07: each of the four zones a pale fill with a stronger outline of one hue (the 4.1 World zone is retired, D-320). */
export const ZONES: Record<ZoneId, { label: string; hue: string; fill: string; text: string; dashed?: boolean }> = {
  front: { label: 'New build · front end', hue: '#15803d', fill: '#edf7ef', text: '#166534' },
  third: { label: 'Third-party libraries', hue: '#7e22ce', fill: '#f6effc', text: '#6b21a8' },
  back: { label: 'New build · back end', hue: '#1d4ed8', fill: '#edf3fe', text: '#1e40af' },
  legacy: { label: 'Legacy', hue: '#c2410c', fill: '#fff3e8', text: '#9a3412' },
};

/** VS-09: value-add gold, used only for revealed value-add components and their parts. */
export const GOLD = { fill: '#fbe6a2', outline: '#a16207', text: '#6f4500', pale: '#fdf6dc' };
/** The ring around the selected component (FR-69). */
export const SELECT_RING = '#1d4ed8';
export const FLOW_LABEL = '#57534e';

/** WCAG relative luminance and contrast ratio. */
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Every text or icon colour paired with the surface it is drawn on (VS-11, AT-22). */
export function contrastPairs(): { what: string; fg: string; bg: string }[] {
  const pairs = [
    { what: 'ink on paper', fg: INK, bg: PAPER }, { what: 'ink on card', fg: INK, bg: CARD },
    { what: 'muted on paper', fg: MUTED, bg: PAPER }, { what: 'muted on card', fg: MUTED, bg: CARD },
    { what: 'flow label on paper', fg: FLOW_LABEL, bg: PAPER },
    { what: 'ink on gold', fg: INK, bg: GOLD.fill }, { what: 'gold text on gold', fg: GOLD.text, bg: GOLD.fill },
    { what: 'gold text on pale gold', fg: GOLD.text, bg: GOLD.pale }, { what: 'gold text on paper', fg: GOLD.text, bg: PAPER },
    { what: 'gold outline on card (icon)', fg: GOLD.outline, bg: CARD },
  ];
  for (const [l, c] of Object.entries(LETTER_COLOURS)) {
    pairs.push({ what: `letter ${l} on its icon`, fg: c, bg: CARD }, { what: `letter ${l} on paper`, fg: c, bg: PAPER });
    for (const [z, s] of Object.entries(ZONES)) pairs.push({ what: `letter ${l} over ${z} zone`, fg: c, bg: s.fill });
  }
  for (const [z, s] of Object.entries(ZONES)) {
    pairs.push({ what: `${z} zone label`, fg: s.text, bg: s.fill }, { what: `ink on ${z} zone`, fg: INK, bg: s.fill },
      { what: `muted on ${z} zone`, fg: MUTED, bg: s.fill });
  }
  return pairs;
}
