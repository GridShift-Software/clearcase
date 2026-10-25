import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../../..', import.meta.url)),
  test: { include: ['tests/publication/hosted/atomic-d1/**/*.test.ts'], pool: 'forks', maxWorkers: 1 },
});
