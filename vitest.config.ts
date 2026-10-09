import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // GRS-10's package suite, then the pilot's unit tests (storage, import, activation, originals, contracts).
    include: ['tests/case-package/**/*.test.ts', 'src/lib/local-case/**/*.test.ts', 'src/lib/components/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 60_000,
  },
});
