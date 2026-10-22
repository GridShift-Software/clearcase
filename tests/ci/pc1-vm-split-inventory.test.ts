import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { test }: Pick<typeof import('vitest'), 'test'> = await import(testRunner);
const ci = fileURLToPath(new URL('.', import.meta.url));

test('pc1 VM scenarios run in four independently scheduled files', () => {
  for (const name of [
    'pc1-vm-provision-registration.test.ts',
    'pc1-vm-verification.test.ts',
    'pc1-vm-stored-verdicts.test.ts',
    'pc1-vm-github-lifecycle.test.ts',
  ]) assert.ok(existsSync(path.join(ci, name)), `${name} is missing`);
});
