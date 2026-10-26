import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  resolve: { conditions: ['server'], alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)) } },
  test: { include: ['tests/hosted-foundation/publication-material/**/*.test.ts'], pool: 'forks', maxWorkers: 1,
    setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 15000 },
});
