// Resource budgets for hosted results storage. Every bound is required configuration: there is no default, because no
// production policy has been measured or approved (docs/acceptance/hosting/storage.md, "What stays HOLD"). A missing,
// unknown or malformed budget makes storage unavailable rather than unbounded.
export interface StorageBudgets {
  /** Files in one results package, manifest included. */
  maxPackageFiles: number;
  /** Bytes of one package file read or written. */
  maxPackageFileBytes: number;
  /** Bytes of one whole package staged in one import. */
  maxPackageBytes: number;
  /** Document rows of one version. */
  maxDocuments: number;
  /** Rows written by one D1 batch while staging. */
  maxRowsPerBatch: number;
  /** Bytes of one original or preview held in memory to verify it before any byte is released. */
  maxBufferedObjectBytes: number;
  /** Declared size of one uploaded original. */
  maxOriginalBytes: number;
}
const KEYS = ['maxPackageFiles', 'maxPackageFileBytes', 'maxPackageBytes', 'maxDocuments', 'maxRowsPerBatch', 'maxBufferedObjectBytes', 'maxOriginalBytes'] as const satisfies readonly (keyof StorageBudgets)[];

/** The budgets from trusted deployment configuration (an object or its JSON text), or null when any is missing or invalid. */
export function storageBudgets(value: unknown): StorageBudgets | null {
  let v = value;
  if (typeof v === 'string') try { v = JSON.parse(v); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== KEYS.length) return null;
  const out: Partial<StorageBudgets> = {};
  for (const k of KEYS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return null;
    out[k] = n;
  }
  return Object.freeze(out as StorageBudgets);
}
