import { describe, expect, test } from 'vitest';
import { ABSENT, classify, covering, diff, flatten, runFailures, scorecard, type Entry } from '../../scripts/parity/lib/compare.mjs';
import { emptySnapshot, fromRaw, remap, tableFromRaw } from '../../scripts/parity/lib/snapshot.mjs';
import { base, register } from './fixtures';

describe('flatten', () => {
	test('every shown value gets one path; table cells are keyed by the row key, not the position', () => {
		const f = flatten(base('v5'));
		expect(f.get('kpi.total_value.value')).toBe('R 1 234.50');
		expect(f.get('table.table_1.row.SY-002.amount')).toBe('R 10.00');
		expect(f.get('table.table_1.order')).toBe('SY-001\nSY-002\nSY-003');
		expect(f.get('table.table_1.rows')).toBe('3');
		expect(f.get('control.row:link:Ref')).toBe('1');
		expect(f.get('sweep.filter_sort_ui.b1.t0.s0.q0.date.asc')).toBe('1|cc:dd|shown 1');
		expect(f.get('export.export_csv.row.1.date')).toBe('2020-01-02');
		expect(f.has('table.table_1.row.SY-001.ref')).toBe(false); // the key is the row's identity, compared via order
	});
	test('duplicate keys stay distinct', () => {
		const s = base('v5');
		s.tables.table_1.rows[2].ref = 'SY-002';
		const f = flatten(s);
		expect(f.get('table.table_1.row.SY-002#2.amount')).toBe('R 1 000.00');
	});
});

describe('diff', () => {
	test('identical snapshots: every value compared and matched', () => {
		const r = diff(base('v5'), { ...base('app'), focus: { after_nav: 'nav-link' } });
		expect(r.diffs).toEqual([]);
		expect(r.matched).toBe(r.compared);
		expect(r.compared).toBe(flatten(base('v5')).size);
	});
	test('normalization applies to both sides: grouping and spacing do not differ', () => {
		const a = base('app');
		a.focus.after_nav = 'nav-link';
		a.kpis.total_value.value = 'R1,234.50';
		a.counts['table_1.total'] = ' 3 ';
		expect(diff(base('v5'), a).diffs).toEqual([]);
	});
	test('kinds: value, v5-only, app-only, order (with the first divergence)', () => {
		const a = base('app');
		a.texts.subtitle = '3 documents';
		delete a.controls['button:Export CSV'];
		a.controls['button:Print'] = 1;
		a.tables.table_1.rows.reverse();
		const byPath = Object.fromEntries(diff(base('v5'), a).diffs.map((d: any) => [d.path, d]));
		expect(byPath['text.subtitle']).toMatchObject({ kind: 'value', v5: '3 items', app: '3 documents' });
		expect(byPath['control.button:Export CSV']).toMatchObject({ kind: 'v5-only', app: ABSENT });
		expect(byPath['control.button:Print']).toMatchObject({ kind: 'app-only', v5: ABSENT });
		expect(byPath['table.table_1.order']).toMatchObject({ kind: 'order', index: 0, v5: 'SY-001', app: 'SY-003' });
	});
	test('a view the app does not implement is one view-level difference, with no values compared', () => {
		const r = diff(base('v5'), emptySnapshot('chronology', 'app', 'not-implemented'));
		expect(r).toMatchObject({ compared: 0, matched: 0, appValues: 0, diffs: [{ path: '*', kind: 'view-not-implemented' }] });
	});
	test('a v5 extraction error is never coverable by the register', () => {
		const r = diff({ ...emptySnapshot('chronology', 'v5', 'error'), error: 'boom' }, base('app'));
		const c = classify('chronology', r, [{ ...register[0], field: '*' } as Entry], {});
		expect(c.unregistered).toHaveLength(1);
		expect(c.registered).toHaveLength(0);
	});
});

describe('register coverage', () => {
	const d = { path: 'focus.after_nav', kind: 'value', v5: 'nav-link', app: 'heading' };
	test('a matching entry covers the difference', () => {
		expect(covering(register, 'chronology', d)?.id).toBe('IDR-900');
	});
	test('the value condition is exact: another app value is not covered', () => {
		expect(covering(register, 'chronology', { ...d, app: 'body' })).toBeNull();
	});
	test('another view is not covered', () => {
		expect(covering(register, 'overview', d)).toBeNull();
	});
	test('globs, lists of globs and regular-expression conditions', () => {
		const e: Entry[] = [{ ...register[0], id: 'IDR-901', field: ['text.x', 'table.table_1.row.*.date'], when: { v5: '—', app: { re: '^undated$' } } }];
		expect(covering(e, 'chronology', { path: 'table.table_1.row.SY-1.date', v5: '—', app: 'undated' })).not.toBeNull();
		expect(covering(e, 'chronology', { path: 'table.table_1.row.SY-1.date', v5: '—', app: 'n/a' })).toBeNull();
		expect(covering(e, 'chronology', { path: 'table.table_1.row.SY-1.amount', v5: '—', app: 'undated' })).toBeNull();
	});
	test('a relation between the two values covers only the pair it names', () => {
		const e: Entry[] = [{ ...register[0], id: 'IDR-903', field: 'text.x', when: { relation: 'app-is-v5-without-ellipsis' } }];
		const at = (v5: string, app: string) => covering(e, 'chronology', { path: 'text.x', kind: 'value', v5, app });
		expect(at('short text…', 'short text')).not.toBeNull();
		expect(at('short text …', 'short text')).not.toBeNull();
		expect(at('short text…', 'other text')).toBeNull();
		expect(at('short text…', '<absent>')).toBeNull();
		expect(at('short text', 'short text')).toBeNull();
		expect(at('short text…', 'short text…')).toBeNull();
		expect(at('<absent>', 'short text')).toBeNull();
	});
	test('a whole-view entry (field "*") covers only the view-level difference, never a value', () => {
		const whole: Entry[] = [{ ...register[0], field: '*', when: undefined, type: 'not-yet-implemented', owner: 'GRS-14' }];
		expect(covering(whole, 'chronology', { path: '*', kind: 'view-not-implemented', v5: 'view', app: ABSENT })).not.toBeNull();
		expect(covering(whole, 'chronology', d)).toBeNull();
	});
	test('approvedOnly ignores proposed entries', () => {
		const proposed: Entry[] = [{ ...register[0], approvedBy: null, approvedOn: null }];
		expect(covering(proposed, 'chronology', d)).not.toBeNull();
		expect(covering(proposed, 'chronology', d, { approvedOnly: true })).toBeNull();
	});
});

describe('scorecard', () => {
	test('counts only: no paths and no values leave the per-view results', () => {
		const a = base('app');
		a.texts.subtitle = 'SECRET-WORDING';
		const r = classify('chronology', diff(base('v5'), a), register, {});
		const sc = scorecard({ chronology: { ...r, v5Status: 'ok', appStatus: 'ok' } });
		const text = JSON.stringify(sc);
		expect(text).not.toContain('SECRET-WORDING');
		expect(text).not.toContain('subtitle');
		expect(text).not.toContain('SY-00');
		expect(sc.total).toMatchObject({ views: 1, unregistered: 1 });
		expect(sc.total.registered.improvement).toBe(1);
		expect(sc.views.chronology.status).toBe('FAIL');
		expect(sc.result).toBe('FAIL');
	});
	test('registered differences only: PASS-with-notes; not implemented: its own status', () => {
		const ok = classify('chronology', diff(base('v5'), base('app')), register, {});
		const nyi = classify('people', diff(base('v5'), emptySnapshot('people', 'app', 'not-implemented')), [{ ...register[0], id: 'IDR-902', view: 'people', field: '*', when: undefined, type: 'not-yet-implemented', owner: 'GRS-14' } as Entry], {});
		const sc = scorecard({ chronology: { ...ok, v5Status: 'ok', appStatus: 'ok' }, people: { ...nyi, v5Status: 'ok', appStatus: 'not-implemented' } });
		expect(sc.views.chronology.status).toBe('PASS-with-notes');
		expect(sc.views.people.status).toBe('NOT-YET-IMPLEMENTED');
		expect(sc.total.registered['not-yet-implemented']).toBe(1);
		expect(sc.result).toBe('PASS');
	});
});

describe('run result', () => {
	const clean = { offline: true, v5NonFileRequests: 0, v5BrowserInternalRequests: 0, appNonLoopbackRequests: 0, canaryHits: 0, canaryBrowserServiceHits: 0, fixtureUnchanged: true };
	const run = (isolation: object) => {
		const ok = classify('chronology', diff(base('v5'), base('app')), register, {});
		return runFailures({ ...scorecard({ chronology: { ...ok, v5Status: 'ok', appStatus: 'ok' } }), isolation: { ...clean, ...isolation } }, { views: 1 });
	};
	test('a clean run passes; browser-internal viewer requests and browser-service canary hits are counted apart', () => {
		expect(run({})).toEqual([]);
		expect(run({ v5BrowserInternalRequests: 7, canaryBrowserServiceHits: 3 })).toEqual([]);
	});
	test('any isolation breach fails the run, an app request that is not loopback included', () => {
		expect(run({ appNonLoopbackRequests: 1 }).join()).toMatch(/app non-loopback requests 1/);
		expect(run({ v5NonFileRequests: 1 }).join()).toMatch(/v5 non-file/);
		expect(run({ canaryHits: 1 }).join()).toMatch(/canary hits 1/);
		expect(run({ fixtureUnchanged: false }).join()).toMatch(/fixture tree changed/);
	});
});

describe('snapshot building', () => {
	test('tableFromRaw: header slugs, arrows removed and recorded, cell parts joined', () => {
		const t = tableFromRaw({ header: ['Date ▲', 'Ref', 'Title / subject'], rows: [[['—'], ['SY-1'], ['Synthetic', 'sender']]] });
		expect(t.columns.map((c: any) => c.id)).toEqual(['date', 'ref', 'title_subject']);
		expect(t.sorted).toBe('date asc');
		expect(t.key).toBe('ref');
		expect(t.rows[0].title_subject).toBe('Synthetic / sender');
	});
	test('fromRaw: KPIs, paragraphs by section, selects as option lists, row controls by column', () => {
		const s = fromRaw('x', 'v5', {
			h1: ['X'], headings: [], kpis: [{ label: 'Open deadlines', value: '0', sub: 'in the tracker' }],
			tables: [], lists: [], focus: null, title: '',
			paragraphs: [{ section: 'X', text: 'meta', cls: 'meta' }, { section: 'Freshness', text: 'one', cls: '' }, { section: 'Freshness', text: 'two', cls: '' }],
			controls: [{ kind: 'select', label: 'All bundles', options: ['All bundles', 'A'], inRow: false }, { kind: 'link', label: 'SY-1', inRow: true, column: 'Ref' }, { kind: 'link', label: 'SY-2', inRow: true, column: 'Ref' }],
		});
		expect(s.kpis.open_deadlines.value).toBe('0');
		expect(s.texts).toEqual({ subtitle: 'meta', 'freshness.1': 'one', 'freshness.2': 'two' });
		expect(s.lists['select.all_bundles']).toEqual(['All bundles', 'A']);
		expect(s.controls).toEqual({ 'select:All bundles': 1, 'row:link:Ref': 1 });
	});
	test('remap renames ids and refuses to merge two onto one', () => {
		const s = base('app');
		s.kpis.other = { label: 'O', value: '1', sub: '' };
		expect(Object.keys(remap(s, { 'kpi.other': 'renamed' }).kpis)).toEqual(['total_value', 'renamed']);
		expect(() => remap(s, { 'kpi.other': 'total_value' })).toThrow(/two kpi ids/);
	});
});
