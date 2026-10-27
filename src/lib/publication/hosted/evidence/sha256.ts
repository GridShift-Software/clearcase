// Incremental SHA-256 (FIPS 180-4) whose state can be saved and restored. Web Crypto digests are one-shot, so a page of
// 500 rows could not be hashed across Workers invocations with it; this lets every step hash only what it produced.
// The constants are derived from the primes, as the standard defines them, and the tests compare every result with the platform digest.
let K: Uint32Array | undefined, IV: Uint32Array | undefined;
function constants() {
  if (K && IV) return { K, IV };
  const primes: number[] = [];
  for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p !== 0)) primes.push(n);
  const frac = (x: number) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
  K = Uint32Array.from(primes, p => frac(Math.cbrt(p)));
  IV = Uint32Array.from(primes.slice(0, 8), p => frac(Math.sqrt(p)));
  return { K, IV };
}
const BLOCK = 64;
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const HEX = '0123456789abcdef';
const toHex = (bytes: Uint8Array) => { let out = ''; for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!; return out; };
const fromHex = (text: string) => { const out = new Uint8Array(text.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16); return out; };

/** The persistable state: eight chaining words, the bytes of the unfinished block (hex) and the total length in bytes. */
export interface Sha256Snapshot { readonly h: readonly number[]; readonly buffer: string; readonly length: number }

export class Sha256 {
  #h: Uint32Array;
  #buffer = new Uint8Array(BLOCK);
  #buffered = 0;
  #length = 0;
  readonly #w = new Uint32Array(64);
  constructor() { this.#h = Uint32Array.from(constants().IV); }

  update(data: Uint8Array): this {
    this.#length += data.length;
    let at = 0;
    if (this.#buffered > 0) {
      const take = Math.min(BLOCK - this.#buffered, data.length);
      this.#buffer.set(data.subarray(0, take), this.#buffered);
      this.#buffered += take; at = take;
      if (this.#buffered < BLOCK) return this;
      this.#compress(this.#buffer, 0); this.#buffered = 0;
    }
    for (; at + BLOCK <= data.length; at += BLOCK) this.#compress(data, at);
    this.#buffer.set(data.subarray(at), 0);
    this.#buffered = data.length - at;
    return this;
  }

  snapshot(): Sha256Snapshot {
    return { h: Array.from(this.#h), buffer: toHex(this.#buffer.subarray(0, this.#buffered)), length: this.#length };
  }

  static restore(snapshot: Sha256Snapshot): Sha256 {
    const buffer = fromHex(snapshot.buffer);
    if (snapshot.h.length !== 8 || !snapshot.h.every(w => Number.isInteger(w) && w >= 0 && w < 2 ** 32) || buffer.length >= BLOCK
      || !Number.isSafeInteger(snapshot.length) || snapshot.length < buffer.length || (snapshot.length - buffer.length) % BLOCK !== 0) throw new RangeError('malformed sha256 state');
    const hash = new Sha256();
    hash.#h = Uint32Array.from(snapshot.h); hash.#buffer.set(buffer); hash.#buffered = buffer.length; hash.#length = snapshot.length;
    return hash;
  }

  /** The digest so far, as lowercase hex. The hash is not consumed. */
  digestHex(): string {
    const copy = Sha256.restore(this.snapshot());
    const padding = new Uint8Array(((copy.#buffered < 56 ? 56 : 120) - copy.#buffered) + 8);
    padding[0] = 0x80;
    const bits = copy.#length * 8;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(padding.length - 4, bits >>> 0);
    copy.update(padding);
    const out = new Uint8Array(32), outView = new DataView(out.buffer);
    copy.#h.forEach((word, i) => outView.setUint32(4 * i, word));
    return toHex(out);
  }

  #compress(data: Uint8Array, offset: number) {
    const w = this.#w, k = constants().K, h = this.#h;
    for (let i = 0; i < 16; i++) w[i] = ((data[offset + 4 * i]! << 24) | (data[offset + 4 * i + 1]! << 16) | (data[offset + 4 * i + 2]! << 8) | data[offset + 4 * i + 3]!) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
}

export const sha256Hex = (bytes: Uint8Array): string => new Sha256().update(bytes).digestHex();
