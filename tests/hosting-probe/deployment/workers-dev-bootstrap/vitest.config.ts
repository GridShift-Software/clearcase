import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Synthetic file checks only. No Wrangler, workerd, provider or deployment execution.
export default defineConfig({
	test: {
		root: fileURLToPath(new URL('.', import.meta.url)),
		include: ['bootstrap.test.ts'],
		pool: 'forks',
	},
});
