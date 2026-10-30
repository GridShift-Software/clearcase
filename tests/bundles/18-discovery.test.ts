import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestServices } from '../../src/lib/server/runtime/contracts';
import {
	createD1UserWork,
	d1WorkRevision,
} from '../../src/lib/user-work/hosted';
import {
	authority,
	auditLog,
	bind,
	CASE,
	caseReader,
	CLIENT,
	d1,
	database,
	RV1,
} from '../hosted-foundation/user-work/world';
import { chunkKeys } from '../../src/lib/views/bundles/ops';
vi.mock('cloudflare:workers', () => ({
	env: {
		CLEARCASE_NATIVE_CONFIG: JSON.stringify({
			userWorkLimits: { maxStatementsPerBatch: 20 },
		}),
	},
}));
import { actions } from '../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/discovery_tab/+page.server';
test('200 C/O marks persist through bulk adapter batches within staging statement and query limits', async () => {
	const db = database();
	bind(db);
	db.exec(
		readFileSync(
			'src/lib/user-work/hosted/migrations/0002_bundle_tables.sql',
			'utf8',
		),
	);
	const binding = d1(db),
		batch = binding.batch.bind(binding);
	let batches = 0,
		maxStatements = 0;
	binding.batch = async (rows) => {
		batches++;
		maxStatements = Math.max(maxStatements, rows.length);
		return batch(rows);
	};
	const auth = authority(),
		identity = auth.identity();
	auth.grant('editor', CASE, 'editor');
	const config = {
		clientId: CLIENT,
		limits: { maxStatementsPerBatch: 20, maxSnapshotBytes: 1000000 },
	};
	const store = {
		...caseReader({ published: RV1, versions: {} }).reader,
		stateRevision: d1WorkRevision({ db: binding, config }),
		publication: async () => ({
			versionId: RV1,
 publishedAt: null, previousVersionId: null,
			shardManifestSha256: 'a'.repeat(64),
			shards: {},
		}),
	};
	const work = createD1UserWork({
		db: binding,
		config,
		identity,
		audit: auditLog().sink,
		store,
		now: () => new Date('2026-10-28T00:00:00Z'),
	});
	const locals = { store, userWork: work } as unknown as RequestServices;
	const keys = Array.from({ length: 200 }, (_, i) => `Synthetic/File-${i}.pdf`);
	const event = (val: string, base: string) => {
		const f = new FormData();
		f.set('val', val);
		for (const key of keys) {
			f.append('key', key);
			f.append('base', base);
		}
		return {
			locals,
			params: { caseId: CASE, version: RV1 },
			request: new Request('http://test', { method: 'POST', body: f }),
		} as unknown as RequestEvent;
	};
	try {
		const result = await actions.co!(event('O', ''));
		expect(result).toEqual({ saved: 200 });
		const calls = binding.statements.length;
		expect(
			(
				await work.listTableRows({
					caseId: CASE,
					table: 'bundles_schedule_mark',
				})
			).every((r) => r.cells.co === 'O'),
		).toBe(true);
		expect(
			(
				await work.listTableRows({
					caseId: CASE,
					table: 'bundles_schedule_mark',
				})
			).length,
		).toBe(200);
		expect(maxStatements).toBeLessThanOrEqual(20);
		expect(batches).toBe(13); // 200 rows in batches of 16, each with its audit event (GRS-266); no acknowledgement batches
		expect(calls).toBeLessThan(1000);
		console.info('18 bulk marks', {
			keys: 200,
			d1Statements: calls,
			batches,
			maxStatements,
		});
		const before = binding.statements.length;
		const conflict = await actions.co!(event('C', 'C'));
		expect(conflict).toMatchObject({ status: 409 });
		expect(batches).toBe(13);
		expect(binding.statements.length - before).toBeLessThan(10);
		expect(
			chunkKeys(Array.from({ length: 1000 }, (_, i) => String(i))).every(
				(c) => c.length <= 200,
			),
		).toBe(true);
	} finally {
		db.close();
	}
});
