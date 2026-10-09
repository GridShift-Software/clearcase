// The M2 contracts beyond views: the document-row read contract (v5 allRows()) with providers, and the enumerable
// user-work store that a generic backup lists and round-trips, including tables a later ticket defines.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import { OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId } from '../components/overview-slots.ts';
import { activeDocumentRows, documentCounts, documentRow, documentRows, listJson, registerDocumentRowProvider } from './documents.server.ts';
import type { ChronologyListRow, DocumentStateRow } from './model.ts';
import { MAX_SLOT_DATA_DEPTH, notPlainData, slotStates } from './overview-widgets.server.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import { USER_WORK_EXPORT, UserWorkError } from './user-work.server.ts';

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
		// revision() is asked first: its failure is the one reported (rows() is not asked then)
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
		// a later ticket defines its own table; the generic export includes it without code changes
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'], scope: 'case' });
		await uw.defineTable({ name: 'timesheet_entry', owner: 'GRS-17', description: 'time entries', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'blob', type: 'BLOB' }], primaryKey: ['case_id', 'entry_id'], scope: 'case' }); // idempotent
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
		expect(await lc2.userWork.importAll(json)).toMatchObject({ tables: 6, rows: 5, cases: ['e2e-case'] });
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

	it('refuses a restore into an existing table of another schema (type, NOT NULL, key order) and leaves every table and row unchanged', async () => {
		const { lc } = await setup('schema');
		// [source table, existing target table, a row already in the target]
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
		// the reviewer's case: the existing row survives and nothing was coerced
		expect(db2.prepare('SELECT id, value, typeof(value) AS t FROM work.shape_0').all().map((r) => ({ ...r }))).toEqual([{ id: 'k0', value: 7, t: 'integer' }]);
		// a compatible existing table restores losslessly: declared types compare case-insensitively, and a key column
		// counts as NOT NULL either way (a restore creates it so, and an export never carries a NULL key)
		db.exec('CREATE TABLE work.shape_ok(id TEXT PRIMARY KEY, value TEXT)');
		db.exec("INSERT INTO work.shape_ok VALUES ('k1', '001')");
		const ok = JSON.parse(JSON.stringify(lc.userWork.exportAll()));
		const okTable = ok.tables.find((t: { name: string }) => t.name === 'shape_ok');
		okTable.columns[0].notNull = true; // as a restored (WITHOUT ROWID) store exports it
		db2.exec("CREATE TABLE work.shape_ok(id text PRIMARY KEY, value text); INSERT INTO work.shape_ok VALUES ('k0', 'gone')");
		expect(await lc2.userWork.importAll({ ...ok, tables: ok.tables.filter((t: { name: string }) => t.name === 'shape_ok') })).toMatchObject({ tables: 1, rows: 1, restored: [{ name: 'shape_ok', scope: 'store', action: 'merged', rows: 1, deleted: 0 }] });
		// an unregistered table is store-scoped: merged by key, so the target's own row is kept
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
		await expect(uw.defineTable({ name: 'sqlitebackup', owner: 'GRS-20', description: '', columns: [{ name: 'id', type: 'TEXT' }], primaryKey: ['id'] })).rejects.toBeInstanceOf(UserWorkError);
		await expect(uw.defineTable({ name: 'sqlite_x', owner: 'GRS-20', description: '', columns: [{ name: 'id', type: 'TEXT' }], primaryKey: ['id'] })).rejects.toBeInstanceOf(UserWorkError);
		// listed by the export, as excluded with the reason (a restore could not recreate a reserved name)
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
		// and the restored store's own export restores into itself
		expect(await lc2.userWork.importAll(JSON.parse(JSON.stringify(back)))).toMatchObject({ tables: back.tables.length, rows: 2 });
	});

	it('exports INTEGERs beyond the JS safe range losslessly and restores them exactly', async () => {
		const { lc } = await setup('bigint');
		const uw = lc.userWork;
		const big = [2n ** 63n - 1n, -(2n ** 63n), 9007199254740993n];
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: 'big keys', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'n', type: 'INTEGER' }, { name: 'r', type: 'REAL' }], primaryKey: ['id'] });
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
		// valid shapes, but a row that breaks its NOT NULL key: the created table goes with the rolled-back transaction
		const failing = { format: 'clearcase.user-work/1', exportedAt: '2030-01-01T00:00:00Z', tables: [table('gamma_new', [col('id', 'TEXT', 1)], [{ id: 'ok' }, { id: null }])] };
		await expect(uw.importAll(failing as never)).rejects.toThrow();
		expect(uw.tables().map((t) => t.name)).toEqual(before);
	});
});

// GRS-13 gate follow-ups: the CC-24 adversarial findings F1-F11 on these contracts, as synthetic regressions.
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
		// the log under its own kind or disguised as user work, the pointer, and a results.sqlite (import state) table
		for (const t of [emptied, { ...emptied, kind: 'user-work' }, pointer, { name: 'import_attempt', kind: 'user-work', owner: 'x', description: '', columns: [col('id', 'TEXT', true, 1)], rows: [] }]) {
			expect(await code(lc.userWork.importAll(envelope([changed, t])))).toBe('restore-state');
		}
		// nothing was written: not the log, not the register rows that came before the refused table
		expect(lc.store.activationLog('e2e-case').length).toBe(log);
		expect(lc.userWork.listRows('e2e-case', 'deadlines').map((r) => r.fields.title)).toEqual(['kept']);
		// an export never offers what a restore refuses
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
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'INTEGER' }], primaryKey: ['id'] });
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
			const def = { name: t.name, owner: 'GRS-99', description: 'taken over', columns: t.columns.map((x) => ({ name: x.name, type: x.type as 'TEXT', notNull: x.notNull })), primaryKey: t.columns.filter((x) => x.pk > 0).sort((a, b) => a.pk - b.pk).map((x) => x.name) };
			expect([t.name, await code(uw.defineTable(def))]).toEqual([t.name, 'table-built-in']);
			expect([t.name, await code(uw.defineTable({ ...def, owner: t.owner }))]).toEqual([t.name, 'table-built-in']);
		}
		expect(await code(uw.defineTable({ name: 'document', owner: 'GRS-17', description: '', columns, primaryKey: ['entry_id'] }))).toBe('table-built-in');
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
		expect(notPlainData(new Map([['__proto__', 1]]))).toBeNull(); // a Map key is data, not a property
		// the reason names the problem, never the value
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

// GRS-13 gate round 2: the HARDEN-M2 verifiers' restore and provider findings, as synthetic regressions.
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
		// tables created outside the API (or before scopes existed) with a nullable or INTEGER case_id
		db.exec("CREATE TABLE work.saved_view(view_id TEXT PRIMARY KEY, case_id TEXT, json TEXT); INSERT INTO work.saved_view VALUES ('v-null', NULL, '{}'), ('v-a', 'e2e-case', '{}')");
		db.exec("CREATE TABLE work.tally(id TEXT PRIMARY KEY, case_id INTEGER); INSERT INTO work.tally VALUES ('t-1', 7)");
		// defineTable no longer makes such a table: a case_id column needs scope 'case', and that needs it NOT NULL
		const nullable = { name: 'bookmark_v', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' as const }, { name: 'case_id', type: 'TEXT' as const }], primaryKey: ['id'] };
		expect(await code(uw.defineTable(nullable))).toBe('invalid');
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
		await uw.defineTable({ name: 'bookmark', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_key', type: 'TEXT' }], primaryKey: ['id'] });
		await uw.defineTable({ name: 'ledger', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_id', type: 'TEXT', notNull: true }, { name: 'v', type: 'TEXT' }], primaryKey: ['id'], scope: 'case' });
		expect(Object.fromEntries(uw.tables().map((t) => [t.name, t.scope]))).toEqual({ active: 'case', activation_log: 'case', bookmark: 'store', ledger: 'case', note: 'case', register_row: 'case', seed_overlay: 'case', trusted_warning: 'case' });
		db.exec("INSERT INTO work.bookmark VALUES ('b-a', 'A'); INSERT INTO work.ledger VALUES ('k1', 'A', 'snap'), ('k2', 'A', 'snap')");
		await uw.putRow('A', 'deadlines', 'a-1', { title: 'in the snapshot' });
		const snap = JSON.parse(JSON.stringify(uw.exportAll()));
		expect(snap.tables.map((t: { name: string; scope: string }) => [t.name, t.scope])).toEqual([['bookmark', 'store'], ['ledger', 'case'], ['note', 'case'], ['register_row', 'case'], ['seed_overlay', 'case'], ['trusted_warning', 'case']]);
		// after the backup: another case's rows in both tables, and an edit of a snapshot row
		db.exec("INSERT INTO work.bookmark VALUES ('b-b', 'B'); INSERT INTO work.ledger VALUES ('k3', 'B', 'later'); UPDATE work.ledger SET v = 'edited' WHERE id = 'k1'");
		const r = await uw.importAll(snap);
		expect(r.cases).toEqual(['A']);
		expect(r.restored.filter((x) => x.rows || x.deleted)).toEqual([
			{ name: 'bookmark', scope: 'store', action: 'merged', rows: 1, deleted: 0 },
			{ name: 'ledger', scope: 'case', action: 'replaced-for-cases', rows: 2, deleted: 2 },
			{ name: 'register_row', scope: 'case', action: 'replaced-for-cases', rows: 1, deleted: 1 },
		]);
		expect(db.prepare('SELECT id FROM work.bookmark ORDER BY id').all().map((x) => x.id)).toEqual(['b-a', 'b-b']);
		expect(db.prepare('SELECT id, v FROM work.ledger ORDER BY id').all().map((x) => [x.id, x.v])).toEqual([['k1', 'snap'], ['k2', 'snap'], ['k3', 'later']]);
		// a snapshot key held by another case here is a typed refusal before any write, naming no value
		db.exec("DELETE FROM work.ledger WHERE id = 'k2'; INSERT INTO work.ledger VALUES ('k2', 'B', 'SECRET-B-ROW')");
		const before = rowsOf(lc);
		const clash = await failure(uw.importAll(snap));
		expect(clash.code).toBe('restore-key-collision');
		expect(clash.message).toMatch(/ledger.*\(id\)/);
		expect(clash.message).not.toMatch(/k2|SECRET|B-ROW/);
		expect(rowsOf(lc)).toBe(before);
		// a snapshot without case rows changes no case table, and says so; 'tables' replaces wholesale, and says so
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
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'n', type: 'INTEGER' }], primaryKey: ['n'] });
		db.exec("INSERT INTO work.counter VALUES (1), (1.5), ('seven')");
		await uw.defineTable({ name: 'gauge', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'r', type: 'REAL' }], primaryKey: ['id'] });
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
		await uw.defineTable({ name: 'box', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'n', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['id'] });
		await uw.defineTable({ name: 'counter', owner: 'GRS-17', description: '', columns: [{ name: 'n', type: 'INTEGER' }], primaryKey: ['n'] });
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
		const ok = { name: 'pin', owner: 'GRS-17', description: '', columns: [{ name: 'a', type: 'TEXT' as const }], primaryKey: ['a'] };
		for (const bad of [{ ...ok, primaryKey: ['a', 'a'] }, { ...ok, owner: undefined }, { ...ok, description: undefined }, { ...ok, columns: 'x' }, { ...ok, columns: [ok.columns[0], ok.columns[0]] }, { ...ok, columns: [null] }, null]) {
			expect(await code(uw.defineTable(bad as never))).toBe('invalid');
		}
		expect(uw.tables().some((t) => t.name === 'pin')).toBe(false);
		lc.storage.db().exec('CREATE TABLE work."Oob5" (x BLOB PRIMARY KEY) WITHOUT ROWID');
		expect(await code(uw.defineTable({ name: 'oob5', owner: 'GRS-17', description: '', columns: [{ name: 'entry_id', type: 'TEXT' }], primaryKey: ['entry_id'] }))).toBe('table-conflict');
		expect(await code(uw.defineTable({ name: 'oob5', owner: 'GRS-17', description: '', columns: [{ name: 'x', type: 'BLOB' }], primaryKey: ['x'] }))).toBe('table-conflict');
		expect(uw.tables().filter((t) => t.name.toLowerCase() === 'oob5').map((t) => [t.name, t.kind])).toEqual([['Oob5', 'unregistered']]);
	});
});
