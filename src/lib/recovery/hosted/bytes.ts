import { contractError } from '../../server/runtime/errors.ts';
import type { RecoveryCode } from './types.ts';

export const fail = (code: RecoveryCode, retryable = false) => contractError(code, retryable);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes: Uint8Array): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource)); }
/** Key-sorted JSON: the same value always gives the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') { if (typeof v === 'number' && !Number.isFinite(v)) throw fail('manifest-invalid'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
export const encode = (s: string) => new TextEncoder().encode(s);
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SHA = /^[0-9a-f]{64}$/;
export function objectKeys(clientId: string, caseId: string, exportId: string) {
  const base = `recovery/exports/${clientId}/${caseId}/${exportId}`;
  return { base, manifest: `${base}/manifest.json`, blob: (sha: string) => `${base}/blobs/${sha}` };
}
