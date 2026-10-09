// The runner's output directory never overlaps the read-only fixture: equal, nested, aliased through a symlink, or
// containing it, the output is refused before anything is created or removed, and the fixture's bytes are unchanged.
// A fresh working directory leaves an unrelated existing .work in the output alone. A symlink or hard link planted
// below a separate output never leads a write into the fixture, the folders of the fixture's files are protected too,
// and the working directory is removed on SIGINT, SIGTERM and SIGHUP or swept by a later run, which removes only
// directories the runner marked as its own, unkept and of a process that is gone. Synthetic trees only.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { canonical, checkOutput, fixtureInputs, locatorInputs, overlap, prepareOutput, SIGNALS } from '../../scripts/parity/lib/outdir.mjs';
import * as outdir from '../../scripts/parity/lib/outdir.mjs';
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

describe('a symlink or hard link planted below a separate output is refused, with the fixture unchanged', () => {
	const planted: [string, (out: string) => void, string[]][] = [
		['views -> the case folder', (o) => symlinkSync(caseFolder, join(o, 'views')), ['views/overview.json']],
		['scorecard.json -> the inventory', (o) => symlinkSync(join(root, 'refs', 'inventory.json'), join(o, 'scorecard.json')), ['scorecard.json']],
		['views/overview.json -> a case file, inside a real views folder', (o) => { mkdirSync(join(o, 'views')); symlinkSync(join(caseFolder, 'synthetic-a.txt'), join(o, 'views', 'overview.json')); }, ['views/overview.json']],
		['a dangling views -> a new case subfolder', (o) => symlinkSync(join(caseFolder, 'planted'), join(o, 'views')), ['views/overview.json']],
		['register-usage.json hard-linked to a case file', (o) => linkSync(join(caseFolder, 'synthetic-a.txt'), join(o, 'register-usage.json')), ['register-usage.json']],
		['a mutant folder -> the case folder (mutate.mjs)', (o) => symlinkSync(join(caseFolder, 'sub'), join(o, 'register-crud')), ['register-crud']],
	];
	for (const [what, plant, children] of planted) test(what, () => {
		const out = mkdtempSync(join(root, 'planted-'));
		plant(out);
		const before = treeHash(caseFolder), refs = treeHash(join(root, 'refs'));
		expect(overlap(out, inputs)).toBeNull();
		expect(() => checkOutput(out, inputs, children)).toThrow(/symlink below --out|hard links/);
		expect(() => prepareOutput(out, inputs, children)).toThrow(/symlink below --out|hard links/);
		const at = checkOutput(out, inputs);
		expect(() => at(...children[0].split('/'))).toThrow(/symlink below --out|hard links/);
		expect(treeHash(caseFolder)).toBe(before);
		expect(treeHash(join(root, 'refs'))).toBe(refs);
		expect(readdirSync(out).filter((n) => n.startsWith('.work'))).toEqual([]);
	});
	test('a real child resolves to itself and is handed out', () => {
		const out = join(root, 'plain-out');
		const at = checkOutput(out, inputs, ['views/overview.json', 'scorecard.json']);
		expect(at('views', 'overview.json')).toBe(join(out, 'views', 'overview.json'));
	});
});

describe('the folders of the fixture files, the archive and a fixture root are read-only too', () => {
	const fxRoot = join(root, 'fxroot');
	put(join(fxRoot, 'expected', 'expected-examples.json'), '{}');
	put(join(fxRoot, 'inventory', 'tree', 'inventory.json'), '{}');
	put(join(fxRoot, 'raws', 'pack.zip'), 'synthetic zip');
	const locator = { caseFolder, mainHtml: { path: join(root, 'v5', 'main.html') }, expectedExamples: { path: join(fxRoot, 'expected', 'expected-examples.json') }, references: { inventory: join(fxRoot, 'inventory', 'tree', 'inventory.json') }, archive: { path: join(fxRoot, 'raws', 'pack.zip') } };
	test.each([
		['inside the expected-examples folder', join(fxRoot, 'expected', 'o'), /expected examples folder/],
		['inside the inventory folder', join(fxRoot, 'inventory', 'tree', 'o'), /inventory folder/],
		['inside the source archive folder', join(fxRoot, 'raws', 'o'), /source archive folder/],
	])('%s', (_, out, why) => {
		expect(overlap(out, locatorInputs(locator))).toMatch(why);
		expect(overlap(out, fixtureInputs({ caseFolder, cfg: locator }))).toMatch(why);
	});
	test('a sibling folder under a given fixture root', () => {
		expect(overlap(join(fxRoot, 'scratch'), locatorInputs(locator))).toBeNull();
		expect(overlap(join(fxRoot, 'scratch'), locatorInputs({ ...locator, fixtureRoot: fxRoot }))).toMatch(/fixture root/);
	});
});

describe('canonical() resolves a dangling relative symlink as the kernel does', () => {
	test('a link under a symlinked folder resolves against the real folder', () => {
		const t = join(root, 'kern');
		mkdirSync(join(t, 'real', 'case'), { recursive: true });
		mkdirSync(join(t, 'real', 'deep'));
		symlinkSync('../case/newdir', join(t, 'real', 'deep', 'dl'));
		symlinkSync(join(t, 'real', 'deep'), join(t, 'deepalias'));
		expect(canonical(join(t, 'deepalias', 'dl'))).toBe(join(canonical(t), 'real', 'case', 'newdir'));
		expect(overlap(join(t, 'deepalias', 'dl'), [['case folder', join(t, 'real', 'case')]])).toMatch(/inside the read-only case folder/);
	});
});

describe('working directories', () => {
	const dead = () => spawnSync('true').pid as number;
	const marker = (dir: string, m: object) => put(join(dir, '.parity-work.json'), JSON.stringify(m));
	const ours = (pid: number, extra: object = {}) => ({ tool: 'clearcase-parity', pid, startedAt: 1, keep: false, ...extra });
	/** A run in a fresh output holding `entries`; returns what it swept and which entries survived. */
	const run = (name: string, make: (out: string) => string[]) => {
		const out = join(root, name);
		mkdirSync(out, { recursive: true });
		const names = make(out);
		const before = treeHash(caseFolder);
		const r = prepareOutput(out, inputs);
		expect(treeHash(caseFolder)).toBe(before);
		rmSync(r.work, { recursive: true });
		return { swept: r.swept, kept: names.filter((n) => existsSync(join(out, n))), out };
	};
	test('a user directory named like a working directory survives, with its files', () => {
		const { swept, kept, out } = run('sweep-user', (o) => { put(join(o, '.work-backup', 'notes.txt'), 'synthetic user file'); put(join(o, '.work', 'x'), 'x'); return ['.work-backup', '.work']; });
		expect(swept).toEqual([]);
		expect(kept).toEqual(['.work-backup', '.work']);
		expect(readFileSync(join(out, '.work-backup', 'notes.txt'), 'utf8')).toBe('synthetic user file');
	});
	test('an unmarked or unparsable directory of a dead pid survives', () => {
		const p = dead();
		const { swept, kept } = run('sweep-unmarked', (o) => {
			put(join(o, `.work-${p}-abcdef`, 'x'), 'x');
			put(join(o, `.work-${p}-garbag`, '.parity-work.json'), '{not json');
			marker(join(o, `.work-${p}-othert`), { ...ours(p), tool: 'something-else' });
			return [`.work-${p}-abcdef`, `.work-${p}-garbag`, `.work-${p}-othert`];
		});
		expect(swept).toEqual([]);
		expect(kept).toHaveLength(3);
	});
	test('a directory kept with --keep-work survives later runs', () => {
		const p = dead();
		const { swept, kept } = run('sweep-keep', (o) => { marker(join(o, `.work-${p}-KeptAA`), ours(p, { keep: true })); return [`.work-${p}-KeptAA`]; });
		expect(swept).toEqual([]);
		expect(kept).toEqual([`.work-${p}-KeptAA`]);
	});
	test('a live run\'s marked directory survives', () => {
		const { swept, kept } = run('sweep-live', (o) => { marker(join(o, `.work-${process.pid}-LiveAA`), ours(process.pid, { pidStartTime: outdir.pidStartTime?.(process.pid) })); return [`.work-${process.pid}-LiveAA`]; });
		expect(swept).toEqual([]);
		expect(kept).toEqual([`.work-${process.pid}-LiveAA`]);
	});
	test('a marked directory of a dead pid, or of a live pid with another start time (reused), is removed', () => {
		const p = dead(), reused = `.work-${process.pid}-ReusAA`;
		const { swept, kept } = run('sweep-stale', (o) => {
			marker(join(o, `.work-${p}-StaleA`), ours(p));
			put(join(o, `.work-${p}-StaleA`, 'pkg'), 'synthetic');
			marker(join(o, reused), ours(process.pid, { pidStartTime: -1 }));
			return [`.work-${p}-StaleA`, reused];
		});
		expect(swept.sort()).toEqual([`.work-${p}-StaleA`, reused].sort());
		expect(kept).toEqual([]);
	});
	test('a symlink named like a working directory is never followed or removed', () => {
		const p = dead(), target = join(root, 'link-target');
		marker(target, ours(p));
		put(join(target, 'synthetic.txt'), 'synthetic');
		const { swept, kept } = run('sweep-link', (o) => { symlinkSync(target, join(o, `.work-${p}-LinkAA`)); return [`.work-${p}-LinkAA`]; });
		expect(swept).toEqual([]);
		expect(kept).toEqual([`.work-${p}-LinkAA`]);
		expect(readdirSync(target).sort()).toEqual(['.parity-work.json', 'synthetic.txt']);
	});
	test('a marker naming another pid than its directory is not removed', () => {
		const p = dead(), q = dead();
		const { swept, kept } = run('sweep-mismatch', (o) => { marker(join(o, `.work-${p}-MisAAA`), ours(q)); return [`.work-${p}-MisAAA`]; });
		expect(swept).toEqual([]);
		expect(kept).toEqual([`.work-${p}-MisAAA`]);
	});
	test('each run marks its own working directory, recording --keep-work', () => {
		const out = join(root, 'sweep-mark');
		for (const keep of [false, true]) {
			const r = prepareOutput(out, inputs, [], { keep });
			expect(r.work).toMatch(new RegExp(`/\\.work-${process.pid}-[A-Za-z0-9]{6}$`));
			const m = JSON.parse(readFileSync(join(r.work, '.parity-work.json'), 'utf8'));
			expect(m).toMatchObject({ tool: 'clearcase-parity', pid: process.pid, keep });
			expect(typeof m.startedAt).toBe('number');
			expect(m.pidStartTime).toBe(outdir.pidStartTime(process.pid));
			expect(Number.isSafeInteger(m.pidStartTime)).toBe(true);
			rmSync(r.work, { recursive: true });
		}
	});
	test('the runner records --keep-work in the marker', () => {
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8')).toMatch(/prepareOutput\(out, fixtureInputs\(fx, \{ appV5Html \}\), CHILDREN, \{ keep: flag\('keep-work'\) \}\)/);
	});
	for (const [sig, code] of Object.entries(SIGNALS)) test(`${sig} removes this run's working directory and exits ${code}`, async () => {
		const out = join(root, `sig-${sig}`);
		const script = `const m = await import(${JSON.stringify(join(REPO, 'scripts', 'parity', 'lib', 'outdir.mjs'))}); const { work } = m.prepareOutput(${JSON.stringify(out)}, []); require('node:fs').writeFileSync(work + '/pkg', 'synthetic'); m.removeOnExit(work); console.log(work); setInterval(() => {}, 1000);`;
		const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
		const work = await new Promise<string>((res) => p.stdout.once('data', (d) => res(String(d).trim())));
		expect(existsSync(join(work, 'pkg'))).toBe(true);
		const done = new Promise<[number | null, string | null]>((res) => p.on('exit', (c, s) => res([c, s])));
		p.kill(sig as NodeJS.Signals);
		expect(await done).toEqual([code, null]);
		expect(existsSync(work)).toBe(false);
		expect(existsSync(join(out, 'views'))).toBe(true);
	});
});

describe('the runner', () => {
	test('writes every output file through the checked path, and cleans up on signals', () => {
		const src = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		expect(src.match(/writeFileSync\(/g)?.length).toBeGreaterThan(5);
		expect(src.match(/writeFileSync\((?!at\()/g)).toBeNull();
		expect(src).toMatch(/removeOnExit\(work\)/);
		expect(src).not.toMatch(/process\.on\('exit'/);
		const mut = readFileSync(join(REPO, 'scripts', 'parity', 'mutate.mjs'), 'utf8');
		expect(mut.indexOf('checkOutput(out')).toBeLessThan(mut.indexOf('mkdirSync('));
		for (const v of ['dir', 'html', 'src']) expect(mut, v).toMatch(new RegExp(`const ${v} = at\\(m\\.id`));
		expect(mut).not.toMatch(/(writeFileSync|rmSync|mkdirSync)\(join\((out|dir),/);
	});
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
