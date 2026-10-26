// Runs this directory alone until the root vitest.config.ts (parent-owned) includes tests/results-review/native/**/*.test.ts.
// Same resolution as the root config; no other setting differs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)), 'cloudflare:workers': fileURLToPath(new URL('../../hosted-foundation/runtime/cloudflare-workers.ts', import.meta.url)) } },
  test: { include: ['tests/results-review/native/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
