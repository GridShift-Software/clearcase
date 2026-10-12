// A failed document-row provider is disclosed by Search and Diff too (GRS-14, CC-04 r2, D14): the search rows carry
// the failure that the list and Documents carry, so the views can say that some documents are left out. Synthetic case
// and a synthetic provider whose revision() throws.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import { registerDocumentRowProvider } from '../../src/lib/local-case/documents.server';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, service, tempRoot } from '../../src/lib/local-case/test-support';
import { evidenceRows, searchRowsOf } from '../../src/lib/views/evidence/rows.server';

let root: string, lc: LocalCase, rv: string;
beforeAll(async () => {
	root = await tempRoot('evidence-degraded');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	const c = await buildCase(path.join(root, 'c'));
	await lc.importPackage(c.caseDir, c.pkgDir);
	rv = c.resultsVersion;
}, 120_000);
afterAll(async () => {
	lc?.shutdown();
	if (root) await cleanup(root);
});

describe('a failed document-row provider', () => {
	it('is carried by the search rows as by the evidence rows, and its rows are left out', () => {
		const before = searchRowsOf(lc.store, rv)!;
		expect(before.failed).toEqual([]);
		const undo = registerDocumentRowProvider({ id: 'broken', owner: 'GRS-20', revision: () => { throw new Error('synthetic provider failure'); }, rows: () => [] });
		try {
			const s = searchRowsOf(lc.store, rv)!;
			expect(s.failed).toHaveLength(1);
			expect(s.failed).toEqual(evidenceRows(lc.store, rv)!.failed);
			expect(s.failed[0]).toMatchObject({ owner: 'GRS-20' });
			expect(s.rows).toHaveLength(before.rows.length);
		} finally { undo(); }
	});
});
