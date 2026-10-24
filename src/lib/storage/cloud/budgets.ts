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

/**
 * The relations every budget set must keep. An original is verified whole in memory before it is bound, so it may not be
 * declared larger than what can be buffered (else a body is stored that no finalize can ever accept), and one package
 * file may not exceed its whole package. Checked by `storageBudgets` and again by every writer, because a raw object can
 * reach a factory without passing through the parser.
 */
export function budgetsConsistent(b: StorageBudgets): boolean {
  return KEYS.every((k) => Number.isSafeInteger(b[k]) && b[k] >= 1) && b.maxOriginalBytes <= b.maxBufferedObjectBytes && b.maxPackageFileBytes <= b.maxPackageBytes;
}

/** The budgets from trusted deployment configuration (an object or its JSON text), or null when any is missing, invalid or inconsistent. */
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
  return budgetsConsistent(out as StorageBudgets) ? Object.freeze(out as StorageBudgets) : null;
}
