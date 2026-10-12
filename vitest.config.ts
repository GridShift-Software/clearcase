import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the Svelte transform and SvelteKit's $lib alias, so a test that reaches a component (an owner's overview widget
  // through the slot registry's import.meta.glob, say) compiles it instead of failing import analysis on the .svelte
  // source or on a $lib import
  plugins: [svelte()],
  resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
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
      'tests/gate/**/*.test.ts',
      'tests/{evidence,analysis,quantum,calculations,registers,litigation,bundles,system}/**/*.test.ts',
      'src/lib/{evidence,analysis,calculations,litigation,bundles,views,user-work}/**/*.test.ts',
      'src/routes/**/*.test.ts',
      'tests/e2e/pilot/**/*.test.ts',
    ],
    pool: 'forks',
    testTimeout: 60_000,
    // each test's line in the JSON report, so scripts/ci/summary.ts can point at a failing test
    includeTaskLocation: true,
  },
});
