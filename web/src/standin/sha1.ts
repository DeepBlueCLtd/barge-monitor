// SHA-1 of a UTF-8 string, hex. Only for datastream identifiers
// (`{system}-{outputName}-{sha1(names)[:6]}`, fields.py `schema_id`, FR-51):
// not used for anything that needs a secure hash.

export function sha1Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const len = msg.length;
  const words = ((len + 8) >> 6) + 1;
  const w = new Uint32Array(words * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  w[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  w[words * 16 - 1] = len * 8;
  w[words * 16 - 2] = Math.floor((len * 8) / 0x100000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const x = new Uint32Array(80);
  for (let blk = 0; blk < words * 16; blk += 16) {
    for (let i = 0; i < 16; i++) x[i] = w[blk + i];
    for (let i = 16; i < 80; i++) {
      const v = x[i - 3] ^ x[i - 8] ^ x[i - 14] ^ x[i - 16];
      x[i] = (v << 1) | (v >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + x[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
