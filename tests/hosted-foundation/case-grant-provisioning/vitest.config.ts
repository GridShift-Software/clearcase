// Private, bounded runner: no browser, workerd, provider calls or unrelated suites.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['tests/hosted-foundation/case-grant-provisioning/**/*.test.ts'],
    setupFiles: ['tests/setup/strip-git-env.ts'],
    pool: 'forks', maxWorkers: 1, fileParallelism: false,
  },
});
