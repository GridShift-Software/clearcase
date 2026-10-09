// The real runner and the real mutation proof, driven with a synthetic locator: an --out equal to, inside or aliased
// to the synthetic case folder (or holding a symlink planted where they write) exits 2 with the overlap message, and
// the synthetic tree is byte-identical afterwards. The check runs on the raw locator before loadConfig hashes
// anything, so no fixture pin is needed. Synthetic trees only; the aliases mutate.mjs needs live under .local/.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const root = mkdtempSync(join(tmpdir(), 'parity-e2e-'));
mkdirSync(join(REPO, '.local'), { recursive: true });
const local = mkdtempSync(join(REPO, '.local', 'parity-e2e-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(local, { recursive: true, force: true }); });
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const caseFolder = join(root, 'case');
put(join(caseFolder, 'synthetic-a.txt'), 'synthetic original A');
put(join(caseFolder, 'register-crud', 'precious.txt'), 'synthetic file that must survive');
put(join(caseFolder, '.work', 'synthetic-original.txt'), 'synthetic work file that must survive');
put(join(root, 'v5', 'main.html'), '<p>synthetic</p>');
put(join(root, 'refs', 'expected.json'), '{}');
put(join(root, 'refs', 'inventory.json'), '{}');
const zero = '0'.repeat(64), id = `sha256:${zero}`;
const locator = join(root, 'locator.json');
writeFileSync(locator, JSON.stringify({ caseFolder, caseId: 'synthetic', mainHtml: { path: join(root, 'v5', 'main.html'), sha256: zero }, expectedExamples: { path: join(root, 'refs', 'expected.json'), sha256: zero }, references: { inventory: join(root, 'refs', 'inventory.json') }, accepted: { resultsVersion: id, diagnosticsSha256: id } }));
symlinkSync(caseFolder, join(root, 'alias'));
symlinkSync(caseFolder, join(local, 'alias'));

/** Every path, every byte and every link target under a directory, symlinks not followed. */
function treeHash(dir: string) {
	const h = createHash('sha256');
	for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }).map((d) => join(d.parentPath, d.name)).sort()) {
		h.update(relative(dir, e) + '\0');
		const l = lstatSync(e);
		h.update(l.isSymbolicLink() ? 'link' : l.isDirectory() ? '<dir>' : readFileSync(e));
		h.update('\0');
	}
	return h.digest('hex');
}

const tool = (script: string, args: string[]) => spawnSync(process.execPath, [join(REPO, 'scripts', 'parity', script), ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, CLEARCASE_OFFLINE: '' }, timeout: 60_000 });

/** Outputs to refuse: equal to, inside, and aliased to the case folder (for mutate.mjs the alias lies in .local/). */
const outs = (aliasRoot: string): [string, string][] => [
	['equal to the case folder', caseFolder],
	['inside the case folder', join(caseFolder, 'register-crud', 'out')],
	['a symlink alias of the case folder', join(aliasRoot, 'alias')],
	['inside a symlink alias', join(aliasRoot, 'alias', 'out')],
];

describe('run.mjs refuses an --out overlapping the synthetic fixture, before loadConfig, with the tree unchanged', () => {
	for (const [what, out] of outs(root)) test(what, () => {
		const before = treeHash(root);
		const r = tool('run.mjs', ['--view', 'overview', '--fixture-config', locator, '--out', out]);
		expect(r.stderr).toMatch(/parity: setup error: .*read-only case folder.*choose an output directory apart from it/);
		expect(r.status).toBe(2);
		expect(treeHash(root)).toBe(before);
	});
	test('a separate --out whose views folder is a planted symlink to the case folder', () => {
		const out = join(root, 'planted-run');
		mkdirSync(out);
		symlinkSync(caseFolder, join(out, 'views'));
		const before = treeHash(root);
		const r = tool('run.mjs', ['--view', 'overview', '--fixture-config', locator, '--out', out]);
		expect(r.stderr).toMatch(/parity: setup error: .*views.* resolves to .*through a symlink below --out/);
		expect(r.status).toBe(2);
		expect(treeHash(root)).toBe(before);
	});
});

describe('mutate.mjs refuses an --out overlapping the synthetic fixture before any mkdir, rm or write', () => {
	for (const [what, out] of outs(local)) test(what, () => {
		const before = treeHash(root);
		const r = tool('mutate.mjs', ['--fixture-config', locator, '--out', out, '--only', 'register-crud']);
		expect(r.stderr).toMatch(/mutate: setup error: .*read-only case folder.*choose an output directory apart from it/);
		expect(r.status).toBe(2);
		expect(treeHash(root)).toBe(before);
		expect(readFileSync(join(caseFolder, 'register-crud', 'precious.txt'), 'utf8')).toBe('synthetic file that must survive');
	});
	test('a separate --out in .local/ whose mutant folder is a planted symlink into the case folder', () => {
		const out = join(local, 'planted-mutate');
		mkdirSync(out);
		symlinkSync(join(caseFolder, 'register-crud'), join(out, 'register-crud'));
		const before = treeHash(root);
		const r = tool('mutate.mjs', ['--fixture-config', locator, '--out', out, '--only', 'register-crud']);
		expect(r.stderr).toMatch(/mutate: setup error: .*register-crud resolves to .*through a symlink below --out/);
		expect(r.status).toBe(2);
		expect(treeHash(root)).toBe(before);
	});
	test('an --out under .local/ that resolves outside it is refused', () => {
		const out = join(local, 'elsewhere');
		symlinkSync(mkdtempSync(join(root, 'elsewhere-')), out);
		const r = tool('mutate.mjs', ['--fixture-config', locator, '--out', join(out, 'm'), '--only', 'register-crud']);
		expect(r.stderr).toMatch(/--out must lie inside .*\.local\/, symlinks resolved/);
		expect(r.status).toBe(2);
	});
});
