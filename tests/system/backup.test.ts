// Backup / Restore (GRS-20): a backup carries every registered table of the case (built in and defined), restores
// into a fresh profile, and a corrupt, incompatible, altered, wrong-case or legacy file leaves the active data
// unchanged. The legacy import hook is tested with a fake importer (importing v5 state is out of scope).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures.ts';
import { rescan } from '../../src/lib/local-case/rescan/rescan.server.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';
import { putOriginal } from '../e2e/pilot/lib/fixtures.ts';
import { BACKUP_FORMAT, backupName, checkBackup, createBackup, restoreBackup, type BackupFile } from '../../src/lib/user-work/backup/backup.server.ts';
import { backupPage } from '../../src/lib/views/system/backup.server.ts';
import { legacyBackup, registerLegacyImporter } from '../../src/lib/user-work/backup/legacy.server.ts';
import { V5_LEGACY_KEYS, V5_STORES } from '../../src/lib/user-work/backup/v5-keys.ts';

let root: string;
const opened: LocalCase[] = [];
afterAll(async () => { for (const lc of opened) lc.shutdown(); if (root) await cleanup(root); });

async function profile(name: string, cases: { caseId: string; dir: string }[]) {
	const lc = service(path.join(root, name));
	opened.push(lc);
	await lc.startup();
	const out: Record<string, string> = {};
	for (const c of cases) {
		const built = await buildCase(c.dir, { caseId: c.caseId });
		const i = await lc.importPackage(built.caseDir, built.pkgDir);
		expect(await lc.activate(built.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
		out[c.caseId] = built.resultsVersion;
	}
	return { lc, rv: out };
}

const CASE = 'backup-case';
const OTHER = 'other-case';
let a: LocalCase, rv: string, otherRv: string;

/** Every table's rows for one case, and every store table's rows: what a restore must reproduce. */
function workOf(lc: LocalCase, caseId: string) {
	return lc.userWork.exportAll().tables.filter((t) => t.name !== 'trusted_warning').map((t) => ({ name: t.name, rows: t.scope === 'case' ? t.rows.filter((r) => r.case_id === caseId) : t.rows }));
}

beforeAll(async () => {
	root = await tempRoot('backup');
	({ lc: a, rv: { [CASE]: rv, [OTHER]: otherRv } } = await profile('a', [{ caseId: CASE, dir: path.join(root, 'c1') }, { caseId: OTHER, dir: path.join(root, 'c2') }]));
	// user work of every kind: notes, register rows in several stores (one anchored), a defined case table, a defined
	// store table, rescan rows; and the other case's work, which a restore of this case must never touch
	await a.userWork.addNote(CASE, rv, 'OD-001', 'synthetic note');
	await a.userWork.putRow(CASE, 'deadlines', null, { title: 'File reply', date: '2001-03-01', seq: 1 });
	await a.userWork.putRow(CASE, 'timesheet', null, { hours: 1.5, billed: 'no', seq: 1 }, a.userWork.anchorFor(CASE, rv, 'OD-002'));
	await a.userWork.defineTable({ name: 'test_marks', owner: 'TEST', scope: 'case', description: 'synthetic', columns: [{ name: 'case_id', type: 'TEXT', notNull: true }, { name: 'k', type: 'TEXT', notNull: true }, { name: 'n', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['case_id', 'k'] });
	await a.userWork.putTableRow('test_marks', { case_id: CASE, k: 'x', n: 2, b: { $b64: 'AAE=' } }, { owner: 'TEST' });
	await a.userWork.defineTable({ name: 'test_prefs', owner: 'TEST', scope: 'store', description: 'synthetic', columns: [{ name: 'k', type: 'TEXT', notNull: true }, { name: 'v', type: 'TEXT' }], primaryKey: ['k'] });
	await a.userWork.putTableRow('test_prefs', { k: 'theme', v: 'plain' }, { owner: 'TEST' });
	await putOriginal(a.store.getVersion(rv)!.case_root, 'DISCOVERY A/OD-005 Added.pdf', new TextEncoder().encode('%PDF-1.4 x'));
	await rescan(a, rv, 'quick');
	await a.userWork.addNote(OTHER, otherRv, 'OD-001', 'other case note');
	await a.userWork.putTableRow('test_marks', { case_id: OTHER, k: 'y', n: 9, b: null }, { owner: 'TEST' });
}, 120_000);

const textOf = (b: BackupFile) => JSON.stringify(b, null, 2);

describe('backup', () => {
	it('carries every registered table with this case only, the identity, version metadata and binaries: false', () => {
		const b = createBackup(a, rv, 'build-x');
		expect(b).toMatchObject({ format: BACKUP_FORMAT, binaries: false, case: { caseId: CASE, resultsVersion: rv }, app: { backupFormat: 1, userWorkFormat: 'clearcase.user-work/1', build: 'build-x' } });
		const names = b.userWork.tables.map((t) => t.name).sort();
		const registered = a.userWork.tables().filter((t) => t.kind !== 'activation' && t.name !== 'trusted_warning').map((t) => t.name).sort();
		expect(names).toEqual(registered);
		expect(names).toEqual(expect.arrayContaining(['note', 'register_row', 'seed_overlay', 'test_marks', 'test_prefs', 'rescan_file', 'rescan_run']));
		for (const t of b.userWork.tables) if (t.scope === 'case') expect(t.rows.every((r) => r.case_id === CASE)).toBe(true);
		expect(b.counts).toMatchObject({ note: 1, register_row: 2, test_marks: 1, test_prefs: 1, rescan_file: 1, rescan_run: 1 });
		expect(backupName(b)).toMatch(/^clearcase-backup-backup-case-\d{8}-\d{4}\.json$/);
	});

	it('round trip: restore after the work changed brings every table back exactly; the other case is untouched', async () => {
		const before = workOf(a, CASE);
		const other = workOf(a, OTHER);
		const text = textOf(createBackup(a, rv));
		await a.userWork.addNote(CASE, rv, 'OD-003', 'added after the backup');
		await a.userWork.putTableRow('test_marks', { case_id: CASE, k: 'x', n: 3, b: null }, { owner: 'TEST' });
		const out = await restoreBackup(a, text, { caseId: CASE, resultsVersion: rv });
		expect(out.kind).toBe('restored');
		expect(workOf(a, CASE)).toEqual(before);
		expect(workOf(a, OTHER).filter((t) => t.name !== 'test_prefs')).toEqual(other.filter((t) => t.name !== 'test_prefs'));
	});

	it('restores into a fresh profile (a new data directory with the same case imported)', async () => {
		const text = textOf(createBackup(a, rv));
		const { lc: b, rv: { [CASE]: freshRv } } = await profile('fresh', [{ caseId: CASE, dir: path.join(root, 'c3') }]);
		const out = await restoreBackup(b, text, { caseId: CASE, resultsVersion: freshRv });
		expect(out.kind === 'restored' && out.summary.rows).toBe(createBackup(a, rv).userWork.tables.reduce((n, t) => n + t.rows.length, 0));
		expect(workOf(b, CASE)).toEqual(workOf(a, CASE));
		expect(b.userWork.notesFor(CASE, freshRv, 'OD-001').map((n) => n.body)).toEqual(['synthetic note']);
	});

	it('a corrupt, incompatible, altered, wrong-case or oversized file is refused and the active data is unchanged', async () => {
		const good = createBackup(a, rv);
		const before = JSON.stringify(a.userWork.exportAll().tables);
		const altered = structuredClone(good);
		(altered.userWork.tables.find((t) => t.name === 'note')!.rows[0] as Record<string, unknown>).body = 'tampered';
		const otherCase = createBackup(a, otherRv);
		const smuggled = structuredClone(good);
		smuggled.userWork.tables.find((t) => t.name === 'test_marks')!.rows.push({ case_id: OTHER, k: 'z', n: 1, b: null });
		smuggled.sha256 = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(smuggled.userWork)).digest('hex');
		const cases: [string, string][] = [
			[textOf(good).slice(0, 200), 'not-json'],
			['[1,2]', 'not-a-backup'],
			[JSON.stringify({ format: 'clearcase.backup/2' }), 'incompatible'],
			[JSON.stringify({ ...good, app: { ...good.app, userWorkFormat: 'clearcase.user-work/9' } }), 'incompatible'],
			[textOf(altered), 'corrupt'],
			[textOf(otherCase), 'wrong-case'],
			[textOf(smuggled), 'wrong-case'],
			['x'.repeat(64 * 1024 * 1024 + 1), 'too-large'],
		];
		for (const [text, code] of cases) {
			await expect(restoreBackup(a, text, { caseId: CASE, resultsVersion: rv }), code).rejects.toMatchObject({ code });
			expect(JSON.stringify(a.userWork.exportAll().tables)).toBe(before);
		}
		expect(() => checkBackup(textOf(good), { caseId: CASE, resultsVersion: rv })).not.toThrow();
	});

	it('a table the contract refuses rolls the whole restore back (nothing half-restored)', async () => {
		const bad = createBackup(a, rv);
		bad.userWork.tables.push({ name: 'active', kind: 'activation', scope: 'store', owner: 'x', description: '', columns: [], rows: [] } as never);
		bad.sha256 = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(bad.userWork)).digest('hex');
		await a.userWork.addNote(CASE, rv, 'OD-004', 'kept');
		const before = JSON.stringify(a.userWork.exportAll().tables);
		await expect(restoreBackup(a, textOf(bad), { caseId: CASE, resultsVersion: rv })).rejects.toMatchObject({ code: 'refused' });
		expect(JSON.stringify(a.userWork.exportAll().tables)).toBe(before);
	});

	it('a restore whose copy of the current work fails is refused and changes nothing', async () => {
		const good = createBackup(a, rv);
		await a.userWork.addNote(CASE, rv, 'OD-004', 'not in the backup');
		const before = JSON.stringify(a.userWork.exportAll().tables);
		const store = (a as unknown as { store: { backupWork: (...x: unknown[]) => unknown } }).store;
		const real = store.backupWork;
		store.backupWork = () => { throw new Error('synthetic: no space left'); };
		try {
			await expect(restoreBackup(a, textOf(good), { caseId: CASE, resultsVersion: rv })).rejects.toMatchObject({ code: 'refused' });
		} finally { store.backupWork = real; }
		expect(JSON.stringify(a.userWork.exportAll().tables)).toBe(before);
		a.backupNow('test-recovered');
		expect(a.warnings.has('backup-failed')).toBe(false);
	});
});

describe('restore keeps no stale work (review H1, M1)', () => {
	let lc: LocalCase, vid: string;
	const ID = 'fresh-case';
	const rows = (table: string) => lc.userWork.exportAll().tables.find((t) => t.name === table)!.rows.filter((r) => r.case_id === ID).length;
	beforeAll(async () => { ({ lc, rv: { [ID]: vid } } = await profile('h1', [{ caseId: ID, dir: path.join(root, 'h1') }])); }, 120_000);

	it('H1: restoring a backup of an empty case removes the note and the deadline added since', async () => {
		const empty = textOf(createBackup(lc, vid));
		await lc.userWork.addNote(ID, vid, 'OD-001', 'added after the backup');
		await lc.userWork.putRow(ID, 'deadlines', null, { title: 'File reply', date: '2001-03-01', seq: 1 });
		expect([rows('note'), rows('register_row')]).toEqual([1, 1]);
		const out = await restoreBackup(lc, empty, { caseId: ID, resultsVersion: vid });
		expect(out.kind).toBe('restored');
		expect([rows('note'), rows('register_row')]).toEqual([0, 0]);
	});

	it('M1: the copy of the work before a restore is a JSON file outside the rotation, and its path is returned', async () => {
		const good = textOf(createBackup(lc, vid));
		await lc.userWork.addNote(ID, vid, 'OD-002', 'kept in the copy');
		const out = await restoreBackup(lc, good, { caseId: ID, resultsVersion: vid });
		if (out.kind !== 'restored') throw new Error('not restored');
		const copy = out.preRestore;
		expect(copy).toBe(path.join(lc.storage.backupDir, 'pre-restore', path.basename(copy)));
		expect(JSON.parse(readFileSync(copy, 'utf8')).userWork.tables.find((t: { name: string }) => t.name === 'note').rows).toHaveLength(1);
		for (let i = 0; i < 12; i++) lc.backupNow(`rotate-${i}`);
		expect(readdirSync(lc.storage.backupDir).filter((n) => /^work-.*\.sqlite$/.test(n)).length).toBeLessThanOrEqual(10);
		expect(existsSync(copy)).toBe(true);
	});

	it('M1: a copy that cannot be written refuses the restore and changes nothing (also for a v5 backup)', async () => {
		const dir = path.join(lc.storage.backupDir, 'pre-restore');
		rmSync(dir, { recursive: true, force: true });
		writeFileSync(dir, 'a file where the directory should be');
		const good = textOf(createBackup(lc, vid));
		await lc.userWork.addNote(ID, vid, 'OD-003', 'not in the backup');
		const before = JSON.stringify(lc.userWork.exportAll().tables);
		const undo = registerLegacyImporter({ id: 'm1', owner: 'TEST', keys: ['ess_dcs_deadlines_v1'], import: async () => ({ rows: 1 }) });
		try {
			await expect(restoreBackup(lc, good, { caseId: ID, resultsVersion: vid })).rejects.toMatchObject({ code: 'refused' });
			await expect(restoreBackup(lc, JSON.stringify({ ess_dcs_deadlines_v1: [{ title: 'x' }] }), { caseId: ID, resultsVersion: vid })).rejects.toMatchObject({ code: 'refused' });
		} finally { undo(); rmSync(dir, { force: true }); mkdirSync(dir); }
		expect(JSON.stringify(lc.userWork.exportAll().tables)).toBe(before);
	});

	it('M2: the page data lists the tables the export leaves out', () => {
		lc.storage.db().exec('CREATE TABLE work.stray_nopk(a TEXT, b TEXT)');
		lc.storage.db().exec("INSERT INTO work.stray_nopk VALUES ('x', 'y')");
		try {
			const page = backupPage(lc, vid);
			expect(page.excluded).toEqual([expect.objectContaining({ name: 'stray_nopk', rows: 1, reason: expect.any(String) })]);
			expect(page.excluded[0].reason.length).toBeGreaterThan(0);
		} finally { lc.storage.db().exec('DROP TABLE work.stray_nopk'); }
		expect(backupPage(lc, vid).excluded).toEqual([]);
	});
});

describe('legacy import hook (v5 browser backups)', () => {
	const v5 = () => ({ ...Object.fromEntries(V5_STORES.map((s) => [s.key, null])), ...Object.fromEntries(V5_LEGACY_KEYS.map((k) => [k, []])), ess_dcs_deadlines_v1: [{ title: 'synthetic' }], ess_dcs_future_v1: [1] });

	it('documents the 21 live v5 stores and the four legacy keys', () => {
		expect(V5_STORES).toHaveLength(21);
		expect(V5_STORES.map((s) => s.key)).toEqual(expect.arrayContaining(['ess_dcs_bundle_header_v2', 'ess_dcs_caselines_docs_v1', 'ess_dcs_schedule_co_v1', 'ess_dcs_schedule_mode_v1', 'ess_dcs_schedule_sel_v1']));
		expect(V5_LEGACY_KEYS).toEqual(['ess_dcs_courtbundle_v1', 'ess_dcs_bundle_header_v1', 'ess_dcs_bundle_extents_v1', 'ess_dcs_bundle_overrides_v1']);
		expect([legacyBackup(v5()), legacyBackup({}), legacyBackup({ format: 'x' })]).toEqual([true, false, false]);
	});

	it('with no importer a v5 backup is recognised, described and changes nothing', async () => {
		const before = JSON.stringify(a.userWork.exportAll().tables);
		const out = await restoreBackup(a, JSON.stringify(v5()), { caseId: CASE, resultsVersion: rv });
		expect(out.kind).toBe('legacy');
		if (out.kind !== 'legacy') return;
		expect(out.legacy.changed).toBe(false);
		const status = Object.fromEntries(out.legacy.keys.map((k) => [k.key, k.status]));
		expect(status).toMatchObject({ ess_dcs_deadlines_v1: 'no-importer', ess_dcs_timesheet_v1: 'empty', ess_dcs_courtbundle_v1: 'legacy-unused', ess_dcs_bundle_header_v1: 'legacy-unused', ess_dcs_bundle_extents_v1: 'legacy-unused', ess_dcs_bundle_overrides_v1: 'legacy-unused', ess_dcs_future_v1: 'unknown' });
		expect(JSON.stringify(a.userWork.exportAll().tables)).toBe(before);
	});

	it('a registered importer receives its keys (including a legacy key) for the active case', async () => {
		const seen: unknown[] = [];
		const undo = registerLegacyImporter({ id: 'fake', owner: 'TEST', keys: ['ess_dcs_deadlines_v1', 'ess_dcs_courtbundle_v1'], import: async (ctx, values) => { seen.push([ctx.caseId, values]); return { rows: 1 }; } });
		try {
			expect(() => registerLegacyImporter({ id: 'dup', owner: 'TEST', keys: ['ess_dcs_deadlines_v1'], import: async () => ({ rows: 0 }) })).toThrow(/imported by fake/);
			const out = await restoreBackup(a, JSON.stringify(v5()), { caseId: CASE, resultsVersion: rv });
			expect(out.kind === 'legacy' && [out.legacy.changed, out.legacy.rows]).toEqual([true, 1]);
			expect(seen).toEqual([[CASE, { ess_dcs_courtbundle_v1: [], ess_dcs_deadlines_v1: [{ title: 'synthetic' }] }]]);
		} finally { undo(); }
	});
});
