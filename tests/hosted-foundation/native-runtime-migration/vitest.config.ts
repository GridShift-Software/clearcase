import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/hosted-foundation/native-runtime-migration/**/*.test.ts'], maxWorkers: 1, pool: 'forks' } });
