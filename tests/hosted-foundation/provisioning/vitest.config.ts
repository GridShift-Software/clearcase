// Focused runner for the GRS-114 tenancy tests while the root vitest.config.ts (coordinator-owned) does not yet include
// tests/hosted-foundation/provisioning/**. Requested handoff: add that glob to the root include list.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { root: fileURLToPath(new URL('../../..', import.meta.url)), include: ['tests/hosted-foundation/provisioning/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'] },
});
