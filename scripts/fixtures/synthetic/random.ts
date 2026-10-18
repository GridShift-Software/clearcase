import { sha256Hex } from '../../../src/lib/case-package/hash.ts';

/** Mulberry32, initialized from the text seed; no wall clock or ambient randomness. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256Hex(new TextEncoder().encode(seed)).slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = state;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}
