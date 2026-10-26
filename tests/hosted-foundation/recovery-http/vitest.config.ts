import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { root: fileURLToPath(new URL('../../..', import.meta.url)), include: ['tests/hosted-foundation/recovery-http/**/*.test.ts'], pool: 'forks', maxWorkers: 1, testTimeout: 60_000, setupFiles: ['tests/setup/strip-git-env.ts'] },
});
