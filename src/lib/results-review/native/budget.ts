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
