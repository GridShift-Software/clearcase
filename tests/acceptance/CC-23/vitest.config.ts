export default {
  test: {
    include: ['tests/acceptance/CC-23/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
  },
};
