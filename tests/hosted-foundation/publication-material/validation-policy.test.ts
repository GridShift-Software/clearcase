// Source-owned policy checks only; these do not certify native Workers or production budgets.
import { describe, expect, it } from 'vitest';
import { hostedValidationPolicy } from '../../../src/lib/server/runtime/hosted/validation-policy.ts';
import { createHostedCandidateStager } from '../../../src/lib/server/runtime/hosted/candidate-stager.ts';
import { LIMITS, type Limits } from '../../../src/lib/case-package/limits.ts';
import { BUDGETS } from '../storage/fixture.ts';
import { world } from '../native-stager/world.ts';
import type { StorageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';

const overrides = {
  packageFiles: 'maxPackageFiles', fileBytes: 'maxPackageFileBytes', manifestBytes: 'maxPackageFileBytes',
  packageBytes: 'maxPackageBytes', originalBytes: 'maxOriginalBytes', originalsTotalBytes: 'maxVerifyBytes',
} as const satisfies Partial<Record<keyof Limits, keyof StorageBudgets>>;
const resourceKeys = new Set<string>(Object.keys(overrides));
const budgetKeys = Object.keys(BUDGETS) as (keyof StorageBudgets)[];

describe('complete immutable hosted validation policy', () => {
  it.each([64 << 10, 2 << 20])('derives all six overrides and retains every non-resource default for file bound %i', (maxPackageFileBytes) => {
    const budgets = { ...BUDGETS, maxPackageFileBytes };
    const policy = hostedValidationPolicy(budgets)!;
    expect(Object.keys(policy).sort()).toEqual(Object.keys(LIMITS).sort());
    for (const [limit, budget] of Object.entries(overrides)) expect(policy[limit as keyof Limits]).toBe(budgets[budget]);
    for (const key of Object.keys(LIMITS) as (keyof Limits)[]) if (!resourceKeys.has(key)) expect(policy[key]).toBe(LIMITS[key]);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each(Object.entries(overrides))('tracks explicit %s changes without unrelated policy drift', (limit, budget) => {
    const before = hostedValidationPolicy(BUDGETS)!;
    const b = { ...BUDGETS, [budget]: BUDGETS[budget] - 1 };
    const after = hostedValidationPolicy(b)!;
    expect(after).not.toBeNull();
    expect(after[limit as keyof Limits]).toBe(b[budget]);
    for (const key of Object.keys(LIMITS) as (keyof Limits)[]) {
      const affected = Object.entries(overrides).some(([k, v]) => k === key && v === budget);
      expect(after[key]).toBe(affected ? b[budget] : before[key]);
    }
    expect(before[limit as keyof Limits]).toBe(BUDGETS[budget]);
  });

  it('captures values independently of caller mutation or later policy construction', () => {
    const b = { ...BUDGETS }, first = hostedValidationPolicy(b)!;
    b.maxPackageFileBytes = 2 << 20; b.maxPackageFiles--;
    const second = hostedValidationPolicy(b)!;
    expect(first.manifestBytes).toBe(BUDGETS.maxPackageFileBytes);
    expect(first.packageFiles).toBe(BUDGETS.maxPackageFiles);
    expect(second.manifestBytes).toBe(b.maxPackageFileBytes);
    expect(second.packageFiles).toBe(b.maxPackageFiles);
    expect(() => Object.assign(first, { manifestBytes: 1 })).toThrow();
  });

  it.each(budgetKeys)('rejects missing or malformed %s, including non-parser storage bounds', (key) => {
    const missing: Record<string, unknown> = { ...BUDGETS }; delete missing[key];
    expect(hostedValidationPolicy(missing)).toBeNull();
    for (const value of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1024']) {
      expect(hostedValidationPolicy({ ...BUDGETS, [key]: value })).toBeNull();
    }
  });

  it.each([
    { maxPackageFileBytes: BUDGETS.maxPackageBytes + 1 },
    { maxOriginalBytes: BUDGETS.maxBufferedObjectBytes + 1 },
    { maxVerifyBytes: BUDGETS.maxVerifyBytesPerCaseWindow + 1 },
    { maxVerifyObjects: BUDGETS.maxVerifyObjectsPerCaseWindow + 1 },
    { unknownAllocationFallback: 1 },
  ])('rejects inconsistent/unknown explicit configuration %j', (change) => {
    expect(hostedValidationPolicy({ ...BUDGETS, ...change })).toBeNull();
  });

  it.each([undefined, null, [], {}, 'not json'])('never supplies policy for absent/malformed config %j', (value) => {
    expect(hostedValidationPolicy(value)).toBeNull();
  });

  it('keeps stager construction fail-closed for every invalid storage budget before any protected read', () => {
    const w = world();
    try {
      const before = { statements: w.db.statements, gets: w.bucket.gets };
      for (const key of budgetKeys) expect(() => createHostedCandidateStager({ ...w.config, budgets: { ...w.config.budgets, [key]: 0 } }))
        .toThrow(expect.objectContaining({ code: 'storage-unavailable' }));
      expect({ statements: w.db.statements, gets: w.bucket.gets }).toEqual(before);
    } finally { w.db.sqlite.close(); }
  });
});
