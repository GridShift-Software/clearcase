// Shared helpers of the native alpha journey. Nothing here reads the environment, the network or the file system.
import { createHash, randomBytes } from 'node:crypto';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex');
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Compact JSON with sorted keys, for digests and byte-exact report comparison. Only the report's own value space (no integer-like keys). */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/**
 * Text that must never enter a report, a log or a URL: a JWT, a Clerk key, a bearer or cookie value, a private-key block,
 * an e-mail address. A report that matches is refused whole, not redacted: redaction would hide that a secret reached it.
 */
const SECRET = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/, // JWT (Clerk session tokens)
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{8,}/, // Clerk and Stripe-style keys
  /\bsess_[A-Za-z0-9]{10,}/, // Clerk session id
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b__(?:session|client_uat|clerk_db_jwt)\w*=/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // e-mail address
];
export const secretLike = (text: string): boolean => SECRET.some((re) => re.test(text));

/** A value is a plain object (not an array, not null). */
export const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).sort().join() === [...keys].sort().join();

export const SHA = /^[0-9a-f]{64}$/;
export const SHA1 = /^[0-9a-f]{40}$/;
export const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
