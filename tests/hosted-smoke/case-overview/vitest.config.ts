// Runs this directory alone until the root vitest.config.ts (parent-owned) includes tests/hosted-smoke/case-overview/**/*.test.ts.
// Same resolution as the root config, plus the Svelte transform for the server-rendered page checks.
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { include: ['tests/hosted-smoke/case-overview/**/*.test.ts'], pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
