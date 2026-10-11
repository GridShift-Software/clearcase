// CC-06 r2, D14 and D15 (GRS-16): the register's matcher, asked about synthetic differences on the narrowed paths and
// the new check keys. Each intended difference is covered; each regression the lanes' mutants cause (a wrong payments
// total, a wrong net claim, a wrong +3-year or as-of count, a wrong or swapped as-of status) is left unregistered.
// Every value here is synthetic or a sweep's own synthetic figure; none comes from a case.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { covering } from '../../scripts/parity/lib/compare.mjs';

const entries: Parameters<typeof covering>[0] = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/reference/parity/register/CC-06.json'), 'utf8')).entries;
const cover = (view: string, path: string, v5: string, app: string): string | null => covering(entries, view, { kind: 'value', path, v5, app })?.id ?? null;

describe('payments_tab: the payments total and the net claim', () => {
	it('covers the separated payments exactly as the sweep types them', () => {
		expect(cover('payments_tab', 'sweep.separators.kpi.Payments recorded', 'R 252.50 · 4 receipts', 'R 2 750.75 · 4 receipts')).toBe('IDR-203');
		expect(cover('payments_tab', 'sweep.separators.kpi.Net claim', 'R1000.00', 'R-1750.75')).toBeNull();
		expect(cover('payments_tab', 'sweep.separators.kpi.Net claim', 'R1000.00', '-R1750.75')).toBe('IDR-233');
	});
	it('leaves a wrong payments total (M1b: cents dropped) unregistered', () => {
		expect(cover('payments_tab', 'sweep.separators.kpi.Payments recorded', 'R 252.50 · 4 receipts', 'R 2 750.00 · 4 receipts')).toBeNull();
		expect(cover('payments_tab', 'sweep.separators.kpi.Payments recorded', 'R 252.50 · 4 receipts', 'R 2 750.75 · 3 receipts')).toBeNull();
	});
	it('leaves a wrong net claim unregistered: no entry covers the net identity check', () => {
		expect(cover('payments_tab', 'sweep.separators.net_identity', 'ok', 'R 1 150.00 | R 2 750.75 | -R 1 600.74')).toBeNull();
	});
});

describe('interest_calc_tab: the separated capital', () => {
	it('covers the three figures exactly and the comparison line by shape', () => {
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k0.value', 'R100.00', 'R100000.00')).toBe('IDR-212');
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k1.value', 'R10.02', 'R10020.53')).toBe('IDR-234');
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k2.value', 'R110.02', 'R110020.53')).toBe('IDR-235');
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k3.sub', '-R 1 000.00 vs your calc', '+R 2 000.00 vs your calc')).toBe('IDR-236');
	});
	it('leaves a wrong interest, total or capital unregistered', () => {
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k1.value', 'R10.02', 'R10020.54')).toBeNull();
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k2.value', 'R110.02', 'R110020.52')).toBeNull();
		expect(cover('interest_calc_tab', 'sweep.compute.separated.k0.value', 'R100.00', 'R10000.00')).toBeNull();
	});
});

describe('prescription_tab: the arithmetic card and the as-of statuses', () => {
	it('covers the card\'s two sentences on exact paths and the per-row status wording', () => {
		expect(cover('prescription_tab', 'text.arithmetic_checks.1', '<absent>', '5 of 7 imported prescription dates are the invoice date plus 3 calendar years. 2 invoices are dated 29 February; 2 of them prescribe on 28 February.')).toBe('IDR-224');
		expect(cover('prescription_tab', 'text.arithmetic_checks.2', '<absent>', '4 of 7 rows have a prescription date on or before the as-of date 2026-10-08 (today, South African time).')).toBe('IDR-238');
		expect(cover('prescription_tab', 'table.table_1.row.ZZ-1.as_of_status', '<absent>', '3-yr date passed')).toBe('IDR-225');
	});
	it('covers the check keys only at exactly 0', () => {
		expect(cover('prescription_tab', 'count.check.as_of_status_disagreements', '<absent>', '0')).toBe('IDR-237');
		expect(cover('prescription_tab', 'count.check.arithmetic_disagreements', '<absent>', '0')).toBe('IDR-237');
	});
	it('leaves wrong statuses, swapped labels and wrong counts unregistered', () => {
		expect(cover('prescription_tab', 'count.check.as_of_status_disagreements', '<absent>', '3')).toBeNull();
		expect(cover('prescription_tab', 'count.check.arithmetic_disagreements', '<absent>', '1')).toBeNull();
		expect(cover('prescription_tab', 'text.arithmetic_checks.9', '<absent>', '1 of 2 rows have a prescription date on or before the as-of date 2026-10-08 (today, South African time).')).toBeNull();
		expect(cover('prescription_tab', 'text.arithmetic_checks.2', '<absent>', '1 of 2 rows have a prescription date on or before the as-of date 2026-10-08 (today, South African time). Extra')).toBeNull();
		expect(cover('prescription_tab', 'text.arithmetic_checks.1', '<absent>', '1 of 2 rows have a prescription date on or before the as-of date 2026-10-08 (today, South African time).')).toBeNull();
	});
	it('IDR-226 cites S-prescription_tab-2, as IDR-224, IDR-225 and IDR-229 do (D15)', () => {
		for (const id of ['IDR-224', 'IDR-225', 'IDR-226', 'IDR-229', 'IDR-238']) expect(entries.find((e) => e.id === id)?.reason).toContain('S-prescription_tab-2');
	});
});
