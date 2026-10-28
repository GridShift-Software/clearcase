// Ticket 17a: what the local and hosted register actions share before they touch a store. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { REGISTERS } from '../../src/lib/views/registers/defs';
import { checkDelete, checkSave, readDelete, readSave, registerHead, STALE } from '../../src/lib/views/registers/shown';

const def = REGISTERS.deadlines_tab;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const entry = { title: 'Synthetic deadline', date: '2026-11-04', cat: 'Filing', note: '' };

describe('readSave and checkSave', () => {
	it('reads the entry, the row and its version, and the operation id', () => {
		const s = readSave(def, form({ ...entry, rowId: 'row-1', version: 'v1', operationId: 'op-1' }));
		expect([s.values, s.rowId, s.version, s.operationId]).toEqual([entry, 'row-1', 'v1', 'op-1']);
		expect(readSave(def, form(entry))).toMatchObject({ rowId: null, version: null, operationId: null });
	});
	it('skips an empty entry, refuses a missing title, and refuses an edit without its version', () => {
		expect(checkSave(def, readSave(def, form({ title: '', date: '', cat: 'Filing', note: '' })))).toEqual({ saved: false });
		expect(checkSave(def, readSave(def, form({ ...entry, title: '' })))).toMatchObject({ status: 400, data: { op: 'save', values: { date: '2026-11-04' } } });
		expect(checkSave(def, readSave(def, form({ ...entry, date: 'not a date' })))).toMatchObject({ status: 400 });
		expect(checkSave(def, readSave(def, form({ ...entry, rowId: 'row-1' })))).toMatchObject({ status: 409, data: { message: STALE, rowId: 'row-1' } });
		expect(checkSave(def, readSave(def, form({ ...entry, rowId: 'row-1', version: 'v1' })))).toBeNull();
		expect(checkSave(def, readSave(def, form(entry)))).toBeNull();
	});
});

describe('readDelete and checkDelete', () => {
	it('names the row from the delete button, cancel or the edited row, and the version the page showed', () => {
		expect(readDelete(def, form({ delete: 'row-1', deleteVersion: 'v1' }))).toMatchObject({ rowId: 'row-1', version: 'v1', draft: {} });
		expect(readDelete(def, form({ cancel: 'row-2' })).rowId).toBe('row-2');
		expect(readDelete(def, form({ rowId: 'row-3', ...entry }))).toMatchObject({ rowId: 'row-3', version: null, draft: { values: entry } });
		expect(readDelete(def, form({})).rowId).toBeNull();
	});
	it('deletes only once confirmed for exactly that row', () => {
		expect(checkDelete(form({}), null, {})).toMatchObject({ status: 400, data: { message: 'No entry was named.' } });
		expect(checkDelete(form({ delete: 'row-1' }), 'row-1', {})).toMatchObject({ status: 400, data: { confirm: 'row-1' } });
		expect(checkDelete(form({ delete: 'row-1', confirm: 'row-9' }), 'row-1', {})).toMatchObject({ status: 400, data: { confirm: 'row-1' } });
		expect(checkDelete(form({ delete: 'row-1', cancel: 'row-1' }), 'row-1', {})).toMatchObject({ status: 400, data: { confirm: null } });
		expect(checkDelete(form({ delete: 'row-1', confirm: 'row-1' }), 'row-1', {})).toBeNull();
	});
});

describe('registerHead', () => {
	it('is the page header of every register, with the deadlines export an .ics', () => {
		expect(registerHead('deadlines_tab', def)).toMatchObject({ view: 'deadlines_tab', label: 'Deadlines', export: { kind: 'ics', name: 'deadlines.ics' }, required: ['title', 'date'], keepAfterAdd: ['cat'] });
	});
});
