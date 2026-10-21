// scripts/ci/summary.ts fails the CI test check for every tracked *.test.ts the root Vitest run did not collect
// (summary.ts:81-82, "tracked test file missing from the report"). GRS-108's identity tests were tracked and not
// collected, so CI refused the branch only after a full run. This asks Vitest for its own list of collected files
// (`vitest list`, which runs nothing) and applies the same rule, so a test file that vitest.config.ts does not reach
// fails here, in seconds, before the report does.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error plain .mjs script, no declarations
import { STEPS } from '../../scripts/gate.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('every tracked *.test.ts outside tests/acceptance is collected by the root vitest.config.ts', () => {
	const tracked = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('tests/acceptance/'));
	const listed = execFileSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20 });
	const collected = new Set((JSON.parse(listed.slice(listed.indexOf('['))) as { file: string }[]).map((e) => path.relative(root, e.file)));
	expect(tracked.filter((f) => !collected.has(f))).toEqual([]);
}, 60_000);

// The identity workspace has its own pins and bun.lock (tests/hosting-probe/identity), so a checkout's root install does not
// reach it, and the root test run now builds and serves it. A fresh worktree's gate and the CI job install it first.
test('the gate and the CI job install the identity workspace before their test step', () => {
	const gate = (STEPS as { name: string; cmd: string[] }[]).map((s) => s.name);
	const install = (STEPS as { name: string; cmd: string[] }[]).find((s) => s.cmd.includes('tests/hosting-probe/identity') && s.cmd.includes('--frozen-lockfile'));
	expect(install, 'a gate step that runs bun install --frozen-lockfile in tests/hosting-probe/identity').toBeTruthy();
	expect(gate.indexOf(install!.name)).toBeLessThan(gate.indexOf('test'));
	const { Bun: bun } = globalThis as unknown as { Bun: { YAML: { parse(s: string): { jobs: Record<string, { steps: { name?: string; run?: string }[] }> } } } };
	const steps = bun.YAML.parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')).jobs.check!.steps;
	const at = steps.findIndex((s) => /tests\/hosting-probe\/identity/.test(s.run ?? '') && /bun install --frozen-lockfile/.test(s.run ?? ''));
	expect(at, 'a CI step that runs bun install --frozen-lockfile in tests/hosting-probe/identity').toBeGreaterThan(-1);
	expect(at).toBeLessThan(steps.findIndex((s) => s.name === 'test'));
});
