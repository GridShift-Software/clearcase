import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The deployment probe's own tests (GRS-107): the trusted parent's target check, the disposable-resource kit, the
// secrets reader and the credential scan. Each file runs in its own process; none needs a network or an account.
export default defineConfig({ test: { include: ['*.test.ts'], pool: 'forks', setupFiles: [fileURLToPath(new URL('../../setup/strip-git-env.ts', import.meta.url))], testTimeout: 120_000 } });
