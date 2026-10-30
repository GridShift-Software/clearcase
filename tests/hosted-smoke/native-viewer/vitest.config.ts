// Runs this directory standalone or as the native-viewer project in the root vitest.config.ts.
// Client compilation is test-only; no app build or browser is started.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { compile, compileModule } from 'svelte/compiler';
export default defineConfig({
  tsconfig: fileURLToPath(new URL('./runtime-tsconfig.json', import.meta.url)),
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  plugins: [{ name: 'viewer-client-regressions', transform(source, id) {
    if (id.endsWith('.svelte')) return { code: compile(source, { filename: id, generate: 'client', dev: false }).js.code, map: null };
    // a rune module (`.svelte.ts`) reaches this plugin with its types already stripped
    if (/\.svelte\.[jt]s$/.test(id)) return { code: compileModule(source, { filename: id, generate: 'client', dev: false }).js.code, map: null };
  } }],
  resolve: { alias: [
    { find: /^svelte$/, replacement: fileURLToPath(new URL('../../../node_modules/svelte/src/index-client.js', import.meta.url)) },
    { find: '$lib', replacement: fileURLToPath(new URL('../../../src/lib', import.meta.url)) },
  ] },
  test: { include: ['tests/hosted-smoke/native-viewer/**/*.test.ts'], pool: 'forks', maxWorkers: 1, setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 60_000 },
});
