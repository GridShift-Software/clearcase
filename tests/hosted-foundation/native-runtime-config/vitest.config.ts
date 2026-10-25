import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
// The root config's transform and aliases, because hostedServices reaches the route registry (import.meta.glob of .svelte pages).
export default defineConfig({
	root: fileURLToPath(new URL('../../..', import.meta.url)),
	plugins: [svelte({ configFile: false })],
	resolve: { alias: { $lib: fileURLToPath(new URL('../../../src/lib', import.meta.url)), 'cloudflare:workers': fileURLToPath(new URL('../runtime/cloudflare-workers.ts', import.meta.url)) } },
	test: { include: ['tests/hosted-foundation/native-runtime-config/**/*.test.ts'], maxWorkers: 1, pool: 'forks', setupFiles: ['tests/setup/strip-git-env.ts'], testTimeout: 30_000 },
});
