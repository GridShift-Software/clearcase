// Cumulative quotas for hosted results storage. Unlike the per-object budgets (budgets.ts), these bound what one case or
// one client may accumulate over time: uploads, bytes, versions and the provider writes of retries. Every writer reserves
// against them in D1 (one conditional statement or one guarded batch) before it touches R2, so a retry cannot reset them.
// Every bound is required configuration with no default: no product quota has been decided. Abandoned reservations are
// not released, because nothing here deletes or reaps an object; they keep counting until a reviewed cleanup exists.
export interface StorageQuotas {
  /** Declared uploads of one case, whatever their state. */
  maxUploadsPerCase: number;
  /** Declared bytes of all uploads of one case. */
  maxOriginalBytesPerCase: number;
  /** Declared bytes of all uploads of the client (the whole database). */
  maxOriginalBytesPerClient: number;
  /** `put` calls that may reach the bucket for one declared upload. */
  maxPutAttemptsPerUpload: number;
  /** Results versions (staging or stored) of one case. */
  maxVersionsPerCase: number;
  /** Bytes of the packages of all versions of one case. */
  maxPackageBytesPerCase: number;
  /** Bytes of the packages of all versions of the client. */
  maxPackageBytesPerClient: number;
  /** Staging attempts, retries included, summed over every version of one case. */
  maxStagingAttemptsPerCase: number;
}
const KEYS = ['maxUploadsPerCase', 'maxOriginalBytesPerCase', 'maxOriginalBytesPerClient', 'maxPutAttemptsPerUpload', 'maxVersionsPerCase', 'maxPackageBytesPerCase', 'maxPackageBytesPerClient', 'maxStagingAttemptsPerCase'] as const satisfies readonly (keyof StorageQuotas)[];

/** True when every quota is present as a positive safe integer. Checked again by every writer. */
export const quotasValid = (q: StorageQuotas | null | undefined): q is StorageQuotas =>
  q !== null && typeof q === 'object' && KEYS.every((k) => Number.isSafeInteger(q[k]) && q[k] >= 1);

/** The quotas from trusted deployment configuration (an object or its JSON text), or null when any is missing or invalid. */
export function storageQuotas(value: unknown): StorageQuotas | null {
  let v = value;
  if (typeof v === 'string') try { v = JSON.parse(v); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== KEYS.length) return null;
  const out = Object.fromEntries(KEYS.map((k) => [k, (v as Record<string, unknown>)[k]])) as unknown as StorageQuotas;
  return quotasValid(out) ? Object.freeze(out) : null;
}
