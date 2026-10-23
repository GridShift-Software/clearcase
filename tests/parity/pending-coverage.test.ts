import { expect, it } from 'vitest';
import { classify, covering, diff } from '../../scripts/parity/lib/compare.mjs';
import { emptySnapshot } from '../../scripts/parity/lib/snapshot.mjs';
import { loadRegister, registryKeys, registryOwners } from '../../scripts/parity/lib/register.mjs';

const register = loadRegister(undefined, { owners: await registryOwners(), keys: await registryKeys() });
const coveredBy = (view: string, path: string, v5: string, app: string) =>
	covering(register.entries, view, { path, kind: v5 === '<absent>' ? 'app-only' : app === '<absent>' ? 'v5-only' : 'value', v5, app })?.id ?? null;

it('an unexpected restore input in a synthetic backup form is not an approved difference', () => {
	expect(register.problems).toEqual([]);
	const difference = {
		path: 'control.input:text:Unexpected restore bypass',
		kind: 'app-only',
		v5: '<absent>',
		app: '1',
	};
	expect(covering(register.entries, 'backup_tab', difference)).toBeNull();
});

it('the pending register entries cover only their observed structures', () => {
	expect(register.problems).toEqual([]);
	const allowed: [string, string, string, string, string][] = [
		['overview', 'text.originals.1', '<absent>', 'synthetic original status', 'IDR-053'],
		['chronology', 'list.select.all_bundles.item.5', '<absent>', 'Synthetic bundle', 'IDR-055'],
		['backup_tab', 'table.what_a_backup_holds_now_3_rows.row.2.rows', '<absent>', '2', 'IDR-414'],
		['backup_tab', 'export.export_all_state.text', 'synthetic v5 backup', '<absent>', 'IDR-418'],
		['backup_tab', 'control.input:text:or its full path on this computer', '<absent>', '1', 'IDR-419'],
		['manual', 'text.your_work_and_backups.2', '<absent>', 'synthetic manual text', 'IDR-423'],
		['manual', 'list.list_1.item.4', '<absent>', 'Pending 1', 'IDR-424'],
	];
	for (const [view, path, v5, app, id] of allowed) expect(coveredBy(view, path, v5, app), path).toBe(id);
	const refused: [string, string, string, string][] = [
		['overview', 'text.originals.unexpected', '<absent>', 'synthetic'],
		['overview', 'table.by_bundle.unexpected', '<absent>', 'synthetic'],
		['chronology', 'list.select.all_bundles.metadata', '<absent>', 'synthetic'],
		['backup_tab', 'table.what_a_backup_holds_now_3_rows.unexpected', '<absent>', 'synthetic'],
		['backup_tab', 'export.export_all_state.columns', 'synthetic', '<absent>'],
		['backup_tab', 'text.import_state.4', '<absent>', 'synthetic'],
		['manual', 'text.starting_and_importing.3', '<absent>', 'synthetic'],
		['manual', 'list.list_2.count', '<absent>', '1'],
	];
	for (const [view, path, v5, app] of refused) expect(coveredBy(view, path, v5, app), path).toBeNull();
});

it('the changed Chronology controls cover only one old and one new control', () => {
	for (const [oldPath, newPath, id] of [
		['control.button:Export CSV', 'control.button:Export CSV (# rows)', 'IDR-062'],
		['control.input:text:Filter text / ref / filename', 'control.input:text:Text, ref or filename', 'IDR-063'],
	]) {
		expect(coveredBy('chronology', oldPath, '1', '<absent>')).toBe(id);
		expect(coveredBy('chronology', newPath, '<absent>', '1')).toBe(id);
		expect(coveredBy('chronology', oldPath, '2', '<absent>')).toBeNull();
		expect(coveredBy('chronology', newPath, '<absent>', '2')).toBeNull();
	}
});

function checkRenderedList(view: string, path: string, v5: string[] | null, rendered: string[], source: string[]) {
	const left = { ...emptySnapshot(view, 'v5'), lists: v5 ? { [path.slice(5)]: v5 } : {} };
	const right = { ...emptySnapshot(view, 'app'), lists: { [path.slice(5)]: rendered } };
	const result = classify(view, diff(left, right), register.entries, { sourceChecks: [{ path, rendered, source }] });
	expect(result.unregistered.map((d: { path: string }) => d.path)).toContain(path);
}

it('an extra saved-note item is refused despite its register wildcard', () => {
	checkRenderedList('overview', 'list.my_notes', null, ['OD-001: 1', 'OD-002: 1'], ['OD-001: 1']);
});

it('a changed existing bundle option is refused despite its register wildcard', () => {
	checkRenderedList('chronology', 'list.select.all_bundles', ['All bundles', 'Original'], ['All bundles', 'Wrong bundle'], ['All bundles', 'Original']);
});

it('a phantom backup table is refused despite the inventory wildcard', () => {
	const table = (rows: { table: string; owner: string; rows: string }[]) => ({
		columns: [{ id: 'table', label: 'Table' }, { id: 'owner', label: 'Owner' }, { id: 'rows', label: 'Rows' }], key: null, rows,
	});
	const source = [{ table: 'note', owner: 'GRS-12', rows: '1' }];
	const rendered = [...source, { table: 'phantom_table', owner: 'TEST', rows: '9' }];
	const left = emptySnapshot('backup_tab', 'v5');
	const right = { ...emptySnapshot('backup_tab', 'app'), tables: { what_a_backup_holds_now_10_rows: table(rendered) } };
	const path = 'table.what_a_backup_holds_now_10_rows';
	const result = classify('backup_tab', diff(left, right), register.entries, { sourceChecks: [{ path, rendered, source }] });
	expect(result.unregistered.map((d: { path: string }) => d.path)).toContain(path);
});
