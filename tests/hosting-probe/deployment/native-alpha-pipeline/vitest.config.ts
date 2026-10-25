import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The checked pipeline's native profile: an explicit private include list that REPLACES the root and deployment lists
// for this run, with no shared setup file because these tests run no git (the deployment list is `*.test.ts`, not recursive, so these files are never in it). Unit only: every
// config, target, artifact and Build Output here is a synthetic fixture, never provider, deploy or funding evidence.
export default defineConfig({
	test: {
		// Rooted at the deployment probe so the frozen legacy target.test.ts (read only, unchanged) runs beside the native tests.
		root: fileURLToPath(new URL('..', import.meta.url)),
		include: ['target.test.ts', 'native-alpha-pipeline/native-pipeline-red.test.ts', 'native-alpha-pipeline/native-pipeline.test.ts', 'native-alpha-pipeline/native-pipeline-fix-r1.test.ts', 'native-alpha-pipeline/native-bundle-assets-red.test.ts', 'native-alpha-pipeline/native-bundle-contract.test.ts', 'native-alpha-pipeline/native-bundle-enum-red.test.ts', 'native-alpha-pipeline/public-asset-provenance-reviewfix.test.ts', 'native-alpha-pipeline/buffer-host.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
});
