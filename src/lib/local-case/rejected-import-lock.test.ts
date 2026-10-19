// PR #76 review, GRS-22, same class as the refused conversion: importPackage also keeps the import lock until a
// rejection is recorded, so an import started meanwhile is told another one is running instead of racing it.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportReport, LocalCase } from './service.server.ts';
import { cleanup, service, tempRoot } from './test-support.ts';

let root = '';
let lc: LocalCase | null = null;
afterEach(async () => {
	vi.restoreAllMocks();
	lc?.shutdown();
	lc = null;
	if (root) await cleanup(root);
});

describe('importPackage while a rejection is still being recorded', () => {
	it('tells a second import that another one is running until the first rejection row is written', async () => {
		root = await tempRoot('rejected-lock');
		lc = service(path.join(root, 'data'));
		await lc.startup();
		const caseDir = path.join(root, 'case');
		const emptyPackage = path.join(root, 'package');
		await mkdir(caseDir);
		await mkdir(emptyPackage);
		const record = lc.store.recordRejected.bind(lc.store);
		const rows: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((r) => { release = r; });
		let entered!: () => void;
		const writing = new Promise<void>((r) => { entered = r; });
		vi.spyOn(lc.store, 'recordRejected').mockImplementation(async (row) => {
			rows.push(row.report);
			if (rows.length > 1) return record(row);
			entered();
			await held;
			return record(row);
		});
		const first = lc.importPackage(caseDir, emptyPackage);
		await writing;
		try {
			expect((await lc.importPackage(caseDir, emptyPackage)).kind).toBe('rejected');
		} finally {
			release();
		}
		expect((await first).kind).toBe('rejected');
		const reports = rows.map((r) => JSON.parse(r) as ImportReport);
		expect(reports).toHaveLength(2);
		expect(reports[1]!.app.map((a) => a.message)).toEqual(['another import is still running']);
	});
});
