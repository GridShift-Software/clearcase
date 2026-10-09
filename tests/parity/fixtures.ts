// Synthetic snapshots for the parity suite: no case values. `base()` is a small view as both sides would show it.
import { emptySnapshot } from '../../scripts/parity/lib/snapshot.mjs';

export function base(side: 'v5' | 'app') {
	const s: any = emptySnapshot('chronology', side);
	s.title = 'Chronology';
	s.texts = { subtitle: '3 items', 'table_1.sorted': 'date asc' };
	s.kpis = { total_value: { label: 'Total value', value: 'R 1 234.50', sub: 'synthetic' } };
	s.counts = { 'table_1.total': '3' };
	s.tables = {
		table_1: {
			columns: [{ id: 'date', label: 'Date' }, { id: 'ref', label: 'Ref' }, { id: 'title_subject', label: 'Title / subject' }, { id: 'amount', label: 'Amount' }],
			key: 'ref',
			rows: [
				{ date: '—', ref: 'SY-001', title_subject: 'Synthetic one', amount: '' },
				{ date: '2020-01-02', ref: 'SY-002', title_subject: 'Synthetic two', amount: 'R 10.00' },
				{ date: '2021-03-04', ref: 'SY-003', title_subject: 'Synthetic three', amount: 'R 1 000.00' },
			],
		},
	};
	s.lists = { navigation: ['Matter / Overview', 'Matter / Chronology'] };
	s.controls = { 'button:Export CSV': 1, 'sort-header:Date': 1, 'row:link:Ref': 1 };
	s.sweeps = {
		filter_sort_ui: { 'b0.t0.s0.q0.date.asc': '3|aa:bb|shown 3', 'b1.t0.s0.q0.date.asc': '1|cc:dd|shown 1' },
		register_edit: { 'add1.rows': '1', 'add1.row.0': '2026-10-11 | Synthetic entry 1', 'delete.rows': '0', 'overview.Open deadlines': '0' },
	};
	s.exports = { export_csv: { name: 'synthetic.csv', columns: ['ref', 'date'], rows: [['SY-001', ''], ['SY-002', '2020-01-02']] } };
	s.focus = { after_nav: side === 'v5' ? 'nav-link' : 'heading' };
	return s;
}

/** A register covering the synthetic view's one intended difference (BA-14 focus), approved by someone else. */
export const register = [
	{ id: 'IDR-900', view: 'chronology', field: 'focus.after_nav', when: { v5: 'nav-link', app: 'heading' }, type: 'improvement', source: 'BA-14', reason: 'Focus moves to the page heading after navigation.', productVisible: true, author: 'worker', approvedBy: 'coordinator', approvedOn: '2026-10-09' },
];
