import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/case-package/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
  },
});
