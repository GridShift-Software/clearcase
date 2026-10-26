// Focused runner for the NATIVE24 upload-grant tests. A focused config's `include` REPLACES the root vitest.config.ts
// include list (it is not merged with it), so this file runs only tests/hosted-foundation/upload-grant/**. Requested
// handoff: add that glob to the root include list; until then run `vitest run -c` on this file.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { root: fileURLToPath(new URL('../../..', import.meta.url)), include: ['tests/hosted-foundation/upload-grant/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'] },
});
