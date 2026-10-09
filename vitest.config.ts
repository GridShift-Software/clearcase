import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // GRS-10's package suite, then the pilot's unit tests (storage, import, activation, originals, contracts), the
    // parity harness, the pilot e2e harness's own unit tests, and the M2 owners' write scopes
    // (.orchestration/reservations.tsv, CC-04 to CC-10), so a new owner's tests run without an edit here. Route-level
    // tests (src/routes/**) are collected too, so a test placed next to a route is never silently skipped.
    include: [
      'tests/case-package/**/*.test.ts',
      'src/lib/local-case/**/*.test.ts',
      'src/lib/components/**/*.test.ts',
      'tests/parity/**/*.test.ts',
      'tests/{evidence,analysis,quantum,calculations,registers,litigation,bundles,system}/**/*.test.ts',
      'src/lib/{evidence,analysis,calculations,litigation,bundles,views,user-work}/**/*.test.ts',
      'src/routes/**/*.test.ts',
      'tests/e2e/pilot/**/*.test.ts',
    ],
    pool: 'forks',
    testTimeout: 60_000,
  },
});
