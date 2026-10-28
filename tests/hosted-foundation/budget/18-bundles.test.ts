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
	const work = createD1UserWork({
		db: countedD1(d1(db), c),
		config: { clientId: CLIENT, limits: LIMITS },
		identity: auth.identity(),
		audit: auditLog().sink,
		store: caseReader({ published: RV1, versions: {} }).reader,
		now: () => new Date('2026-10-28T00:00:00Z'),
	});
	return {
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
test('bundle table plus header read stays within the two-query page budget beyond authorization', async () => {
	const f = fixture();
	try {
		const result = await measure(f.c, async () => {
			await f.store.table(CUSTOM_TABLE);
			await f.store.registers('bundle-header');
		});
		console.info('18 bundle table+header D1 calls:', result.counts.d1);
		expect(result.thrown).toBeUndefined();
		expect(result.counts.d1).toBeLessThanOrEqual(2);
	} finally {
		f.db.close();
	}
});
