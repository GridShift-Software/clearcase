// CC-04's register entries are narrow (GRS-14, CC-04 r2, D6 and D9): the register's own matcher is asked about
// synthetic regressions, and each one must leave a difference unregistered, so parity fails on it.
//  * D6: a documents order that differs in a bundle filter state IDR-107 does not list (IDR-107 lists exact paths).
//  * D9: a bundle option in the wrong place in Search (one IDR-121 entry per option, each pinned to its own pair); a
//    diff pick-list count that changes with no option to show for it is still covered by IDR-128, whose guard is the
//    item paths, so an appended option the app should not have is the regression to check (IDR-129 pins v5's side).
// Synthetic refs and labels only (the bundle labels are the ones IDR-121 already names).
import { describe, expect, it } from 'vitest';
import { classify, covering, diff } from '../../scripts/parity/lib/compare.mjs';
import { loadRegister, registryKeys, registryOwners } from '../../scripts/parity/lib/register.mjs';
import { emptySnapshot } from '../../scripts/parity/lib/snapshot.mjs';
import { seqValue } from '../../scripts/parity/lib/sweeps.mjs';

const reg = loadRegister(undefined, { owners: await registryOwners(), keys: await registryKeys() });
type D = { path: string; kind: string; v5: string; app: string };
const cover = (view: string, d: D) => (covering(reg.entries, view, d) as { id: string } | null)?.id ?? null;

describe('CC-04 register entries cover only the differences they name', () => {
	it('loads without problems', () => expect(reg.problems).toEqual([]));

	it('D6: a documents order that differs outside IDR-107s paths is unregistered', () => {
		const refs = ['SYN-1', 'SYN-2', 'SYN-3'];
		const snap = (side: 'v5' | 'app', order: string[]) => {
			const s = emptySnapshot('documents', side);
			s.title = 'Documents';
			s.tables.table_1 = { columns: [{ id: 'ref', label: 'Ref' }, { id: 'date', label: 'Date' }], key: 'ref', rows: order.map((r) => ({ ref: r, date: `2024-01-0${refs.indexOf(r) + 1}` })) };
			s.sweeps.bundle_filter = { 'b2.q0.set': `${seqValue([...order].sort())}|shown 3`, 'b2.q0.order': seqValue(order), 'b3.q0.order': seqValue(order) };
			return s;
		};
		const res = classify('documents', diff(snap('v5', refs), snap('app', [...refs].reverse())), reg.entries) as { unregistered: { path: string }[]; registered: { path: string; register: string }[] };
		expect(res.unregistered.map((d) => d.path)).toEqual(['sweep.bundle_filter.b2.q0.order']);
		// the listed paths stay covered (the unit test guards the order within them)
		expect(res.registered.map((d) => [d.path, d.register]).sort()).toEqual([['sweep.bundle_filter.b3.q0.order', 'IDR-107'], ['table.table_1.order', 'IDR-107']]);
		for (const q of ['q3', 'q5']) expect(cover('documents', { path: `sweep.bundle_filter.b3.${q}.order`, kind: 'order', v5: 'x', app: 'y' })).toBeNull();
	});

	it('D9: a Search bundle option in the wrong place is unregistered; each option is pinned to its own pair', () => {
		expect(cover('search', { path: 'list.select.all.item.3', kind: 'value', v5: 'Correspondence', app: 'Pleadings' })).toBeNull();
		expect(cover('search', { path: 'list.select.all.item.4', kind: 'value', v5: 'Pleadings', app: 'Additional' })).toBeNull();
		expect(cover('search', { path: 'list.select.all.item.5', kind: 'value', v5: '<absent>', app: 'Correspondence' })).toBeNull();
		expect(cover('search', { path: 'list.select.all.item.3', kind: 'value', v5: 'Correspondence', app: 'Additional' })).toBe('IDR-121');
		expect(cover('search', { path: 'list.select.all.item.4', kind: 'value', v5: 'Pleadings', app: 'Correspondence' })).not.toBeNull();
		expect(cover('search', { path: 'list.select.all.item.5', kind: 'value', v5: '<absent>', app: 'Pleadings' })).not.toBeNull();
	});

	it('D9: a diff pick-list option the app shows in place of one v5 shows is unregistered', () => {
		// IDR-129 covers only options v5 lacks; an option v5 has but the app replaces still compares
		expect(cover('hoa_diff_tab', { path: 'list.select.pick.item.7', kind: 'value', v5: 'SYN-7 · Synthetic', app: 'SYN-9 · Synthetic' })).toBeNull();
		expect(cover('hoa_diff_tab', { path: 'list.select.pick.item.1500', kind: 'app-only', v5: '<absent>', app: 'SYN-9 · Synthetic' })).toBe('IDR-129');
	});

	it('D9: IDR-105 and IDR-128 carry no no-op condition, and IDR-105 is as visible as IDR-049', () => {
		const by = new Map((reg.entries as { id: string; when?: unknown; productVisible: boolean }[]).map((e) => [e.id, e]));
		expect(by.get('IDR-105')).toMatchObject({ productVisible: by.get('IDR-049')!.productVisible });
		expect(by.get('IDR-105')!.when).toBeUndefined();
		expect(by.get('IDR-128')!.when).toBeUndefined();
	});

	it('D5: export names come from view-content, so no entry covers any export-name difference', () => {
		for (const id of ['IDR-106', 'IDR-116', 'IDR-124', 'IDR-134']) expect(reg.entries.some((e: { id: string }) => e.id === id)).toBe(false);
		expect(cover('filings_tab', { path: 'export.export_csv.name', kind: 'value', v5: 'syn_filings.csv', app: 'filings.csv' })).toBeNull();
		expect(cover('filings_tab', { path: 'export.export_register_csv.name', kind: 'value', v5: 'syn_filing_register.csv', app: 'filing-register.csv' })).toBeNull();
		expect(cover('contracts_tab', { path: 'export.export_csv.name', kind: 'value', v5: 'syn_contracts.csv', app: 'contracts.csv' })).toBeNull();
		expect(cover('search', { path: 'export.export_csv.name', kind: 'value', v5: 'syn_search.csv', app: 'search.csv' })).toBeNull();
	});

	it('D5: IDR-101 covers only the storage sentence after the introduction', () => {
		const path = 'text.filing_replying_affidavit_register.1';
		const app = "Synthetic intro. Saved in this case's local work store; imported rows stay as imported and your changes are kept apart from them.";
		expect(cover('filings_tab', { path, kind: 'value', v5: 'Synthetic intro. Saved in this browser (syn_key).', app })).toBe('IDR-101');
		// the app's paragraph without its storage sentence, or v5's without the browser sentence, is a regression
		expect(cover('filings_tab', { path, kind: 'value', v5: 'Synthetic intro. Saved in this browser (syn_key).', app: 'Synthetic intro.' })).toBeNull();
		expect(cover('filings_tab', { path, kind: 'value', v5: 'Synthetic intro.', app })).toBeNull();
	});
});
