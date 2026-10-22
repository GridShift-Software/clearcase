import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testRunner = process.env.VITEST ? 'vitest' : 'bun:test';
const { test }: Pick<typeof import('vitest'), 'test'> = await import(testRunner);
const app = fileURLToPath(new URL('../..', import.meta.url));

test('every self-hosted workflow job requires the clearcase-pc1 label that verify removes', () => {
  const workflows = path.join(app, '.github/workflows');
  const runsOn = readdirSync(workflows).flatMap((name) => readFileSync(path.join(workflows, name), 'utf8').split('\n').filter((line) => /^\s*runs-on:/.test(line)));
  assert.ok(runsOn.length > 0);
  for (const line of runsOn) assert.match(line, /\bclearcase-pc1\b/, line);
});
