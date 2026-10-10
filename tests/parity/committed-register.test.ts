// A waiver counts only when the reviewed commit holds it. On a clean synthetic checkout holding the parity runner's
// register code and the repository's .gitignore, with a build stamped with its HEAD (so the build is fresh), the
// evidence record is computed as run.mjs computes it (freshness, then runNonEvidence with the files loadRegister read):
// the committed register is evidence; a valid register under docs/reference/parity/.local/ (ignored, so git status is
// clean and the build stays fresh), a fragment a committed .gitignore hides, an untracked fragment and a modified
// register are not, each with a reason naming the file. A parity module found by listing its folder is held to the same.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'parity-committed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const synth = join(root, 'checkout');
const g = (...a: string[]) => {
	const x = spawnSync('git', ['-C', synth, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
	if (x.status !== 0) throw new Error(x.stderr);
	return x.stdout.trim();
};
/** Commit (everything not ignored, unless `all` is false) and stamp a build of the new HEAD, made from a clean tree. */
const commit = (msg: string, all = true) => {
	if (all) g('add', '-A');
	g('commit', '-q', '-m', msg);
	mkdirSync(join(synth, 'build'), { recursive: true });
	writeFileSync(join(synth, 'build', 'handler.js'), '');
	writeFileSync(join(synth, 'build', 'clearcase-build.json'), JSON.stringify({ revision: g('rev-parse', 'HEAD'), dirty: false, buildId: 'synthetic' }));
};
for (const p of ['scripts/parity', 'tests/e2e/pilot/lib', 'docs/reference/parity', 'docs/reference/v5-summary.json', 'src/lib/components/view-registry.ts']) cpSync(join(REPO, p), join(synth, p), { recursive: true });
cpSync(join(REPO, '.gitignore'), join(synth, '.gitignore'));
symlinkSync(join(REPO, 'node_modules'), join(synth, 'node_modules'), 'junction');
g('init', '-q');
commit('synthetic');

/** The evidence record for a run with `--register register` (or the default register), as run.mjs computes it. */
const script = join(root, 'record.mjs');
writeFileSync(script, `import { join, resolve } from 'node:path';
const [synth, register, mode] = process.argv.slice(2);
const r = await import(join(synth, 'scripts', 'parity', 'lib', 'register.mjs'));
const f = await import(join(synth, 'tests', 'e2e', 'pilot', 'lib', 'fresh-build.ts'));
const reg = r.loadRegister(register ? resolve(register) : undefined, { owners: await r.registryOwners(synth), keys: await r.registryKeys(synth) });
const buildDir = join(synth, 'build');
const fresh = f.freshness(synth, f.readStamp(buildDir), { buildDir, appRoot: synth });
const opts = { register: register || undefined, ...(mode === 'loaded' ? { loaded: reg.read } : {}), ...(mode === 'modules' ? { modules: [join(synth, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs')] } : {}) };
console.log(JSON.stringify({ problems: reg.problems, ids: reg.entries.map((e) => e.id), fresh: fresh.fresh, reasons: fresh.reasons, ...f.evidenceRecord(fresh, false, r.runNonEvidence(opts)) }));
`);
const record = (register = '', mode = '') => {
	const x = spawnSync(BUN, [script, synth, register, mode], { encoding: 'utf8', timeout: 60_000 });
	if (x.status !== 0) throw new Error(x.stderr);
	return JSON.parse(x.stdout);
};
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
	test('an untracked fragment, then the same fragment hidden by a committed .gitignore: not evidence either way', () => {
		const frag = join(PARITY, 'register', 'CC-10.json');
		g('rm', '-q', '--cached', 'docs/reference/parity/register/CC-10.json');
		commit('CC-10 untracked', false);
		const untracked = record();
		expect(untracked).toMatchObject({ problems: [], fresh: false, evidence: false });
		expect(untracked.evidenceNote).toContain('register files the run read that the reviewed commit does not hold: docs/reference/parity/register/CC-10.json (untracked)');
		writeFileSync(join(PARITY, 'register', '.gitignore'), 'CC-10.json\n');
		commit('a committed rule hides CC-10');
		// git status is clean and the build fresh, but the loader still reads the hidden fragment
		expect(g('status', '--porcelain')).toBe('');
		expect(readFileSync(frag, 'utf8')).toContain('IDR-038');
		const ignored = record('', 'loaded');
		expect(ignored).toMatchObject({ problems: [], fresh: true, evidence: false });
		expect(ignored.ids).toContain('IDR-038');
		expect(ignored.evidenceNote).toBe('NOT release evidence: register files the run read that the reviewed commit does not hold: docs/reference/parity/register/CC-10.json (ignored)');
	});
	test('a parity module found by listing its folder and hidden by the committed .env.* rule: not evidence', async () => {
		const { moduleFiles } = await import('../../scripts/parity/lib/modules.mjs');
		writeFileSync(join(synth, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs'), 'export default {};\n');
		expect(g('status', '--porcelain')).toBe('');
		// the app adapter loader lists it, so the runner would import it
		expect(moduleFiles(join(synth, 'scripts', 'parity', 'adapters', 'app'))).toContain(join(synth, 'scripts', 'parity', 'adapters', 'app', '.env.local.mjs'));
		expect(record('', 'modules').evidenceNote).toContain('parity modules loaded by file name that the reviewed commit does not hold: scripts/parity/adapters/app/.env.local.mjs (ignored)');
	});
});
