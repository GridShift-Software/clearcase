import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { checkSummary, PROBE_INPUTS } from '../../../deploy/probes/summary-check.ts';

const SCRATCH = path.join(import.meta.dirname, '../../../.local/hosting-probe/deployment', `summary-check-${process.pid}`);
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const SUMMARY = 'docs/acceptance/hosting/evidence/deployment-summary.json';
const DOC = 'docs/acceptance/hosting/deployment.md';

/** A scratch repository that stands for the checkout: the probe's inputs, other people's files, the page and the summary. */
let n = 0;
function repo() {
	const dir = path.join(SCRATCH, `r${++n}`);
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } }).trim();
	const put = (file: string, body: string) => (mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }), writeFileSync(path.join(dir, file), body));
	git('init', '-q', '-b', 'main');
	put('deploy/probes/target.ts', '// target\n');
	put('tests/hosting-probe/deployment/probe.ts', '// probe\n');
	put('tests/e2e/pilot/offline.sh', '#!/bin/sh\n');
	put('src/other.ts', '// not the probe\n');
	put(DOC, '# page\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'the probe');
	const source = git('rev-parse', 'HEAD');
	const inputs = Object.fromEntries(PROBE_INPUTS.map((p) => [p, git('rev-parse', `HEAD:${p}`)]));
	const summary = { schema: 'clearcase.deployment-probe/1', sourceSha: source, treeClean: true, evidence: true, inputs, legs: { P1: { status: 'PASS' }, P2: { status: 'PASS' } } };
	const record = (edit: (s: Record<string, unknown>) => void = () => {}, page = `PASS at ${source}\n`) => {
		const s = structuredClone(summary) as Record<string, unknown>;
		edit(s);
		put(SUMMARY, `${JSON.stringify(s, null, 2)}\n`);
		put(DOC, `# page\n${page}`);
		git('add', '-A');
		git('commit', '-q', '-m', 'docs: the summary and the page');
	};
	const check = () => checkSummary({ repo: dir, summary: path.join(dir, SUMMARY), doc: path.join(dir, DOC) });
	return { dir, git, put, source, record, check };
}

describe('the committed deployment summary is bound to an ancestor commit and to the probe own inputs', () => {
	test('a docs-only commit after the run passes, and the sha stays the run own', () => {
		const r = repo();
		r.record();
		expect(r.check()).toEqual([]);
		expect(JSON.parse(readFileSync(path.join(r.dir, SUMMARY), 'utf8')).sourceSha).toBe(r.source);
		expect(r.git('rev-parse', 'HEAD')).not.toBe(r.source);
	});

	test("a merge of another branch that touches none of the probe's inputs still passes (git merge origin/wave/proofs)", () => {
		const r = repo();
		r.git('branch', 'wave/proofs');
		r.record();
		r.git('checkout', '-q', 'wave/proofs');
		r.put('docs/runtime.md', 'another ticket\n');
		r.put('src/other.ts', '// changed elsewhere\n');
		r.put('deploy/client/wrangler.toml', '# GRS-112\n');
		r.git('add', '-A');
		r.git('commit', '-q', '-m', 'another ticket');
		r.git('checkout', '-q', 'main');
		r.git('merge', '-q', '--no-ff', '-m', 'Merge wave/proofs', 'wave/proofs');
		expect(r.check()).toEqual([]);
	});

	test.each(PROBE_INPUTS.map((p) => [p]))('a change under %s after the run is refused', (input) => {
		const r = repo();
		r.record();
		r.put(input.endsWith('.sh') ? input : `${input}/changed.ts`, '// changed after the run\n');
		r.git('add', '-A');
		r.git('commit', '-q', '-m', 'changed after the run');
		expect(r.check().join('\n')).toMatch(new RegExp(`${input.replace(/\./g, '\\.')} changed since the run`));
	});

	test('a summary whose sha was overwritten with HEAD, over changed inputs, is refused', () => {
		const r = repo();
		r.put('deploy/probes/target.ts', '// changed after the run\n');
		r.git('add', '-A');
		r.git('commit', '-q', '-m', 'changed');
		r.record((s) => (s.sourceSha = r.git('rev-parse', 'HEAD')));
		expect(r.check().join('\n')).toMatch(/inputs recorded in the summary/);
	});

	test('a sha that is not an ancestor of HEAD is refused', () => {
		const r = repo();
		r.git('checkout', '-q', '-b', 'elsewhere');
		r.put('src/other.ts', '// another history\n');
		r.git('add', '-A');
		r.git('commit', '-q', '-m', 'elsewhere');
		const stray = r.git('rev-parse', 'HEAD');
		r.git('checkout', '-q', 'main');
		r.record((s) => (s.sourceSha = stray), `PASS at ${stray}\n`);
		expect(r.check().join('\n')).toMatch(/is not an ancestor of HEAD/);
	});

	test.each([
		['evidence false', (s: Record<string, unknown>) => (s.evidence = false), /evidence is false/],
		['a tree that was not clean', (s: Record<string, unknown>) => (s.treeClean = false), /treeClean is false/],
		['a failed leg', (s: Record<string, unknown>) => (s.legs = { P1: { status: 'FAIL' } }), /leg P1 is FAIL/],
		['no legs', (s: Record<string, unknown>) => (s.legs = {}), /holds no legs/],
		['another schema', (s: Record<string, unknown>) => (s.schema = 'x'), /schema is "x"/],
		['no sha', (s: Record<string, unknown>) => delete s.sourceSha, /sourceSha is missing/],
	])('a hand edit to %s is refused', (_what, edit, reason) => {
		const r = repo();
		r.record(edit);
		expect(r.check().join('\n')).toMatch(reason);
	});

	test('a page that does not name the summary sha is refused', () => {
		const r = repo();
		r.record(undefined, 'PASS at 0000000000000000000000000000000000000000\n');
		expect(r.check().join('\n')).toMatch(/page does not name the summary's sourceSha/);
	});

	test('a missing summary is a problem, not a crash', () => {
		const r = repo();
		expect(r.check().join('\n')).toMatch(/cannot be read/);
	});
});
