// GRS-56 item 1: a v5 backup's `ess_dcs_custom_bundles_v1` is imported through GRS-19's importV5CustomBundles by the
// legacy import hook (GRS-20), under the stable ids `v5-<no>`, so importing one file twice writes the same rows.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';

const g = globalThis as { __clearcase?: unknown };
const KEY = 'ess_dcs_custom_bundles_v1';
let root: string, lc: LocalCase, caseId: string, rv: string;
let backup: typeof import('../../src/lib/user-work/backup/backup.server.ts');
let store: typeof import('../../src/lib/views/bundles/store.server.ts');
afterAll(async () => { try { lc?.shutdown(); } catch { /* closed */ } if (root) await cleanup(root); });

beforeAll(async () => {
	root = await tempRoot('legacy-bundles');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	const built = await buildCase(path.join(root, 'case'), { caseId: 'legacy-bundles' });
	const i = await lc.importPackage(built.caseDir, built.pkgDir);
	expect(await lc.activate(built.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
	caseId = 'legacy-bundles'; rv = built.resultsVersion;
	g.__clearcase = { app: lc, originals: null, id: 'legacy-bundles', startedAt: '', build: null };
	vi.resetModules();
	backup = await import('../../src/lib/user-work/backup/backup.server.ts');
	store = await import('../../src/lib/views/bundles/store.server.ts');
	const importers = await import('../../src/lib/user-work/backup/v5-importers.server.ts');
	importers.registerV5Importers();
	importers.registerV5Importers(); // once per process: a second call is not an error
}, 120_000);

const row = (n: number, desc: string) => ({ n, key: '', desc, pages: 3, from: 1, to: 3, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 3 }] });
// the shape v5 localStorage holds: a JSON string inside the backup object
const v5File = (list: unknown[]) => JSON.stringify({ [KEY]: JSON.stringify(list) });

describe('legacy import of custom bundles', () => {
	it('writes each bundle under v5-<no>, keeps the list order, and writes the same rows when the file is imported twice', async () => {
		const file = v5File([
			{ no: 'C1', name: 'Hearing bundle', pages: 6, indexPages: 1, filePages: 7, note: 'n', rows: [row(1, 'ALPHA'), row(2, 'BETA')] },
			{ no: 'C2', name: 'Trial bundle', pages: 3, indexPages: 0, filePages: 3, note: '', rows: [row(1, 'GAMMA')] },
			{ no: 'C1', name: 'Repeated number, dropped', pages: 1, indexPages: 0, filePages: 1, note: '', rows: [] },
		]);
		const first = await backup.restoreBackup(lc, file, { caseId, resultsVersion: rv });
		expect(first).toMatchObject({ kind: 'legacy', legacy: { changed: true, rows: 2, error: null, keys: [{ key: KEY, status: 'imported', importer: 'v5-custom-bundles' }] } });
		const once = await store.readCustom(caseId);
		expect(once.map((c) => [c.id, c.no, c.name, c.rows.length, c.seq])).toEqual([['v5-C1', 'C1', 'Hearing bundle', 2, 1], ['v5-C2', 'C2', 'Trial bundle', 1, 2]]);
		expect(once[0]!.rows[0]!.parts[0]).toEqual({ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 3 });

		const second = await backup.restoreBackup(lc, file, { caseId, resultsVersion: rv });
		expect(second).toMatchObject({ kind: 'legacy', legacy: { error: null } });
		expect(await store.readCustom(caseId)).toEqual(once);
		expect(lc.userWork.listTableRows(store.CUSTOM_TABLE, { caseId })).toHaveLength(2);
	});

	it('the next bundle the builder saves takes a number past the imported ones, and an import keeps a bundle saved by the builder', async () => {
		expect(await store.saveCustom(caseId, 'builder-out', { name: 'Built here', pages: 1, indexPages: 0, filePages: 1, note: '', rows: [] }, [])).toBe('C3');
		await backup.restoreBackup(lc, v5File([{ no: 'C4', name: 'Fourth', rows: [] }]), { caseId, resultsVersion: rv });
		expect((await store.readCustom(caseId)).map((c) => [c.id, c.no])).toEqual([['v5-C1', 'C1'], ['v5-C2', 'C2'], ['builder-out', 'C3'], ['v5-C4', 'C4']]);
	});

	it('a write that fails part-way leaves no bundle of the file and says the import failed and nothing changed', async () => {
		// a busy or failing store on the 2nd bundle: a trigger refuses the row of C8 (whatever way the rows are written)
		await lc.storage.tx((d) => { d.exec("CREATE TRIGGER work.refuse_c8 BEFORE INSERT ON bundles_custom WHEN NEW.id = 'v5-C8' BEGIN SELECT RAISE(ABORT, 'store busy'); END"); });
		const before = (await store.readCustom(caseId)).map((c) => c.id);
		try {
			const out = await backup.restoreBackup(lc, v5File([{ no: 'C7', name: 'Seventh', rows: [] }, { no: 'C8', name: 'Eighth', rows: [] }, { no: 'C9', name: 'Ninth', rows: [] }]), { caseId, resultsVersion: rv });
			expect(out).toMatchObject({ kind: 'legacy', legacy: { changed: false, rows: 0, keys: [{ key: KEY, status: 'failed' }] } });
			expect((out as { legacy: { error: string } }).legacy.error).toMatch(/v5-custom-bundles: .*nothing was written/);
			expect((await store.readCustom(caseId)).map((c) => c.id)).toEqual(before);
		} finally {
			await lc.storage.tx((d) => { d.exec('DROP TRIGGER work.refuse_c8'); });
		}
	});

	it('a value that holds no bundle writes nothing and says so; another case is untouched', async () => {
		const before = lc.userWork.listTableRows(store.CUSTOM_TABLE, { caseId }).length;
		const out = await backup.restoreBackup(lc, JSON.stringify({ [KEY]: 'not json' }), { caseId, resultsVersion: rv });
		expect(out).toMatchObject({ kind: 'legacy', legacy: { changed: false, rows: 0 } });
		expect(lc.userWork.listTableRows(store.CUSTOM_TABLE, { caseId })).toHaveLength(before);
		expect(lc.userWork.listTableRows(store.CUSTOM_TABLE, { caseId: 'other-case' })).toEqual([]);
	});
});
