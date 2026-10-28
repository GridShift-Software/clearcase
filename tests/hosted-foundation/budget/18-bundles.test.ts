import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createD1UserWork } from '../../../src/lib/user-work/hosted';
import { counters, countedD1, measure } from './harness';
import {
	authority,
	auditLog,
	bind,
	CASE,
	caseReader,
	CLIENT,
	d1,
	database,
	LIMITS,
	RV1,
} from '../user-work/world';
import {
	bundleStore,
	CUSTOM_TABLE,
	customRows,
} from '../../../src/lib/views/bundles/store.hosted';
import type { RequestServices } from '../../../src/lib/server/runtime/contracts';
function fixture() {
	const db = database();
	bind(db);
	db.exec(
		readFileSync(
			'src/lib/user-work/hosted/migrations/0002_bundle_tables.sql',
			'utf8',
		),
	);
	const auth = authority();
	auth.grant('editor', CASE, 'editor');
	const c = counters();
	let batches = 0;
	const binding = d1(db),
		originalBatch = binding.batch.bind(binding);
	binding.batch = async (statements) => {
		batches++;
		return originalBatch(statements);
	};
	const work = createD1UserWork({
		db: countedD1(binding, c),
		config: { clientId: CLIENT, limits: LIMITS },
		identity: auth.identity(),
		audit: auditLog().sink,
		store: caseReader({ published: RV1, versions: {} }).reader,
		now: () => new Date('2026-10-28T00:00:00Z'),
	});
	return {
		batches: () => batches,
		db,
		c,
		work,
		store: bundleStore({ userWork: work } as RequestServices, {
			caseId: CASE,
			resultsVersion: RV1,
		}),
	};
}
test('bundle PDF metadata survives a new store instance and replacement preserves the saved PDF', async () => {
	const f = fixture();
	try {
		const custom = {
			no: 'C',
			name: 'Synthetic court bundle',
			pages: 3,
			indexPages: 1,
			filePages: 2,
			note: '',
			rows: [],
		};
		await f.store.putCustom('bundle-a', custom, [], {
			sha256: 'a'.repeat(64),
			bytes: 4000,
		});
		const reloaded = bundleStore({ userWork: f.work } as RequestServices, {
			caseId: CASE,
			resultsVersion: RV1,
		});
		expect(customRows(await reloaded.table(CUSTOM_TABLE))).toMatchObject([
			{ id: 'bundle-a', assembledSha256: 'a'.repeat(64), bytes: 4000 },
		]);
		await reloaded.putCustom('bundle-a', { ...custom, name: 'Renamed' }, []);
		expect(customRows(await reloaded.table(CUSTOM_TABLE))).toMatchObject([
			{ name: 'Renamed', assembledSha256: 'a'.repeat(64), bytes: 4000 },
		]);
	} finally {
		f.db.close();
	}
});
test('bundle table plus header is one D1 read each', async () => {
	const f = fixture();
	try {
		const result = await measure(f.c, async () => {
			await f.store.table(CUSTOM_TABLE);
			await f.store.registers('bundle-header');
		});
		console.info('18 bundle table+header D1 calls:', result.counts.d1);
		expect(result.thrown).toBeUndefined();
		// Ticket target 2, met since GRS-266: binding, definition and rows are one query per read.
		expect(result.counts.d1).toBeLessThanOrEqual(2);
	} finally {
		f.db.close();
	}
});

test('assembled metadata is one D1 batch, its audit included', async () => {
	const f = fixture();
	try {
		await f.store.putCustom(
			'batch-test',
			{
				no: 'C',
				name: 'Synthetic',
				pages: 3,
				indexPages: 1,
				filePages: 2,
				note: '',
				rows: [],
			},
			[],
			{ sha256: 'a'.repeat(64), bytes: 1000 },
		);
		console.info('18 assembled metadata D1 batches:', f.batches());
		// Ticket target 1, met since GRS-266: the change's audit event commits in its own batch.
		expect(f.batches()).toBeLessThanOrEqual(1);
	} finally {
		f.db.close();
	}
});
test('assembled lookup is one D1 query', async () => {
	const f = fixture();
	try {
		const result = await measure(f.c, () => f.store.table(CUSTOM_TABLE));
		expect(result.thrown).toBeUndefined();
		console.info('18 assembled GET lookup D1 calls:', result.counts.d1);
		// Ticket target 1, met since GRS-266: binding, definition and rows are one query.
		expect(result.counts.d1).toBeLessThanOrEqual(1);
	} finally {
		f.db.close();
	}
});
