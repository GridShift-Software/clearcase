// Fresh-build evidence in the parity runner (run.mjs): a build whose stamp is not HEAD's is refused with exit 2 before
// the runner goes offline or reads the locator; --allow-stale-build gets past the refusal (here it then stops at the
// absent synthetic locator) and the scorecard records evidence: false. mutate.mjs passes the flag to its own runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO } from '../../scripts/parity/lib/register.mjs';

const BUN = process.versions.bun ? process.execPath : 'bun';
const root = mkdtempSync(join(tmpdir(), 'parity-stale-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const app = join(root, 'app');
mkdirSync(join(app, 'build'), { recursive: true });
writeFileSync(join(app, 'build', 'handler.js'), '');
writeFileSync(join(app, 'build', 'clearcase-build.json'), JSON.stringify({ revision: '0'.repeat(40), dirty: true, buildId: 'synthetic' }));
const parity = (...extra: string[]) => spawnSync(BUN, [join(REPO, 'scripts', 'parity', 'run.mjs'), '--view', 'overview', '--fixture-config', join(root, 'absent.json'), '--out', join(root, 'out'), '--app-root', app, ...extra], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CANARY_PORT: '43899', CLEARCASE_ALLOW_STALE_BUILD: '' } });

describe('parity refuses a stale build', () => {
	test('exit 2 naming the reasons, before anything is written', () => {
		const r = parity();
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/parity: setup error: refusing a stale build \(the build is of 000000000000, not HEAD [0-9a-f]{12}; the build was made from a tree with modified tracked files/);
		expect(r.stderr).toMatch(/pass --allow-stale-build/);
		expect(() => readFileSync(join(root, 'out', 'scorecard.json'))).toThrow();
	});
	test('--allow-stale-build gets past the refusal', () => {
		for (const r of [parity('--allow-stale-build'), spawnSync(BUN, [join(REPO, 'scripts', 'parity', 'run.mjs'), '--view', 'overview', '--fixture-config', join(root, 'absent.json'), '--out', join(root, 'out'), '--app-root', app], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CANARY_PORT: '43899', CLEARCASE_ALLOW_STALE_BUILD: '1' } })]) {
			expect(r.stderr).not.toMatch(/refusing a stale build/);
			expect(r.stderr).toMatch(/absent\.json/);
		}
	});
	test('the scorecard carries the evidence record, and mutate.mjs runs its mutants with the override', () => {
		const run = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		expect(run).toContain('...evidenceRecord(fresh, allowedStale),');
		expect(run).toContain("`Evidence: ${sc.evidence ? 'yes (a fresh build of clean HEAD)' : `**no**: ${sc.evidenceNote}`}.`");
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'mutate.mjs'), 'utf8')).toMatch(/'--out', join\(dir, 'out'\), '--allow-stale-build'\]/);
	});
});
