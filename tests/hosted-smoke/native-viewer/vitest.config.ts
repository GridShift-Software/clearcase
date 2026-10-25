// Runs this directory alone until the root vitest.config.ts (parent-owned) includes tests/hosted-smoke/native-viewer/**/*.test.ts.
// Client compilation and synthetic transport are test-only; no app build or browser is started.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { compile } from 'svelte/compiler';
export default defineConfig({
  tsconfig: fileURLToPath(new URL('./runtime-tsconfig.json', import.meta.url)),
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [{ name: 'viewer-client-regressions', transform(source, id) {
    if (id.endsWith('.svelte')) return { code: compile(source, { filename: id, generate: 'client', dev: false }).js.code, map: null };
  } }],
  resolve: { alias: [
    { find: /^svelte$/, replacement: fileURLToPath(new URL('../../../node_modules/svelte/src/index-client.js', import.meta.url)) },
    { find: '$lib', replacement: fileURLToPath(new URL('../../../src/lib', import.meta.url)) },
    { find: /^\.\/pdf\.min\.mjs$/, replacement: fileURLToPath(new URL('./pdfjs-transport.mjs', import.meta.url)) },
  ] },
  test: { include: ['tests/hosted-smoke/native-viewer/**/*.test.ts'], pool: 'forks', maxWorkers: 1, setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
