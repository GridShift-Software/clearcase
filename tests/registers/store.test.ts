// Register persistence (GRS-17) on a real work.sqlite: insertion order under a fixed clock, delete by stable id
// (S-deadlines_tab-1, expected example deadline-delete-shown-row), the privilege ledger example, edit in place, case
// scoping and restart.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, service, tempRoot } from '../../src/lib/local-case/test-support';
import { addEntry, deleteEntry, editEntry, listRegister } from '../../src/lib/user-work/registers.server';
import { REGISTERS } from '../../src/lib/views/registers/defs';
import { byDate, entryFrom, isSkipped } from '../../src/lib/views/registers/logic';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await cleanup(d); });
async function fresh() { const d = await tempRoot('registers'); dirs.push(d); return { dir: d, lc: service(d) }; }
const CASE = 'case-synthetic-1';
/** v5's persisted value: the field values only, in stored order. */
const persisted = (lc: Awaited<ReturnType<typeof fresh>>['lc'], view: keyof typeof REGISTERS) => listRegister(lc.userWork, CASE, REGISTERS[view]).map((r) => r.values);

describe('register rows', () => {
	it('keep insertion order under the fixed clock, where createdAt ties for every row', async () => {
		const { lc } = await fresh();
		const def = REGISTERS.popia_tab;
		for (let i = 0; i < 12; i++) await addEntry(lc.userWork, CASE, def, entryFrom(def, { activity: `Synthetic ${i}` }));
		expect(new Set(lc.userWork.listRows(CASE, def.store).map((r) => r.createdAt)).size).toBe(1);
		expect(persisted(lc, 'popia_tab').map((v) => v.activity)).toEqual(Array.from({ length: 12 }, (_, i) => `Synthetic ${i}`));
		expect(listRegister(lc.userWork, CASE, def).map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
	});

	it('delete the shown row, not the row at its position in the store (expected example deadline-delete-shown-row, rewrite)', async () => {
		const { lc } = await fresh();
		const def = REGISTERS.deadlines_tab;
		await addEntry(lc.userWork, CASE, def, { title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' });
		await addEntry(lc.userWork, CASE, def, { title: 'Synthetic earlier', date: '2026-11-01', cat: 'Hearing', note: '' });
		const shown = byDate(listRegister(lc.userWork, CASE, def));
		expect(shown.map((r) => r.values.title)).toEqual(['Synthetic earlier', 'Synthetic later']);
		expect(await deleteEntry(lc.userWork, CASE, def, shown[0]!.rowId)).toBe(true);
		expect(persisted(lc, 'deadlines_tab')).toEqual([{ title: 'Synthetic later', date: '2026-12-03', cat: 'Filing', note: '' }]);
	});

	it('follow the privilege ledger example (ledger-privilege-add-add-delete)', async () => {
		const { lc } = await fresh();
		const def = REGISTERS.privilege_tab;
		for (const input of [{ ref: 'OD-002', date: '2026-10-01', desc: 'Synthetic entry one', basis: 'Legal advice' }, {}, { ref: 'SD-010', date: '', desc: 'Synthetic entry two', basis: 'Litigation' }]) {
			const e = entryFrom(def, input);
			if (!isSkipped(def, e)) await addEntry(lc.userWork, CASE, def, e);
		}
		await deleteEntry(lc.userWork, CASE, def, listRegister(lc.userWork, CASE, def)[0]!.rowId);
		expect(JSON.stringify(persisted(lc, 'privilege_tab'))).toBe('[{"ref":"SD-010","date":"","desc":"Synthetic entry two","basis":"Litigation"}]');
	});

	it('edit in place, keeping the row id and its position; editing a deleted row saves nothing', async () => {
		const { lc } = await fresh();
		const def = REGISTERS.disbursements_tab;
		const a = await addEntry(lc.userWork, CASE, def, { date: '2026-10-01', desc: 'one', payee: 'p', amount: '10' });
		const b = await addEntry(lc.userWork, CASE, def, { date: '2026-10-02', desc: 'two', payee: 'p', amount: '20' });
		expect(await editEntry(lc.userWork, CASE, def, a, { date: '2026-10-03', desc: 'one edited', payee: 'q', amount: '15' })).toBe(true);
		expect(listRegister(lc.userWork, CASE, def).map((r) => [r.rowId, r.values.desc])).toEqual([[a, 'one edited'], [b, 'two']]);
		await deleteEntry(lc.userWork, CASE, def, b);
		expect(await editEntry(lc.userWork, CASE, def, b, { date: '', desc: 'ghost', payee: '', amount: '' })).toBe(false);
		expect(persisted(lc, 'disbursements_tab').map((v) => v.desc)).toEqual(['one edited']);
	});

	it('are scoped to their case and kept in one store per register', async () => {
		const { lc } = await fresh();
		await addEntry(lc.userWork, CASE, REGISTERS.timesheet_tab, { date: '', fee_earner: 'x', activity: '', hours: '1', rate: '', billed: 'no' });
		await addEntry(lc.userWork, 'case-synthetic-2', REGISTERS.timesheet_tab, { date: '', fee_earner: 'y', activity: '', hours: '2', rate: '', billed: '' });
		expect(persisted(lc, 'timesheet_tab').map((v) => v.fee_earner)).toEqual(['x']);
		const other = listRegister(lc.userWork, 'case-synthetic-2', REGISTERS.timesheet_tab)[0]!;
		expect(await deleteEntry(lc.userWork, CASE, REGISTERS.timesheet_tab, other.rowId)).toBe(false);
		expect(lc.userWork.registerStores(CASE)).toEqual(['timesheet']);
		expect(new Set(Object.values(REGISTERS).map((d) => d.store)).size).toBe(7);
	});

	it('survive a restart of the store', async () => {
		const { dir, lc } = await fresh();
		const def = REGISTERS.transcriptions_tab;
		const id = await addEntry(lc.userWork, CASE, def, { title: 'Synthetic hearing', date: '2026-10-05', source: 'Synthetic', body: 'line one\nline two' });
		lc.storage.close();
		const again = service(dir);
		expect(listRegister(again.userWork, CASE, def).map((r) => [r.rowId, r.values.body])).toEqual([[id, 'line one\nline two']]);
	});
});
