import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Synthetic file checks only. No Wrangler, workerd, browser, provider or deployment execution.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('.', import.meta.url)),
		include: ['browser-binding.test.ts', 'input-boundary.test.ts', 'snapshot-consumers.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
});
