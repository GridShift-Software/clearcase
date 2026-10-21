// scripts/ci/summary.ts fails the CI test check for every tracked *.test.ts the root Vitest run did not collect
// (summary.ts:81-82, "tracked test file missing from the report"). GRS-108's identity tests were tracked and not
// collected, so CI refused the branch only after a full run. This asks Vitest for its own list of collected files
// (`vitest list`, which runs nothing) and applies the same rule, so a test file that vitest.config.ts does not reach
// fails here, in seconds, before the report does.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

test('every tracked *.test.ts outside tests/acceptance is collected by the root vitest.config.ts', () => {
	const tracked = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('tests/acceptance/'));
	const listed = execFileSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 });
	const collected = new Set((JSON.parse(listed.slice(listed.indexOf('['))) as { file: string }[]).map((e) => path.relative(root, e.file)));
	expect(tracked.filter((f) => !collected.has(f))).toEqual([]);
}, 60_000);
