/**
 * SHA-256 of a text (as UTF-8), as 64 lowercase hex characters. Written out so that the validator of a replay can check the
 * hash of a review in the browser and on the server with the same code (this package has no Node or DOM types). The
 * constants are the fractional parts of the roots of the first primes, computed once; the tests compare the result with
 * `node:crypto` for many inputs.
 */
let K: number[] | undefined;
let H0: number[] | undefined;
function constants(): { k: number[]; h: number[] } {
  if (K === undefined || H0 === undefined) {
    const primes: number[] = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);
    const frac = (x: number): number => Math.floor((x - Math.floor(x)) * 4294967296);
    K = primes.map((p) => frac(Math.cbrt(p)));
    H0 = primes.slice(0, 8).map((p) => frac(Math.sqrt(p)));
  }
  return { k: K, h: H0 };
}
function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
export function sha256Hex(text: string): string {
  const { k, h: init } = constants();
  const bytes = utf8Bytes(text);
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bits / 4294967296);
  const low = bits >>> 0;
  for (const word of [high, low]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  const h = init.map((v) => v | 0);
  const w = new Array<number>(64).fill(0);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((bytes[off + 4 * i] as number) << 24) | ((bytes[off + 4 * i + 1] as number) << 16) | ((bytes[off + 4 * i + 2] as number) << 8) | (bytes[off + 4 * i + 3] as number);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (k[i] as number) + (w[i] as number)) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (next[i] as number)) | 0;
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}
