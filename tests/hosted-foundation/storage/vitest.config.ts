// Runs this directory alone until the root vitest.config.ts (coordinator-owned) includes
// tests/hosted-foundation/storage/**/*.test.ts. Same resolution as the root config; no other setting differs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { include: ['tests/hosted-foundation/storage/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
