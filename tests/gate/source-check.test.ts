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
