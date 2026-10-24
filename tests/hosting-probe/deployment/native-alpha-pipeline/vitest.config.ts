import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The checked pipeline's native profile: an explicit private include list that REPLACES the root and deployment lists
// for this run, with no shared setup file because these tests run no git (the deployment list is `*.test.ts`, not recursive, so these files are never in it). Unit only: every
// config, target, artifact and Build Output here is a synthetic fixture, never provider, deploy or funding evidence.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('.', import.meta.url)),
		include: ['native-pipeline-red.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
});
