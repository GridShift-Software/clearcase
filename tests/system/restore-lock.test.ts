// GRS-54 on real SQLite (LocalCase work.sqlite): a write started from a timer inside an `exclusive` run after the run settled queues like any other write (N1 of the
// GRS-52 re-check). A second connection holding BEGIN IMMEDIATE keeps a write mid-transaction (busy, retrying), the
// window in which an unqueued write would read the store before the held one commits.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures.ts';
import { registers, type AddResult, type ReplaceResult } from '../../src/lib/local-case/registers.server.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';

const CASE = 'lock-case';
const OTHER = 'lock-other';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let root: string, lc: LocalCase;
const rv: Record<string, string> = {};

beforeAll(async () => {
	root = await tempRoot('restore-lock');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	for (const caseId of [CASE, OTHER]) {
		const built = await buildCase(path.join(root, caseId), { caseId });
		const i = await lc.importPackage(built.caseDir, built.pkgDir);
		expect(await lc.activate(built.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
		rv[caseId] = built.resultsVersion;
	}
});
afterAll(async () => { lc?.shutdown(); if (root) await cleanup(root); });

/** Hold work.sqlite's write lock from another connection for `ms`: this process's writes meanwhile are busy and retry. */
function holdStore(ms: number): Promise<void> {
	const d = new DatabaseSync(lc.storage.workFile);
	d.exec('BEGIN IMMEDIATE');
	return tick(ms).then(() => { d.exec('COMMIT'); d.close(); });
}
const fieldsOf = (caseId: string, store: string) => registers(lc.userWork).open(caseId, store).rows().map((r) => r.fields);

describe('N1: a write started after its exclusive run settled', () => {
	it('queues like any other: it never shares a seq with a held write, goes through the re-check, and may write another store', async () => {
		const r = registers(lc.userWork);
		const adds = r.open(CASE, 'n1-adds'), edits = r.open(CASE, 'n1-edits'), another = r.open(CASE, 'n1-another');
		await adds.add({ k: 'first' });
		const { rowId } = await edits.add({ k: 'row' });
		const shown = edits.rows()[0]!.version;
		let lateAdd: Promise<AddResult> | null = null, lateEdit: Promise<ReplaceResult> | null = null, lateOther: Promise<AddResult> | null = null;
		// each timer keeps its run's async context and fires after the run has settled
		await r.exclusive(CASE, async () => { setTimeout(() => { lateAdd = adds.add({ k: 'late' }); }, 20); });
		await edits.batch(async () => { setTimeout(() => { lateEdit = edits.replace(rowId, shown, { k: 'late edit' }); lateOther = another.add({ k: 'late' }); }, 20); });
		const held = holdStore(100);
		const normalAdd = adds.add({ k: 'normal' });
		const normalEdit = edits.replace(rowId, shown, { k: 'normal edit' });
		await tick(40);
		expect([lateAdd, lateEdit, lateOther]).not.toContain(null);
		await held;
		const results = await Promise.allSettled([normalAdd, lateAdd!, normalEdit, lateEdit!, lateOther!]);
		expect(results.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
		expect([await normalEdit, await lateEdit!]).toEqual(['replaced', 'stale']);
		expect(fieldsOf(CASE, 'n1-adds')).toEqual([{ k: 'first', seq: 1 }, { k: 'normal', seq: 2 }, { k: 'late', seq: 3 }]);
		expect(fieldsOf(CASE, 'n1-edits')).toEqual([{ k: 'normal edit', seq: 1 }]);
	});
});
