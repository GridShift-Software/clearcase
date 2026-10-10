// Fresh-build evidence in the parity runner (run.mjs): a build whose stamp is not HEAD's is refused with exit 2 before
// the runner goes offline or reads the locator; --allow-stale-build gets past the refusal (here it then stops at the
// absent synthetic locator) and the scorecard records evidence: false. The override is the flag only: an exported
// CLEARCASE_ALLOW_STALE_BUILD does nothing. An --app-root build is never this repository's build/, so even one stamped
// with HEAD is refused, and so is an --app-root copy whose build/ links to this repository's. A --register FILE outside
// docs/reference/parity/ and --app-v5-html (self-parity) make the scorecard non-evidence. mutate.mjs passes the flag
// to its own runs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO, runNonEvidence } from '../../scripts/parity/lib/register.mjs';

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
	test('an --app-root copy whose build/ links to this repository\'s build/ is refused: the app tree is not the repository', () => {
		const copy = join(root, 'linked');
		mkdirSync(copy, { recursive: true });
		symlinkSync(join(REPO, 'build'), join(copy, 'build'));
		const r = parity([], {}, copy);
		// with no build in this checkout the stamp check is skipped and the run stops at the locator; the guard is the
		// same freshness call either way (tests/e2e/pilot/lib/fresh-build.test.ts covers the reason itself)
		if (existsSync(join(REPO, 'build', 'clearcase-build.json'))) {
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(`the app tree under test is ${copy}, not ${REPO}`);
		}
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8')).toContain('freshness(REPO, readStamp(buildDir), { buildDir, appRoot })');
	});
	test('a register outside docs/reference/parity/ and v5 self-parity are never evidence', () => {
		const dir = join(REPO, 'docs', 'reference', 'parity');
		expect(runNonEvidence({})).toEqual([]);
		expect(runNonEvidence({ register: join(dir, 'intentional-differences.json') })).toEqual([]);
		const local = join(root, 'r.json');
		expect(runNonEvidence({ register: local })).toEqual([`--register ${local} is not under ${dir}/`]);
		// a path that only starts with the folder's name, or climbs out of it, is outside
		expect(runNonEvidence({ register: `${dir}-copy/x.json` })).toHaveLength(1);
		expect(runNonEvidence({ register: join(dir, '..', 'x.json') })).toHaveLength(1);
		expect(runNonEvidence({ appV5Html: join(root, 'v5.html') })).toEqual(['--app-v5-html compares v5 with a copy of itself (self-parity)']);
		expect(runNonEvidence({ register: local, appV5Html: 'x' })).toHaveLength(2);
	});
	test('the scorecard carries the evidence record, and mutate.mjs runs its mutants with the override', () => {
		const run = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		expect(run).toContain("...evidenceRecord(fresh, allowedStale, runNonEvidence({ register: opt('register'), appV5Html })),");
		// the final status line says NOT EVIDENCE whenever the scorecard's evidence is false
		expect(run).toContain('console.log(`parity: ${sc.result} (exit ${exitCode})${evidenceSuffix(sc)}:');
		expect(run).toContain("`Evidence: ${sc.evidence ? 'yes (a fresh build of clean HEAD)' : `**no**: ${sc.evidenceNote}`}.`");
		const mutate = readFileSync(join(REPO, 'scripts', 'parity', 'mutate.mjs'), 'utf8');
		expect(mutate).toMatch(/'--out', join\(dir, 'out'\), '--allow-stale-build'\]/);
		// each mutant build is stamped as a mutant, so its scorecard says evidence: false
		expect(mutate).toContain("CLEARCASE_SOURCE_REVISION: `mutant:${m.id}@${HEAD}`");
	});
});
