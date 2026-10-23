import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The identity probe's own tests (GRS-108): the gates on workerd against a crafted issuer (gates.test.ts) and the
// evidence checker (check.test.ts). Neither needs a Clerk key or a network; probe.ts runs the Clerk legs.
export default defineConfig({ test: { include: ['*.test.ts'], pool: 'forks', setupFiles: [fileURLToPath(new URL('../../setup/strip-git-env.ts', import.meta.url))], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } });
