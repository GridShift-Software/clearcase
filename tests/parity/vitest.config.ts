// The parity harness's own suite alone: `bun --bun x vitest run --config tests/parity/vitest.config.ts`. The root
// vitest.config.ts includes tests/parity too, so `bun run --bun test` runs it with the rest.
export default {
	test: {
		include: ['tests/parity/**/*.test.ts'],
		pool: 'forks',
		setupFiles: ['tests/setup/strip-git-env.ts'], // no test sees an inherited GIT_* variable, as under the root config
		testTimeout: 60_000,
	},
};
