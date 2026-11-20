// The Annex A palette (VS-05..VS-09). Every text and icon colour here is
// checked for contrast against the surface it sits on (AT-V2).
export const PAPER = '#fbfaf6';
export const CARD = '#ffffff';
export const INK = '#23262d';
export const MUTED = '#57534e';
export const LETTER_COLOURS: Record<string, string> = {
  Q: '#1d4ed8', D: '#0f766e', O: '#15803d', K: '#7e22ce', P: '#1e3a8a', H: '#b91c1c', L: '#9a3412', I: '#4b5563',
};
export const ZONES: Record<string, { hue: string; fill: string; text: string; dashed?: boolean }> = {
  simulated: { hue: '#78716c', fill: '#f3f2ef', text: '#57534e', dashed: true },
  legacy: { hue: '#c2410c', fill: '#fff4ea', text: '#9a3412' },
  new: { hue: '#1d4ed8', fill: '#eef4ff', text: '#1e40af' },
  third: { hue: '#7e22ce', fill: '#f7f0fd', text: '#6b21a8' },
};
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

/** Every text or icon colour paired with the surface it is drawn on (VS-09). */
export function contrastPairs(): { what: string; fg: string; bg: string }[] {
  const pairs = [
    { what: 'ink on paper', fg: INK, bg: PAPER }, { what: 'ink on card', fg: INK, bg: CARD },
    { what: 'muted on paper', fg: MUTED, bg: PAPER }, { what: 'muted on card', fg: MUTED, bg: CARD },
    { what: 'flow label on paper', fg: FLOW_LABEL, bg: PAPER },
  ];
  for (const [l, c] of Object.entries(LETTER_COLOURS)) {
    pairs.push({ what: `letter ${l} on its icon`, fg: c, bg: CARD }, { what: `letter ${l} in the key`, fg: c, bg: CARD });
  }
  for (const [z, s] of Object.entries(ZONES)) pairs.push({ what: `${z} zone label`, fg: s.text, bg: s.fill }, { what: `ink on ${z} zone`, fg: INK, bg: s.fill });
  return pairs;
}
