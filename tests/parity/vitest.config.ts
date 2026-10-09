// The parity harness's own suite: `bunx vitest run --config tests/parity/vitest.config.ts`. The root vitest.config.ts
// (coordinator-owned) does not include tests/parity yet; CC-29's report asks for that one-line include.
export default {
	test: {
		include: ['tests/parity/**/*.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
};
