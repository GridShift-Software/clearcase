// A waiver counts only when the reviewed commit holds it. On a clean synthetic checkout holding the parity runner's
// register code and the repository's .gitignore, with a build stamped with its HEAD (so the build is fresh), the
// evidence record is computed as run.mjs computes it (freshness, then runNonEvidence with the files loadRegister read):
// the committed register is evidence; a valid register under docs/reference/parity/.local/ (ignored, so git status is
// clean and the build stays fresh), a fragment a committed .gitignore hides, an untracked fragment and a modified
// register are not, each with a reason naming the file. A parity module found by listing its folder is held to the same.
// git's index is not trusted for the contents: a register edit a clean filter or a restored mtime hides from git status
// is not evidence (its bytes are not HEAD's blob), and neither is a register read through an ignored symlink or a
// fragment that resolves to a committed file outside docs/reference/parity/. A clean committed register in a linked
// worktree stays evidence. An ignored module that deletes itself once imported is still checked, and is not evidence.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'parity-committed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** Whether this process may create a file symlink: Windows refuses one (EPERM) without Developer Mode or elevation. */
const canSymlink = (() => {
	try { symlinkSync(join(root, 'absent'), join(root, 'symlink-probe'), 'file'); return true; } catch (e) { if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) return false; throw e; }
})();
/** A case that needs a symlink: skipped, with the reason in its title, where the platform refuses to create one. */
const symlinkTest = (name: string, fn: () => void) => (canSymlink ? test(name, fn) : test.skip(`${name} [skipped: this platform refuses to create symlinks]`, fn));

/** The evidence record for a run in checkout `dir` with `--register register` (or the default register), as run.mjs computes it. */
const script = join(root, 'record.mjs');
writeFileSync(script, `import { join, resolve } from 'node:path';
const [synth, register, mode] = process.argv.slice(2);
const r = await import(join(synth, 'scripts', 'parity', 'lib', 'register.mjs'));
const f = await import(join(synth, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'));
const reg = r.loadRegister(register ? resolve(register) : undefined, { owners: await r.registryOwners(synth), keys: await r.registryKeys(synth) });
const buildDir = join(synth, 'build');
const fresh = f.freshness(synth, f.readStamp(buildDir), { buildDir, appRoot: synth });
// 'imported': the app adapters are imported as run.mjs imports them, and the modules checked are the ones it checks
const m = await import(join(synth, 'scripts', 'parity', 'lib', 'modules.mjs'));
const app = join(synth, 'scripts', 'parity', 'adapters', 'app');
if (mode === 'imported') for (const file of m.moduleFiles(app)) await m.importModule(file);
const opts = { register: register || undefined, ...(mode === 'loaded' ? { loaded: reg.read, bytes: reg.bytes } : {}), ...(mode === 'modules' ? { modules: [join(app, '.env.local.mjs')] } : {}), ...(mode === 'imported' ? { modules: m.checkedModules([app]), bytes: Object.fromEntries(m.IMPORTED) } : {}) };
console.log(JSON.stringify({ problems: reg.problems, ids: reg.entries.map((e) => e.id), fresh: fresh.fresh, reasons: fresh.reasons, ...f.evidenceRecord(fresh, false, r.runNonEvidence(opts)) }));
`);

/** A build of `dir`'s HEAD, made from a clean tree, in `dir`/build. */
const stampBuild = (dir: string, head: string) => {
	mkdirSync(join(dir, 'build'), { recursive: true });
	writeFileSync(join(dir, 'build', 'handler.js'), '');
	writeFileSync(join(dir, 'build', 'clearcase-build.json'), JSON.stringify({ revision: head, dirty: false, buildId: 'synthetic' }));
};
/**
 * A clean synthetic checkout in `root`/`name` holding the register code, the guard and the repository's .gitignore, with
 * node_modules linked and a build stamped with its HEAD.
 */
function checkout(name: string) {
	const dir = join(root, name);
	const g = (...a: string[]) => {
		const x = spawnSync('git', ['-C', dir, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
		if (x.status !== 0) throw new Error(x.stderr);
		return x.stdout.trim();
	};
	/** Commit (everything not ignored, unless `all` is false) and stamp a build of the new HEAD, made from a clean tree. */
	const commit = (msg: string, all = true) => {
		if (all) g('add', '-A');
		g('commit', '-q', '-m', msg);
		stampBuild(dir, g('rev-parse', 'HEAD'));
	};
	for (const p of ['scripts/parity', 'tests/e2e', 'docs/reference/parity', 'docs/reference/v5-summary.json', 'src/lib/components/view-registry.ts']) cpSync(join(REPO, p), join(dir, p), { recursive: true });
	cpSync(join(REPO, '.gitignore'), join(dir, '.gitignore'));
	symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
	g('init', '-q');
	commit('synthetic');
	const record = (register = '', mode = '', at = dir) => {
		const x = spawnSync(BUN, [script, at, register, mode], { encoding: 'utf8', timeout: 60_000 });
		if (x.status !== 0) throw new Error(x.stderr);
		return JSON.parse(x.stdout);
	};
	return { dir, g, commit, record, parity: join(dir, 'docs', 'reference', 'parity') };
}
const { dir: synth, g, commit, record } = checkout('checkout');
const PARITY = join(synth, 'docs', 'reference', 'parity');
/** A valid synthetic register: one approved waiver nobody reviewed. */
const waiver = JSON.stringify({ $schema: '../../intentional-differences.schema.json', version: 1, entries: [{ id: 'IDR-990', view: 'chronology', field: 'text.synthetic_override', type: 'improvement', source: 'GRS-13', reason: 'A synthetic local override for the test.', productVisible: false, author: 'synthetic author', approvedBy: 'synthetic reviewer', approvedOn: '2026-10-10' }] }, null, 1);

describe('register files must be committed review inputs', () => {
	test('the committed register, clean, on a fresh build: evidence', () => {
		expect(record()).toMatchObject({ problems: [], fresh: true, evidence: true });
		expect(record('', 'loaded')).toMatchObject({ problems: [], fresh: true, evidence: true });
		expect(record(join(PARITY, 'intentional-differences.json'))).toMatchObject({ fresh: true, evidence: true });
	});
	test("an ignored register under docs/reference/parity/.local/ (the reviewer's path): the build stays fresh, the run is not evidence", () => {
		const file = join(PARITY, '.local', 'audit', 'overrides.json');
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, waiver);
		// the gap: git status is clean, the build is fresh and the register loads with its waiver
		expect(g('status', '--porcelain')).toBe('');
		const reason = 'register files the run read that the reviewed commit does not hold: docs/reference/parity/.local/audit/overrides.json (ignored)';
		for (const mode of ['', 'loaded']) {
			const r = record(file, mode);
			expect(r).toMatchObject({ problems: [], ids: ['IDR-990'], fresh: true, evidence: false });
			expect(r.evidenceNote).toBe(`NOT release evidence: ${reason}`);
		}
		// its own register/ fragments are read and named too
		mkdirSync(join(file, '..', 'register'));
		writeFileSync(join(file, '..', 'register', 'CC-10.json'), JSON.stringify({ version: 1, entries: [] }));
		expect(record(file, 'loaded').evidenceNote).toContain('docs/reference/parity/.local/audit/register/CC-10.json (ignored)');
		rmSync(join(PARITY, '.local'), { recursive: true });
	});
	test('a tracked register modified in the working tree: not evidence (the build is stale too)', () => {
		const file = join(PARITY, 'intentional-differences.json');
		const was = readFileSync(file, 'utf8');
		writeFileSync(file, `${was}\n`);
		const r = record();
		expect(r).toMatchObject({ fresh: false, evidence: false });
		expect(r.reasons).toContain('files are modified or untracked: docs/reference/parity/intentional-differences.json');
		expect(r.evidenceNote).toContain('register files the run read that the reviewed commit does not hold: docs/reference/parity/intentional-differences.json (modified)');
		writeFileSync(file, was);
		expect(record()).toMatchObject({ evidence: true });
	});
	test('an untracked fragment: not evidence (the build is stale too)', () => {
		g('rm', '-q', '--cached', 'docs/reference/parity/register/CC-10.json');
		commit('CC-10 untracked', false);
		const untracked = record();
		expect(untracked).toMatchObject({ problems: [], fresh: false, evidence: false });
		expect(untracked.evidenceNote).toContain('register files the run read that the reviewed commit does not hold: docs/reference/parity/register/CC-10.json (untracked)');
	});
	test('the same fragment hidden by a committed .gitignore: the build stays fresh, the run is not evidence', () => {
		const frag = join(PARITY, 'register', 'CC-10.json');
		expect(g('ls-files', 'docs/reference/parity/register/CC-10.json')).toBe('');
		writeFileSync(join(PARITY, 'register', '.gitignore'), 'CC-10.json\n');
		commit('a committed rule hides CC-10');
		// git status is clean and the build fresh, but the loader still reads the hidden fragment
		expect(g('status', '--porcelain')).toBe('');
		expect(readFileSync(frag, 'utf8')).toContain('IDR-400');
		const ignored = record('', 'loaded');
		expect(ignored).toMatchObject({ problems: [], fresh: true, evidence: false });
		expect(ignored.ids).toContain('IDR-400');
		expect(ignored.evidenceNote).toBe('NOT release evidence: register files the run read that the reviewed commit does not hold: docs/reference/parity/register/CC-10.json (ignored)');
	});
	test('a parity module found by listing its folder and hidden by the committed .env.* rule: not evidence', async () => {
		writeFileSync(join(synth, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs'), 'export default {};\n');
		expect(g('status', '--porcelain')).toBe('');
		expect(record('', 'modules')).toMatchObject({ fresh: true, evidence: false });
		expect(record('', 'modules').evidenceNote).toContain('parity modules loaded by file name that the reviewed commit does not hold: scripts/parity/adapters/app/.env.local.mjs (ignored)');
		// the app adapter loader lists it, so the runner would import it
		const { moduleFiles } = await import('../../scripts/parity/lib/modules.mjs');
		expect(moduleFiles(join(synth, 'scripts', 'parity', 'adapters', 'app'))).toContain(join(synth, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs'));
	});
});

describe("the bytes read must be HEAD's, at the path as given, inside the parity folder", () => {
	const REL = 'docs/reference/parity/register/CC-09.json';
	/** A waiver in CC-09's range, as an owner's fragment entry. */
	const entry = { id: 'IDR-399', view: 'chronology', field: 'text.synthetic_override', type: 'improvement', source: 'GRS-13', reason: 'A synthetic unreviewed waiver for the test.', productVisible: false, author: 'synthetic author', approvedBy: 'synthetic reviewer', approvedOn: '2026-10-10' };
	/** An mtime long before any index write (seconds since the epoch), so git trusts the index entry's stat data. */
	const OLD = 86_400;
	test('a clean committed register in a linked worktree: evidence', () => {
		const c = checkout('linked-main');
		const linked = join(root, 'linked');
		c.g('worktree', 'add', '-q', '--detach', linked);
		symlinkSync(join(REPO, 'node_modules'), join(linked, 'node_modules'), 'junction');
		stampBuild(linked, c.g('rev-parse', 'HEAD'));
		expect(c.record('', 'loaded', linked)).toMatchObject({ problems: [], fresh: true, evidence: true });
		expect(c.record('', '', linked)).toMatchObject({ fresh: true, evidence: true });
	});
	test('a waiver a clean filter hid from the index (git status clean, ls-files H): not evidence', () => {
		const c = checkout('filter');
		const file = join(c.dir, REL);
		const doc = JSON.parse(readFileSync(file, 'utf8'));
		writeFileSync(file, JSON.stringify({ ...doc, entries: [...doc.entries, entry] }, null, 1));
		utimesSync(file, OLD, OLD);
		writeFileSync(join(c.dir, '.git', 'info', 'attributes'), `${REL} filter=hide\n`);
		c.g('config', 'filter.hide.clean', `sh -c 'cat >/dev/null; git cat-file blob HEAD:${REL}'`);
		c.g('add', REL);
		rmSync(join(c.dir, '.git', 'info', 'attributes'));
		c.g('config', '--unset', 'filter.hide.clean');
		expect(c.g('status', '--porcelain')).toBe('');
		expect(c.g('ls-files', '-v', REL)).toBe(`H ${REL}`);
		const reason = `NOT release evidence: register files the run read that the reviewed commit does not hold: ${REL} (its bytes are not HEAD's)`;
		const r = c.record('', 'loaded');
		expect(r).toMatchObject({ problems: [], fresh: true, evidence: false, evidenceNote: reason });
		expect(r.ids).toContain('IDR-399');
		// without the bytes the loader kept, the file is read again: the same
		expect(c.record()).toMatchObject({ evidence: false, evidenceNote: reason });
	});
	test('a same-size edit with its old mtime restored and core.trustctime=false (git status clean): not evidence', () => {
		const c = checkout('stat');
		const file = join(c.dir, REL);
		utimesSync(file, OLD, OLD);
		c.g('update-index', '-q', '--refresh');
		const before = readFileSync(file, 'utf8');
		const at = before.indexOf('"reason": "') + '"reason": "'.length;
		writeFileSync(file, before.slice(0, at) + (before[at] === 'X' ? 'Y' : 'X') + before.slice(at + 1));
		utimesSync(file, OLD, OLD);
		c.g('config', 'core.trustctime', 'false');
		expect(readFileSync(file).length).toBe(Buffer.byteLength(before));
		expect(c.g('status', '--porcelain')).toBe('');
		expect(c.record('', 'loaded')).toMatchObject({ problems: [], fresh: true, evidence: false, evidenceNote: `NOT release evidence: register files the run read that the reviewed commit does not hold: ${REL} (its bytes are not HEAD's)` });
	});
	symlinkTest('ignored symlinks: a --register outside the folder that resolves to the committed register, and a fragment that resolves to a committed fixture: not evidence', () => {
		const c = checkout('symlinks');
		mkdirSync(join(c.dir, 'tests', 'fixtures'), { recursive: true });
		writeFileSync(join(c.dir, 'tests', 'fixtures', 'waiver.json'), JSON.stringify({ version: 1, entries: [entry] }, null, 1));
		c.commit('a committed fixture holding a waiver');
		mkdirSync(join(c.dir, '.local', 'register'), { recursive: true });
		symlinkSync(join(c.parity, 'intentional-differences.json'), join(c.dir, '.local', 'r.json'));
		for (const k of ['CC-04', 'CC-05', 'CC-06', 'CC-07', 'CC-08', 'CC-09', 'CC-10']) symlinkSync(k === 'CC-09' ? join(c.dir, 'tests', 'fixtures', 'waiver.json') : join(c.parity, 'register', `${k}.json`), join(c.dir, '.local', 'register', `${k}.json`));
		expect(c.g('status', '--porcelain')).toBe('');
		const r = c.record(join(c.dir, '.local', 'r.json'), 'loaded');
		expect(r).toMatchObject({ problems: [], fresh: true, evidence: false });
		expect(r.ids).toContain('IDR-399');
		expect(r.evidenceNote).toContain('.local/r.json (outside docs/reference/parity/; ignored; resolves to docs/reference/parity/intentional-differences.json)');
		expect(r.evidenceNote).toContain('.local/register/CC-09.json (outside docs/reference/parity/; ignored; resolves outside docs/reference/parity/, to tests/fixtures/waiver.json)');
	});
	symlinkTest('a committed symlink in the parity folder that resolves to a committed file outside it: not evidence', () => {
		const c = checkout('tracked-symlink');
		mkdirSync(join(c.dir, 'tests', 'fixtures'), { recursive: true });
		writeFileSync(join(c.dir, 'tests', 'fixtures', 'waiver.json'), JSON.stringify({ version: 1, entries: [entry] }, null, 1));
		rmSync(join(c.dir, REL));
		symlinkSync(join('..', '..', '..', '..', 'tests', 'fixtures', 'waiver.json'), join(c.dir, REL));
		c.commit('CC-09 is a symlink');
		expect(c.g('status', '--porcelain')).toBe('');
		const r = c.record('', 'loaded');
		expect(r).toMatchObject({ problems: [], fresh: true, evidence: false });
		expect(r.evidenceNote).toBe(`NOT release evidence: register files the run read that the reviewed commit does not hold: ${REL} (resolves outside docs/reference/parity/, to tests/fixtures/waiver.json; its bytes are not HEAD's)`);
	});
	test('an app adapter hidden by the committed .env.* rule that deletes itself once imported: not evidence', () => {
		const c = checkout('self-deleting');
		expect(c.record('', 'imported')).toMatchObject({ fresh: true, evidence: true });
		const file = join(c.dir, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs');
		writeFileSync(file, "import { unlinkSync } from 'node:fs';\nunlinkSync(new URL(import.meta.url));\nexport default { view: 'chronology', extract: async () => ({}) };\n");
		expect(c.g('status', '--porcelain')).toBe('');
		const r = c.record('', 'imported');
		// the runner imported it, and the folder no longer lists it when the evidence record is written
		expect(existsSync(file)).toBe(false);
		expect(r).toMatchObject({ problems: [], fresh: true, evidence: false, evidenceNote: 'NOT release evidence: parity modules loaded by file name that the reviewed commit does not hold: scripts/parity/adapters/app/.env.local.mjs (untracked)' });
	});
});
