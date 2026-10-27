const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => { const t = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) t[ALPHABET.charCodeAt(i)] = i; return t; })();

/** The decoded length of canonical padded base64 text, or null when it is not that (no whitespace, no URL-safe alphabet, no missing padding). */
export function base64Length(text: string): number | null {
  const n = text.length;
  if (n % 4 !== 0) return null;
  const pad = n === 0 ? 0 : text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (n / 4) * 3 - pad;
}

/** Strict standard base64 (RFC 4648 section 4) to bytes, or null. Padding only at the end; the bits the padding drops must be zero. */
export function decodeBase64Strict(text: string): Uint8Array | null {
  const size = base64Length(text);
  if (size === null) return null;
  const out = new Uint8Array(size);
  let o = 0;
  const full = text.length === 0 ? 0 : text.length - 4;
  const digit = (i: number): number => { const c = text.charCodeAt(i); return c < 128 ? LOOKUP[c]! : -1; };
  for (let i = 0; i < full; i += 4) {
    const a = digit(i), b = digit(i + 1), c = digit(i + 2), d = digit(i + 3);
    if ((a | b | c | d) < 0) return null;
    out[o++] = (a << 2) | (b >> 4); out[o++] = ((b & 15) << 4) | (c >> 2); out[o++] = ((c & 3) << 6) | d;
  }
  if (text.length > 0) {
    const i = full, a = digit(i), b = digit(i + 1);
    if ((a | b) < 0) return null;
    if (text.endsWith('==')) {
      if ((b & 15) !== 0) return null;
      out[o++] = (a << 2) | (b >> 4);
    } else if (text.endsWith('=')) {
      const c = digit(i + 2);
      if (c < 0 || (c & 3) !== 0) return null;
      out[o++] = (a << 2) | (b >> 4); out[o++] = ((b & 15) << 4) | (c >> 2);
    } else {
      const c = digit(i + 2), d = digit(i + 3);
      if ((c | d) < 0) return null;
      out[o++] = (a << 2) | (b >> 4); out[o++] = ((b & 15) << 4) | (c >> 2); out[o++] = ((c & 3) << 6) | d;
    }
  }
  return o === size ? out : null;
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : ALPHABET[c & 63]!);
  }
  return out;
}
