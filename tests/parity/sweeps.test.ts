import { describe, expect, test } from 'vitest';
import { chronologyDims, engineCombos, fnv, seededUserWork, seqValue, uiCombos } from '../../scripts/parity/lib/sweeps.mjs';

const rows = [
	{ bundle: 'B2', doc_type: 't1', text_status: 'none' },
	{ bundle: 'B1', doc_type: 't2', text_status: 'extracted' },
	{ bundle: 'B1', doc_type: 't1', text_status: 'odd' },
];
describe('sweep designs', () => {
	test('dimensions come from the shared input, sorted, with "all" first', () => {
		const d = chronologyDims(rows);
		expect(d.bundles).toEqual(['', 'B1', 'B2']);
		expect(d.types).toEqual(['', 't1', 't2']);
		expect(d.statuses).toEqual(['', 'extracted', 'ocr', 'none', 'pending', 'odd']);
	});
	test('combination keys are index-coded: no input value appears in a key', () => {
		const d = chronologyDims(rows);
		for (const c of [...uiCombos(d), ...engineCombos(d)]) expect(c.key).toMatch(/^b\d+\.t\d+\.s\d+\.q\d+\.(date|ref|docType|bundle|amount)\.(asc|desc)$/);
	});
	test('the engine grid is the full product; the UI design covers every bundle, sort and direction', () => {
		const d = chronologyDims(rows);
		expect(engineCombos(d)).toHaveLength(3 * 3 * 6 * 5 * 5 * 2);
		const ui = uiCombos(d);
		for (let b = 0; b < 3; b++) for (const k of ['date', 'ref', 'docType', 'bundle', 'amount']) for (const dir of ['asc', 'desc']) expect(ui.some((c) => c.key === `b${b}.t0.s0.q0.${k}.${dir}`)).toBe(true);
		expect(new Set(ui.map((c) => c.key)).size).toBe(ui.length);
	});
	test('sequence values change with order and membership', () => {
		expect(seqValue(['a', 'b'])).not.toBe(seqValue(['b', 'a']));
		expect(seqValue(['a'])).toBe(`1|${fnv('a')}`);
	});
	test('synthetic user work is relative to the clock', () => {
		const w = seededUserWork('2026-10-08T09:00:00Z');
		expect(w.ess_dcs_deadlines_v1.map((d) => d.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-11-07']);
		expect(w.ess_dcs_timesheet_v1.map((t) => t.billed)).toEqual(['', 'no', 'yes']);
	});
});
