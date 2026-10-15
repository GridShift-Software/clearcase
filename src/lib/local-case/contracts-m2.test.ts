import path from 'node:path';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import { OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId } from '../components/overview-slots.ts';
import { activeDocumentRows, documentCounts, documentRow, documentRows, listJson, registerDocumentRowProvider } from './documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import { MAX_SLOT_DATA_DEPTH, notPlainData, slotStates } from './overview-widgets.server.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import { USER_WORK_EXPORT, UserWorkError, type TableCell } from './user-work.server.ts';

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
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toEqual(all.rows.find((r) => r.ref === 'RS-001'));
		expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toMatchObject({ source: 'provider:rescan', row: { subject: 'rescanned' } });
		const od = documentRow(lc.store, c.resultsVersion, 'OD-001')!;
		expect(od).toEqual(all.rows.find((r) => r.ref === 'OD-001'));
		expect([od.source, od.row.subject]).toEqual(['results', 'Synthetic subject OD-001']);
		expect(documentRow(lc.store, c.resultsVersion, 'ZZ-404')).toBeNull();
		expect(documentCounts(lc.store, c.resultsVersion)).toEqual({ total: all.rows.length, imported, provided: 1, failed: [] });
		expect(all.rows.length).toBe(imported + 1);
		expect((JSON.parse(listJson(lc.store, c.resultsVersion)!.json) as unknown[]).length).toBe(all.rows.length);
	});

	it('isolates a provider that throws: its rows are left out and reported, the list and counts still answer', async () => {
		const { lc, c } = await setup('throw');
		const plain = documentRows(lc.store, c.resultsVersion).rows.length;
		undo.push(registerDocumentRowProvider({ id: 'broken', owner: 'GRS-20', revision: () => { throw new Error('revision down'); }, rows: () => { throw new Error('rescan index unreadable'); } }));
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => 'r1', rows: () => [{ ref: 'RS-001', row: {}, list: providerList('RS-001'), state: providerState }] }));
		const failed = [{ source: 'provider:broken', owner: 'GRS-20', reason: 'revision down' }];
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
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'], scope: 'case' });
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'], scope: 'case' });
		lc.storage.db().prepare('INSERT INTO work.timesheet_entry VALUES (?, ?, ?, ?)').run('e2e-case', 'e-1', 2.5, new Uint8Array([0, 1, 255]));
		lc.storage.db().exec('CREATE TABLE work.stray(id TEXT PRIMARY KEY, v TEXT)');
		lc.storage.db().exec("INSERT INTO work.stray VALUES ('s1', 'kept')");
		const snapshot = uw.exportAll();
		expect(snapshot.tables.map((t) => [t.name, t.kind, t.rows.length])).toEqual([['note', 'user-work', 1], ['register_row', 'user-work', 2], ['seed_overlay', 'user-work', 0], ['stray', 'unregistered', 1], ['timesheet_entry', 'user-work', 1], ['trusted_warning', 'user-work', 0]]);
		const json = JSON.parse(JSON.stringify(snapshot));

		const root2 = await tempRoot('enum2');
		roots.push(root2);
		const lc2 = service(path.join(root2, 'data'));
		open.push(lc2);
		await lc2.startup();
		await lc2.userWork.putRow('e2e-case', 'deadlines', null, { title: 'to be replaced' });
		expect(await lc2.userWork.importAll(json)).toMatchObject({ tables: 6, rows: 5, cases: ['e2e-case'] });
		const again = lc2.userWork.exportAll();
		expect(again.tables.map((t) => [t.name, t.rows])).toEqual(snapshot.tables.map((t) => [t.name, t.rows]));
		expect((lc2.storage.db().prepare('SELECT blob FROM work.timesheet_entry').get() as { blob: Uint8Array }).blob).toEqual(new Uint8Array([0, 1, 255]));
	});

	it('refuses table definitions without stable keys and restores that would not fit', async () => {
		const { lc } = await setup('enumbad');
		const uw = lc.userWork;
		await expect(uw.defineTable({ name: 'x', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: [], scope: 'store' })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'Bad-Name', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: ['a'], scope: 'store' })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'note', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' }], primaryKey: ['a'], scope: 'store' })).rejects.toBeInstanceOf(UserWorkError);
		const snap = uw.exportAll();
		const bad = { ...snap, tables: snap.tables.map((t) => (t.name === 'note' ? { ...t, columns: t.columns.slice(1) } : t)) };
		await expect(uw.importAll(bad)).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.importAll({ format: 'other' } as never)).rejects.toBeInstanceOf(UserWorkError);
	});

	it('refuses a restore into an existing table of another schema (type, NOT NULL, key order) and leaves every table and row unchanged', async () => {
		const { lc } = await setup('schema');
		const cases: [string, string, string][] = [
			['(id TEXT PRIMARY KEY, value TEXT)', '(id TEXT PRIMARY KEY, value INTEGER)', "('k0', 7)"],
			['(id TEXT PRIMARY KEY, value TEXT)', '(id TEXT PRIMARY KEY, value TEXT NOT NULL)', "('k0', 'kept')"],
			['(a TEXT, b TEXT, PRIMARY KEY(a, b))', '(a TEXT, b TEXT, PRIMARY KEY(b, a))', "('x', 'y')"],
			['(a TEXT, b TEXT, PRIMARY KEY(a, b))', '(a TEXT PRIMARY KEY, b TEXT)', "('x', 'y')"],
		];
		const db = lc.storage.db();
		for (const [i, [src]] of cases.entries()) {
			db.exec(`CREATE TABLE work.shape_${i}${src}`);
			db.exec(`INSERT INTO work.shape_${i} VALUES ${src.startsWith('(id') ? "('k1', '001')" : "('a1', 'b1')"}`);
		}
		const snap = JSON.parse(JSON.stringify(lc.userWork.exportAll()));
		const root2 = await tempRoot('schema2');
		roots.push(root2);
		const lc2 = service(path.join(root2, 'data'));
		open.push(lc2);
		await lc2.startup();
		const db2 = lc2.storage.db();
		await lc2.userWork.putRow('e2e-case', 'deadlines', null, { title: 'kept' });
		for (const [i, [, target, existing]] of cases.entries()) { db2.exec(`CREATE TABLE work.shape_${i}${target}`); db2.exec(`INSERT INTO work.shape_${i} VALUES ${existing}`); }
		const before = JSON.stringify(lc2.userWork.exportAll().tables);
		for (const i of cases.keys()) {
			const one = { ...snap, tables: snap.tables.filter((t: { name: string }) => !t.name.startsWith('shape_') || t.name === `shape_${i}`) };
			await expect(lc2.userWork.importAll(one)).rejects.toThrow(new RegExp(`^table shape_${i}: .*nothing was restored`));
			expect(JSON.stringify(lc2.userWork.exportAll().tables)).toBe(before);
		}
		expect(db2.prepare('SELECT id, value, typeof(value) AS t FROM work.shape_0').all().map((r) => ({ ...r }))).toEqual([{ id: 'k0', value: 7, t: 'integer' }]);
		db.exec('CREATE TABLE work.shape_ok(id TEXT PRIMARY KEY, value TEXT)');
		db.exec("INSERT INTO work.shape_ok VALUES ('k1', '001')");
		const ok = JSON.parse(JSON.stringify(lc.userWork.exportAll()));
		const okTable = ok.tables.find((t: { name: string }) => t.name === 'shape_ok');
		okTable.columns[0].notNull = true;
		db2.exec("CREATE TABLE work.shape_ok(id text PRIMARY KEY, value text); INSERT INTO work.shape_ok VALUES ('k0', 'gone')");
		expect(await lc2.userWork.importAll({ ...ok, tables: ok.tables.filter((t: { name: string }) => t.name === 'shape_ok') })).toMatchObject({ tables: 1, rows: 1, restored: [{ name: 'shape_ok', scope: 'store', action: 'merged', rows: 1, deleted: 0 }] });
		expect(db2.prepare('SELECT id, value, typeof(value) AS t FROM work.shape_ok ORDER BY id').all().map((r) => ({ ...r }))).toEqual([{ id: 'k0', value: 'gone', t: 'text' }, { id: 'k1', value: '001', t: 'text' }]);
	});

	it('enumerates tables whose names start with sqlite (no LIKE wildcard) and refuses that prefix in defineTable', async () => {
		const { lc } = await setup('sqliteprefix');
		const uw = lc.userWork;
		const db = lc.storage.db();
		db.exec('CREATE TABLE work.sqlite1(id TEXT PRIMARY KEY, v TEXT)');
		db.exec('CREATE TABLE work.sqlitebackup(id TEXT PRIMARY KEY, v TEXT)');
		db.exec("INSERT INTO work.sqlite1 VALUES ('a', 'kept')");
		expect(uw.tables().map((t) => t.name)).toEqual(expect.arrayContaining(['sqlite1', 'sqlitebackup']));
		await expect(uw.defineTable({ name: 'sqlitebackup', owner: 'GRS-20', description: '', columns: [{ name: 'id', type: 'TEXT' }], primaryKey: ['id'], scope: 'store' })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'sqlite_x', owner: 'GRS-20', description: '', columns: [{ name: 'id', type: 'TEXT' }], primaryKey: ['id'], scope: 'store' })).rejects.toBeInstanceOf(UserWorkError);
		const snap = uw.exportAll();
		expect(snap.tables.map((t) => t.name)).not.toContain('sqlite1');
		expect(snap.excluded).toEqual(expect.arrayContaining([{ name: 'sqlite1', kind: 'unregistered', rows: 1, reason: expect.stringContaining('sqlite') }, { name: 'sqlitebackup', kind: 'unregistered', rows: 0, reason: expect.stringContaining('sqlite') }]));
	});

	it('always restores its own export: unrestorable tables are excluded with a reason, never a refused restore', async () => {
		const { lc } = await setup('symmetric');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.putRow('e2e-case', 'deadlines', null, { title: 'Synthetic' });
		db.exec('CREATE TABLE work.stray_nopk(a TEXT, b TEXT)');
		db.exec("INSERT INTO work.stray_nopk VALUES ('x', 'y')");
		db.exec('CREATE TABLE work.stray_datetime(id TEXT PRIMARY KEY, at DATETIME)');
		db.exec('CREATE TABLE work.stray_nullkey(id TEXT PRIMARY KEY, v TEXT)');
		db.exec("INSERT INTO work.stray_nullkey VALUES (NULL, 'rowid tables allow it')");
		db.exec('CREATE TABLE work.stray_ok(id TEXT PRIMARY KEY, v text)');
		db.exec("INSERT INTO work.stray_ok VALUES ('k', 'kept')");
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		expect(snap.excluded.map((x: { name: string }) => x.name).sort()).toEqual(['stray_datetime', 'stray_nopk', 'stray_nullkey']);
		expect(snap.excluded.every((x: { reason: string }) => x.reason.length > 0)).toBe(true);
		const root2 = await tempRoot('symmetric2');
		roots.push(root2);
		const lc2 = service(path.join(root2, 'data'));
		open.push(lc2);
		await lc2.startup();
		expect(await lc2.userWork.importAll(snap)).toMatchObject({ tables: snap.tables.length, rows: 2 });
		const back = lc2.userWork.exportAll();
		expect(back.tables.map((t) => [t.name, t.kind, t.rows])).toEqual(snap.tables.map((t: { name: string; kind: string; rows: unknown }) => [t.name, t.kind, t.rows]));
		expect(await lc2.userWork.importAll(JSON.parse(JSON.stringify(back)))).toMatchObject({ tables: back.tables.length, rows: 2 });
	});

	it('exports INTEGERs beyond the JS safe range losslessly and restores them exactly', async () => {
		const { lc } = await setup('bigint');
		const uw = lc.userWork;
		const big = [2n ** 63n - 1n, -(2n ** 63n), 9007199254740993n];
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: 'big keys', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'n', type: 'INTEGER' }, { name: 'r', type: 'REAL' }], primaryKey: ['id'], scope: 'store' });
		const db = lc.storage.db();
		for (const [i, n] of big.entries()) db.prepare('INSERT INTO work.counter VALUES (?, ?, ?)').run(n, i, 0.5);
		db.exec('CREATE TABLE work.stray_big(id TEXT PRIMARY KEY, v INTEGER)');
		db.prepare("INSERT INTO work.stray_big VALUES ('k', ?)").run(2n ** 60n);
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		expect(snap.excluded).toEqual([]);
		expect(snap.tables.find((t: { name: string }) => t.name === 'counter').rows).toEqual([{ id: { $int: String(-(2n ** 63n)) }, n: 1, r: 0.5 }, { id: { $int: '9007199254740993' }, n: 2, r: 0.5 }, { id: { $int: String(2n ** 63n - 1n) }, n: 0, r: 0.5 }]);
		const root2 = await tempRoot('bigint2');
		roots.push(root2);
		const lc2 = service(path.join(root2, 'data'));
		open.push(lc2);
		await lc2.startup();
		expect(await lc2.userWork.importAll(snap)).toMatchObject({ tables: snap.tables.length, rows: 4 });
		const read = (sql: string) => { const st = lc2.storage.db().prepare(sql); st.setReadBigInts(true); return st.all().map((r) => ({ ...r })); };
		expect(read('SELECT id FROM work.counter ORDER BY id').map((r) => r.id)).toEqual([...big].sort((a, b) => (a < b ? -1 : 1)));
		expect(read('SELECT v FROM work.stray_big')).toEqual([{ v: 2n ** 60n }]);
		const again = JSON.parse(JSON.stringify(lc2.userWork.exportAll()));
		expect(again.tables.map((t: { name: string; rows: unknown }) => [t.name, t.rows])).toEqual(snap.tables.map((t: { name: string; rows: unknown }) => [t.name, t.rows]));
	});

	it('restores atomically: a refused restore creates no table, and a failure while writing rows rolls the tables back', async () => {
		const { lc } = await setup('atomic');
		const uw = lc.userWork;
		const before = uw.tables().map((t) => t.name);
		const col = (name: string, type: string, pk = 0) => ({ name, type, notNull: pk > 0, pk });
		const table = (name: string, columns: ReturnType<typeof col>[], rows: Record<string, unknown>[] = []) => ({ name, kind: 'user-work', owner: 'GRS-20', description: '', columns, rows });
		const refused = { format: 'clearcase.user-work/1', exportedAt: '2030-01-01T00:00:00Z', tables: [table('alpha_new', [col('id', 'TEXT', 1)]), table('beta_bad', [col('id', 'TEXT', 1), col('at', 'DATETIME')])] };
		await expect(uw.importAll(refused as never)).rejects.toBeInstanceOf(UserWorkError);
		expect(uw.tables().map((t) => t.name)).toEqual(before);
		const failing = { format: 'clearcase.user-work/1', exportedAt: '2030-01-01T00:00:00Z', tables: [table('gamma_new', [col('id', 'TEXT', 1)], [{ id: 'ok' }, { id: null }])] };
		await expect(uw.importAll(failing as never)).rejects.toThrow();
		expect(uw.tables().map((t) => t.name)).toEqual(before);
	});
});

describe('gate follow-ups: user-work restore and defineTable (CC-24 F1, F7-F10)', () => {
	const col = (name: string, type: string, notNull = false, pk = 0) => ({ name, type, notNull, pk });
	const envelope = (tables: unknown[]) => JSON.parse(JSON.stringify({ format: USER_WORK_EXPORT, exportedAt: '2030-01-01T00:00:00Z', tables }));
	const code = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return e instanceof UserWorkError ? e.code : `untyped ${(e as Error).name}`; } };
	const logColumns = [col('id', 'INTEGER', false, 1), col('case_id', 'TEXT', true), col('version_id', 'TEXT', true), col('at', 'TEXT', true), col('kind', 'TEXT', true), col('manifest_sha256', 'TEXT', true), col('read_model_sha256', 'TEXT', true), col('diagnostics_sha256', 'TEXT', true), col('validator_version', 'TEXT', true), col('acknowledgement', 'TEXT'), col('accepted_warnings', 'TEXT', true)];

	it('F1 refuses a restore that carries activation tables, writes nothing, and the active case survives a restart', async () => {
		const { root, lc, c, imp } = await setup('f1');
		expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
		const log = lc.store.activationLog('e2e-case').length;
		await lc.userWork.putRow('e2e-case', 'deadlines', null, { title: 'kept' });
		const register = lc.userWork.exportAll().tables.find((t) => t.name === 'register_row')!;
		const emptied = { name: 'activation_log', kind: 'activation', owner: 'GRS-12', description: '', columns: logColumns, rows: [] };
		const pointer = { name: 'active', kind: 'activation', owner: 'GRS-12', description: '', columns: [col('case_id', 'TEXT', true, 1), col('version_id', 'TEXT', true), col('previous_version_id', 'TEXT'), col('activated_at', 'TEXT', true)], rows: [] };
		const changed = { ...register, rows: register.rows.map((r) => ({ ...r, fields: '{"title":"restored"}' })) };
		for (const t of [emptied, { ...emptied, kind: 'user-work' }, pointer, { name: 'import_attempt', kind: 'user-work', owner: 'x', description: '', columns: [col('id', 'TEXT', true, 1)], rows: [] }]) {
			expect(await code(lc.userWork.importAll(envelope([changed, t])))).toBe('restore-state');
		}
		expect(lc.store.activationLog('e2e-case').length).toBe(log);
		expect(lc.userWork.listRows('e2e-case', 'deadlines').map((r) => r.fields.title)).toEqual(['kept']);
		expect(lc.userWork.exportAll({ kinds: ['activation'] })).toMatchObject({ tables: [], excluded: [{ name: 'activation_log' }, { name: 'active' }] });
		lc.shutdown();
		open.pop();
		const lc2 = service(path.join(root, 'data'));
		open.push(lc2);
		await lc2.startup();
		expect(lc2.effectiveActive('e2e-case')).toBe(c.resultsVersion);
	});

	it('F7 a restore never creates trust: trusted_warning rows are dropped and reported, the store keeps its own', async () => {
		const { lc } = await setup('f7');
		const before = [...lc.trustedFor('e2e-case')];
		const trusted = { name: 'trusted_warning', kind: 'user-work', owner: 'GRS-12', description: '', columns: [col('case_id', 'TEXT', true, 1), col('fingerprint', 'TEXT', true, 2), col('accepted_at', 'TEXT', true)], rows: [{ case_id: 'e2e-case', fingerprint: 'fp-never-acknowledged', accepted_at: '2030-01-01T00:00:00Z' }] };
		for (const replace of ['cases', 'tables'] as const) {
			const r = await lc.userWork.importAll(envelope([trusted]), { replace });
			expect(r).toEqual({ tables: 1, rows: 0, cases: [], restored: [{ name: 'trusted_warning', scope: 'case', action: 'dropped', rows: 0, deleted: 0 }], dropped: [{ name: 'trusted_warning', rows: 1, reason: expect.any(String) }] });
			expect([...lc.trustedFor('e2e-case')]).toEqual(before);
		}
		expect(lc.userWork.exportAll().tables.find((t) => t.name === 'trusted_warning')!.rows).toEqual([]);
	});

	it('F8 restores case-scoped by default: rows of cases absent from the snapshot are kept; whole tables only on request', async () => {
		const { lc } = await setup('f8');
		const uw = lc.userWork;
		await uw.putRow('e2e-case', 'deadlines', 'a-1', { title: 'in the snapshot' });
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: '', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }], primaryKey: ['case_id', 'entry_id'], scope: 'case' });
		lc.storage.db().prepare('INSERT INTO work.timesheet_entry VALUES (?, ?)').run('e2e-case', 'e-1');
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		await uw.putRow('e2e-case', 'deadlines', 'a-2', { title: 'after the snapshot' });
		await uw.putRow('other-case', 'deadlines', 'b-1', { title: 'another case' });
		lc.storage.db().prepare('INSERT INTO work.timesheet_entry VALUES (?, ?)').run('other-case', 'e-9');
		await uw.importAll(snap);
		expect(uw.listRows('e2e-case', 'deadlines').map((r) => r.rowId)).toEqual(['a-1']);
		expect(uw.listRows('other-case', 'deadlines').map((r) => r.rowId)).toEqual(['b-1']);
		expect(lc.storage.db().prepare('SELECT case_id, entry_id FROM work.timesheet_entry ORDER BY case_id').all().map((r) => ({ ...r }))).toEqual([{ case_id: 'e2e-case', entry_id: 'e-1' }, { case_id: 'other-case', entry_id: 'e-9' }]);
		await uw.importAll(snap, { replace: 'tables' });
		expect(uw.registerStores('other-case')).toEqual([]);
		expect(lc.storage.db().prepare('SELECT count(*) AS n FROM work.timesheet_entry').get()).toEqual({ n: 1 });
		expect(await code(uw.importAll(snap, { replace: 'all' as never }))).toBe('invalid');
	});

	it('F9 refuses a restore with an empty or non-integer key, writing nothing, so the next export keeps the table', async () => {
		const { lc, c } = await setup('f9');
		const uw = lc.userWork;
		await uw.addNote('e2e-case', c.resultsVersion, 'OD-001', 'kept note');
		const note = uw.exportAll().tables.find((t) => t.name === 'note')!;
		const row = note.rows[0]!;
		for (const id of [null, undefined]) {
			const tables = [{ ...note, rows: [{ ...row, id: 'n-2' }, { ...row, id }] }];
			expect(await code(uw.importAll(envelope(tables)))).toBe('restore-key');
		}
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'INTEGER' }], primaryKey: ['id'], scope: 'store' });
		for (const id of [1.5, 'x', { $int: '1e3' }]) expect(await code(uw.importAll(envelope([{ name: 'counter', kind: 'user-work', owner: 'GRS-17', description: '', columns: [col('id', 'INTEGER', true, 1)], rows: [{ id }] }])))).toBe('restore-key');
		const after = uw.exportAll();
		expect(after.excluded).toEqual([]);
		expect(after.tables.find((t) => t.name === 'note')!.rows).toEqual([row]);
	});

	it('F10 defineTable refuses another primary key or owner on an existing table, and every built-in table', async () => {
		const { lc } = await setup('f10');
		const uw = lc.userWork;
		const columns = [{ name: 'case_id', type: 'TEXT' as const }, { name: 'entry_id', type: 'TEXT' as const }];
		await uw.defineTable({ name: 'timesheet', owner: 'GRS-17', description: '', columns, primaryKey: ['case_id', 'entry_id'], scope: 'case' });
		expect(await code(uw.defineTable({ name: 'timesheet', owner: 'GRS-17', description: '', columns: [{ ...columns[0]!, notNull: true }, columns[1]!], primaryKey: ['entry_id'], scope: 'case' }))).toBe('table-conflict');
		expect(await code(uw.defineTable({ name: 'timesheet', owner: 'GRS-18', description: 'other', columns, primaryKey: ['case_id', 'entry_id'], scope: 'case' }))).toBe('table-conflict');
		expect(await code(uw.defineTable({ name: 'timesheet', owner: 'GRS-17', description: 'updated', columns, primaryKey: ['case_id', 'entry_id'], scope: 'case' }))).toBe('accepted');
		const before = uw.tables();
		for (const t of before.filter((x) => x.kind !== 'unregistered' && x.name !== 'timesheet')) {
			const def = { name: t.name, owner: 'GRS-99', description: 'taken over', columns: t.columns.map((x) => ({ name: x.name, type: x.type as 'TEXT', notNull: x.notNull })), primaryKey: t.columns.filter((x) => x.pk > 0).sort((a, b) => a.pk - b.pk).map((x) => x.name), scope: t.scope };
			expect([t.name, await code(uw.defineTable(def))]).toEqual([t.name, 'table-built-in']);
			expect([t.name, await code(uw.defineTable({ ...def, owner: t.owner }))]).toEqual([t.name, 'table-built-in']);
		}
		expect(await code(uw.defineTable({ name: 'document', owner: 'GRS-17', description: '', columns, primaryKey: ['entry_id'], scope: 'store' }))).toBe('table-built-in');
		expect(uw.tables().map((t) => [t.name, t.owner, t.kind])).toEqual(before.map((t) => [t.name, t.owner, t.kind]));
	});
});

describe('gate follow-ups: overview slots (CC-24 F2, F3)', () => {
	it('F2 slot data with an own __proto__, constructor or prototype key, or nested too deep, marks only its slot', async () => {
		const deep = (n: number) => { let o: Record<string, unknown> = { leaf: true }; for (let i = 0; i < n; i++) o = { c: o }; return o; };
		const thenableMap = Object.assign(new Map(), { then: () => {} });
		const bad = [JSON.parse('{"__proto__": {"x": 1}, "ok": 1}'), JSON.parse('{"constructor": {"prototype": {}}}'), { list: [{ prototype: 1 }] }, Object.assign(Object.create(null), JSON.parse('{"__proto__": 1}')), deep(MAX_SLOT_DATA_DEPTH + 1), thenableMap];
		for (const v of bad) expect(notPlainData(v)).toEqual(expect.any(String));
		expect(notPlainData(deep(MAX_SLOT_DATA_DEPTH - 1))).toBeNull();
		expect(notPlainData(new Map([['__proto__', 1]]))).toBeNull();
		expect(notPlainData({ constructor: 'Synthetic secret' })).not.toContain('Synthetic secret');
		for (const v of bad) {
			const loaders = new Map<SlotId, OverviewWidgetLoader>([['deadlines', { slot: 'deadlines', load: () => v }], ['unbilled-time', { slot: 'unbilled-time', load: () => ({ hours: 1 }) }]]);
			expect((await slotStates({ app: null, caseId: 'c', caseName: 'Case', resultsVersion: 'r' }, loaders)).map((x) => x.status)).toEqual(['error', 'filled', 'unavailable']);
		}
	});

	it('F3 a slot loader that never settles times out to its error state; the other slots render', async () => {
		const loaders = new Map<SlotId, OverviewWidgetLoader>([['deadlines', { slot: 'deadlines', load: () => new Promise(() => {}) }], ['unbilled-time', { slot: 'unbilled-time', load: async () => ({ hours: 1 }) }]]);
		const started = Date.now();
		const s = await slotStates({ app: null, caseId: 'c', caseName: 'Case', resultsVersion: 'r' }, loaders, new Set(loaders.keys()), 50);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(s.map((x) => [x.slot.id, x.status])).toEqual(OVERVIEW_SLOTS.map((x, i) => [x.id, ['error', 'filled', 'unavailable'][i]]));
		expect(s[0]).toEqual({ slot: OVERVIEW_SLOTS[0], status: 'error', message: 'This summary could not be loaded.' });
	}, 3_000);
});

describe('gate follow-ups: document-row providers (CC-24 F4-F6, F11)', () => {
	it('F4 refuses a provider row whose list entry names another ref: no duplicate, no misdirected list entry', async () => {
		const { lc, c } = await setup('f4');
		const imported = documentRows(lc.store, c.resultsVersion).rows.length;
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => 'r1', rows: () => [{ ref: 'RS-900', row: {}, list: providerList('OD-001'), state: providerState }, { ref: 'RS-901', row: {}, list: providerList('RS-901'), state: providerState }] }));
		const r = documentRows(lc.store, c.resultsVersion);
		expect(r.rows.map((x) => x.list.ref).filter((x) => x === 'OD-001')).toEqual(['OD-001']);
		expect(r.rows.every((x) => x.list.ref === x.ref)).toBe(true);
		expect(r.dropped).toEqual([{ source: 'provider:rescan', ref: 'RS-900', reason: 'the list entry names another ref' }]);
		expect(documentRow(lc.store, c.resultsVersion, 'RS-900')).toBeNull();
		expect((JSON.parse(listJson(lc.store, c.resultsVersion)!.json) as ChronologyListRow[]).filter((x) => x.ref === 'OD-001')).toHaveLength(1);
		expect(documentCounts(lc.store, c.resultsVersion)).toMatchObject({ total: imported + 1, provided: 1 });
	});

	it('F5 isolates a provider row whose property read throws, and a provider whose row list cannot be read', async () => {
		const { lc, c } = await setup('f5');
		const plain = documentRows(lc.store, c.resultsVersion).rows.length;
		const bad: Record<string, unknown> = {};
		Object.defineProperty(bad, 'ref', { enumerable: true, get() { throw new Error('getter boom'); } });
		undo.push(registerDocumentRowProvider({ id: 'getter', owner: 'GRS-20', revision: () => 'g', rows: () => [bad as never, { ref: 'RS-001', row: {}, list: providerList('RS-001'), state: providerState }] }));
		const unreadable = new Proxy([{ ref: 'RS-002', row: {}, list: providerList('RS-002'), state: providerState }], { get(t, k) { if (k === 'length') throw new Error('length boom'); return Reflect.get(t, k); } });
		undo.push(registerDocumentRowProvider({ id: 'proxy', owner: 'GRS-20', revision: () => 'p', rows: () => unreadable }));
		const r = documentRows(lc.store, c.resultsVersion);
		expect(r.rows.filter((x) => x.source !== 'results').map((x) => [x.source, x.ref])).toEqual([['provider:getter', 'RS-001']]);
		expect(r.dropped).toEqual([{ source: 'provider:getter', ref: '#0', reason: expect.stringMatching(/^malformed row: /) }]);
		expect(r.failed).toEqual([{ source: 'provider:proxy', owner: 'GRS-20', reason: 'length boom' }]);
		expect(listJson(lc.store, c.resultsVersion)!.etag).toContain('failed=provider:proxy');
		expect(documentCounts(lc.store, c.resultsVersion)).toMatchObject({ total: plain + 1, provided: 1 });
		expect(activeDocumentRows({ store: lc.store, effectiveActive: () => c.resultsVersion }, 'e2e-case').rows).toHaveLength(plain + 1);
	});

	it('F6 a present original without a valid path, size, sha256 or media type becomes absent, with a diagnostic', async () => {
		const { lc, c } = await setup('f6');
		const good = { path: 'rescan/new.pdf', sha256: 'a'.repeat(64), size: 3, mediaType: 'application/pdf', status: 'verified', downloadOnly: false };
		const originals = [{}, { ...good, path: '' }, { ...good, size: -1 }, { ...good, size: '3' }, { ...good, sha256: 'not-a-digest' }, { ...good, mediaType: undefined }];
		const present = (ref: string, original: unknown) => ({ ref, row: {}, list: { ...providerList(ref), file: 'present' as const }, state: { ...providerState, file: 'present' as const, flags: [], original: original as DocumentStateRow['original'] } });
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => 'r1', rows: () => [...originals.map((o, i) => present(`RS-90${i}`, o)), present('RS-999', good)] }));
		const r = documentRows(lc.store, c.resultsVersion);
		expect(r.rows.filter((x) => x.source !== 'results').map((x) => [x.ref, x.state.original])).toEqual([...originals.map((_, i) => [`RS-90${i}`, null]), ['RS-999', good]]);
		expect(r.dropped).toEqual(originals.map((_, i) => ({ source: 'provider:rescan', ref: `RS-90${i}`, reason: expect.stringMatching(/^the original was left out/) })));
		expect(documentRow(lc.store, c.resultsVersion, 'RS-900')!.state.original).toBeNull();
	});

	it('F11 a provider revision that is not a safe ETag token marks the provider failed; the list ETag stays a valid header', async () => {
		const { lc, c } = await setup('f11');
		let rev = 'x\ny';
		undo.push(registerDocumentRowProvider({ id: 'rescan', owner: 'GRS-20', revision: () => rev, rows: () => [{ ref: 'RS-001', row: {}, list: providerList('RS-001'), state: providerState }] }));
		for (const bad of ['x\ny', 'x"y', 'a b', '', 'x'.repeat(129), 'é']) {
			rev = bad;
			const l = listJson(lc.store, c.resultsVersion)!;
			expect(l.failed).toEqual([{ source: 'provider:rescan', owner: 'GRS-20', reason: 'revision() did not return a safe ETag token' }]);
			expect(() => new Response(l.json, { headers: { etag: l.etag } })).not.toThrow();
			expect(documentRow(lc.store, c.resultsVersion, 'RS-001')).toBeNull();
		}
		rev = 'sha256:AbC+/=_.-1';
		const ok = listJson(lc.store, c.resultsVersion)!;
		expect([ok.failed, ok.etag.endsWith(`|rescan=${rev}"`)]).toEqual([[], true]);
		expect(new Response(ok.json, { headers: { etag: ok.etag } }).headers.get('etag')).toBe(ok.etag);
	});
});

describe('gate round 2: explicit table scope and typed restore failures (HARDEN-M2 r2)', () => {
	const col = (name: string, type: string, notNull = false, pk = 0) => ({ name, type, notNull, pk });
	const envelope = (tables: unknown[]) => JSON.parse(JSON.stringify({ format: USER_WORK_EXPORT, exportedAt: '2030-01-01T00:00:00Z', tables }));
	const failure = async (p: Promise<unknown>) => { try { await p; return { code: 'accepted', message: '' }; } catch (e) { return { code: e instanceof UserWorkError ? e.code : `untyped ${(e as Error).name}`, message: String((e as Error).message) }; } };
	const code = async (p: Promise<unknown>) => (await failure(p)).code;
	const rowsOf = (lc: LocalCase) => JSON.stringify(lc.userWork.exportAll().tables.map((t) => [t.name, t.rows]));
	async function fresh(tag: string) {
		const root = await tempRoot(tag);
		roots.push(root);
		const lc = service(path.join(root, 'data'));
		open.push(lc);
		await lc.startup();
		return lc;
	}

	it('R2-1 a store restores its own backup by default when a table holds rows with an empty or non-text case_id', async () => {
		const { lc } = await setup('r2own');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.putRow('e2e-case', 'deadlines', 'a-1', { title: 'kept' });
		db.exec("CREATE TABLE work.saved_view(view_id TEXT PRIMARY KEY, case_id TEXT, json TEXT); INSERT INTO work.saved_view VALUES ('v-null', NULL, '{}'), ('v-a', 'e2e-case', '{}')");
		db.exec("CREATE TABLE work.tally(id TEXT PRIMARY KEY, case_id INTEGER); INSERT INTO work.tally VALUES ('t-1', 7)");
		const own = JSON.parse(JSON.stringify(uw.exportAll()));
		const ownRows = rowsOf(lc);
		expect(await code(uw.importAll(own))).toBe('accepted');
		expect(rowsOf(lc)).toBe(ownRows);
		const nullable = { name: 'bookmark_v', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' as const }, { name: 'case_id', type: 'TEXT' as const }], primaryKey: ['id'] };
		expect(await code(uw.defineTable({ ...nullable, scope: 'store' }))).toBe('invalid');
		expect(await code(uw.defineTable({ ...nullable, scope: 'case' }))).toBe('invalid');
		expect(await code(uw.defineTable({ ...nullable, columns: [nullable.columns[0]!, { ...nullable.columns[1]!, notNull: true }], scope: 'case' }))).toBe('accepted');
		db.exec("INSERT INTO work.bookmark_v VALUES ('b-1', 'e2e-case')");
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		expect(snap.excluded).toEqual([]);
		const before = rowsOf(lc);
		expect(await code(uw.importAll(snap))).toBe('accepted');
		expect(rowsOf(lc)).toBe(before);
		const lc2 = await fresh('r2own2');
		expect(await code(lc2.userWork.importAll(snap))).toBe('accepted');
		expect(rowsOf(lc2)).toBe(before);
	});

	it('R2-2 scope is declared, not inferred from a column name: a store table merges, a case table keeps other cases', async () => {
		const { lc } = await setup('r2scope');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.defineTable({ name: 'bookmark', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_key', type: 'TEXT' }], primaryKey: ['id'], scope: 'store' });
		await uw.defineTable({ name: 'ledger', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_id', type: 'TEXT', notNull: true }, { name: 'v', type: 'TEXT' }], primaryKey: ['id'], scope: 'case' });
		db.exec("INSERT INTO work.bookmark VALUES ('b-a', 'A'); INSERT INTO work.ledger VALUES ('k1', 'A', 'snap'), ('k2', 'A', 'snap')");
		await uw.putRow('A', 'deadlines', 'a-1', { title: 'in the snapshot' });
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		db.exec("INSERT INTO work.bookmark VALUES ('b-b', 'B'); INSERT INTO work.ledger VALUES ('k3', 'B', 'later'); UPDATE work.ledger SET v = 'edited' WHERE id = 'k1'");
		const r = await uw.importAll(snap);
		expect(db.prepare('SELECT id FROM work.bookmark ORDER BY id').all().map((x) => x.id)).toEqual(['b-a', 'b-b']);
		expect(snap.tables.map((t: { name: string; scope: string }) => [t.name, t.scope])).toEqual([['bookmark', 'store'], ['ledger', 'case'], ['note', 'case'], ['register_row', 'case'], ['seed_overlay', 'case'], ['trusted_warning', 'case']]);
		expect(r.cases).toEqual(['A']);
		expect(r.restored.filter((x) => x.rows || x.deleted)).toEqual([
			{ name: 'bookmark', scope: 'store', action: 'merged', rows: 1, deleted: 0, inserted: 0, replaced: 1 },
			{ name: 'ledger', scope: 'case', action: 'replaced-for-cases', rows: 2, deleted: 2, cases: ['A'] },
			{ name: 'register_row', scope: 'case', action: 'replaced-for-cases', rows: 1, deleted: 1, cases: ['A'] },
		]);
		expect(db.prepare('SELECT id, v FROM work.ledger ORDER BY id').all().map((x) => [x.id, x.v])).toEqual([['k1', 'snap'], ['k2', 'snap'], ['k3', 'later']]);
		expect(Object.fromEntries(uw.tables().map((t) => [t.name, t.scope]))).toEqual({ active: 'case', activation_log: 'case', bookmark: 'store', ledger: 'case', note: 'case', register_row: 'case', seed_overlay: 'case', trusted_warning: 'case' });
		db.exec("DELETE FROM work.ledger WHERE id = 'k2'; INSERT INTO work.ledger VALUES ('k2', 'B', 'SECRET-B-ROW')");
		const before = rowsOf(lc);
		const clash = await failure(uw.importAll(snap));
		expect(clash.code).toBe('restore-key-collision');
		expect(clash.message).toMatch(/ledger.*\(id\)/);
		expect(clash.message).not.toMatch(/k2|SECRET|B-ROW/);
		expect(rowsOf(lc)).toBe(before);
		const noCases = envelope(snap.tables.map((t: { rows: unknown[] }) => ({ ...t, rows: [] })));
		const empty = await uw.importAll(noCases);
		expect([empty.cases, empty.restored.find((x) => x.name === 'ledger'), rowsOf(lc)]).toEqual([[], { name: 'ledger', scope: 'case', action: 'no-cases', rows: 0, deleted: 0 }, before]);
		const whole = await uw.importAll(noCases, { replace: 'tables' });
		expect(whole.restored.find((x) => x.name === 'bookmark')).toEqual({ name: 'bookmark', scope: 'store', action: 'replaced', rows: 0, deleted: 2 });
	});

	it('R2-3 an export never holds what a restore refuses: such a table is listed in excluded, and the rest restores', async () => {
		const { lc } = await setup('r2inv');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'n', type: 'INTEGER' }], primaryKey: ['n'], scope: 'store' });
		db.exec("INSERT INTO work.counter VALUES (1), (1.5), ('seven')");
		await uw.defineTable({ name: 'gauge', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'r', type: 'REAL' }], primaryKey: ['id'], scope: 'store' });
		db.exec("INSERT INTO work.gauge VALUES ('g', 9e999)");
		await uw.putRow('e2e-case', 'deadlines', 'a-1', { title: 'kept' });
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		expect(snap.excluded).toEqual([
			{ name: 'counter', kind: 'user-work', rows: 3, reason: expect.stringContaining('primary-key cell (n)') },
			{ name: 'gauge', kind: 'user-work', rows: 1, reason: expect.stringContaining('column r') },
		]);
		expect(await code(uw.importAll(snap))).toBe('accepted');
		expect(await code((await fresh('r2inv2')).userWork.importAll(snap))).toBe('accepted');
	});

	it('R2-4 every malformed restore is a typed refusal before any write, and no message echoes a value', async () => {
		const { lc } = await setup('r2cells');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.putRow('e2e-case', 'deadlines', 'a-1', { title: 'kept' });
		await uw.defineTable({ name: 'box', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'n', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['id'], scope: 'store' });
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'n', type: 'INTEGER' }], primaryKey: ['n'], scope: 'store' });
		db.exec("CREATE TABLE work.uniq(id TEXT PRIMARY KEY, v TEXT UNIQUE); INSERT INTO work.uniq VALUES ('u-1', 'SECRET-UNIQ')");
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		const register = snap.tables.find((t: { name: string }) => t.name === 'register_row');
		const changed = { ...register, rows: register.rows.map((r: object) => ({ ...r, fields: '{"title":"SECRET-RESTORED"}' })) };
		const table = (name: string) => snap.tables.find((t: { name: string }) => t.name === name);
		const box = (row: object) => ({ ...table('box'), rows: [{ id: 'x', n: 1, b: null, ...row }] });
		const before = rowsOf(lc);
		const cases: [string, unknown[], string][] = [
			['$b64 not text', [changed, box({ b: { $b64: 7731 } })], 'invalid'],
			['$b64 not base64', [changed, box({ b: { $b64: 'SECRET not base64' } })], 'invalid'],
			['$int beyond int64 in a key', [changed, { ...table('counter'), rows: [{ n: { $int: '99999999999999999999' } }] }], 'restore-key'],
			['$int beyond int64', [changed, box({ n: { $int: '99999999999999999999' } })], 'invalid'],
			['boolean key', [changed, { ...table('box'), rows: [{ id: true, n: 1, b: null }] }], 'invalid'],
			['array cell', [changed, box({ n: [7731] })], 'invalid'],
			['object cell', [changed, box({ n: { secret: 7731 } })], 'invalid'],
			['repeated key', [changed, { ...table('box'), rows: [{ id: 'x', n: 1, b: null }, { id: 'x', n: 2, b: null }] }], 'restore-key'],
			['null entry', [changed, null], 'invalid'],
			['duplicate entry', [changed, changed], 'invalid'],
			['index name', [changed, { ...table('box'), name: 'note_case' }], 'invalid'],
			['UNIQUE clash while writing', [changed, { ...table('uniq'), rows: [{ id: 'u-2', v: 'SECRET-UNIQ' }] }], 'invalid'],
		];
		for (const [what, tables, expected] of cases) {
			const f = await failure(uw.importAll(envelope(tables)));
			expect([what, f.code]).toEqual([what, expected]);
			expect([what, f.message]).not.toEqual([what, expect.stringMatching(/7731|SECRET|99999/)]);
			expect(rowsOf(lc)).toBe(before);
		}
	});

	it('R2-5 defineTable refuses malformed input as invalid and a table that exists in another letter case', async () => {
		const { lc } = await setup('r2define');
		const uw = lc.userWork;
		const ok = { name: 'pin', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' as const }], primaryKey: ['a'], scope: 'store' as const };
		for (const bad of [{ ...ok, primaryKey: ['a', 'a'] }, { ...ok, owner: undefined }, { ...ok, description: undefined }, { ...ok, columns: 'x' }, { ...ok, columns: [ok.columns[0], ok.columns[0]] }, { ...ok, columns: [null] }, null]) {
			expect(await code(uw.defineTable(bad as never))).toBe('invalid');
		}
		expect(uw.tables().some((t) => t.name === 'pin')).toBe(false);
		lc.storage.db().exec('CREATE TABLE work."Oob5" (x BLOB PRIMARY KEY) WITHOUT ROWID');
		expect(await code(uw.defineTable({ name: 'oob5', owner: 'GRS-17', description: '', columns: [{ name: 'entry_id', type: 'TEXT' }], primaryKey: ['entry_id'], scope: 'store' }))).toBe('table-conflict');
		expect(await code(uw.defineTable({ name: 'oob5', owner: 'GRS-17', description: '', columns: [{ name: 'x', type: 'BLOB' }], primaryKey: ['x'], scope: 'store' }))).toBe('table-conflict');
		expect(uw.tables().filter((t) => t.name.toLowerCase() === 'oob5').map((t) => [t.name, t.kind])).toEqual([['Oob5', 'unregistered']]);
	});

	it('R2-6 providers: the validated row is the copied one, a thrown unprintable value stays isolated, refs are well-formed', async () => {
		const { lc, c } = await setup('r2prov');
		let reads = 0;
		const stateful = { ref: 'RS-900', row: {}, state: providerState, get list() { return providerList(reads++ === 0 ? 'RS-900' : 'OD-001'); } };
		undo.push(registerDocumentRowProvider({ id: 'getter', owner: 'GRS-20', revision: () => 'g', rows: () => { reads = 0; return [stateful as never]; } }));
		const unprintable = Object.create(null);
		const throwsOnRead = { ref: 'RS-910', row: {}, list: providerList('RS-910'), state: providerState };
		Object.defineProperty(throwsOnRead, 'row', { enumerable: true, get() { throw unprintable; } });
		undo.push(registerDocumentRowProvider({ id: 'rows', owner: 'GRS-20', revision: () => 'r', rows: () => [throwsOnRead as never, { ref: 'RS-911', row: {}, list: providerList('RS-911'), state: providerState }, { ref: 'RS-\ud800', row: {}, list: providerList('RS-\ud800'), state: providerState }] }));
		undo.push(registerDocumentRowProvider({ id: 'broken', owner: 'GRS-20', revision: () => { throw unprintable; }, rows: () => [] }));
		const r = documentRows(lc.store, c.resultsVersion);
		expect(r.rows.filter((x) => x.source !== 'results').map((x) => [x.ref, x.list.ref])).toEqual([['RS-900', 'RS-900'], ['RS-911', 'RS-911']]);
		expect((JSON.parse(listJson(lc.store, c.resultsVersion)!.json) as ChronologyListRow[]).filter((x) => x.ref === 'OD-001')).toHaveLength(1);
		expect(r.dropped).toEqual([
			{ source: 'provider:rows', ref: 'RS-910', reason: 'malformed row: a value that cannot be shown as text was thrown' },
			{ source: 'provider:rows', ref: '#2', reason: 'malformed row: ref is not well-formed Unicode' },
		]);
		expect(r.failed).toEqual([{ source: 'provider:broken', owner: 'GRS-20', reason: expect.any(String) }]);
		expect(documentCounts(lc.store, c.resultsVersion)).toMatchObject({ provided: 2 });
	});
});

describe('gate round 3: required scope, table rows, restore edges (HARDEN-M2 r3)', () => {
	const failure = async (p: Promise<unknown>) => { try { await p; return { code: 'accepted', message: '' }; } catch (e) { return { code: e instanceof UserWorkError ? e.code : `untyped ${(e as Error).name}`, message: String((e as Error).message) }; } };
	const code = async (p: Promise<unknown>) => (await failure(p)).code;
	const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
	async function fresh(tag: string, dataDir?: string) {
		const root = await tempRoot(tag);
		roots.push(root);
		const lc = service(dataDir ?? path.join(root, 'data'));
		open.push(lc);
		await lc.startup();
		return lc;
	}
	const timesheet = { name: 'timesheet', owner: 'GRS-17', description: 'synthetic time entries', scope: 'case' as const, columns: [{ name: 'id', type: 'TEXT' as const }, { name: 'case_id', type: 'TEXT' as const, notNull: true }, { name: 'hours', type: 'REAL' as const }, { name: 'big', type: 'INTEGER' as const }, { name: 'blob', type: 'BLOB' as const }], primaryKey: ['id'] };
	const pref = { name: 'pref', owner: 'GRS-17', description: 'synthetic store-wide settings', scope: 'store' as const, columns: [{ name: 'k', type: 'TEXT' as const }, { name: 'v', type: 'TEXT' as const }], primaryKey: ['k'] };
	const own = { owner: 'GRS-17' };

	it('R3-1 scope is required: a definition without one is refused as invalid and creates nothing', async () => {
		const { lc } = await setup('r3scope');
		const uw = lc.userWork;
		const { scope: _, ...loose } = pref;
		const missing = await failure(uw.defineTable(loose as never));
		expect(missing.code).toBe('invalid');
		expect(missing.message).toMatch(/scope is required/);
		for (const scope of [undefined, null, 'cases', 'Store', 7]) expect([scope, await code(uw.defineTable({ ...pref, scope } as never))]).toEqual([scope, 'invalid']);
		expect(uw.tables().some((t) => t.name === 'pref')).toBe(false);
		expect(await code(uw.defineTable(pref))).toBe('accepted');
	});

	it('R3-2 putTableRow, deleteTableRow and listTableRows: validated, owned, case-scoped, backed up and persistent', async () => {
		const { root, lc } = await setup('r3rows');
		const uw = lc.userWork;
		await uw.defineTable(timesheet);
		await uw.defineTable(pref);
		const scheduled = vi.spyOn(lc, 'scheduleUserWorkBackup');
		const t1 = { id: 't1', case_id: 'A', hours: 1.5, big: { $int: '9007199254740993' }, blob: { $b64: 'AAH/' } };
		await uw.putTableRow('timesheet', t1, own);
		await uw.putTableRow('timesheet', { id: 't0', case_id: 'A', hours: null }, own);
		await uw.putTableRow('timesheet', { id: 't3', case_id: 'B', hours: 3, big: -7, blob: null }, own);
		await uw.putTableRow('pref', { k: 'theme', v: 'plain' }, own);
		expect(scheduled).toHaveBeenCalledTimes(4);
		expect(uw.listTableRows('timesheet', { caseId: 'A' })).toEqual([{ id: 't0', case_id: 'A', hours: null, big: null, blob: null }, t1]);
		expect(uw.listTableRows('timesheet', { caseId: 'B' }).map((r) => r.id)).toEqual(['t3']);
		expect(uw.listTableRows('pref')).toEqual([{ k: 'theme', v: 'plain' }]);
		await uw.putTableRow('timesheet', { ...t1, hours: 2 }, own);
		expect(uw.listTableRows('timesheet', { caseId: 'A' }).find((r) => r.id === 't1')!.hours).toBe(2);
		const before = JSON.stringify(uw.exportAll().tables);
		const calls = scheduled.mock.calls.length;
		const refusals: [string, Promise<unknown>, string][] = [
			['another case holds the key', uw.putTableRow('timesheet', { id: 't1', case_id: 'B-SECRET', hours: 9 }, own), 'restore-key-collision'],
			['another owner', uw.putTableRow('timesheet', { id: 'x', case_id: 'A' }, { owner: 'GRS-18' }), 'table-conflict'],
			['no owner', uw.putTableRow('timesheet', { id: 'x', case_id: 'A' }, undefined as never), 'invalid'],
			['built-in', uw.putTableRow('note', { id: 'x', case_id: 'A' }, own), 'table-built-in'],
			['built-in list', Promise.resolve().then(() => uw.listTableRows('register_row', { caseId: 'A' })), 'table-built-in'],
			['import state', uw.deleteTableRow('document', { id: 'x' }, own), 'table-built-in'],
			['no such table', uw.putTableRow('nope', { id: 'x' }, own), 'invalid'],
			['no case_id', uw.putTableRow('timesheet', { id: 'x', hours: 1 }, own), 'invalid'],
			['number case_id', uw.putTableRow('timesheet', { id: 'x', case_id: 7731 as never }, own), 'invalid'],
			['empty key', uw.putTableRow('timesheet', { id: null, case_id: 'A' }, own), 'restore-key'],
			['NaN', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', hours: Number.NaN }, own), 'invalid'],
			['Infinity', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', hours: Number.POSITIVE_INFINITY }, own), 'invalid'],
			['boolean', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', hours: true as never }, own), 'invalid'],
			['bad base64', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', blob: { $b64: 'SECRET not base64' } }, own), 'invalid'],
			['$int beyond 64 bits', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', big: { $int: '99999999999999999999' } }, own), 'invalid'],
			['unknown column', uw.putTableRow('timesheet', { id: 'x', case_id: 'A', secret: 'SECRET' } as never, own), 'invalid'],
			['list without caseId', Promise.resolve().then(() => uw.listTableRows('timesheet')), 'invalid'],
			['caseId on a store table', Promise.resolve().then(() => uw.listTableRows('pref', { caseId: 'A' })), 'invalid'],
			['delete without case_id', uw.deleteTableRow('timesheet', { id: 't1' }, own), 'invalid'],
			['delete by another owner', uw.deleteTableRow('timesheet', { id: 't1', case_id: 'A' }, { owner: 'GRS-18' }), 'table-conflict'],
		];
		for (const [what, p, expected] of refusals) {
			const f = await failure(p);
			expect([what, f.code]).toEqual([what, expected]);
			expect([what, f.message]).not.toEqual([what, expect.stringMatching(/SECRET|7731|99999|B-SECRET/)]);
		}
		expect(JSON.stringify(uw.exportAll().tables)).toBe(before);
		expect(scheduled.mock.calls.length).toBe(calls);
		expect(await uw.deleteTableRow('timesheet', { id: 't1', case_id: 'B' }, own)).toBe(false);
		expect(scheduled.mock.calls.length).toBe(calls);
		expect(await uw.deleteTableRow('timesheet', { id: 't0', case_id: 'A' }, own)).toBe(true);
		expect(await uw.deleteTableRow('pref', { k: 'gone' }, own)).toBe(false);
		expect(scheduled.mock.calls.length).toBe(calls + 1);
		const rowsNow = { A: uw.listTableRows('timesheet', { caseId: 'A' }), B: uw.listTableRows('timesheet', { caseId: 'B' }), pref: uw.listTableRows('pref') };
		expect(rowsNow.A).toEqual([{ ...t1, hours: 2 }]);
		const snap = json(uw.exportAll());
		scheduled.mockRestore();

		lc.shutdown();
		open.splice(open.indexOf(lc), 1);
		const backups = readdirSync(lc.storage.backupDir).filter((n) => n.startsWith('work-')).sort();
		expect(backups.length).toBeGreaterThan(0);
		const b = new DatabaseSync(path.join(lc.storage.backupDir, backups.at(-1)!), { readOnly: true });
		expect(b.prepare('SELECT id FROM timesheet ORDER BY id').all().map((r) => r.id)).toEqual(['t1', 't3']);
		b.close();
		const read = (l: LocalCase) => ({ A: l.userWork.listTableRows('timesheet', { caseId: 'A' }), B: l.userWork.listTableRows('timesheet', { caseId: 'B' }), pref: l.userWork.listTableRows('pref') });
		const again = await fresh('r3rows-restart', path.join(root, 'data'));
		expect(read(again)).toEqual(rowsNow);
		const restoredDir = path.join(root, 'restored');
		mkdirSync(restoredDir, { recursive: true });
		copyFileSync(path.join(lc.storage.backupDir, backups.at(-1)!), path.join(restoredDir, 'work.sqlite'));
		expect(read(await fresh('r3rows-file', restoredDir))).toEqual(rowsNow);
		const other = await fresh('r3rows-export');
		await other.userWork.importAll(snap);
		expect(read(other)).toEqual(rowsNow);
		await other.userWork.putTableRow('timesheet', { id: 't4', case_id: 'B' }, own);
		expect(other.userWork.listTableRows('timesheet', { caseId: 'B' }).map((r) => r.id)).toEqual(['t3', 't4']);
	});

	it('R3-3 a table scope never changes: store to case and case to store are table-conflict', async () => {
		const { lc } = await setup('r3trans');
		const uw = lc.userWork;
		const db = lc.storage.db();
		db.exec('CREATE TABLE work.oob(id TEXT NOT NULL, case_id TEXT NOT NULL, PRIMARY KEY(id)) WITHOUT ROWID');
		const oob = { name: 'oob', owner: 'GRS-17', description: '', scope: 'case' as const, columns: [{ name: 'id', type: 'TEXT' as const }, { name: 'case_id', type: 'TEXT' as const, notNull: true }], primaryKey: ['id'] };
		const toCase = await failure(uw.defineTable(oob));
		expect(toCase).toEqual({ code: 'table-conflict', message: expect.stringMatching(/store-scoped here/) });
		expect(uw.tables().find((t) => t.name === 'oob')).toMatchObject({ kind: 'unregistered', scope: 'store' });
		db.exec("CREATE TABLE work.old(id TEXT PRIMARY KEY, case_id TEXT NOT NULL); INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES ('old', 'user-work', 'GRS-17', '')");
		expect(await code(uw.defineTable({ ...oob, name: 'old' }))).toBe('table-conflict');
		await uw.defineTable(timesheet);
		const toStore = await failure(uw.defineTable({ ...timesheet, scope: 'store' }));
		expect(toStore).toEqual({ code: 'table-conflict', message: expect.stringMatching(/case-scoped here/) });
		expect(uw.tables().find((t) => t.name === 'timesheet')!.scope).toBe('case');
		expect(await code(uw.defineTable(timesheet))).toBe('accepted');
		db.exec('CREATE TABLE work.oob2(k TEXT PRIMARY KEY, v TEXT)');
		expect(await code(uw.defineTable({ name: 'oob2', owner: 'GRS-17', description: '', scope: 'store', columns: [{ name: 'k', type: 'TEXT' }, { name: 'v', type: 'TEXT' }], primaryKey: ['k'] }))).toBe('accepted');
	});

	it('R3-4 a snapshot without scope fields (round 1, dev) restores into a fresh store as store tables (case tables with case_id, r4)', async () => {
		const { lc } = await setup('r3old');
		const uw = lc.userWork;
		await uw.defineTable(pref);
		await uw.defineTable(timesheet);
		lc.storage.db().exec("INSERT INTO work.pref VALUES ('theme', 'plain'); INSERT INTO work.timesheet(id, case_id, hours) VALUES ('t1', 'A', 1)");
		await uw.putRow('A', 'deadlines', 'a-1', { title: 'kept' });
		const old = json(uw.exportAll()) as unknown as { tables: Record<string, unknown>[] };
		for (const t of old.tables) delete t.scope;
		const lc2 = await fresh('r3old2');
		const r = await lc2.userWork.importAll(old as never);
		expect(r.restored.map((x) => [x.name, x.scope, x.action])).toEqual([['note', 'case', 'replaced-for-cases'], ['pref', 'store', 'merged'], ['register_row', 'case', 'replaced-for-cases'], ['seed_overlay', 'case', 'replaced-for-cases'], ['timesheet', 'case', 'replaced-for-cases'], ['trusted_warning', 'case', 'dropped']]);
		expect(Object.fromEntries(lc2.userWork.tables().map((t) => [t.name, t.scope]))).toMatchObject({ pref: 'store', timesheet: 'case', register_row: 'case' });
		expect(lc2.userWork.listTableRows('pref')).toEqual([{ k: 'theme', v: 'plain' }]);
		expect(lc2.userWork.listRows('A', 'deadlines').map((x) => x.rowId)).toEqual(['a-1']);
		expect((await uw.importAll(old as never)).restored.find((x) => x.name === 'timesheet')!.scope).toBe('case');
		expect(await code(lc2.userWork.importAll({ ...old, tables: old.tables.map((t) => ({ ...t, scope: 'cases' })) } as never))).toBe('invalid');
	});

	it('R3-5 defineTable refuses to adopt a table whose key or case_id column does not compare byte for byte', async () => {
		const { lc } = await setup('r3coll');
		const uw = lc.userWork;
		const db = lc.storage.db();
		const store = (name: string, extra: Partial<typeof pref> = {}) => ({ ...pref, name, ...extra });
		db.exec('CREATE TABLE work.nk(k TEXT COLLATE NOCASE PRIMARY KEY, v TEXT)');
		const nk = await failure(uw.defineTable(store('nk')));
		expect(nk).toEqual({ code: 'table-conflict', message: expect.stringMatching(/column k has the collation NOCASE/) });
		db.exec('CREATE TABLE work.nkpk(k TEXT NOT NULL, v TEXT, PRIMARY KEY(k COLLATE RTRIM)) WITHOUT ROWID');
		expect(await failure(uw.defineTable(store('nkpk')))).toEqual({ code: 'table-conflict', message: expect.stringMatching(/column k has the collation RTRIM/) });
		db.exec("CREATE TABLE work.nc(k TEXT NOT NULL, case_id TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY(case_id, k)) WITHOUT ROWID; INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES ('nc', 'user-work', 'GRS-17', '')");
		await uw.defineTable({ ...store('scope_seed'), scope: 'store' });
		db.exec("INSERT INTO work.userwork_catalog_scope(name, scope) VALUES ('nc', 'case')");
		const nc = { name: 'nc', owner: 'GRS-17', description: '', scope: 'case' as const, columns: [{ name: 'k', type: 'TEXT' as const }, { name: 'case_id', type: 'TEXT' as const, notNull: true }], primaryKey: ['case_id', 'k'] };
		expect(await failure(uw.defineTable(nc))).toEqual({ code: 'table-conflict', message: expect.stringMatching(/column case_id has the collation NOCASE/) });
		db.exec('CREATE TABLE work.bk(k TEXT COLLATE BINARY PRIMARY KEY, v TEXT COLLATE NOCASE)');
		expect(await code(uw.defineTable(store('bk')))).toBe('accepted');
		expect(db.prepare("SELECT name FROM work.sqlite_master WHERE name LIKE '%probe%'").all()).toEqual([]);
		expect(uw.tables().filter((t) => ['nk', 'nkpk', 'nc'].includes(t.name)).map((t) => t.owner)).toEqual(['GRS-17', 'unknown', 'unknown']);
	});

	it('R3-6 ImportResult says, per merged table, how many rows were inserted and replaced and, per case table, which cases', async () => {
		const { lc } = await setup('r3result');
		const uw = lc.userWork;
		await uw.defineTable(pref);
		await uw.defineTable(timesheet);
		await uw.defineTable({ name: 'tag', owner: 'GRS-17', description: 'all-key table', scope: 'store', columns: [{ name: 'k', type: 'TEXT' }], primaryKey: ['k'] });
		const db = lc.storage.db();
		db.exec("INSERT INTO work.pref VALUES ('k1', 'snap'), ('k2', 'snap'); INSERT INTO work.tag VALUES ('1'); INSERT INTO work.timesheet(id, case_id) VALUES ('t1', 'A')");
		await uw.putRow('A', 'deadlines', 'a-1', { title: 'a' });
		await uw.putRow('B', 'deadlines', 'b-1', { title: 'b' });
		const snap = json(uw.exportAll());
		db.exec("DELETE FROM work.pref WHERE k = 'k1'; UPDATE work.pref SET v = 'later' WHERE k = 'k2'; INSERT INTO work.pref VALUES ('k3', 'later'); INSERT INTO work.timesheet(id, case_id) VALUES ('t9', 'B'), ('t8', 'C')");
		snap.tables.find((t) => t.name === 'tag')!.rows.push({ k: '2' });
		const r = await uw.importAll(snap);
		const by = Object.fromEntries(r.restored.map((x) => [x.name, x]));
		expect(r.cases).toEqual(['A', 'B']);
		expect(by.pref).toEqual({ name: 'pref', scope: 'store', action: 'merged', rows: 2, deleted: 0, inserted: 1, replaced: 1 });
		expect(by.tag).toEqual({ name: 'tag', scope: 'store', action: 'merged', rows: 2, deleted: 0, inserted: 1, replaced: 1 });
		expect(by.timesheet).toEqual({ name: 'timesheet', scope: 'case', action: 'replaced-for-cases', rows: 1, deleted: 2, cases: ['A', 'B'] });
		expect(by.register_row).toEqual({ name: 'register_row', scope: 'case', action: 'replaced-for-cases', rows: 2, deleted: 2, cases: ['A', 'B'] });
		expect(by.note).toEqual({ name: 'note', scope: 'case', action: 'replaced-for-cases', rows: 0, deleted: 0, cases: [] });
		expect(uw.listTableRows('pref')).toEqual([{ k: 'k1', v: 'snap' }, { k: 'k2', v: 'snap' }, { k: 'k3', v: 'later' }]);
		expect(uw.listTableRows('timesheet', { caseId: 'C' }).map((x) => x.id)).toEqual(['t8']);
		expect(uw.listTableRows('timesheet', { caseId: 'B' })).toEqual([]);
	});
});

describe('gate round 4: owner traps in the user-work API (HARDEN-M2 r4)', () => {
	const failure = async (p: Promise<unknown>) => { try { await p; return { code: 'accepted', message: '' }; } catch (e) { return { code: e instanceof UserWorkError ? e.code : `untyped ${(e as Error).name}`, message: String((e as Error).message) }; } };
	const code = async (p: Promise<unknown>) => (await failure(p)).code;
	const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
	async function fresh(tag: string) {
		const root = await tempRoot(tag);
		roots.push(root);
		const lc = service(path.join(root, 'data'));
		open.push(lc);
		await lc.startup();
		return lc;
	}
	const step = { name: 'step', owner: 'GRS-18', description: 'synthetic litigation steps', scope: 'case' as const, columns: [{ name: 'case_id', type: 'TEXT' as const, notNull: true }, { name: 'step_id', type: 'TEXT' as const }, { name: 'seq', type: 'INTEGER' as const }, { name: 'ref_no', type: 'TEXT' as const }, { name: 'amount', type: 'REAL' as const }], primaryKey: ['case_id', 'step_id'] };
	const st = { name: 'st', owner: 'GRS-18', description: 'synthetic store keys', scope: 'store' as const, columns: [{ name: 'k', type: 'TEXT' as const }, { name: 'v', type: 'TEXT' as const }], primaryKey: ['k'] };
	const rk = { name: 'rk', owner: 'GRS-18', description: 'synthetic real keys', scope: 'store' as const, columns: [{ name: 'k', type: 'REAL' as const }, { name: 'v', type: 'TEXT' as const }], primaryKey: ['k'] };
	const own = { owner: 'GRS-18' };

	it('R4-1 a number in a TEXT column is refused by putTableRow and deleteTableRow as invalid, naming the column only', async () => {
		const lc = await fresh('r4num');
		const uw = lc.userWork;
		await uw.defineTable(step);
		await uw.defineTable(st);
		await uw.putTableRow('step', { case_id: 'A', step_id: 's1', seq: 1, ref_no: 'R-1', amount: 2.5 }, own);
		await uw.putTableRow('st', { k: '7', v: 'text key' }, own);
		const before = JSON.stringify(uw.exportAll().tables);
		const refusals: [string, Promise<unknown>, string][] = [
			['non-key TEXT cell', uw.putTableRow('step', { case_id: 'A', step_id: 's2', ref_no: 7731 as never }, own), 'ref_no'],
			['TEXT key cell', uw.putTableRow('step', { case_id: 'A', step_id: 7731 as never }, own), 'step_id'],
			['store TEXT key', uw.putTableRow('st', { k: 7731 as never, v: 'x' }, own), 'k'],
			['large integer', uw.putTableRow('st', { k: 'big', v: 12345678901234567 as never }, own), 'v'],
			['delete by a number key', uw.deleteTableRow('st', { k: 7 as never }, own), 'k'],
			['delete by a number in a case key', uw.deleteTableRow('step', { case_id: 'A', step_id: 1 as never }, own), 'step_id'],
		];
		for (const [what, p, column] of refusals) {
			const f = await failure(p);
			expect([what, f.code]).toEqual([what, 'invalid']);
			expect([what, f.message]).toEqual([what, expect.stringContaining(`column ${column}`)]);
			expect([what, f.message]).not.toEqual([what, expect.stringMatching(/7731|1234567|7\.0/)]);
		}
		expect(JSON.stringify(uw.exportAll().tables)).toBe(before);
		await uw.putTableRow('step', { case_id: 'A', step_id: '9', seq: 2, ref_no: '0042', amount: 3 }, own);
		expect(uw.listTableRows('step', { caseId: 'A' }).map((r) => [r.step_id, r.ref_no])).toEqual([['9', '0042'], ['s1', 'R-1']]);
		expect(await uw.deleteTableRow('st', { k: '7' }, own)).toBe(true);
	});

	it('R4-2 a restore refuses rows whose keys SQLite stores as one, in every mode, before writing', async () => {
		const lc = await fresh('r4dup');
		const uw = lc.userWork;
		await uw.defineTable(st);
		await uw.defineTable(rk);
		await uw.defineTable(step);
		await uw.putTableRow('st', { k: 'kept', v: 'here' }, own);
		const base = json(uw.exportAll());
		const snap = (name: string, rows: Record<string, TableCell>[]) => ({ ...base, tables: base.tables.filter((t) => t.name === name).map((t) => ({ ...t, rows })) });
		const collisions: [string, string, Record<string, TableCell>[]][] = [
			['TEXT: a number and its SQLite text', 'st', [{ k: 7, v: 'x' }, { k: '7.0', v: 'y' }]],
			['TEXT: a large number and its SQLite text', 'st', [{ k: 12345678901234567, v: 'x' }, { k: '12345678901234568.0', v: 'y' }]],
			['TEXT: $int and its decimal', 'st', [{ k: { $int: '0001' }, v: 'x' }, { k: '1', v: 'y' }]],
			['REAL: a number and $int beyond 2^53', 'rk', [{ k: 9007199254740992, v: 'x' }, { k: { $int: '9007199254740993' }, v: 'y' }]],
			['REAL: a number and numeric text', 'rk', [{ k: 1.5, v: 'x' }, { k: ' 1.50 ', v: 'y' }]],
			['case table TEXT key', 'step', [{ case_id: 'A', step_id: 3 }, { case_id: 'A', step_id: '3.0' }]],
		];
		for (const [what, name, rows] of collisions) {
			for (const replace of ['cases', 'tables'] as const) {
				expect([what, replace, await code(uw.importAll(snap(name, rows), { replace }))]).toEqual([what, replace, 'restore-key']);
			}
		}
		expect(json(uw.exportAll()).tables).toEqual(base.tables);
		expect((await uw.importAll(snap('st', [{ k: 7, v: 'x' }, { k: '7', v: 'y' }]))).restored[0]).toMatchObject({ action: 'merged', inserted: 2, replaced: 0 });
		expect(uw.listTableRows('st').map((r) => r.k)).toEqual(['7', '7.0', 'kept']);
		expect((await uw.importAll(snap('rk', [{ k: 'abc', v: 'x' }, { k: 'abd', v: 'y' }, { k: '0x10', v: 'z' }, { k: 16, v: 'w' }]))).restored[0]).toMatchObject({ inserted: 4 });
	});

	it('R4-3 a restore creates a catalogued table with case_id TEXT NOT NULL as a case table, and refuses it as a store table', async () => {
		const src = await fresh('r4scope-src');
		await src.userWork.defineTable(step);
		await src.userWork.putTableRow('step', { case_id: 'A', step_id: 's1' }, own);
		const snap = json(src.userWork.exportAll());
		const only = (scope: unknown) => ({ ...snap, tables: snap.tables.filter((t) => t.name === 'step').map((t) => ({ ...t, scope })) });
		const lc = await fresh('r4scope');
		const store = await failure(lc.userWork.importAll(only('store') as never));
		expect(store).toEqual({ code: 'invalid', message: expect.stringMatching(/case_id TEXT NOT NULL column is case-scoped/) });
		expect(lc.userWork.tables().some((t) => t.name === 'step')).toBe(false);
		const r = await lc.userWork.importAll(only(undefined) as never);
		expect(r.restored[0]).toMatchObject({ name: 'step', scope: 'case', action: 'replaced-for-cases', cases: ['A'] });
		expect(await code(lc.userWork.defineTable(step))).toBe('accepted');
		await lc.userWork.putTableRow('step', { case_id: 'B', step_id: 's1' }, own);
		expect(lc.userWork.listTableRows('step', { caseId: 'A' }).map((x) => x.step_id)).toEqual(['s1']);
		const oob = await fresh('r4scope-oob');
		oob.storage.db().exec("CREATE TABLE work.loose(id TEXT NOT NULL, case_id TEXT NOT NULL, PRIMARY KEY(id)) WITHOUT ROWID; INSERT INTO work.loose VALUES ('x', 'A')");
		const loose = json(oob.userWork.exportAll());
		expect(loose.tables.find((t) => t.name === 'loose')).toMatchObject({ kind: 'unregistered', scope: 'store' });
		expect(await code((await fresh('r4scope-oob2')).userWork.importAll(loose))).toBe('accepted');
	});

	it('R4-4 a restore into an existing table with a non-BINARY key or case_id collation is table-conflict', async () => {
		const lc = await fresh('r4coll');
		const uw = lc.userWork;
		const db = lc.storage.db();
		db.exec("CREATE TABLE work.nk(k TEXT COLLATE NOCASE NOT NULL, v TEXT, PRIMARY KEY(k)) WITHOUT ROWID; INSERT INTO work.nk VALUES ('ABC', 'theirs')");
		const nk = { ...json(uw.tables().find((t) => t.name === 'nk')!), rows: [{ k: 'abc', v: 'mine' }] };
		const f = await failure(uw.importAll({ format: USER_WORK_EXPORT, exportedAt: '2030-01-31T09:00:00Z', tables: [nk] }));
		expect(f).toEqual({ code: 'table-conflict', message: expect.stringMatching(/column k has the collation NOCASE/) });
		expect(db.prepare('SELECT k, v FROM work.nk').all().map((r) => ({ ...r }))).toEqual([{ k: 'ABC', v: 'theirs' }]);
		db.exec("CREATE TABLE work.nc(k TEXT NOT NULL, case_id TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY(k)) WITHOUT ROWID; INSERT INTO work.nc VALUES ('x', 'A'); INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES ('nc', 'user-work', 'GRS-18', '')");
		await uw.defineTable(st);
		db.exec("INSERT INTO work.userwork_catalog_scope(name, scope) VALUES ('nc', 'case')");
		const nc = { ...json(uw.tables().find((t) => t.name === 'nc')!), rows: [{ k: 'y', case_id: 'a' }] };
		expect(await failure(uw.importAll({ format: USER_WORK_EXPORT, exportedAt: '2030-01-31T09:00:00Z', tables: [nc] }))).toEqual({ code: 'table-conflict', message: expect.stringMatching(/column case_id has the collation NOCASE/) });
		expect(db.prepare('SELECT k, case_id FROM work.nc').all().map((r) => ({ ...r }))).toEqual([{ k: 'x', case_id: 'A' }]);
		expect(db.prepare("SELECT name FROM work.sqlite_master WHERE name LIKE '%probe%'").all()).toEqual([]);
		const all = json(uw.exportAll());
		expect(await code(uw.importAll({ ...all, tables: all.tables.filter((t) => t.name !== 'nk' && t.name !== 'nc') }))).toBe('accepted');
	});

	it('R4-5 deleteTableRow without case_id is invalid for a case table, whether or not case_id is in its key', async () => {
		const lc = await fresh('r4del');
		const uw = lc.userWork;
		await uw.defineTable(step);
		await uw.putTableRow('step', { case_id: 'A', step_id: 's1' }, own);
		expect(await code(uw.deleteTableRow('step', { step_id: 's1' } as never, own))).toBe('invalid');
		expect(await code(uw.deleteTableRow('step', { case_id: null, step_id: 's1' }, own))).toBe('invalid');
		expect(uw.listTableRows('step', { caseId: 'A' })).toHaveLength(1);
	});

	it('R4-6 redefining a catalogued table of the same owner and scope skips the collation probe index', async () => {
		const lc = await fresh('r4probe');
		const uw = lc.userWork;
		await uw.defineTable(step);
		const db = lc.storage.db();
		const exec = vi.spyOn(db, 'exec');
		await uw.defineTable(step);
		await uw.defineTable(st);
		await uw.defineTable(st);
		expect(exec.mock.calls.map((c) => String(c[0])).filter((sql) => sql.includes('userwork_catalog_probe'))).toEqual([]);
		db.exec('CREATE TABLE work.adopt(k TEXT PRIMARY KEY, v TEXT)');
		await uw.defineTable({ ...st, name: 'adopt' });
		expect(exec.mock.calls.some((c) => String(c[0]).includes('userwork_catalog_probe'))).toBe(true);
		exec.mockRestore();
	});
});

describe('external review of PR #12: export and restore agree (PRFIX-12)', () => {
	const failure = async (p: Promise<unknown>) => { try { await p; return { code: 'accepted', message: '' }; } catch (e) { return { code: e instanceof UserWorkError ? e.code : `untyped ${(e as Error).name}`, message: String((e as Error).message) }; } };
	const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
	async function fresh(tag: string) {
		const root = await tempRoot(tag);
		roots.push(root);
		const lc = service(path.join(root, 'data'));
		open.push(lc);
		await lc.startup();
		return lc;
	}
	const own = { owner: 'GRS-17' };
	const amounts = { name: 'amounts', owner: 'GRS-17', description: 'synthetic amounts', scope: 'store' as const, columns: [{ name: 'id', type: 'TEXT' as const }, { name: 'amount', type: 'REAL' as const }, { name: 'units', type: 'INTEGER' as const }], primaryKey: ['id'] };
	const OUT_OF_RANGE = ['1e999', '-1e999', ' 1e999 ', `1${'0'.repeat(400)}`];

	it('P2-1 numeric text that SQLite stores as a non-finite number is refused, so the next export keeps every valid row', async () => {
		const lc = await fresh('pf1');
		const uw = lc.userWork;
		await uw.defineTable(amounts);
		await uw.putTableRow('amounts', { id: 'a', amount: 12.5, units: 3 }, own);
		for (const v of OUT_OF_RANGE) for (const column of ['amount', 'units']) {
			const f = await failure(uw.putTableRow('amounts', { id: 'b', [column]: v }, own));
			expect(f).toEqual({ code: 'invalid', message: expect.stringMatching(new RegExp(`column ${column}: .*out of range.*nothing was written`)) });
			expect(f.message).not.toContain(v.trim());
			expect((await failure(uw.putTableRow('amounts', { id: 'a', [column]: v }, own))).code).toBe('invalid');
		}
		await uw.putTableRow('amounts', { id: 'c', amount: 'NaN', units: 'Infinity' }, own);
		await uw.putTableRow('amounts', { id: 'd', amount: '-Infinity', units: '99999999999999999999' }, own);
		const snap = json(uw.exportAll());
		expect(snap.excluded).toEqual([]);
		expect(snap.tables.find((t) => t.name === 'amounts')!.rows).toEqual([
			{ id: 'a', amount: 12.5, units: 3 }, { id: 'c', amount: 'NaN', units: 'Infinity' }, { id: 'd', amount: '-Infinity', units: 1e20 },
		]);
		expect((await failure(uw.importAll(snap))).code).toBe('accepted');
		const lc2 = await fresh('pf1b');
		await lc2.userWork.importAll(snap);
		expect(json(lc2.userWork.exportAll()).tables.find((t) => t.name === 'amounts')!.rows).toEqual(snap.tables.find((t) => t.name === 'amounts')!.rows);
	});

	it('P2-1 a restore carrying such numeric text is refused as invalid and writes nothing, here or in a fresh store', async () => {
		const lc = await fresh('pf1r');
		const uw = lc.userWork;
		await uw.defineTable(amounts);
		await uw.putTableRow('amounts', { id: 'a', amount: 1, units: 1 }, own);
		const good = json(uw.exportAll());
		const lc2 = await fresh('pf1r2');
		for (const v of OUT_OF_RANGE) for (const column of ['amount', 'units']) {
			const t = good.tables.find((x) => x.name === 'amounts')!;
			const bad = { ...good, tables: [{ ...t, rows: [...t.rows, { id: 'z', amount: null, units: null, [column]: v }] }] };
			for (const target of [uw, lc2.userWork]) for (const replace of ['cases', 'tables'] as const) {
				const f = await failure(target.importAll(json(bad), { replace }));
				expect(f).toEqual({ code: 'invalid', message: expect.stringMatching(new RegExp(`^table amounts: column ${column}: .*nothing was restored`)) });
				expect(f.message).not.toContain(v.trim());
			}
		}
		expect(json(uw.exportAll()).tables).toEqual(good.tables);
		expect(lc2.userWork.tables().some((t) => t.name === 'amounts')).toBe(false);
		await uw.defineTable({ ...amounts, name: 'rkey', columns: [{ name: 'k', type: 'REAL' }, { name: 'v', type: 'TEXT' }], primaryKey: ['k'] });
		expect((await failure(uw.putTableRow('rkey', { k: '1e999', v: 'x' }, own))).code).toBe('invalid');
		expect(uw.listTableRows('rkey')).toEqual([]);
	});

	it('P2-1 a non-finite number already stored by raw SQL (REAL, INTEGER, NUMERIC) is excluded with a reason, and the export restores', async () => {
		const lc = await fresh('pf1x');
		const uw = lc.userWork;
		const db = lc.storage.db();
		await uw.defineTable(amounts);
		await uw.putTableRow('amounts', { id: 'a', amount: 1, units: 1 }, own);
		db.exec("CREATE TABLE work.raw_real(id TEXT PRIMARY KEY NOT NULL, r REAL); INSERT INTO work.raw_real VALUES ('x', '1e999'), ('y', 2)");
		db.exec("CREATE TABLE work.raw_int(id TEXT PRIMARY KEY NOT NULL, n INTEGER); INSERT INTO work.raw_int VALUES ('x', '-1e999')");
		db.exec("CREATE TABLE work.raw_num(id TEXT PRIMARY KEY NOT NULL, n NUMERIC); INSERT INTO work.raw_num VALUES ('x', '1e999')");
		const snap = json(uw.exportAll());
		expect(snap.excluded).toEqual([
			{ name: 'raw_int', kind: 'unregistered', rows: 1, reason: expect.stringContaining('column n') },
			{ name: 'raw_num', kind: 'unregistered', rows: 1, reason: expect.stringContaining('columns need') },
			{ name: 'raw_real', kind: 'unregistered', rows: 2, reason: expect.stringContaining('column r') },
		]);
		expect(snap.tables.map((t) => t.name)).toContain('amounts');
		expect((await failure(uw.importAll(snap))).code).toBe('accepted');
		expect((await failure((await fresh('pf1x2')).userWork.importAll(snap))).code).toBe('accepted');
	});

	it('P2-2 an unregistered table with a non-BINARY key collation is excluded with a reason, so its export restores here and fresh', async () => {
		const lc = await fresh('pf2');
		const uw = lc.userWork;
		const db = lc.storage.db();
		db.exec("CREATE TABLE work.legacy(id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL, memo TEXT); INSERT INTO work.legacy VALUES ('L-1', 'synthetic')");
		db.exec("CREATE TABLE work.legacy_rt(id TEXT NOT NULL, memo TEXT, PRIMARY KEY(id COLLATE RTRIM)) WITHOUT ROWID; INSERT INTO work.legacy_rt VALUES ('R-1', 'synthetic')");
		db.exec("CREATE TABLE work.legacy_nc(k TEXT NOT NULL PRIMARY KEY, case_id TEXT COLLATE NOCASE NOT NULL); INSERT INTO work.legacy_nc VALUES ('x', 'A'); INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES ('legacy_nc', 'user-work', 'GRS-18', '')");
		db.exec("CREATE TABLE work.legacy_ok(id TEXT PRIMARY KEY NOT NULL, memo TEXT COLLATE NOCASE); INSERT INTO work.legacy_ok VALUES ('O-1', 'Synthetic')");
		const snap = json(uw.exportAll());
		expect(snap.excluded).toEqual([
			{ name: 'legacy', kind: 'unregistered', rows: 1, reason: expect.stringMatching(/column id has the collation NOCASE/) },
			{ name: 'legacy_nc', kind: 'user-work', rows: 1, reason: expect.stringMatching(/column case_id has the collation NOCASE/) },
			{ name: 'legacy_rt', kind: 'unregistered', rows: 1, reason: expect.stringMatching(/column id has the collation RTRIM/) },
		]);
		expect(snap.tables.find((t) => t.name === 'legacy_ok')!.rows).toEqual([{ id: 'O-1', memo: 'Synthetic' }]);
		expect((await failure(uw.importAll(json(snap)))).code).toBe('accepted');
		expect((await failure(uw.importAll(json(snap), { replace: 'tables' }))).code).toBe('accepted');
		const lc2 = await fresh('pf2b');
		expect((await failure(lc2.userWork.importAll(json(snap)))).code).toBe('accepted');
		expect(json(lc2.userWork.exportAll()).tables.find((t) => t.name === 'legacy_ok')!.rows).toEqual([{ id: 'O-1', memo: 'Synthetic' }]);
		expect(db.prepare("SELECT name FROM work.sqlite_master WHERE name LIKE '%probe%'").all()).toEqual([]);
		expect(db.isTransaction).toBe(false);
		expect(db.prepare('SELECT * FROM work.legacy').all().map((r) => ({ ...r }))).toEqual([{ id: 'L-1', memo: 'synthetic' }]);
	});

	it('P2-2 a table a fresh store would refuse (store-scoped with case_id TEXT NOT NULL) is excluded, naming the fresh store', async () => {
		const lc = await fresh('pf2f');
		const uw = lc.userWork;
		const db = lc.storage.db();
		db.exec("CREATE TABLE work.early(id TEXT PRIMARY KEY NOT NULL, case_id TEXT NOT NULL); INSERT INTO work.early VALUES ('e', 'A'); INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES ('early', 'user-work', 'GRS-18', '')");
		const snap = json(uw.exportAll());
		expect(snap.excluded).toEqual([{ name: 'early', kind: 'user-work', rows: 1, reason: expect.stringMatching(/^in a fresh store: .*case-scoped/) }]);
		expect((await failure(uw.importAll(json(snap)))).code).toBe('accepted');
		expect((await failure((await fresh('pf2f2')).userWork.importAll(json(snap)))).code).toBe('accepted');
	});
});
