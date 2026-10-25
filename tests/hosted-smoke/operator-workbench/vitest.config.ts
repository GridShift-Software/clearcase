import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
// Private include replaces the root suite. No browsers, workerd, provider calls or processing.
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { include: ['tests/hosted-smoke/operator-workbench/**/*.test.ts'], maxWorkers: 1, pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 10_000 },
});
