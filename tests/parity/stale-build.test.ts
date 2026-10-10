// Fresh-build evidence in the parity runner (run.mjs): a build whose stamp is not HEAD's is refused with exit 2 before
// the runner goes offline or reads the locator; --allow-stale-build gets past the refusal (here it then stops at the
// absent synthetic locator) and the scorecard records evidence: false. The override is the flag only: an exported
// CLEARCASE_ALLOW_STALE_BUILD does nothing. An --app-root build is never this repository's build/, so even one stamped
// with HEAD is refused, and so is an --app-root copy whose build/ links to this repository's. A --register FILE outside
// docs/reference/parity/, a register file or listed module that is not committed (committed-register.test.ts), a run
// that compares less than the gate (--no-sweeps, --no-exports, PARITY_MAX_COMBOS) and --app-v5-html (self-parity) make
// the scorecard non-evidence, and the scorecard records the fixture identity. mutate.mjs passes the flag to its own runs.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO, runNonEvidence } from '../../scripts/parity/lib/register.mjs';
import { freshness, readStamp } from '../e2e/pilot/lib/fresh-build.ts';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'parity-stale-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const app = join(root, 'app');
mkdirSync(join(app, 'build'), { recursive: true });
writeFileSync(join(app, 'build', 'handler.js'), '');
writeFileSync(join(app, 'build', 'clearcase-build.json'), JSON.stringify({ revision: '0'.repeat(40), dirty: true, buildId: 'synthetic' }));
const parity = (extra: string[] = [], env: Record<string, string> = {}, appRoot = app) => spawnSync(BUN, [join(REPO, 'scripts', 'parity', 'run.mjs'), '--view', 'overview', '--fixture-config', join(root, 'absent.json'), '--out', join(root, 'out'), '--app-root', appRoot, ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CANARY_PORT: '43899', ...env } });

describe('parity refuses a stale build', () => {
	test('exit 2 naming the reasons, before anything is written', () => {
		const r = parity();
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/parity: setup error: stale build \(the build is of 000000000000, not HEAD [0-9a-f]{12}; the build was made from a tree with modified or untracked files/);
		expect(r.stderr).toMatch(/then rerun \(or pass --allow-stale-build for a non-evidence run\)/);
		expect(() => readFileSync(join(root, 'out', 'scorecard.json'))).toThrow();
	});
	test('--allow-stale-build gets past the refusal; an exported CLEARCASE_ALLOW_STALE_BUILD=1 does not', () => {
		const r = parity(['--allow-stale-build']);
		expect(r.stderr).not.toMatch(/stale build/);
		expect(r.stderr).toMatch(/absent\.json/);
		const env = parity([], { CLEARCASE_ALLOW_STALE_BUILD: '1' });
		expect(env.status).toBe(2);
		expect(env.stderr).toMatch(/setup error: stale build/);
	});
	test('an --app-root build stamped with HEAD, clean, is still refused: it is not this repository\'s build/', () => {
		const copy = join(root, 'copy');
		mkdirSync(join(copy, 'build'), { recursive: true });
		writeFileSync(join(copy, 'build', 'handler.js'), '');
		const head = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
		writeFileSync(join(copy, 'build', 'clearcase-build.json'), JSON.stringify({ revision: head, dirty: false, exported: true, buildId: 'synthetic' }));
		const r = parity([], {}, copy);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`the build is not ${join(REPO, 'build')} (it is ${join(copy, 'build')})`);
	});
	test('an --app-root copy whose build/ links to the repository\'s own fresh build is refused: the app tree is not the repository', () => {
		// a clean synthetic checkout holding this parity runner and what it reads before the guard, with a build stamped
		// with its HEAD, so the app tree is the only reason left
		const synth = mkdtempSync(join(root, 'synth-'));
		const g = (...a: string[]) => { const x = spawnSync('git', ['-C', synth, '-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr); return x.stdout.trim(); };
		for (const p of ['scripts/parity', 'tests/e2e/pilot', 'docs/reference/parity', 'docs/reference/v5-summary.json', 'src/lib/components/view-registry.ts']) cpSync(join(REPO, p), join(synth, p), { recursive: true });
		writeFileSync(join(synth, '.gitignore'), 'build/\nnode_modules\n.local/\n');
		symlinkSync(join(REPO, 'node_modules'), join(synth, 'node_modules'));
		g('init', '-q');
		g('add', '.');
		g('commit', '-q', '-m', 'synthetic');
		mkdirSync(join(synth, 'build'));
		writeFileSync(join(synth, 'build', 'handler.js'), '');
		writeFileSync(join(synth, 'build', 'clearcase-build.json'), JSON.stringify({ revision: g('rev-parse', 'HEAD'), dirty: false, buildId: 'synthetic' }));
		const copy = join(root, 'linked');
		mkdirSync(copy, { recursive: true });
		symlinkSync(join(synth, 'build'), join(copy, 'build'));
		const run = (extra: string[]) => spawnSync(BUN, [join(synth, 'scripts', 'parity', 'run.mjs'), '--view', 'overview', '--fixture-config', join(root, 'absent.json'), '--out', join(root, 'out-linked'), ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CANARY_PORT: '43899' } });
		const r = run(['--app-root', copy]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`parity: setup error: stale build (the app tree under test is ${copy}, not ${synth} (its server entry, suites and routes would be unverified)): git add`);
		// the control: the synthetic checkout and its own build are fresh (the reason list above is exactly the app tree)
		expect(freshness(synth, readStamp(join(synth, 'build')), { buildDir: join(synth, 'build'), appRoot: synth })).toMatchObject({ fresh: true, reasons: [] });
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8')).toContain('freshness(REPO, readStamp(buildDir), { buildDir, appRoot })');
	});
	test('a register outside docs/reference/parity/, v5 self-parity and a run that compares less than the gate are never evidence', () => {
		const dir = join(REPO, 'docs', 'reference', 'parity');
		// `loaded: []`: no register file to check, so these cases do not depend on this worktree's git state
		const none = { loaded: [] };
		expect(runNonEvidence(none)).toEqual([]);
		expect(runNonEvidence({ ...none, register: join(dir, 'intentional-differences.json') })).toEqual([]);
		const local = join(root, 'r.json');
		expect(runNonEvidence({ ...none, register: local })).toEqual([`--register ${local} is not under ${dir}/`]);
		// a path that only starts with the folder's name, or climbs out of it, is outside
		expect(runNonEvidence({ ...none, register: `${dir}-copy/x.json` })).toHaveLength(1);
		expect(runNonEvidence({ ...none, register: join(dir, '..', 'x.json') })).toHaveLength(1);
		expect(runNonEvidence({ ...none, appV5Html: join(root, 'v5.html') })).toEqual(['--app-v5-html compares v5 with a copy of itself (self-parity)']);
		expect(runNonEvidence({ ...none, register: local, appV5Html: 'x' })).toHaveLength(2);
		// without `loaded`, the files --register FILE would read are checked: one outside the checkout is not committed
		expect(runNonEvidence({ register: local })).toEqual([`--register ${local} is not under ${dir}/`, `register files the run read that the reviewed commit does not hold: ${local} (outside the checkout ${REPO})`]);
		expect(runNonEvidence({ ...none, noSweeps: true, noExports: true, maxCombos: '5' })).toEqual(['--no-sweeps skips the interaction sweeps', '--no-exports skips the export capture', 'PARITY_MAX_COMBOS=5 compares only some chronology UI combinations']);
	});
	test('the scorecard carries the evidence record, and mutate.mjs runs its mutants with the override', () => {
		const run = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		expect(run).toContain("const nonEvidence = runNonEvidence({ register: opt('register'), appV5Html, loaded: reg.read, bytes: { ...reg.bytes, ...Object.fromEntries(IMPORTED) }, modules, noSweeps: flag('no-sweeps'), noExports: flag('no-exports'), maxCombos: process.env.PARITY_MAX_COMBOS });");
		// every listed module is imported through importModule, which keeps the bytes it imported
		expect(run).toContain('const a = (await importModule(file)).default;');
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'adapters', 'v5', 'specs.mjs'), 'utf8')).toContain('const spec = (await importModule(join(dir, name))).default;');
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'adapters', 'app', '_shell.mjs'), 'utf8')).toContain('const mod = await importModule(join(dir, f));');
		expect(run).toContain('...evidenceRecord(fresh, allowedStale, nonEvidence),');
		// the modules checked are the ones the three loaders list (they share one listing rule) and the ones they imported
		expect(run).toContain('const modules = checkedModules([APP_ADAPTERS, SPEC_DIR, SLOTS_DIR]);');
		expect(run).toContain('for (const file of moduleFiles(APP_ADAPTERS)) {');
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'adapters', 'v5', 'specs.mjs'), 'utf8')).toContain('const names = moduleFiles(dir).map((f) => basename(f));');
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'adapters', 'app', '_shell.mjs'), 'utf8')).toContain('for (const f of moduleFiles(dir).map((p) => basename(p))) {');
		// the fixture identity the verdict is about
		expect(run).toContain('acceptedResultsVersion: fx.accepted.resultsVersion, baseResultsVersion: fx.acceptedBase.resultsVersion, diagnosticsSha256: fx.accepted.diagnosticsSha256, packageResultsVersion: pkg.manifest.resultsVersion');
		expect(run).toContain('fixture, clock, timezone,');
		// the final status line says NOT EVIDENCE whenever the scorecard's evidence is false
		expect(run).toContain('console.log(`parity: ${sc.result} (exit ${exitCode})${evidenceSuffix(sc)}:');
		expect(run).toContain("`Evidence: ${sc.evidence ? 'yes (a fresh build of clean HEAD)' : `**no**: ${sc.evidenceNote}`}.`");
		const mutate = readFileSync(join(REPO, 'scripts', 'parity', 'mutate.mjs'), 'utf8');
		expect(mutate).toMatch(/'--out', join\(dir, 'out'\), '--allow-stale-build'\]/);
		// each mutant build is stamped as a mutant, so its scorecard says evidence: false
		expect(mutate).toContain("CLEARCASE_SOURCE_REVISION: `mutant:${m.id}@${HEAD}`");
	});
});
