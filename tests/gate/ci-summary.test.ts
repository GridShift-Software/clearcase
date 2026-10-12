// scripts/ci/summary.ts on synthetic receipts and Vitest reports in a disposable Git checkout: it passes only a
// complete, clean, revision-bound run, and names each other case with its check, location, diagnostic and the command
// that reproduces it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ci/summary.ts');
let dir: string, receipts: string, head: string;
const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim();

beforeEach(() => {
	dir = mkdtempSync(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-ci-summary-'));
	receipts = path.join(dir, 'receipts');
	mkdirSync(path.join(dir, 'tests'), { recursive: true });
	writeFileSync(path.join(dir, 'tests', 'a.test.ts'), '');
	mkdirSync(path.join(dir, 'tests', 'acceptance'), { recursive: true });
	writeFileSync(path.join(dir, 'tests', 'acceptance', 'old.test.ts'), '');
	git('init', '-q');
	git('add', '-A');
	git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture');
	head = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function receipt(name: string, over: { result?: string; exitCode?: number; head?: string; dirty?: boolean | null; stdout?: string } = {}) {
	const folder = path.join(receipts, `20261012T000000.000000Z-${name}`);
	mkdirSync(folder, { recursive: true });
	const exitCode = over.exitCode ?? 0;
	writeFileSync(path.join(folder, 'receipt.json'), JSON.stringify({ name, result: over.result ?? (exitCode ? 'FAIL' : 'PASS'), exitCode, reason: exitCode ? `${name} exit=${exitCode}` : null, command: ['bun', 'run', '--bun', name], durationSeconds: 1.5, revision: { head: over.head ?? head, dirty: over.dirty === undefined ? false : over.dirty } }));
	writeFileSync(path.join(folder, 'stdout.txt'), over.stdout ?? '');
	writeFileSync(path.join(folder, 'stderr.txt'), '');
}
const passed = { fullName: 'a works', status: 'passed', failureMessages: [], location: { line: 3, column: 2 } };
function report(tests: object[] = [passed], files = ['tests/a.test.ts']) {
	const all = tests as { status: string }[];
	writeFileSync(path.join(receipts, 'vitest.json'), JSON.stringify({
		numTotalTests: all.length, numFailedTests: all.filter((t) => t.status === 'failed').length, numPendingTests: all.filter((t) => t.status === 'skipped').length, numTodoTests: 0,
		testResults: files.map((f) => ({ name: path.join(dir, f), status: 'passed', message: '', assertionResults: tests })),
	}));
}
function summary(...checks: string[]) {
	// never the job's own summary: in CI this suite runs under GITHUB_STEP_SUMMARY
	const r = spawnSync(process.execPath, [script, receipts, ...checks], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
	const json = (() => { try { return JSON.parse(readFileSync(path.join(receipts, 'summary.json'), 'utf8')); } catch { return null; } })();
	return { status: r.status, out: r.stdout, json, shown: `exit ${r.status}\n${r.stdout}${r.stderr}` };
}

describe('CI summary', () => {
	it('passes a complete run: both receipts PASS for HEAD, every tracked test file ran (tests/acceptance excepted)', () => {
		receipt('check'); receipt('test'); report();
		const r = summary('check', 'test');
		expect(r.status, r.shown).toBe(0);
		expect(r.out).toContain(`## CI PASS at ${head}`);
		expect(r.out).toContain('Tests: 1 tests in 1 files (1 tracked), 0 failed, 0 skipped.');
		expect(r.json).toMatchObject({ schema: 'clearcase-ci-summary/1', verdict: 'PASS', head, problems: [] });
	});

	it.each([
		['a missing receipt', () => { receipt('check'); report(); }, { check: 'test', where: null, detail: expect.stringMatching(/^no receipt/), reproduce: 'bun run --bun test' }],
		['a receipt for another revision', () => { receipt('check', { head: 'b'.repeat(40) }); receipt('test'); report(); }, { check: 'check', detail: `receipt is for ${'b'.repeat(40)}, the checkout is HEAD` }],
		['a receipt of a dirty tree', () => { receipt('check', { dirty: true }); receipt('test'); report(); }, { check: 'check', detail: 'the tree was dirty when it ran' }],
		['a compiler error', () => { receipt('check', { exitCode: 2, stdout: "src/x.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" }); receipt('test'); report(); },
			{ check: 'check', where: 'src/x.ts:3:7', detail: "TS2322: Type 'string' is not assignable to type 'number'.", reproduce: "'bun' 'run' '--bun' 'check'" }],
		['a svelte-check error', () => { receipt('check', { exitCode: 1, stdout: '1791832549360 ERROR "src/lib/A.svelte" 2:8 "Type \'string\' is not assignable to type \'number\'."\n1791832549361 COMPLETED 1338 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS\n' }); receipt('test'); report(); },
			{ check: 'check', where: 'src/lib/A.svelte:2:8', detail: "ERROR: Type 'string' is not assignable to type 'number'." }],
		['a source-check problem', () => { receipt('check', { exitCode: 1, stdout: 'run.sh:4:1: error [sh-syntax] syntax error: unexpected end of file\n' }); receipt('test'); report(); },
			{ check: 'check', where: 'run.sh:4:1', detail: '[sh-syntax] syntax error: unexpected end of file' }],
		['a failure without a known diagnostic, by the tail of its output', () => { receipt('check', { exitCode: 1, stdout: 'something broke\n' }); receipt('test'); report(); },
			{ check: 'check', where: null, detail: 'FAIL, exit 1: check exit=1\nsomething broke' }],
		['a failed test', () => { receipt('check'); receipt('test', { exitCode: 1 }); report([{ fullName: 'a breaks', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'], location: { line: 9, column: 3 } }]); },
			{ check: 'test', where: 'tests/a.test.ts:9:3', detail: 'a breaks\nAssertionError: expected 1 to be 2', reproduce: "bun run --bun test tests/a.test.ts -t 'a breaks'" }],
		['a skipped test', () => { receipt('check'); receipt('test'); report([passed, { fullName: 'a needs symlinks', status: 'skipped', failureMessages: [] }]); },
			{ check: 'test', detail: 'a needs symlinks: skipped, not run (a skipped test is not evidence)' }],
		['a tracked test file missing from the report', () => { receipt('check'); receipt('test'); report([passed], []); }, { check: 'test', where: 'tests/a.test.ts', detail: expect.stringMatching(/^tracked test file missing from the report/) }],
		['a test file with no test', () => { receipt('check'); receipt('test'); report([], ['tests/a.test.ts']); }, { check: 'test', where: 'tests/a.test.ts', detail: 'no test ran in this file' }],
		['a missing Vitest report', () => { receipt('check'); receipt('test'); }, { check: 'test', detail: expect.stringMatching(/^no Vitest report at /) }],
	])('fails %s with exit 1 and names it', (_, arrange, problem) => {
		arrange();
		const r = summary('check', 'test');
		expect(r.status, r.shown).toBe(1);
		const want = { ...problem, ...(typeof problem.detail === 'string' ? { detail: problem.detail.replace('HEAD', head) } : {}) };
		expect(r.json?.problems, r.shown).toContainEqual(expect.objectContaining(want));
		expect(r.out).toContain(`## CI FAIL at ${head}`);
	});

	it('exits 2 without receipt names', () => {
		expect(summary().status).toBe(2);
	});
});
