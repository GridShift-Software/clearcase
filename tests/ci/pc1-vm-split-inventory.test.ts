import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { test }: Pick<typeof import('vitest'), 'test'> = await import(testRunner);
const ci = fileURLToPath(new URL('.', import.meta.url));

test('pc1 VM scenarios run in four independently scheduled files', () => {
  const names = [
    'pc1-vm-provision-registration.test.ts',
    'pc1-vm-verification.test.ts',
    'pc1-vm-stored-verdicts.test.ts',
    'pc1-vm-github-lifecycle.test.ts',
  ];
  for (const name of names) assert.ok(existsSync(path.join(ci, name)), `${name} is missing`);
  const inventory = JSON.parse(readFileSync(path.join(ci, 'pc1-vm-test-inventory.json'), 'utf8'));
  assert.equal(inventory.scenarioCount, 115);
  assert.deepEqual(inventory.files.map((file: { path: string }) => path.basename(file.path)), names);
  const recorded = inventory.files.flatMap((file: { names: string[] }) => file.names);
  assert.equal(recorded.length, 115);
  assert.equal(new Set(recorded).size, 115);
});
