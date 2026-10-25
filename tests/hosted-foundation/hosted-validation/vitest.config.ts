import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['tests/hosted-foundation/hosted-validation/**/*.test.ts'],
    pool: 'forks', maxWorkers: 1,
    setupFiles: ['tests/setup/strip-git-env.ts'],
    testTimeout: 15_000,
  },
});
