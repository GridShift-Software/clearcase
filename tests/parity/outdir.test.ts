// The runner's output directory never overlaps the read-only fixture: equal, nested, aliased through a symlink, or
// containing it, the output is refused before anything is created or removed, and the fixture's bytes are unchanged.
// A fresh working directory leaves an unrelated existing .work in the output alone. Synthetic trees only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { fixtureInputs, overlap, prepareOutput } from '../../scripts/parity/lib/outdir.mjs';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const root = mkdtempSync(join(tmpdir(), 'parity-outdir-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const caseFolder = join(root, 'case');
put(join(caseFolder, 'synthetic-a.txt'), 'synthetic original A');
put(join(caseFolder, 'sub', 'synthetic-b.txt'), 'synthetic original B');
put(join(caseFolder, '.work', 'synthetic-original.txt'), 'synthetic work file that must survive');
put(join(root, 'v5', 'main.html'), '<p>synthetic</p>');
put(join(root, 'refs', 'examples.json'), '{}');
put(join(root, 'refs', 'inventory.json'), '{}');
symlinkSync(caseFolder, join(root, 'alias'));
symlinkSync(join(caseFolder, 'not-yet'), join(root, 'dangling'));
const fx = { caseFolder, cfg: { mainHtml: { path: join(root, 'v5', 'main.html') }, expectedExamples: { path: join(root, 'refs', 'examples.json') }, references: { inventory: join(root, 'refs', 'inventory.json') } }, summaryPath: join(root, 'refs', 'inventory.json'), packageDir: null };
const inputs = fixtureInputs(fx);

/** Every path and every byte under a directory, symlinks not followed. */
function treeHash(dir: string) {
	const h = createHash('sha256');
	for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }).map((d) => join(d.parentPath, d.name)).sort()) {
		h.update(relative(dir, e) + '\0');
		try { h.update(readFileSync(e)); } catch { h.update('<dir>'); }
		h.update('\0');
	}
	return h.digest('hex');
}

describe('an output overlapping the fixture is refused, with the fixture unchanged', () => {
	const cases: [string, string][] = [
		['equal to the case folder', caseFolder],
		['nested inside the case folder', join(caseFolder, 'sub', 'out')],
		['a symlink alias of the case folder', join(root, 'alias')],
		['nested under a symlink alias', join(root, 'alias', 'out')],
		['a dangling symlink into the case folder', join(root, 'dangling')],
		['containing the case folder', root],
		['the v5 HTML folder', join(root, 'v5', 'out')],
	];
	for (const [what, out] of cases) test(what, () => {
		const before = treeHash(root);
		expect(overlap(out, inputs)).toMatch(/read-only/);
		expect(() => prepareOutput(out, inputs)).toThrow(/read-only/);
		expect(treeHash(root)).toBe(before);
		expect(existsSync(join(caseFolder, '.work', 'synthetic-original.txt'))).toBe(true);
		expect(existsSync(join(caseFolder, 'not-yet'))).toBe(false);
	});
});

describe('a separate output', () => {
	test('a sibling sharing the case folder name as a prefix is allowed', () => {
		expect(overlap(join(root, 'case-out'), inputs)).toBeNull();
	});
	test('a self-parity v5 copy is protected as a file, so the mutation proof may write it next to the output', () => {
		const copy = join(root, 'mut', 'v5-copy.html');
		put(copy, '<p>synthetic copy</p>');
		const withCopy = fixtureInputs(fx, { appV5Html: copy });
		expect(overlap(join(root, 'mut', 'out'), withCopy)).toBeNull();
		expect(overlap(join(root, 'mut'), withCopy)).toMatch(/self-parity v5 HTML/);
	});
	test('an unrelated existing .work in the output survives; each run gets its own working directory', () => {
		const out = join(root, 'out');
		put(join(out, '.work', 'unrelated.txt'), 'unrelated');
		const caseBefore = treeHash(caseFolder);
		const a = prepareOutput(out, inputs), b = prepareOutput(out, inputs);
		expect(a.work).not.toBe(b.work);
		expect(a.work).not.toBe(join(out, '.work'));
		expect(existsSync(a.views)).toBe(true);
		writeFileSync(join(a.work, 'scratch'), 'x');
		rmSync(a.work, { recursive: true, force: true }); // the runner's cleanup
		rmSync(b.work, { recursive: true, force: true });
		expect(readFileSync(join(out, '.work', 'unrelated.txt'), 'utf8')).toBe('unrelated');
		expect(treeHash(caseFolder)).toBe(caseBefore);
	});
});

describe('the runner', () => {
	test('checks the output before its first write, and never clears a fixed .work', () => {
		const src = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		const guard = src.indexOf('prepareOutput(out, fixtureInputs(fx');
		expect(guard).toBeGreaterThan(0);
		for (const call of ['mkdirSync(', 'rmSync(', 'writeFileSync(', 'startServer(', 'v5Package(']) {
			const at = src.indexOf(call, src.indexOf('\n', src.indexOf('import { existsSync')));
			expect(at === -1 || at > guard, call).toBe(true);
		}
		expect(src).not.toMatch(/['"]\.work['"]/);
	});
});
