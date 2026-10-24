import type { IntakeBudget } from './ports.ts';

/**
 * The intake budget from trusted deployment configuration (an object or its JSON text, e.g. a `CLEARCASE_INTAKE_BUDGET`
 * variable the parent names), or null when it is missing, has unknown or missing keys, or a value is not a positive safe
 * integer. There is no default: no production size has been approved. `maxOriginalBytes`, when given, is the original
 * store's own bound; a file budget above it is refused, so no body is accepted that the store cannot verify.
 */
export function intakeBudget(value: unknown, o: { maxOriginalBytes?: number } = {}): IntakeBudget | null {
  let v = value;
  if (typeof v === 'string') try { v = JSON.parse(v); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== 'maxFileBytes,maxMetadataBytes') return null;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
  if (!ok(b.maxFileBytes) || !ok(b.maxMetadataBytes) || b.maxMetadataBytes > 65_536) return null;
  if (o.maxOriginalBytes !== undefined && b.maxFileBytes > o.maxOriginalBytes) return null;
  return Object.freeze({ maxFileBytes: b.maxFileBytes, maxMetadataBytes: b.maxMetadataBytes });
}
