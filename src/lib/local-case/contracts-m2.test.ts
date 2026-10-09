// The M2 contracts beyond views: the document-row read contract (v5 allRows()) with providers, and the enumerable
// user-work store that a generic backup lists and round-trips, including tables a later ticket defines.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import { activeDocumentRows, documentCounts, documentRow, documentRows, listJson, registerDocumentRowProvider } from './documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import { UserWorkError } from './user-work.server.ts';

const roots: string[] = [];
const open: LocalCase[] = [];
const undo: (() => void)[] = [];
afterEach(async () => {
	for (const u of undo.splice(0)) u();
	for (const lc of open.splice(0)) lc.shutdown();
	for (const r of roots.splice(0)) await cleanup(r);
});
async function setup(tag: string) {
	const root = await tempRoot(tag);
	roots.push(root);
	const lc = service(path.join(root, 'data'));
	open.push(lc);
	await lc.startup();
	const c = await buildCase(path.join(root, 'c'));
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	return { root, lc, c, imp };
}

const providerState: DocumentStateRow = { file: 'missing', preview: 'none', text: 'pending', mediaType: null, flags: ['rescan'], original: null, self: null };
const providerList = (ref: string): Omit<ChronologyListRow, 'ord'> => ({ ref, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Rescan', subject: 'new file', filename: 'new.pdf', sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'pending', parentRef: null, file: 'missing', preview: 'none', attachments: 0 });

describe('document rows', () => {
	it('returns the imported register in source order with raw rows, list entries and states', async () => {
		const { lc, c, imp } = await setup('rows');
		expect(activeDocumentRows(lc, 'e2e-case')).toEqual({ resultsVersion: null, rows: [], dropped: [], failed: [] });
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
		const { resultsVersion, rows, dropped } = activeDocumentRows(lc, 'e2e-case');
		expect(resultsVersion).toBe(c.resultsVersion);
		const source = lc.store.projectionRows(c.resultsVersion).documents.sort((a, b) => a.ord - b.ord);
		expect(rows.map((r) => [r.ref, r.ord, r.source])).toEqual(source.map((d) => [d.ref, d.ord, 'results']));
		expect(rows[0]!.row).toEqual(JSON.parse(source[0]!.row_json));
		expect(Object.isFrozen(rows[0]!.row)).toBe(true);
		expect(dropped).toEqual([]);
		expect(listJson(lc.store, c.resultsVersion)!.json).toBe(lc.store.chronologyJson(c.resultsVersion));
	});

	it('appends provider rows after the register without changing readers, never shadowing an imported ref', async () => {
		const { lc, c } = await setup('provider');
		const plain = listJson(lc.store, c.resultsVersion)!;
		const state: DocumentStateRow = { file: 'missing', preview: 'none', text: 'pending', mediaType: null, flags: ['rescan'], original: null, self: null };
		const list = (ref: string): Omit<ChronologyListRow, 'ord'> => ({ ref, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Rescan', subject: 'new file', filename: 'new.pdf', sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url: '', textStatus: 'pending', parentRef: null, file: 'missing', preview: 'none', attachments: 0 });
		let rev = 'r1';
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => rev, rows: () => [{ ref: 'RS-001', row: { ref: 'RS-001', _new: true }, list: list('RS-001'), state }, { ref: 'OD-001', row: {}, list: list('OD-001'), state }] }));
		expect(() => registerDocumentRowProvider({ id: 'rescan', owner: 'x', revision: () => '', rows: () => [] })).toThrow();
		const { rows, dropped } = documentRows(lc.store, c.resultsVersion);
		expect(rows.at(-1)).toMatchObject({ ref: 'RS-001', source: 'provider:rescan', ord: rows.length - 1 });
		expect(rows.filter((r) => r.ref === 'OD-001').map((r) => r.source)).toEqual(['results']);
		expect(dropped).toEqual([{ source: 'provider:rescan', ref: 'OD-001', reason: expect.any(String) }]);
		const withProvider = listJson(lc.store, c.resultsVersion)!;
		expect((JSON.parse(withProvider.json) as ChronologyListRow[]).map((r) => r.ref).at(-1)).toBe('RS-001');
		expect(withProvider.etag).not.toBe(plain.etag);
		rev = 'r2';
		expect(listJson(lc.store, c.resultsVersion)!.etag).not.toBe(withProvider.etag);
	});

	it('every reader honours the contract: one row by ref (imported refs unshadowed) and the overview count', async () => {
		const { lc, c } = await setup('reader');
		const imported = documentRows(lc.store, c.resultsVersion).rows.length;
		expect(documentCounts(lc.store, c.resultsVersion)).toEqual({ total: imported, imported, provided: 0, failed: [] });
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toBeNull();
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => 'r1', rows: () => [
			{ ref: 'RS-001', row: { ref: 'RS-001', subject: 'rescanned' }, list: providerList('RS-001'), state: providerState },
			{ ref: 'OD-001', row: { ref: 'OD-001', subject: 'SHADOW' }, list: providerList('OD-001'), state: providerState },
			{ ref: 'RS-001', row: { ref: 'RS-001', subject: 'duplicate' }, list: providerList('RS-001'), state: providerState },
		] }));
		const all = documentRows(lc.store, c.resultsVersion);
		// the detail reader finds the provider row, and an imported ref is always the imported document
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toEqual(all.rows.find((r) => r.ref === 'RS-001'));
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toMatchObject({ source: 'provider:rescan', row: { subject: 'rescanned' } });
		const od = documentRow(lc.store, c.resultsVersion, 'OD-001')!;
		expect(od).toEqual(all.rows.find((r) => r.ref === 'OD-001'));
		expect([od.source, od.row.subject]).toEqual(['results', 'Synthetic subject OD-001']);
		expect(documentRow(lc.store, c.resultsVersion, 'ZZ-404')).toBeNull();
		// the overview count is the contract's row count
		expect(documentCounts(lc.store, c.resultsVersion)).toEqual({ total: all.rows.length, imported, provided: 1, failed: [] });
		expect(all.rows.length).toBe(imported + 1);
		expect((JSON.parse(listJson(lc.store, c.resultsVersion)!.json) as unknown[]).length).toBe(all.rows.length);
	});

	it('isolates a provider that throws: its rows are left out and reported, the list and counts still answer', async () => {
		const { lc, c } = await setup('throw');
		const plain = documentRows(lc.store, c.resultsVersion).rows.length;
		undo.push(registerDocumentRowProvider({ id: 'broken', owner: 'GRS-20', revision: () => { throw new Error('revision down'); }, rows: () => { throw new Error('rescan index unreadable'); } }));
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => 'r1', rows: () => [{ ref: 'RS-001', row: {}, list: providerList('RS-001'), state: providerState }] }));
		const failed = [{ source: 'provider:broken', owner: 'GRS-20', reason: 'rescan index unreadable' }];
		const r = documentRows(lc.store, c.resultsVersion);
		expect(r.failed).toEqual(failed);
		expect(r.rows.map((x) => x.source).filter((x) => x !== 'results')).toEqual(['provider:rescan']);
		expect(r.rows.length).toBe(plain + 1);
		const list = listJson(lc.store, c.resultsVersion)!;
		expect(list.failed).toEqual(failed);
		expect((JSON.parse(list.json) as unknown[]).length).toBe(plain + 1);
		expect(list.etag).toContain('failed=provider:broken');
		expect(documentCounts(lc.store, c.resultsVersion)).toEqual({ total: plain + 1, imported: plain, provided: 1, failed });
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')?.source).toBe('provider:rescan');
	});
});

describe('enumerable user work', () => {
	it('lists every work.sqlite table with its kind, and round-trips all user work generically', async () => {
		const { lc, c } = await setup('enum');
		const uw = lc.userWork;
		const kinds = Object.fromEntries(uw.tables().map((t) => [t.name, t.kind]));
		expect(kinds).toEqual({ active: 'activation', activation_log: 'activation', note: 'user-work', register_row: 'user-work', seed_overlay: 'user-work', trusted_warning: 'user-work' });
		await uw.addNote('e2e-case', c.resultsVersion, 'OD-001', 'note one');
		await uw.putRow('e2e-case', 'deadlines', null, { title: 'Synthetic', date: '2030-01-01' });
		await uw.putRow('e2e-case', 'privilege-log', null, { ref: 'OD-002' });
		expect(uw.registerStores('e2e-case')).toEqual(['deadlines', 'privilege-log']);
		// a later ticket defines its own table; the generic export includes it without code changes
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'] });
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'] }); // idempotent
		lc.storage.db().prepare('INSERT INTO work.timesheet_entry VALUES (?, ?, ?, ?)').run('e2e-case', 'e-1', 2.5, new Uint8Array([0, 1, 255]));
		// a table created behind the catalogue's back is still enumerated, as unregistered
		lc.storage.db().exec('CREATE TABLE work.stray(id TEXT PRIMARY KEY, v TEXT)');
		lc.storage.db().exec("INSERT INTO work.stray VALUES ('s1', 'kept')");
		const snapshot = uw.exportAll();
		expect(snapshot.tables.map((t) => [t.name, t.kind, t.rows.length])).toEqual([['note', 'user-work', 1], ['register_row', 'user-work', 2], ['seed_overlay', 'user-work', 0], ['stray', 'unregistered', 1], ['timesheet_entry', 'user-work', 1], ['trusted_warning', 'user-work', 0]]);
		const json = JSON.parse(JSON.stringify(snapshot));

		// restore into a fresh data directory: every table and row comes back, including the defined and stray ones
		const root2 = await tempRoot('enum2');
		roots.push(root2);
		const lc2 = service(path.join(root2, 'data'));
		open.push(lc2);
		await lc2.startup();
		await lc2.userWork.putRow('e2e-case', 'deadlines', null, { title: 'to be replaced' });
		expect(await lc2.userWork.importAll(json)).toEqual({ tables: 6, rows: 5 });
		const again = lc2.userWork.exportAll();
		expect(again.tables.map((t) => [t.name, t.rows])).toEqual(snapshot.tables.map((t) => [t.name, t.rows]));
		expect((lc2.storage.db().prepare('SELECT blob FROM work.timesheet_entry').get() as { blob: Uint8Array }).blob).toEqual(new Uint8Array([0, 1, 255]));
	});

	it('refuses table definitions without stable keys and restores that would not fit', async () => {
		const { lc } = await setup('enumbad');
		const uw = lc.userWork;
		await expect(uw.defineTable({ name: 'x', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: [] })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'Bad-Name', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: ['a'] })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'note', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: ['a'] })).rejects.toBeInstanceOf(UserWorkError);
		const snap = uw.exportAll();
		const bad = { ...snap, tables: snap.tables.map((t) => (t.name === 'note' ? { ...t, columns: t.columns.slice(1) } : t)) };
		await expect(uw.importAll(bad)).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.importAll({ format: 'other' } as never)).rejects.toBeInstanceOf(UserWorkError);
	});
});
