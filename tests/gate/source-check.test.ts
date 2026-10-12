// scripts/ci/source-check.ts against a disposable Git checkout: a clean tree passes, each deliberate defect fails with
// exit 1 and one `path:line:col: error [rule] message` line naming it, and a tree the check cannot judge exits 2.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ci/source-check.ts');
const SHA = 'a'.repeat(40);
const CLEAN: Record<string, string> = {
	'lib/a.mjs': "import { b } from './b.mjs';\nexport const a = b + 1;\n",
	'lib/b.mjs': 'export const b = 1;\n',
	'run.sh': '#!/bin/bash\nset -eu\necho ok\n',
	'tool.py': 'print("ok")\n',
	'.github/workflows/ci.yml': `on: push\njobs:\n  check:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n      - run: scripts/go.sh\n`,
	'scripts/go.sh': '#!/bin/bash\ntrue\n',
};
const WF = (job: string, steps = '      - run: scripts/go.sh\n') => `on: push\njobs:\n${job}${steps ? `    steps:\n${steps}` : ''}`;
const EXECUTABLE = ['run.sh', 'scripts/go.sh'];

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A Git checkout of CLEAN with `edits` applied (null deletes), then source-check run in it. */
function run(edits: Record<string, string | null> = {}, opts: { git?: boolean } = {}) {
	dir = mkdtempSync(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-source-check-'));
	for (const [file, text] of Object.entries({ ...CLEAN, ...edits })) {
		if (text === null) continue;
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), text);
	}
	for (const f of EXECUTABLE) if (edits[f] !== null) chmodSync(path.join(dir, f), 0o755);
	if (opts.git !== false) {
		const g = (...a: string[]) => spawnSync('git', ['-C', dir!, ...a], { encoding: 'utf8' });
		g('init', '-q');
		g('add', '-A');
	}
	const r = spawnSync(process.execPath, [script, '--json', path.join(dir, 'out.json')], { cwd: dir, encoding: 'utf8' });
	return { status: r.status, out: r.stdout, err: r.stderr, shown: `exit ${r.status}\n${r.stdout}${r.stderr}` };
}

describe('source-check', () => {
	it('passes a clean tree, counting the files of every rule', () => {
		const r = run();
		expect(r.status, r.shown).toBe(0);
		expect(r.out).toContain('source-check: PASS (problems/files: js-syntax 0/2, js-import 0/2, sh-syntax 0/2, py-syntax 0/1, workflow-pin 0/1, workflow-exec 0/1)');
	});

	it.each([
		['a JavaScript syntax error', { 'lib/b.mjs': 'export const b = 1;\nfunction ( {\n' }, 'lib/b.mjs:2:10: error [js-syntax] Expected identifier but found "("'],
		['a relative import of a missing file', { 'lib/a.mjs': "import { b } from './b.mjs';\nexport { c } from './gone.mjs';\n" }, 'lib/a.mjs:2:20: error [js-import] imports ./gone.mjs, which resolves to lib/gone.mjs: not a tracked file'],
		['a dynamic import of a missing file', { 'lib/a.mjs': "export const a = () => import('../nope/x.js');\n" }, 'lib/a.mjs:1:32: error [js-import] imports ../nope/x.js, which resolves to nope/x.js: not a tracked file'],
		['a bash syntax error', { 'run.sh': '#!/bin/bash\nif true; then\necho x\n' }, 'run.sh:4:1: error [sh-syntax] syntax error: unexpected end of file'],
		['a Python syntax error', { 'tool.py': 'def f(:\n    pass\n' }, 'tool.py:1:7: error [py-syntax]'],
		['an action pinned to a tag', { '.github/workflows/ci.yml': 'on: push\njobs:\n  check:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v7\n' }, '.github/workflows/ci.yml:6:15: error [workflow-pin] actions/checkout@v7 is not pinned to a full commit SHA (owner/action@<40 hex>)'],
		['a step that runs a script without the executable bit', { 'scripts/go.sh': null, 'scripts/go2.sh': '#!/bin/bash\ntrue\n', '.github/workflows/ci.yml': CLEAN['.github/workflows/ci.yml']!.replace('scripts/go.sh', 'scripts/go2.sh') }, '.github/workflows/ci.yml:7:14: error [workflow-exec] runs scripts/go2.sh, which is tracked with mode 100644, not 100755'],
		['a step that runs, after an environment assignment, a script without the executable bit', { 'scripts/go.sh': null, 'scripts/go2.sh': '#!/bin/bash\ntrue\n', '.github/workflows/ci.yml': CLEAN['.github/workflows/ci.yml']!.replace('scripts/go.sh', 'X=$tmp scripts/go2.sh') }, '.github/workflows/ci.yml:7:21: error [workflow-exec] runs scripts/go2.sh, which is tracked with mode 100644, not 100755'],
		['a step that runs a script that is not tracked', { 'scripts/go.sh': null }, '.github/workflows/ci.yml:7:14: error [workflow-exec] runs scripts/go.sh, which is not a tracked file'],
	])('fails %s with exit 1 and names it', (_, edits, line) => {
		const r = run(edits);
		expect(r.status, r.shown).toBe(1);
		expect(r.out, r.shown).toContain(line);
		expect(r.out).toMatch(/source-check: FAIL 1 problem\(s\) .*reproduce: bun scripts\/ci\/source-check\.ts\n$/);
	});

	// the pin contract: a step action, a job's reusable workflow and a container image are each a full commit SHA, a
	// sha256 digest or a path in this repository, and a retyped uses is not skipped
	const D = 'b'.repeat(64);
	it.each([
		['a job-level reusable workflow on a branch', WF("  call:\n    uses: someorg/repo/.github/workflows/ci.yml@main\n", ''), '.github/workflows/ci.yml:4:11: error [workflow-pin] someorg/repo/.github/workflows/ci.yml@main is not pinned to a full commit SHA (owner/action@<40 hex>)'],
		['a job-level reusable workflow on a tag', WF("  call:\n    uses: someorg/repo/.github/workflows/ci.yml@v1\n    with:\n      x: 1\n", ''), 'ci.yml@v1 is not pinned'],
		['a job-level reusable workflow on a 39-hex ref', WF(`  call:\n    uses: o/r/.github/workflows/ci.yml@${'a'.repeat(39)}\n`, ''), 'is not pinned to a full commit SHA'],
		['a job-level reusable workflow on an upper-case SHA', WF(`  call:\n    uses: o/r/.github/workflows/ci.yml@${'A'.repeat(40)}\n`, ''), 'is not pinned to a full commit SHA'],
		['a job-level reusable workflow with no ref', WF('  call:\n    uses: o/r/.github/workflows/ci.yml\n', ''), 'o/r/.github/workflows/ci.yml is not pinned to a full commit SHA'],
		['a bare SHA with no action before it', WF(`  call:\n    uses: "@${SHA}"\n`, ''), 'is not pinned to a full commit SHA'],
		['a docker image by tag', WF('  check:\n    runs-on: x\n', '      - uses: docker://alpine:latest\n'), '.github/workflows/ci.yml:6:15: error [workflow-pin] docker://alpine:latest is not pinned to an image digest (docker://image@sha256:<64 hex>)'],
		['a docker image with no tag at all', WF('  check:\n    runs-on: x\n', '      - uses: docker://alpine\n'), 'docker://alpine is not pinned to an image digest'],
		['a docker image with a short digest', WF('  check:\n    runs-on: x\n', '      - uses: docker://alpine@sha256:abc123\n'), 'is not pinned to an image digest'],
		['a docker image with a sha1 digest', WF('  check:\n    runs-on: x\n', `      - uses: docker://alpine@sha1:${'a'.repeat(40)}\n`), 'is not pinned to an image digest'],
		['a docker image with an upper-case digest', WF('  check:\n    runs-on: x\n', `      - uses: docker://alpine@sha256:${'B'.repeat(64)}\n`), 'is not pinned to an image digest'],
		['a docker uses with nothing after the scheme', WF('  check:\n    runs-on: x\n', '      - uses: docker://\n'), 'docker:// is not pinned to an image digest'],
		['a step whose uses is empty', WF('  check:\n    runs-on: x\n', '      - uses:\n'), 'error [workflow-pin] uses must be a string, found null'],
		['a step whose uses is a number', WF('  check:\n    runs-on: x\n', '      - uses: 3\n'), 'error [workflow-pin] uses must be a string, found 3'],
		['a job whose uses is a list', WF('  call:\n    uses:\n      - o/r/.github/workflows/ci.yml@main\n', ''), 'error [workflow-pin] uses must be a string, found ["o/r/.github/workflows/ci.yml@main"]'],
		['an unpinned action in a second job', WF('  check:\n    runs-on: x\n    steps:\n      - run: scripts/go.sh\n  other:\n    runs-on: x\n', `      - uses: actions/checkout@${SHA}\n      - uses: a/b@v1\n`), 'a/b@v1 is not pinned'],
		['an unpinned action in a composite action', { '.github/actions/x/action.yml': 'name: x\nruns:\n  using: composite\n  steps:\n    - uses: a/b@v1\n' }, '.github/actions/x/action.yml:5:13: error [workflow-pin] a/b@v1 is not pinned'],
		['a composite action that runs a script without the executable bit', { 'scripts/plain.sh': '#!/bin/bash\ntrue\n', '.github/actions/x/action.yml': 'name: x\nruns:\n  using: composite\n  steps:\n    - run: scripts/plain.sh\n      shell: bash\n' }, 'error [workflow-exec] runs scripts/plain.sh, which is tracked with mode 100644'],
	] as [string, string | Record<string, string>, string][])('fails %s', (_, edit, line) => {
		const r = run(typeof edit === 'string' ? { '.github/workflows/ci.yml': edit } : edit);
		expect(r.status, r.shown).toBe(1);
		expect(r.out, r.shown).toContain(line);
		expect(r.out).toMatch(/source-check: FAIL 1 problem\(s\) /);
	});

	it.each([
		['a local reusable workflow', WF('  call:\n    uses: ./.github/workflows/other.yml\n', ''), { '.github/workflows/other.yml': WF('  x:\n    runs-on: x\n', '      - run: scripts/go.sh\n') }],
		['a SHA-pinned reusable workflow', WF(`  call:\n    uses: o/r/.github/workflows/ci.yml@${SHA}\n    secrets: inherit\n`, ''), {}],
		['a local action', WF('  check:\n    runs-on: x\n', '      - uses: ./.github/actions/x\n'), {}],
		['a docker image by digest', WF('  check:\n    runs-on: x\n', `      - uses: docker://alpine@sha256:${D}\n`), {}],
		['a docker image by tag and digest', WF('  check:\n    runs-on: x\n', `      - uses: docker://ghcr.io/o/img:1.2@sha256:${D}\n`), {}],
		['a docker image from a registry with a port', WF('  check:\n    runs-on: x\n', `      - uses: docker://localhost:5000/o/img@sha256:${D}\n`), {}],
		['a sub-path action pinned to a SHA', WF('  check:\n    runs-on: x\n', `      - uses: o/r/sub/dir@${SHA}\n`), {}],
		['a composite action whose steps are pinned', WF('  check:\n    runs-on: x\n', '      - uses: ./.github/actions/x\n'), { '.github/actions/x/action.yml': `name: x\nruns:\n  using: composite\n  steps:\n    - uses: a/b@${SHA}\n    - uses: ./.github/actions/y\n` }],
		['a JavaScript composite action, which has no steps', CLEAN['.github/workflows/ci.yml']!, { '.github/actions/x/action.yml': 'name: x\nruns:\n  using: node24\n  main: index.js\n' }],
	] as [string, string, Record<string, string>][])('passes %s', (_, workflow, more) => {
		const r = run({ '.github/workflows/ci.yml': workflow, ...more });
		expect(r.status, r.shown).toBe(0);
		expect(r.out).toContain('source-check: PASS');
	});

	it('writes the same problems as JSON', () => {
		const r = run({ 'tool.py': 'def f(:\n' });
		expect(r.status, r.shown).toBe(1);
		const j = JSON.parse(readFileSync(path.join(dir!, 'out.json'), 'utf8'));
		expect(j).toMatchObject({ schema: 'clearcase-source-check/1', ok: false, problems: [{ rule: 'py-syntax', file: 'tool.py', line: 1 }], counts: { 'py-syntax': { files: 1, problems: 1 } } });
	});

	it('exits 2, not 0, when a rule has no files or the tree is not a Git checkout', () => {
		const none = run({ 'tool.py': null });
		expect(none.status, none.shown).toBe(2);
		expect(none.err).toContain('source-check: ERROR no tracked files for py-syntax: refusing to report a pass over nothing');
		const nogit = run({}, { git: false });
		expect(nogit.status, nogit.shown).toBe(2);
		expect(nogit.err).toMatch(/^source-check: ERROR git rev-parse --show-toplevel failed/);
	});
});
