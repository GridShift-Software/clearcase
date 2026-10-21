// The CI job's verdict for agents: reads the receipts the check steps wrote and Vitest's JSON report, and writes
// summary.md (also to $GITHUB_STEP_SUMMARY) and summary.json beside them. Each problem names its check, the file and
// line where there is one, the raw diagnostic or the violated contract, and the command that reproduces it.
//
// Usage: bun scripts/ci/summary.ts RECEIPTS_DIR CHECK... (the receipt names that must exist, for example check test)
// Exit 0 only when every named receipt exists for the checked-out HEAD, clean, with PASS and exit 0, and the test
// report lists every tracked test file (tests/acceptance/ excepted, which Vitest never collects) with at least one
// test, none failed and none skipped. Exit 1 otherwise, 2 on a usage error.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs script, no declarations
import { gitEnv } from '../browser-lock.mjs';

type Problem = { check: string; where: string | null; detail: string; reproduce: string };
type Receipt = { name: string; result: string; exitCode: number | null; reason: string | null; command: string[]; durationSeconds: number | null; revision: { head: string | null; dirty: boolean | null } };
type VitestAssertion = { fullName: string; title?: string; ancestorTitles?: string[]; status: string; failureMessages: string[]; location?: { line: number; column: number } };
type VitestReport = { numTotalTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number; testResults: { name: string; status: string; message: string; assertionResults: VitestAssertion[] }[] };

const MAX_LINES = 12;
const clip = (s: string, n = MAX_LINES) => { const l = s.trimEnd().split('\n'); return l.length > n ? [...l.slice(0, n), `… ${l.length - n} more lines in the receipt`].join('\n') : l.join('\n'); };
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : quote(s));
const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** Compiler and checker diagnostics in a failed check's output, as file:line plus the message. */
const DIAGNOSTICS: [RegExp, (m: RegExpMatchArray) => [string, string]][] = [
	[/^(\S[^(\n]*)\((\d+),(\d+)\): error (TS\d+: .*)$/gm, (m) => [`${m[1]}:${m[2]}:${m[3]}`, m[4]!]], // tsc
	[/^\d+ (ERROR|WARNING) "(.+?)" (\d+):(\d+) "(.*)"$/gm, (m) => [`${m[2]}:${m[3]}:${m[4]}`, `${m[1]}: ${m[5]}`]], // svelte-check, machine output off a TTY
	[/^(\S+):(\d+):(\d+): error (\[[\w-]+\] .*)$/gm, (m) => [`${m[1]}:${m[2]}:${m[3]}`, m[4]!]], // source-check
];

function receiptProblems(dir: string, names: string[], head: string): { problems: Problem[]; rows: string[] } {
	const problems: Problem[] = [], rows: string[] = [];
	const found = new Map<string, { receipt: Receipt; folder: string }>();
	for (const f of existsSync(dir) ? readdirSync(dir) : []) {
		const file = path.join(dir, f, 'receipt.json');
		if (!existsSync(file)) continue;
		const receipt: Receipt = JSON.parse(readFileSync(file, 'utf8'));
		found.set(receipt.name, { receipt, folder: path.join(dir, f) });
	}
	for (const name of names) {
		const hit = found.get(name);
		if (!hit) {
			problems.push({ check: name, where: null, detail: 'no receipt: the step did not run (an earlier step failed) or wrote nothing', reproduce: `bun run --bun ${name}` });
			rows.push(`| ${name} | NOT RUN | – | – |`);
			continue;
		}
		const { receipt: r, folder } = hit;
		const cmd = r.command.map(quote).join(' ');
		rows.push(`| ${name} | ${r.result} (exit ${r.exitCode}) | ${r.durationSeconds?.toFixed(1) ?? '–'} s | ${r.revision.head?.slice(0, 12) ?? '–'}${r.revision.dirty ? ' dirty' : ''} |`);
		if (r.revision.head !== head) problems.push({ check: name, where: null, detail: `receipt is for ${r.revision.head}, the checkout is ${head}`, reproduce: cmd });
		if (r.revision.dirty !== false) problems.push({ check: name, where: null, detail: `the tree was ${r.revision.dirty === null ? 'not inspected' : 'dirty'} when it ran`, reproduce: cmd });
		if (r.result === 'PASS' && r.exitCode === 0) continue;
		const out = ['stdout.txt', 'stderr.txt'].map((f) => existsSync(path.join(folder, f)) ? readFileSync(path.join(folder, f), 'utf8') : '').join('\n');
		const diags = DIAGNOSTICS.flatMap(([re, pick]) => [...out.matchAll(re)].map(pick));
		for (const [where, detail] of diags.slice(0, 20)) problems.push({ check: name, where, detail, reproduce: cmd });
		if (!diags.length) problems.push({ check: name, where: null, detail: `${r.result}, exit ${r.exitCode}${r.reason ? `: ${r.reason}` : ''}\n${clip(out.trim().split('\n').slice(-MAX_LINES).join('\n'))}`, reproduce: cmd });
	}
	return { problems, rows };
}

function testProblems(reportFile: string, root: string): { problems: Problem[]; line: string } {
	// Vitest's -t is a regex over the test's names joined with ' > ' (its JSON report's fullName joins them with a space),
	// so the selector is built from the report's own titles, escaped and anchored. Without the titles the whole file runs.
	const select = (a: VitestAssertion) => (a.title && Array.isArray(a.ancestorTitles) ? ` -t ${quote(`^${[...a.ancestorTitles, a.title].map(escapeRegExp).join(' > ')}$`)}` : '');
	const run = (file: string, a?: VitestAssertion) => `bun run --bun test${file ? ` ${shellWord(file)}` : ''}${a ? select(a) : ''}`; // no file: the whole suite, never an empty filter
	if (!existsSync(reportFile)) return { problems: [{ check: 'test', where: null, detail: `no Vitest report at ${reportFile}`, reproduce: run('') }], line: 'no report' };
	const report: VitestReport = JSON.parse(readFileSync(reportFile, 'utf8'));
	const problems: Problem[] = [];
	const ran = new Set<string>();
	for (const file of report.testResults) {
		const rel = path.relative(root, file.name);
		ran.add(rel);
		if (file.assertionResults.length === 0) problems.push({ check: 'test', where: rel, detail: `no test ran in this file${file.message ? `: ${clip(file.message)}` : ''}`, reproduce: run(rel) });
		for (const a of file.assertionResults) {
			if (a.status === 'passed') continue;
			const where = `${rel}${a.location ? `:${a.location.line}:${a.location.column}` : ''}`;
			const detail = a.status === 'failed' ? `${a.fullName}\n${clip(a.failureMessages.join('\n'))}` : `${a.fullName}: ${a.status}, not run (a skipped test is not evidence)`;
			problems.push({ check: 'test', where, detail, reproduce: run(rel, a) });
		}
	}
	const tracked = execFileSync('git', ['ls-files', '*.test.ts'], { cwd: root, encoding: 'utf8', env: gitEnv() }).split('\n').filter((f) => f && !f.startsWith('tests/acceptance/'));
	for (const f of tracked.filter((f) => !ran.has(f))) problems.push({ check: 'test', where: f, detail: 'tracked test file missing from the report: not collected by vitest.config.ts, or it failed to load', reproduce: run(f) });
	if (report.numTotalTests === 0) problems.push({ check: 'test', where: null, detail: 'the report lists no tests', reproduce: run('') });
	const line = `${report.numTotalTests} tests in ${report.testResults.length} files (${tracked.length} tracked), ${report.numFailedTests} failed, ${report.numPendingTests + report.numTodoTests} skipped`;
	return { problems, line };
}

const [dir, ...names] = process.argv.slice(2);
if (!dir || names.length === 0) {
	console.error('usage: bun scripts/ci/summary.ts RECEIPTS_DIR CHECK...');
	process.exit(2);
}
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', env: gitEnv() }).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: gitEnv() }).trim();
const receipts = receiptProblems(dir, names, head);
const tests = names.includes('test') ? testProblems(path.join(dir, 'vitest.json'), root) : { problems: [], line: '' };
const problems = [...receipts.problems, ...tests.problems];
const verdict = problems.length ? 'FAIL' : 'PASS';
const md = [
	`## CI ${verdict} at ${head}`,
	'',
	'| check | result | time | head |',
	'| --- | --- | --- | --- |',
	...receipts.rows,
	...(tests.line ? ['', `Tests: ${tests.line}.`] : []),
	...(problems.length ? ['', `### ${problems.length} problem(s)`, ''] : []),
	...problems.slice(0, 40).flatMap((p) => [`- **${p.check}**${p.where ? ` \`${p.where}\`` : ''}`, '  ```', ...p.detail.split('\n').map((l) => `  ${l}`), '  ```', `  reproduce: \`${p.reproduce}\``]),
	...(problems.length > 40 ? [`- … ${problems.length - 40} more in summary.json`] : []),
].join('\n');
writeFileSync(path.join(dir, 'summary.md'), `${md}\n`);
writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify({ schema: 'clearcase-ci-summary/1', verdict, head, checks: names, tests: tests.line || null, problems }, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
console.log(clip(md, 40));
process.exit(problems.length ? 1 : 0);
