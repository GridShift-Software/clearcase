// Runs this directory alone: its include REPLACES the root list. The root vitest.config.ts is the parent's to extend.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  resolve: { alias: { $lib: fileURLToPath(new URL('../../src/lib', import.meta.url)) } },
  test: { include: ['tests/native-alpha-journey/**/*.test.ts'], pool: 'forks', maxWorkers: 1, setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 120_000 },
});
