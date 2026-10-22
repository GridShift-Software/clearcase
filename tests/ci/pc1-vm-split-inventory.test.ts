import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { test }: Pick<typeof import('vitest'), 'test'> = await import(testRunner);
const ci = fileURLToPath(new URL('.', import.meta.url));

type Recorded = { path: string; names: string[] };

/** The names a Vitest run collects from `files` under `root`, per file basename, in source order. */
function collectNames(_root: string, _files: string[]): Map<string, string[]> {
  return new Map(); // stub: the red commit
}

/** What differs between the collected names and the recorded ones, file by file, in order. */
function inventoryProblems(collected: Map<string, string[]>, recorded: Recorded[]): string[] {
  const problems: string[] = [];
  for (const file of recorded) {
    const base = path.basename(file.path);
    const actual = collected.get(base) ?? [];
    const missing = file.names.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !file.names.includes(name));
    if (missing.length || extra.length) problems.push(`${base}: missing ${JSON.stringify(missing)}, unrecorded ${JSON.stringify(extra)}`);
    else if (actual.join('\n') !== file.names.join('\n')) problems.push(`${base}: same names in a different order`);
  }
  return problems;
}

const names = [
  'pc1-vm-provision-registration.test.ts',
  'pc1-vm-verification.test.ts',
  'pc1-vm-stored-verdicts.test.ts',
  'pc1-vm-github-lifecycle.test.ts',
];

test('pc1 VM scenarios run in four independently scheduled files', () => {
  for (const name of names) assert.ok(existsSync(path.join(ci, name)), `${name} is missing`);
  const inventory = JSON.parse(readFileSync(path.join(ci, 'pc1-vm-test-inventory.json'), 'utf8'));
  assert.equal(inventory.scenarioCount, 115);
  assert.deepEqual(inventory.files.map((file: { path: string }) => path.basename(file.path)), names);
  const recorded = inventory.files.flatMap((file: { names: string[] }) => file.names);
  assert.equal(recorded.length, 115);
  assert.equal(new Set(recorded).size, 115);
});

test('the four files collect exactly the recorded test names, in order', () => {
  const inventory = JSON.parse(readFileSync(path.join(ci, 'pc1-vm-test-inventory.json'), 'utf8'));
  assert.deepEqual(inventoryProblems(collectNames(path.join(ci, '..', '..'), names), inventory.files), []);
});

test('the inventory check rejects a renamed, skipped, todo, dropped or reordered case', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clearcase-ci-inventory.'));
  try {
    writeFileSync(path.join(dir, 'vitest.config.mjs'), 'export default { test: { globals: true } };\n');
    const recorded = (names: string[]): Recorded[] => [{ path: 'tests/ci/suite.test.ts', names }];
    const suite = (body: string) => writeFileSync(path.join(dir, 'suite.test.ts'), body);
    const problems = (names: string[]) => inventoryProblems(collectNames(dir, ['suite.test.ts']), recorded(names));

    suite("test('one', () => {});\ntest('two', () => {});\ndescribe('group', () => { test('three', () => {}); });\n");
    assert.deepEqual(problems(['one', 'two', 'group > three']), []);
    assert.equal(problems(['two', 'one', 'group > three']).length, 1, 'reordered');
    assert.equal(problems(['one', 'two', 'group > three', 'four']).length, 1, 'dropped');
    suite("test('one', () => {});\ntest('renamed', () => {});\ndescribe('group', () => { test('three', () => {}); });\n");
    assert.equal(problems(['one', 'two', 'group > three']).length, 1, 'renamed');
    suite("test('one', () => {});\ntest.skip('two', () => {});\ndescribe('group', () => { test('three', () => {}); });\n");
    assert.equal(problems(['one', 'two', 'group > three']).length, 1, 'skipped');
    suite("test('one', () => {});\ntest.todo('two');\ndescribe('group', () => { test('three', () => {}); });\n");
    assert.equal(problems(['one', 'two', 'group > three']).length, 1, 'todo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
