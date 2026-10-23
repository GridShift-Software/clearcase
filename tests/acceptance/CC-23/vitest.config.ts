export default {
  test: {
    include: ['tests/acceptance/CC-23/**/*.test.ts'],
    pool: 'forks',
    setupFiles: ['tests/setup/strip-git-env.ts'], // no test sees an inherited GIT_* variable, as under the root config
    testTimeout: 60_000,
  },
};
