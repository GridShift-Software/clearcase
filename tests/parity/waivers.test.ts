// A whole-view not-yet-implemented entry waives only a view the app genuinely does not implement: an extraction error
// on either side (an app adapter that threw, an available view with no adapter, a v5 view that did not extract) is
// never covered and fails the run. Nor is an available view whose adapter returns anything but 'ok', and only a field of
// exactly '*' stands for the whole view. Uses the committed register's `people` entry with synthetic snapshots.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classify, covering, diff, runFailures, scorecard, type Entry } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister, REPO } from '../../scripts/parity/lib/register.mjs';
import * as snap from '../../scripts/parity/lib/snapshot.mjs';
import { VIEWS } from '../../src/lib/components/view-registry';
import { base } from './fixtures';

const { entries } = loadRegister();
const whole = entries.find((e: Entry) => e.view === 'people' && e.field === '*' && e.type === 'not-yet-implemented') as Entry;
const registry = Object.fromEntries(VIEWS.map((v) => [v.id, v]));
const clean = { offline: true, v5NonFileRequests: 0, v5BrowserInternalRequests: 0, appNonLoopbackRequests: 0, canaryHits: 0, canaryBrowserServiceHits: 0, fixtureUnchanged: true };
const v5 = () => ({ ...base('v5'), view: 'people' });

/** What the runner does with one view's pair of snapshots: classify, score and decide the run. */
function run(s5: any, sa: any) {
	const r = classify('people', diff(s5, sa), entries, {});
	const sc = scorecard({ people: { ...r, v5Status: s5.status, appStatus: sa.status } });
	return { r, sc, failures: runFailures({ ...sc, isolation: clean }, { views: 1 }) };
}

describe('extraction errors are never waived', () => {
	test('the committed register has a whole-view entry for people (the waiver under test)', () => {
		expect(whole?.id).toBeTruthy();
	});
	test('an app adapter that threw, under the whole-view waiver: unregistered, view FAIL, run FAIL', () => {
		const { r, sc, failures } = run(v5(), { ...snap.emptySnapshot('people', 'app', 'error'), error: 'synthetic adapter crash' });
		expect(r.registered).toEqual([]);
		expect(r.unregistered).toMatchObject([{ kind: 'extract-error' }]);
		expect(sc.views.people.status).toBe('FAIL');
		expect(sc.result).toBe('FAIL');
		expect(failures.join('; ')).toMatch(/extraction error/);
	});
	test('an available view without an app adapter, under the whole-view waiver: run FAIL', () => {
		const sa = snap.appWithoutAdapter('people', { ...registry, people: { ...registry.people, status: 'available' } });
		expect(sa.status).toBe('error');
		expect(snap.appWithoutAdapter('people', registry)).toMatchObject({ status: 'not-implemented', owner: registry.people.linear });
		const { r, sc, failures } = run(v5(), sa);
		expect(r.registered).toEqual([]);
		expect(sc.views.people.status).toBe('FAIL');
		expect(failures.length).toBeGreaterThan(0);
	});
	test('a v5 view that did not extract, under the whole-view waiver: run FAIL', () => {
		const { r, sc, failures } = run({ ...snap.emptySnapshot('people', 'v5', 'error'), error: 'synthetic' }, snap.emptySnapshot('people', 'app', 'not-implemented'));
		expect(r.registered).toEqual([]);
		expect(sc.result).toBe('FAIL');
		expect(failures.length).toBeGreaterThan(0);
	});
	test('a whole-view entry matches only kind view-not-implemented, whatever the path', () => {
		expect(covering(entries, 'people', { path: '*', kind: 'extract-error', v5: 'view', app: 'error' })).toBeNull();
		expect(covering(entries, 'people', { path: '*', kind: 'value', v5: 'a', app: 'b' })).toBeNull();
		expect(covering([{ ...whole, field: '**' }], 'people', { path: '!app', kind: 'extract-error', v5: 'view', app: 'error' })).toBeNull();
	});
	test('an available view whose app adapter returns status not-implemented: an extraction error, run FAIL', () => {
		const available = { ...registry, people: { ...registry.people, status: 'available' } };
		const sa = snap.appFromAdapter('people', available, { ...snap.emptySnapshot('people', 'app', 'not-implemented'), owner: registry.people.linear });
		expect(sa.status).toBe('error');
		const { r, sc, failures } = run(v5(), sa);
		expect(r.registered).toEqual([]);
		expect(sc.views.people.status).toBe('FAIL');
		expect(sc.total.viewsExtractError).toBe(1);
		expect(failures.join('; ')).toMatch(/extraction error/);
		for (const status of ['partial', '', 'not-implemented ']) expect(snap.appFromAdapter('people', available, snap.emptySnapshot('people', 'app', status as any)).status).toBe('error');
		const ok = snap.emptySnapshot('people', 'app', 'ok'), thrown = { ...snap.emptySnapshot('people', 'app', 'error'), error: 'synthetic' };
		expect(snap.appFromAdapter('people', available, ok)).toBe(ok);
		expect(snap.appFromAdapter('people', available, thrown)).toBe(thrown);
		const absent = snap.emptySnapshot('people', 'app', 'not-implemented');
		expect(snap.appFromAdapter('people', registry, absent)).toBe(absent);
	});
	test('the runner passes every app adapter snapshot through appFromAdapter', () => {
		expect(readFileSync(join(REPO, 'scripts', 'parity', 'run.mjs'), 'utf8')).toMatch(/sa = appFromAdapter\(view, registry, sa, implemented\)/);
	});
	test('a whole-view absence is covered only by a field of exactly the string *, not by ?, **, *? or [*]', () => {
		const d = { path: '*', kind: 'view-not-implemented', v5: 'view', app: '<absent>' };
		expect(covering([whole], 'people', d)?.id).toBe(whole.id);
		for (const field of ['?', '**', '*?', ['*'], ['?'], ['text.*', '*']]) expect(covering([{ ...whole, field } as Entry], 'people', d), JSON.stringify(field)).toBeNull();
		expect(covering([{ ...whole, field: ['*', 'text.x'] } as Entry], 'people', { path: 'kpi.y.value', kind: 'value', v5: 'a', app: 'b' })).toBeNull();
		const { failures } = run(v5(), { ...snap.emptySnapshot('people', 'app', 'not-implemented'), owner: registry.people.linear });
		expect(failures).toEqual([]);
	});
	test('any app status other than ok or not-implemented counts as an extraction error in the scorecard', () => {
		const { sc, failures } = run(v5(), snap.emptySnapshot('people', 'app', 'partial' as any));
		expect(sc.total.viewsExtractError).toBe(1);
		expect(failures.join('; ')).toMatch(/1 view\(s\) with an extraction error/);
	});
	test('positive control: a view the app genuinely does not implement still passes, with the waiver as its note', () => {
		const { r, sc, failures } = run(v5(), { ...snap.emptySnapshot('people', 'app', 'not-implemented'), owner: registry.people.linear });
		expect(r.unregistered).toEqual([]);
		expect(r.registered).toMatchObject([{ register: whole.id, type: 'not-yet-implemented' }]);
		expect(sc.views.people.status).toBe('NOT-YET-IMPLEMENTED');
		expect(sc.result).toBe('PASS');
		expect(failures).toEqual([]);
	});
});
