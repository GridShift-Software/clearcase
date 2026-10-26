// The identity tests (GRS-113) until the root vitest.config.ts collects tests/hosted-foundation/identity/: the root
// config (its $lib and cloudflare:workers aliases, forks pool, setup) with this directory as the only include.
import { fileURLToPath } from 'node:url';
import root from '../../../vitest.config.ts';

export default { ...root, root: fileURLToPath(new URL('../../..', import.meta.url)), test: { ...root.test, include: ['tests/hosted-foundation/identity/**/*.test.ts'], sequence: undefined } };
