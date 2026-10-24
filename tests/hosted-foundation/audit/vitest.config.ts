// Focused runner for the GRS-116 audit tests while the root vitest.config.ts (coordinator-owned) does not include
// tests/hosted-foundation/audit/**. This list REPLACES the root include; it is not merged with it.
// Requested handoff: add 'tests/hosted-foundation/audit/**/*.test.ts' to the root include list.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { root: fileURLToPath(new URL('../../..', import.meta.url)), include: ['tests/hosted-foundation/audit/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'] },
});
