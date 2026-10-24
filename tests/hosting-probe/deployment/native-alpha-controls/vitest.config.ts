import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Native alpha custom-domain controls: an explicit private include list (no shared setup file: these tests run no git or child process), not merged into the root or deployment lists.
// Unit only: every provider state and canary result here is injected data, never provider or network evidence.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('.', import.meta.url)),
		include: ['controls.test.ts'],
		pool: 'forks',
		testTimeout: 30_000,
	},
});
