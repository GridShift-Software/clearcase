import type { NativeImportBudget } from './ports.ts';

/**
 * The import budget from trusted deployment configuration (an object or its JSON text, e.g. a variable the parent names), or
 * null when it is missing, has unknown or missing keys, or a value is not a positive safe integer. There is no default: no
 * production size has been approved. `maxPackageBytes`, when given a ceiling, must not exceed the stager's own bound, so no
 * body is accepted that the stager cannot take.
 */
export function nativeImportBudget(value: unknown, o: { stagerMaxPackageBytes?: number } = {}): NativeImportBudget | null {
  let v = value;
  if (typeof v === 'string') try { v = JSON.parse(v); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== 'maxFileBytes,maxFiles,maxPackageBytes,maxRequestBytes') return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
  if (!ok(b.maxFileBytes) || !ok(b.maxFiles) || !ok(b.maxPackageBytes) || !ok(b.maxRequestBytes)) return null;
  if (b.maxFiles > 1023 + 1 || b.maxFileBytes > b.maxPackageBytes) return null;
  if (o.stagerMaxPackageBytes !== undefined && b.maxPackageBytes > o.stagerMaxPackageBytes) return null;
  return Object.freeze({ maxRequestBytes: b.maxRequestBytes, maxFiles: b.maxFiles, maxFileBytes: b.maxFileBytes, maxPackageBytes: b.maxPackageBytes });
}

/**
 * What one request may make, from the deployment's plan: D1 calls (a batch is one) and external subrequests (each Clerk
 * session check), and the stager's `maxRowsPerBatch`, which sets how many row batches an import writes.
 */
export interface RequestBudget { readonly d1: number; readonly external: number; readonly rowsPerBatch: number }
/** An import's work as its package shows it: package files, distinct originals, and read-model rows (documents, assets, seeds). */
export interface ImportShape { readonly files: number; readonly originals: number; readonly rows: number }

/**
 * The calls one fresh, accepted import makes as import-composition.ts composes it, measured in
 * tests/hosted-foundation/native-stager/request-cost.test.ts. Fixed: admission, the attempt claim, submission and version
 * reads, the stager's storage gates, folder, admission and stored readback, its outcome audit, the link and its audit.
 * Each distinct original is read in four passes, each read under a fresh observation (one D1 call and one Clerk check).
 * Each guarded row batch after the version-row batch is one D1 call and one Clerk check. Fewer rows give a lower bound.
 * The answer ends on the repository's release fence, one D1 call after the settling readback (the session check it needs
 * is the one already counted for the answer), so the fixed part is 37 D1 calls.
 */
export function nativeImportCost(s: ImportShape, rowsPerBatch: number): { d1: number; external: number } {
  const batches = (n: number) => Math.ceil(Math.max(0, n) / rowsPerBatch);
  const writes = batches(s.files - rowsPerBatch) + batches(s.rows);
  return { d1: 37 + 4 * s.originals + writes, external: 11 + 4 * s.originals + writes };
}
/** The refusal detail for work over the budget, or null when it fits. */
export function overRequestBudget(s: ImportShape, b: RequestBudget): string | null {
  const c = nativeImportCost(s, b.rowsPerBatch);
  return c.d1 <= b.d1 && c.external <= b.external ? null
    : `this import needs ${c.d1} D1 calls and ${c.external} subrequests; one request here may make ${b.d1} and ${b.external}`;
}
