// Parity knows a view is implemented when its owner route exists, whatever the registry status says (it flips only
// after the owner's gate): such a view with no app adapter, or with an adapter returning not-implemented, is an
// extraction error that its whole-view '*' entry does not cover. A synthetic route file in a temp tree; the committed
// register's deadlines_tab entry (IDR-014) is the waiver under test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { classify, diff, runFailures, scorecard, type Entry } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister, REPO } from '../../scripts/parity/lib/register.mjs';
import * as snap from '../../scripts/parity/lib/snapshot.mjs';
import { VIEWS } from '../../src/lib/components/view-registry';
import { implementedViews, routeFile } from '../e2e/pilot/lib/implemented.mjs';
import { base } from './fixtures';

const root = mkdtempSync(join(tmpdir(), 'parity-implemented-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { entries } = loadRegister();
const registry = Object.fromEntries(VIEWS.map((v) => [v.id, v]));
const VIEW = 'deadlines_tab';
const clean = { offline: true, v5NonFileRequests: 0, v5BrowserInternalRequests: 0, appNonLoopbackRequests: 0, canaryHits: 0, canaryBrowserServiceHits: 0, fixtureUnchanged: true };
const run = (sa: any) => {
	const r = classify(VIEW, diff({ ...base('v5'), view: VIEW }, sa), entries, {});
	const sc = scorecard({ [VIEW]: { ...r, v5Status: 'ok', appStatus: sa.status } });
	return { r, failures: runFailures({ ...sc, isolation: clean }, { views: 1 }) };
};

describe('an implemented view (its owner route exists) while the registry still says unavailable', () => {
	const file = routeFile(root, registry[VIEW])!;
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, '<h1>synthetic</h1>\n');
	const implemented = implementedViews(root, VIEWS);

	test('the premise: the registry says unavailable, the committed register waives the whole view, the route exists', () => {
		expect(registry[VIEW].status).toMatch(/^unavailable-until:/);
		expect(entries.find((e: Entry) => e.view === VIEW && e.field === '*')?.id).toBe('IDR-014');
		expect([...implemented]).toEqual([VIEW]);
		// without the route it is still the not-implemented absence the waiver covers
		expect(run(snap.appWithoutAdapter(VIEW, registry, new Set())).r.registered).toMatchObject([{ register: 'IDR-014' }]);
	});
	test('no app adapter: an extraction error naming the adapter to add, not covered by IDR-014, run FAIL', () => {
		const sa = snap.appWithoutAdapter(VIEW, registry, implemented);
		expect(sa).toMatchObject({ status: 'error', error: `${VIEW}'s owner route exists but no app adapter exists: add scripts/parity/adapters/app/${VIEW}.mjs` });
		const { r, failures } = run(sa);
		expect(r.registered).toEqual([]);
		expect(r.unregistered).toMatchObject([{ kind: 'extract-error' }]);
		expect(failures.join('; ')).toMatch(/extraction error/);
	});
	test('an adapter returning not-implemented: an extraction error, not covered by IDR-014, run FAIL', () => {
		const sa = snap.appFromAdapter(VIEW, registry, { ...snap.emptySnapshot(VIEW, 'app', 'not-implemented'), owner: 'GRS-17' }, implemented);
		expect(sa.status).toBe('error');
		const { r, failures } = run(sa);
		expect(r.registered).toEqual([]);
		expect(failures.join('; ')).toMatch(/extraction error/);
		const ok = snap.emptySnapshot(VIEW, 'app', 'ok');
		expect(snap.appFromAdapter(VIEW, registry, ok, implemented)).toBe(ok);
	});
	test('the runner derives the implemented views from the app tree it runs', () => {
		const src = readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8');
		expect(src).toContain('const implemented = implementedViews(appRoot, VIEWS);');
		expect(src).toContain('sa = appWithoutAdapter(view, registry, implemented);');
	});
});
