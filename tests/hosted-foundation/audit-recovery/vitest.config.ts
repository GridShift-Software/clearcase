import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    include: ['tests/hosted-foundation/audit-recovery/**/*.test.ts', 'tests/hosted-foundation/audit/**/*.test.ts'],
    pool: 'forks', maxWorkers: 2, setupFiles: ['tests/setup/strip-git-env.ts'],
  },
});
