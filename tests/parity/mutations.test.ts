// Synthetic mutation cases: a regression planted in each category must surface as an unregistered difference, even
// with the register's legitimate entries in force. The real-sample run of the same categories (a scratch copy of
// the app with planted regressions, scripts/parity/mutate.mjs) is local evidence; these keep the comparator honest.
import { describe, expect, test } from 'vitest';
import { classify, diff } from '../../scripts/parity/lib/compare.mjs';
import { base, register } from './fixtures';

const run = (mutate: (s: any) => void) => {
	const app = base('app');
	mutate(app);
	return classify('chronology', diff(base('v5'), app), register, {});
};

const CASES: [string, string, (s: any) => void, RegExp][] = [
	['filter/sort', 'a sort that reorders rows', (s) => { s.tables.table_1.rows = [s.tables.table_1.rows[1], s.tables.table_1.rows[0], s.tables.table_1.rows[2]]; }, /^table\.table_1\.order$/],
	['filter/sort', 'a filter combination with another result', (s) => { s.sweeps.filter_sort_ui['b1.t0.s0.q0.date.asc'] = '2|ee:ff|shown 2'; }, /^sweep\.filter_sort_ui\./],
	['calculation', 'a KPI computed differently', (s) => { s.kpis.total_value.value = 'R 1 234.00'; }, /^kpi\.total_value\.value$/],
	['calculation', 'a cell amount computed differently', (s) => { s.tables.table_1.rows[2].amount = 'R 100.00'; }, /^table\.table_1\.row\.SY-003\.amount$/],
	['register CRUD', 'delete removes the wrong entry', (s) => { s.sweeps.register_edit['delete.rows'] = '1'; }, /^sweep\.register_edit\.delete\.rows$/],
	['register CRUD', 'an added entry stored with the wrong date', (s) => { s.sweeps.register_edit['add1.row.0'] = '2026-10-12 | Synthetic entry 1'; }, /^sweep\.register_edit\.add1\.row\.0$/],
	['export', 'an export that drops a column', (s) => { s.exports.export_csv = { ...s.exports.export_csv, columns: ['ref'], rows: s.exports.export_csv.rows.map((r: string[]) => [r[0]]) }; }, /^export\.export_csv\./],
	['export', 'an export with a changed cell', (s) => { s.exports.export_csv.rows[1][1] = '2020-02-01'; }, /^export\.export_csv\.row\.1\.date$/],
	['navigation/focus', 'focus lost after navigation', (s) => { s.focus.after_nav = 'body'; }, /^focus\.after_nav$/],
	['navigation/focus', 'a navigation entry renamed', (s) => { s.lists.navigation[1] = 'Matter / Timeline'; }, /^list\.navigation\.item\.1$/],
	['rendered text', 'a changed subtitle', (s) => { s.texts.subtitle = '3 records'; }, /^text\.subtitle$/],
	['rendered text', 'a renamed column', (s) => { s.tables.table_1.columns[2].label = 'Subject'; }, /^table\.table_1\.col\.title_subject$/],
];

describe('every planted regression is caught', () => {
	test('control: the unmutated app has only registered differences', () => {
		const r = run(() => {});
		expect(r.unregistered).toEqual([]);
		expect(r.registered.map((d: any) => d.register)).toEqual(['IDR-900']);
	});
	for (const [cat, what, mutate, path] of CASES) {
		test(`${cat}: ${what}`, () => {
			const r = run(mutate);
			expect(r.unregistered.length).toBeGreaterThan(0);
			expect(r.unregistered.some((d: any) => path.test(d.path))).toBe(true);
		});
	}
	test('all six categories are covered', () => {
		expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set(['filter/sort', 'calculation', 'register CRUD', 'export', 'navigation/focus', 'rendered text']));
	});
});
