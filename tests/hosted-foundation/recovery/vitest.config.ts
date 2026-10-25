// Focused runner for the native24 recovery tests while the root vitest.config.ts (coordinator-owned) does not include
// tests/hosted-foundation/recovery/**. This list REPLACES the root include; it is not merged with it.
// Requested handoff: add 'tests/hosted-foundation/recovery/**/*.test.ts' to the root include list.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { root: fileURLToPath(new URL('../../..', import.meta.url)), include: ['tests/hosted-foundation/recovery/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'] },
});
