import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Files that spend most of their run waiting on real SQLite locks and timers, longest first on pc1's CI VM. They start
// first, so that no worker ends the run alone on one: without Vitest's results cache (a fresh checkout, as in CI)
// files run largest first, which put these last. Each file runs in its own process, so order changes nothing else.
const SLOW = ['src/lib/local-case/busy.test.ts', 'tests/bundles/r2-store.test.ts', 'tests/evidence/filings-actions.test.ts', 'tests/gate/gate.test.ts', 'tests/system/restore-lock.test.ts', 'src/lib/local-case/contracts-m2.test.ts', 'tests/registers/actions.test.ts'];
for (const f of SLOW) if (!existsSync(path.join(import.meta.dirname, f))) throw new Error(`vitest.config.ts: SLOW names ${f}, which does not exist`);
class SlowFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    const rank = (f: TestSpecification) => { const i = SLOW.indexOf(path.relative(import.meta.dirname, f.moduleId)); return i < 0 ? SLOW.length : i; };
    return (await super.sort(files)).sort((a, b) => rank(a) - rank(b)); // stable: the rest keep Vitest's order
  }
}

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
      'tests/ci/**/*.test.ts',
      'tests/{evidence,analysis,quantum,calculations,registers,litigation,bundles,system}/**/*.test.ts',
      'src/lib/{evidence,analysis,calculations,litigation,bundles,views,user-work}/**/*.test.ts',
      'src/routes/**/*.test.ts',
      'tests/e2e/pilot/**/*.test.ts',
      'tests/demo/**/*.test.ts',
    ],
    pool: 'forks',
    sequence: { sequencer: SlowFirst },
    testTimeout: 60_000,
    // each test's line in the JSON report, so scripts/ci/summary.ts can point at a failing test
    includeTaskLocation: true,
  },
});
