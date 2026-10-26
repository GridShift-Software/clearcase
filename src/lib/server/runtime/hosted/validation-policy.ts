import { LIMITS, type Limits } from '../../../case-package/limits.ts';
import { storageBudgets } from '../../../storage/cloud/budgets.ts';

/**
 * One effective policy for native candidate import and publication revalidation. Canonical non-resource rules stay
 * fixed; resource bounds come only from complete, valid deployment storage budgets, never parser/allocation defaults.
 * Capture synchronously so later caller mutation cannot change a factory's validation policy across awaits.
 */
export function hostedValidationPolicy(value: unknown): Readonly<Limits> | null {
  const b = storageBudgets(value);
  if (!b) return null;
  return Object.freeze({
    ...LIMITS,
    packageFiles: b.maxPackageFiles,
    fileBytes: b.maxPackageFileBytes,
    manifestBytes: b.maxPackageFileBytes,
    packageBytes: b.maxPackageBytes,
    originalBytes: b.maxOriginalBytes,
    originalsTotalBytes: b.maxVerifyBytes,
  });
}
