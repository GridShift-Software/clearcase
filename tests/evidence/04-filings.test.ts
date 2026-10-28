// Ticket 04: the filings loader splits into a pure part (the version alone) and a merge part (the register's user work).
// merge(pure, no work) equals load without user work, and load with user work is what it was before the split.
// Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCase, type Booted, type J } from '../registers/04-harness';
import { REGISTER_STORE, SEED_DATASET } from '../../src/lib/views/evidence/filings';

let b: Booted;
let route: unknown;
beforeAll(async () => {
	b = await bootCase('04-filings');
	route = await import('../../src/routes/v/[vid]/evidence/filings_tab/+page.server');
}, 180_000);
afterAll(() => b?.stop());

const split = async () => ({
	pure: (await import('../../src/lib/views/evidence/filings.server')).filingsPure,
	merge: (await import('../../src/lib/views/evidence/filings')).filingsMerge,
});
const work = () => ({ seeds: b.lc.userWork.seedViews(b.caseId, b.rv, SEED_DATASET), rows: b.lc.userWork.listRows(b.caseId, REGISTER_STORE) });

describe('filings_tab: pure and merge', () => {
	it('merge(pure, no user work) equals load, with and without ?edit', async () => {
		const { pure, merge } = await split();
		const empty = { seeds: work().seeds, rows: [] };
		expect(empty.seeds.every((s) => s.state === 'seed')).toBe(true);
		expect(merge(pure(b.input()), empty)).toEqual(await b.load(route));
		const seed = (await b.load(route)).entries[0].key as string;
		expect(merge(pure(b.input()), empty, seed)).toEqual(await b.load(route, `?edit=${encodeURIComponent(seed)}`));
	});

	it('the shard holds no user work: its file index names every listed document', async () => {
		const { pure } = await split();
		const s = pure(b.input()) as J;
		expect(Object.keys(s).sort()).toEqual(['content', 'exportNames', 'fileOf', 'groups']);
		expect(s.fileOf.map(([r]: [string]) => r)).toEqual(expect.arrayContaining(['OD-001', 'OD-002']));
	});

	it('with user work, load shows the user rows, the edited seed and the files of user-typed refs', async () => {
		const seed = work().seeds[0]!;
		if (seed.state !== 'seed') throw new Error('expected an unedited seed');
		await b.lc.userWork.putSeedOverlay({ caseId: b.caseId, datasetKey: SEED_DATASET, seedId: seed.seed.seedId, baseSeedSha256: seed.seed.seedSha256, fields: { filing: 'Edited filing', deleted: false } });
		await b.lc.userWork.putRow(b.caseId, REGISTER_STORE, null, { seq: 1, filing: 'User filing', fdate: '', fparty: '', response: '', rdate: '', ref: 'OD-002', status: '' });
		await b.lc.userWork.putRow(b.caseId, REGISTER_STORE, null, { seq: 2, filing: 'Unknown ref', fdate: '', fparty: '', response: '', rdate: '', ref: 'ZZ-404', status: '' });
		const d = await b.load(route);
		expect(d.entries.map((e: J) => [e.state, e.fields.filing])).toEqual([['edited', 'Edited filing'], ['user', 'User filing'], ['user', 'Unknown ref']]);
		const files = new Map(d.files as [string, string | null][]);
		expect([...files.keys()]).toEqual(['OD-001', 'OD-002', 'ZZ-404']);
		expect(files.get('OD-002')).toEqual(expect.any(String));
		expect(files.get('ZZ-404')).toBeNull();
		const { pure, merge } = await split();
		expect(merge(pure(b.input()), work())).toEqual(d);
	});
});
