import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Native stage binder: an explicit private include list that replaces the root and deployment lists for this run.
// Real stages are built by the real stageNative and judged by the real checkNativeStage on a real temp directory; the
// provider readback and the clock are injected data, never provider evidence.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('.', import.meta.url)),
		include: ['native-stage-binding.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
});
