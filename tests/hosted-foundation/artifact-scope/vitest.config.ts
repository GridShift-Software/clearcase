import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: { include: ['tests/hosted-foundation/artifact-scope/**/*.test.ts', 'tests/hosted-foundation/runtime/hosted-artifact.test.ts'], pool: 'forks', maxWorkers: 1 },
});
