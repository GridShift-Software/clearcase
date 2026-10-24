import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Real CLI seams, synthetic repositories only. Neither fixture owns the judging tools or their dependencies.
// DEV105 is the explicit old reader; running this file at the red commit must fail the admission expectations.
const ROOT = join(import.meta.dirname, '..', '..');
const DEV105 = '105c4fa8ccf9e5850d082a502ef2705a85d70301';
const TOOLS = join(ROOT, 'scripts/agent-tools');
const MANIFEST = 'docs/acceptance/fix-rounds/synthetic.json';
const REVIEW = 'docs/acceptance/file-reviews/synthetic.json';
const PYTHON = 'tests/custom/test_probe.py';
const TYPESCRIPT = 'tests/custom/probe.test.ts';
const INPUT = 'tests/custom/schema.sql';
const named = (extension: string) => `tests/other.test.${extension}`;
const originalTest = "test('keeps its assertion', () => { expect(1).toBe(1); });\n";
// Runtime regression: these same 70 real-CLI cases must reach their guard oracles via
// `env -u CLEARCASE_NODE bun run --bun test tests/gate/reviewed-python-file-protection.test.ts`.
// A direct external .mjs launch does not reproduce that package launcher's node PATH stand-in.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
	!key.startsWith('GIT_') && !['CLEARCASE_BASE_REF', 'CLEARCASE_RECEIPTS_DIR', 'T3_PSTACK_HARNESS', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_HOME'].includes(key)));
const spaces: string[] = [];
afterEach(() => { for (const ws of spaces.splice(0)) rmSync(ws, { recursive: true, force: true }); });
type Caller = 'test-guard' | 'fix-round-guard';
type Entry = { file: string; revision: string };

class Fixture {
	ws: string;
	repo: string;
	oldTools: string;
	base: string;
	snapshot: string;
	probe: string;
	files: Entry[];
	provenance: {
		schema: string; unit: string; fixBase: string; reviewFindingsSha256: string; reviewedHead: string;
		verdict: string; fresh: boolean; reviewer: string; implementer: string; files: Entry[];
	};
	manifest: {
		schema: string; unit: string; fixBase: string; reviewFindingsSha256: string;
		tests: { file: string; name: string }[];
		protection?: { kind: string; files: Entry[]; review: { file: string; sha256: string } };
		noTests?: { reviewSha: string; reviewFindingsSha256: string; reason: string };
	};

	constructor(probe = PYTHON, weakenBeforeSnapshot?: string) {
		// Ancestors resolve only this checkout's installed dependencies, also for the byte-exact old tool copy.
		mkdirSync(join(ROOT, '.local'), { recursive: true });
		this.ws = mkdtempSync(join(ROOT, '.local/reviewed-python-cli-'));
		spaces.push(this.ws);
		this.repo = join(this.ws, 'repo');
		mkdirSync(this.repo);
		this.oldTools = join(this.ws, 'trusted/scripts/agent-tools');
		mkdirSync(this.oldTools, { recursive: true });
		for (const file of ['test_guard.mjs', 'agent_tools.py', '_common.sh', 'skills.lock.json', 'test-guard', 'fix-round-guard']) {
			const result = spawnSync('git', ['-C', ROOT, 'show', `${DEV105}:scripts/agent-tools/${file}`], { encoding: 'utf8', env: cleanEnv() });
			if (result.status !== 0) throw new Error(result.stderr);
			writeFileSync(join(this.oldTools, file), result.stdout);
			if (file.endsWith('-guard')) chmodSync(join(this.oldTools, file), 0o755);
		}
		this.git('init', '-q', '-b', 'dev');
		this.git('config', 'core.fileMode', 'true');
		this.probe = probe;
		const supportedProbe = probe === TYPESCRIPT;
		this.write(probe, supportedProbe ? originalTest : probe.endsWith('.py')
			? 'import unittest\n\nclass Probe(unittest.TestCase):\n    def test_original(self):\n        self.assertEqual(1, 1)\n' : '#!/bin/sh\ntest 1 = 1\n');
		this.write(INPUT, 'CREATE TABLE cases (id TEXT PRIMARY KEY);\n');
		for (const extension of ['js', 'ts']) this.write(named(extension), originalTest);
		this.write('src/app.ts', 'export const value = 1;\n');
		this.base = this.commit('original runtime review');
		this.write(probe, readFileSync(join(this.repo, probe), 'utf8') + (supportedProbe
			? "test('new regression', () => { expect(2).toBe(2); });\n" : probe.endsWith('.py')
				? '\n    def test_new_regression(self):\n        self.assertEqual(2, 2)\n' : 'test 2 = 2\n'));
		this.write('src/app.ts', 'export const value = 2;\n');
		if (weakenBeforeSnapshot) this.write(weakenBeforeSnapshot, "test('keeps its assertion', () => {});\n");
		this.snapshot = this.commit('fixed runtime and complete custom probe reviewed independently');
		this.files = [probe, INPUT, ...(weakenBeforeSnapshot ? [weakenBeforeSnapshot] : [])].map(file => ({ file, revision: this.snapshot }));
		this.provenance = {
			schema: 'clearcase-file-protection-review/1', unit: 'GRS-104/implementation', fixBase: this.base,
			reviewFindingsSha256: 'a'.repeat(64), reviewedHead: this.snapshot, verdict: 'PASS', fresh: true,
			reviewer: 'synthetic-independent-reviewer', implementer: 'synthetic-worker', files: structuredClone(this.files),
		};
		this.manifest = {
			schema: 'clearcase-fix-round/1', unit: this.provenance.unit, fixBase: this.base,
			reviewFindingsSha256: this.provenance.reviewFindingsSha256, tests: [],
			protection: { kind: 'files', files: structuredClone(this.files), review: { file: REVIEW, sha256: '' } },
		};
	}

	git(...args: string[]) {
		const result = spawnSync('git', ['-C', this.repo, '-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
			'-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: cleanEnv() });
		if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stdout}${result.stderr}`);
		return result.stdout.trim();
	}

	write(file: string, text: string) {
		mkdirSync(dirname(join(this.repo, file)), { recursive: true });
		writeFileSync(join(this.repo, file), text);
	}

	commit(message: string) {
		this.git('add', '-A');
		this.git('commit', '-qm', message);
		return this.git('rev-parse', 'HEAD');
	}

	finish() {
		const bytes = JSON.stringify(this.provenance);
		this.write(REVIEW, bytes);
		if (this.manifest.protection) this.manifest.protection.review.sha256 = createHash('sha256').update(bytes).digest('hex');
		this.write(MANIFEST, JSON.stringify(this.manifest));
		this.commit('synthetic manifest and separate review provenance');
	}

	call(caller: Caller, old = false) {
		const receipts = mkdtempSync(join(this.ws, 'receipts-'));
		const args = caller === 'test-guard' ? ['--fix-base', this.base, '--findings', join(this.repo, MANIFEST)]
			: ['--base', this.base, '--require-manifest'];
		const result = spawnSync(join(old ? this.oldTools : TOOLS, caller), ['--root', this.repo, ...args], {
			cwd: this.repo, encoding: 'utf8', env: { ...cleanEnv(), CLEARCASE_RECEIPTS_DIR: receipts }, timeout: 30_000,
		});
		if (result.error) throw result.error;
		const output = result.stdout + result.stderr;
		const records = readdirSync(receipts).flatMap(dir => {
			const file = join(receipts, dir, 'receipt.json');
			return dir.includes('-test-guard') ? [JSON.parse(readFileSync(file, 'utf8'))] : [];
		});
		expect(records, output).toHaveLength(1);
		expect(records[0].name, output).toBe('test-guard');
		expect(records[0].result, output).toBe(result.status === 0 ? 'PASS' : 'FAIL');
		return { status: result.status, output, receipt: records[0] };
	}

	refuse(caller: Caller, reason: string, old = false) {
		const result = this.call(caller, old);
		expect(result.status, result.output).toBe(1);
		expect(result.output).toContain(`test-guard: FAIL`);
		expect(result.output).toContain(reason);
	}
}

describe.each<Caller>(['test-guard', 'fix-round-guard'])('%s reviewed Python whole-file protection', caller => {
	it('admits only a validated frozen Python snapshot, while explicit DEV105 refuses the same fixture', () => {
		const f = new Fixture();
		f.finish();
		const old = f.call(caller, true);
		expect(old.status, old.output).toBe(1);
		expect(old.output).toContain(`unsupported changed test syntax: ${PYTHON}`);
		const current = f.call(caller);
		expect(current.status, current.output).toBe(0);
		expect(current.output).toContain('file protection: 2 frozen files');
		expect(current.receipt.guard.fixBase).toBe(f.base);
		expect(current.receipt.guard.protection).toEqual(f.manifest.protection);
	});

	it.each(['bytes', 'mode', 'deleted', 'snapshot-file-missing', 'snapshot-missing', 'snapshot-short', 'unlisted-python'])(
		'refuses %s instead of treating a frozen list as a waiver', variant => {
			// Keep the unlisted-Python boundary independent of admission of a different frozen Python file.
			const f = new Fixture(variant === 'unlisted-python' ? TYPESCRIPT : PYTHON);
			if (variant === 'snapshot-file-missing') {
				f.manifest.protection!.files[0].file = 'tests/custom/missing.py';
				f.provenance.files[0].file = 'tests/custom/missing.py';
			} else if (variant === 'snapshot-missing' || variant === 'snapshot-short') {
				const revision = variant === 'snapshot-missing' ? '0'.repeat(40) : f.snapshot.slice(0, 8);
				f.manifest.protection!.files[0].revision = revision;
				f.provenance.files[0].revision = revision;
			}
			f.finish();
			if (variant === 'bytes') f.write(PYTHON, 'assert True\n');
			if (variant === 'mode') chmodSync(join(f.repo, PYTHON), 0o755);
			if (variant === 'deleted') rmSync(join(f.repo, PYTHON));
			if (variant === 'unlisted-python') f.write('tests/custom/test_unlisted.py', 'assert True\n');
			if (['bytes', 'mode', 'deleted', 'unlisted-python'].includes(variant)) f.commit('unreviewed test change');
			const reason = variant === 'unlisted-python'
				? 'unsupported changed test syntax: tests/custom/test_unlisted.py; guard refuses to infer assertion counts' : 'file protection';
			if (variant === 'unlisted-python') f.refuse(caller, reason, true);
			f.refuse(caller, reason);
		});

	it.each(['fresh', 'actor', 'verdict', 'fix-base', 'findings', 'reviewed-head', 'short-list', 'wrong-list', 'reordered-list', 'nonancestor', 'before-base'])(
		'refuses invalid independent provenance: %s', variant => {
			const f = new Fixture();
			if (variant === 'fresh') f.provenance.fresh = false;
			if (variant === 'actor') f.provenance.reviewer = f.provenance.implementer;
			if (variant === 'verdict') f.provenance.verdict = 'FAIL';
			if (variant === 'fix-base') f.provenance.fixBase = f.snapshot;
			if (variant === 'findings') f.provenance.reviewFindingsSha256 = 'b'.repeat(64);
			if (variant === 'reviewed-head') f.provenance.reviewedHead = f.base;
			if (variant === 'short-list') f.manifest.protection!.files.pop();
			if (variant === 'wrong-list') f.provenance.files[0].file = INPUT;
			if (variant === 'reordered-list') f.provenance.files.reverse();
			if (variant === 'nonancestor') {
				f.write('outside.txt', 'not received\n');
				const outside = f.commit('unmerged review head');
				f.git('switch', '-q', '--detach', f.snapshot);
				f.provenance.reviewedHead = outside;
			}
			if (variant === 'before-base') {
				// A valid commit and matching review are not sufficient: snapshots must descend from fixBase.
				f.git('switch', '-q', '--orphan', 'unrelated');
				// switch --orphan already removes tracked files; an empty index is the intended setup.
				expect(f.git('ls-files')).toBe('');
				f.write(PYTHON, 'assert True\n');
				const outside = f.commit('unrelated snapshot');
				f.git('switch', '-q', '--detach', f.snapshot);
				f.manifest.protection!.files[0].revision = outside;
				f.provenance.files[0].revision = outside;
			}
			f.finish();
			f.refuse(caller, variant === 'before-base'
				? 'file protection files must be unique repository paths and full ancestor revisions identical to the separate review'
				: 'file protection');
		});

	it.each(['hash', 'missing-review', 'review-bytes'])('refuses %s after the snapshot binding', variant => {
		const f = new Fixture();
		f.finish();
		if (variant === 'hash') {
			f.manifest.protection!.review.sha256 = 'f'.repeat(64);
			f.write(MANIFEST, JSON.stringify(f.manifest));
		} else if (variant === 'missing-review') rmSync(join(f.repo, REVIEW));
		else f.write(REVIEW, JSON.stringify({ ...f.provenance, reviewer: 'substituted' }));
		f.commit('tampered binding');
		f.refuse(caller, 'file protection');
	});

	it.each(['absent', 'empty', 'mixed-named', 'mixed-noTests', 'noTests', 'named-python'])(
		'keeps declaration semantics: %s', variant => {
			const f = new Fixture();
			if (variant === 'empty') f.manifest.protection!.files = [];
			if (['absent', 'noTests', 'named-python'].includes(variant)) delete f.manifest.protection;
			if (['mixed-named', 'named-python'].includes(variant)) f.manifest.tests = [{ file: PYTHON, name: 'test_original' }];
			if (['mixed-noTests', 'noTests'].includes(variant)) f.manifest.noTests = {
				reviewSha: f.base, reviewFindingsSha256: f.manifest.reviewFindingsSha256, reason: 'synthetic documentation finding',
			};
			f.finish();
			f.refuse(caller, variant === 'absent' ? 'findings.tests must be a nonempty list'
				: variant === 'noTests' ? 'no-test declaration covers a docs-only range'
					: variant === 'named-python' ? 'unsupported protected test syntax' : 'file protection');
		});

	it('still refuses a separately reviewed frozen shell test', () => {
		const f = new Fixture('tests/custom/probe.sh');
		f.finish();
		f.refuse(caller, 'unsupported changed test syntax: tests/custom/probe.sh');
	});

	it.each(['js', 'ts'])('retains %s assertion floors even for separately frozen files', extension => {
		// No changed Python source may shadow the supported-language assertion floor in either reader.
		const f = new Fixture(TYPESCRIPT, named(extension));
		f.finish();
		f.refuse(caller, `assertion count fell in ${named(extension)}: 1 -> 0`, true);
		f.refuse(caller, `assertion count fell in ${named(extension)}: 1 -> 0`);
	});

	it.each(['js', 'ts'])('retains named %s test protection independently of Python support', extension => {
		const f = new Fixture();
		delete f.manifest.protection;
		f.manifest.tests = [{ file: named(extension), name: 'keeps its assertion' }];
		f.write(named(extension), originalTest.replace('.toBe(1)', '.toBeTruthy()'));
		f.finish();
		f.refuse(caller, 'named test changed');
	});

	it.each(['configuration', 'framework-reach'])('retains ordinary %s checks with frozen Python', variant => {
		const f = new Fixture();
		if (variant === 'configuration') f.write('vitest.config.ts', 'export default {};\n');
		else f.write('src/app.ts', 'globalThis.expect = () => true;\n');
		f.finish();
		f.refuse(caller, variant === 'configuration' ? 'protected dependency added/deleted: vitest.config.ts' : 'reaches the test framework');
	});
});
