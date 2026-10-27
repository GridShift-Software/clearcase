import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { $lib: resolve('src/lib') } },
  test: { include: ['deploy/client/routes/**/records/route.test.ts'], testTimeout: 120_000 },
});
