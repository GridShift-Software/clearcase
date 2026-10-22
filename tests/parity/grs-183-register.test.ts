// GRS-183: the register entries that waive the evidence-list fixes (IDR-088, 090, 141, 147, 148 and the entries
// split from 090 and 148, in the main file and CC-04) cover the one difference each names and nothing else. The register's own matcher is asked
// about synthetic wrong values; each one must stay unregistered so strict parity fails on it. Synthetic text only.
import { describe, expect, it } from 'vitest';
import { covering } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister, registryKeys, registryOwners } from '../../scripts/parity/lib/register.mjs';

const register = loadRegister(undefined, { owners: await registryOwners(), keys: await registryKeys() });
const coveredBy = (view: string, path: string, v5: string, app: string) =>
	(covering(register.entries, view, { path, kind: v5 === '<absent>' ? 'app-only' : app === '<absent>' ? 'v5-only' : 'value', v5, app }) as { id: string } | null)?.id ?? null;

const NOTHING = '0|811c9dc5:1505'; // an empty shown sequence, as the sweeps print it
const ROWS = '12|abc123:def456';

describe('GRS-183 register entries waive only the corrected value', () => {
	it('loads without problems', () => expect(register.problems).toEqual([]));

	it('IDR-088: a short Chronology excerpt without its ellipsis is waived, nothing else is', () => {
		const path = 'table.table_1.row.SY-1.excerpt';
		expect(coveredBy('chronology', path, 'Synthetic excerpt…', 'Synthetic excerpt')).toBe('IDR-088');
		// the excerpt vanished, or the app shows another row's text
		expect(coveredBy('chronology', path, 'Synthetic excerpt…', '<absent>')).toBeNull();
		expect(coveredBy('chronology', path, 'Synthetic excerpt…', 'Another row text')).toBeNull();
		expect(coveredBy('chronology', path, '<absent>', 'Synthetic excerpt')).toBeNull();
		// a long excerpt that lost its ellipsis: v5 cuts at 140 and appends one, so 140 characters are not "short"
		expect(coveredBy('chronology', path, `${'x'.repeat(140)}…`, 'x'.repeat(140))).toBeNull();
		expect(coveredBy('chronology', path, `${'x'.repeat(140)}…`, `${'x'.repeat(140)}…`.slice(0, 139))).toBeNull();
		// the app keeps an ellipsis it should not have, or v5 lost its own
		expect(coveredBy('chronology', path, 'Synthetic excerpt…', 'Synthetic excerpt…')).toBeNull();
		expect(coveredBy('chronology', path, 'Synthetic excerpt', 'Synthetic excerpt')).toBeNull();
	});

	describe.each([
		['chronology', 'any_text_status', 'filter_sort_ui', 'b0.t0.s2.q0.date.asc', [`${NOTHING}|shown 0`], ['IDR-090', 'IDR-092', 'IDR-093', 'IDR-094', 'IDR-095']],
		['search', 'any', 'search_filters', 's2', [`${NOTHING}|shown 0`, NOTHING], ['IDR-148', 'IDR-149', 'IDR-500', 'IDR-501', 'IDR-502']],
	] as const)('%s: the empty OCR text-status option', (view, select, sweep, key, empty, ids) => {
		const list = (n: string) => `list.select.${select}.${n}`;
		const sweepPaths = view === 'search' ? [`sweep.${sweep}.${key}.set`, `sweep.${sweep}.${key}.order`] : [`sweep.${sweep}.${key}`];

		it('waives exactly the option v5 lists and the app omits', () => {
			expect(coveredBy(view, list('count'), '5', '4')).toBe(ids[0]);
			expect(coveredBy(view, list('item.2'), 'ocr', 'none')).toBe(ids[1]);
			expect(coveredBy(view, list('item.3'), 'none', 'pending')).toBe(ids[2]);
			expect(coveredBy(view, list('item.4'), 'pending', '<absent>')).toBe(ids[3]);
			sweepPaths.forEach((p, i) => expect(coveredBy(view, p, empty[i] ?? empty[0], 'no-option'), p).toBe(ids[4]));
		});

		it('leaves a changed, dropped or extra option unregistered', () => {
			expect(coveredBy(view, list('item.2'), 'ocr', 'garbage')).toBeNull();
			expect(coveredBy(view, list('item.2'), 'ocr', 'pending')).toBeNull(); // the none option dropped
			expect(coveredBy(view, list('item.3'), 'none', 'garbage')).toBeNull();
			expect(coveredBy(view, list('item.3'), 'none', 'none')).toBeNull();
			expect(coveredBy(view, list('item.4'), 'pending', 'extracted')).toBeNull();
			expect(coveredBy(view, list('item.5'), '<absent>', 'extra')).toBeNull();
			expect(coveredBy(view, list('item.1'), 'extracted', 'ocr')).toBeNull();
		});

		it('leaves a changed count unregistered', () => {
			for (const app of ['2', '3', '5', '6']) expect(coveredBy(view, list('count'), '5', app), app).toBeNull();
			expect(coveredBy(view, list('count'), '4', '4')).toBeNull();
		});

		it('leaves an OCR sweep that shows rows unregistered', () => {
			for (const p of sweepPaths) {
				expect(coveredBy(view, p, `${ROWS}|shown 12`, 'no-option'), p).toBeNull(); // v5 found rows
				expect(coveredBy(view, p, `${ROWS}`, 'no-option'), p).toBeNull();
				expect(coveredBy(view, p, `${NOTHING}|shown 0`, `${ROWS}|shown 12`), p).toBeNull(); // the app shows rows for it
				expect(coveredBy(view, p, `${NOTHING}|shown 0`, 'rejected'), p).toBeNull();
				expect(coveredBy(view, p, `${NOTHING}|shown 0`, '<absent>'), p).toBeNull();
			}
		});

		it('leaves the other statuses unregistered', () => {
			const other = view === 'search' ? `sweep.${sweep}.s3.set` : `sweep.${sweep}.b0.t0.s3.q0.date.asc`;
			expect(coveredBy(view, other, `${NOTHING}|shown 0`, 'no-option')).toBeNull();
		});
	});

	it('IDR-141 and IDR-147: a new input is waived once, with v5 lacking it', () => {
		for (const [view, path, id] of [
			['filings_tab', 'control.input:text:Status', 'IDR-141'],
			['hoa_diff_tab', 'control.input:search:Search Document A', 'IDR-147'],
			['hoa_diff_tab', 'control.input:search:Search Document B', 'IDR-147'],
		] as const) {
			expect(coveredBy(view, path, '<absent>', '1'), path).toBe(id);
			expect(coveredBy(view, path, '<absent>', '2'), path).toBeNull(); // a duplicated input
			expect(coveredBy(view, path, '1', '<absent>'), path).toBeNull(); // the input went missing from v5's side
			expect(coveredBy(view, path, '1', '2'), path).toBeNull();
		}
	});

	it('IDR-089 and IDR-145 are dispositions that cover no path', () => {
		const by = new Map((register.entries as { id: string; field: unknown }[]).map((e) => [e.id, e]));
		for (const id of ['IDR-089', 'IDR-145']) expect(by.get(id)!.field, id).toEqual([]);
	});

	it('every entry this branch adds or changes is unapproved', () => {
		const by = new Map((register.entries as { id: string; approvedBy: string | null; approvedOn: string | null }[]).map((e) => [e.id, e]));
		for (const id of ['IDR-088', 'IDR-089', 'IDR-090', 'IDR-092', 'IDR-093', 'IDR-094', 'IDR-095', 'IDR-141', 'IDR-145', 'IDR-147', 'IDR-148', 'IDR-149', 'IDR-500', 'IDR-501', 'IDR-502'])
			expect(by.get(id), id).toMatchObject({ approvedBy: null, approvedOn: null });
	});
});
