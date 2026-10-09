// The parity harness's own suite alone: `bunx vitest run --config tests/parity/vitest.config.ts`. The root
// vitest.config.ts includes tests/parity too, so `bun run --bun test` runs it with the rest.
export default {
	test: {
		include: ['tests/parity/**/*.test.ts'],
		pool: 'forks',
		testTimeout: 60_000,
	},
};
