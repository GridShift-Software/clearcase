// Runs this directory alone until the root vitest.config.ts (parent-owned) includes tests/publication/hosted/**/*.test.ts.
// The include list REPLACES the root list; resolution matches the root config.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { include: ['tests/publication/hosted/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
