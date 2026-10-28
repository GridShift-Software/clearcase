// Ticket 04: Authorities, Cross-examination and the Enforcement Roadmap split into a pure part (the version alone) and a
// merge part (the registers, seed overlays and saved statuses). merge(pure, no user work) equals load, and load with user
// work is what it was before the split. Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCase, type Booted, type J } from '../registers/04-harness';

const SEED = 'lit-crossexam-seed';
let b: Booted;
const routes: Record<string, unknown> = {};
beforeAll(async () => {
	b = await bootCase('04-litigation', (r) => {
		const lit = (r.DATA as J).lit as J;
		lit.crossexam_seed = [
			{ witness: 'Ann Lee', topic: 'Payment', put: 'Put citing [[OD-001]]', docs: 'OD-002' },
			{ witness: 'Bob Ray', topic: 'Delivery', put: 'Put citing [[SD-001]] and [[ZZ-999]]', docs: '' },
		];
		lit.enforcement = [
			{ phase: '1 · Start', step: 'Invented step', basis: 'Basis citing [[OD-002]]', status: 'To do', note: '' },
			{ phase: '2 · Next', step: 'Second step', basis: 'Invented basis', status: 'Monitor', note: 'Note citing [[OD-001]]' },
		];
		lit.authorities = [{ topic: 'T', authority: 'Invented v Invented', proposition: 'P citing [[OD-001]]' }];
	});
	routes.authorities = await import('../../src/routes/v/[vid]/litigation/authorities_tab/+page.server');
	routes.crossexam = await import('../../src/routes/v/[vid]/litigation/crossexam_tab/+page.server');
	routes.enforcement = await import('../../src/routes/v/[vid]/litigation/enforcement_tab/+page.server');
}, 180_000);
afterAll(() => b?.stop());

const split = async () => {
	const reg = await import('../../src/lib/views/litigation/register.server');
	return {
		authorities: { pure: reg.authoritiesPure, merge: (await import('../../src/lib/views/litigation/authorities')).authoritiesMerge },
		crossexam: { pure: reg.crossexamPure, merge: (await import('../../src/lib/views/litigation/crossexam')).crossexamMerge },
		enforcement: { pure: (await import('../../src/lib/views/litigation/enforcement.server')).enforcementPure, merge: (await import('../../src/lib/views/litigation/enforcement')).enforcementMerge },
	};
};
const regs = async () => (await import('../../src/lib/local-case/registers.server')).registers(b.lc.userWork);
const rows = async (store: string) => (await regs()).open(b.caseId, store).rows();
const seeds = async () => (await regs()).seeds(b.caseId, b.rv, SEED).views();
// addId is a fresh random id per page load; compare the rest
const sansAddId = ({ addId, ...rest }: J) => (expect(addId).toMatch(/^[0-9a-f-]{36}$/), rest);

describe('litigation: pure and merge', () => {
	it('merge(pure, no user work) equals load for all three views', async () => {
		const s = await split();
		const a = await b.load(routes.authorities);
		expect(s.authorities.merge(s.authorities.pure(b.input()), { rows: [] }, a.addId)).toEqual(a);
		const c = await b.load(routes.crossexam);
		expect(c.known).toEqual(['OD-001', 'SD-001']);
		expect(s.crossexam.merge(s.crossexam.pure(b.input()), { seeds: await seeds(), rows: [] }, c.addId)).toEqual(c);
		expect(s.enforcement.merge(s.enforcement.pure(b.input()), { rows: [] })).toEqual(await b.load(routes.enforcement));
	});

	it('the shards hold no user work', async () => {
		const s = await split();
		expect(Object.keys(s.authorities.pure(b.input())).sort()).toEqual(['exportName', 'imported', 'known', 'present']);
		expect(s.crossexam.pure(b.input())).toEqual({ tip: expect.anything(), knownSeedRefs: ['OD-001', 'SD-001'] });
		const e = s.enforcement.pure(b.input()) as J;
		expect(e.rows.map((r: J) => r.override)).toEqual([null, null]);
	});

	it('the enforcement merge versions saved statuses exactly as the status writer does', async () => {
		const w = await import('../../src/lib/views/litigation/writes.server');
		const e = await import('../../src/lib/views/litigation/enforcement');
		const sample = [{ rowId: 'r1', version: 'v1', fields: { stepKey: 'k1', status: 'Done' } }, { rowId: 'r2', version: 'v2', fields: { stepKey: 'k2' } }, { rowId: 'r3', version: 'v3', fields: { stepKey: 'k1', status: 'Monitor' } }] as never[];
		for (const k of ['k1', 'k2', 'k3']) {
			expect(e.stepRows(sample, k)).toEqual(w.stepRows(sample, k));
			expect(e.stepVersion(e.stepRows(sample, k))).toBe(w.stepVersion(w.stepRows(sample, k)));
		}
	});

	it('with user work, load shows the rows, overlays and statuses as before', async () => {
		const { STORES } = await import('../../src/lib/views/litigation/register.server');
		const { saveStatus } = await import('../../src/lib/views/litigation/writes.server');
		await (await regs()).open(b.caseId, STORES.authorities).add({ topic: 'UT', authority: 'User v User', proposition: 'UP' });
		const first = (await seeds())[0]!;
		expect((await (await regs()).seeds(b.caseId, b.rv, SEED).remove(first.seedId, first.version))).toBe('deleted');
		await (await regs()).open(b.caseId, STORES.crossexam).add({ witness: 'User witness', topic: 'User topic', put: 'cites [[OD-002]]', docs: '' });
		const enf = await b.load(routes.enforcement);
		expect(await saveStatus(b.lc.userWork, b.caseId, STORES.enforcement, enf.rows[0].key, 'Done', null)).toBe('saved');

		const a = await b.load(routes.authorities);
		expect(a.user.map((u: J) => [u.topic, u.authority, u.proposition, typeof u.rowId])).toEqual([['UT', 'User v User', 'UP', 'string']]);
		const c = await b.load(routes.crossexam);
		expect(c.rows.map((r: J) => [r.kind, r.witness, r.authored, typeof r.del])).toEqual([['seed', 'Bob Ray', true, 'string'], ['user', 'User witness', false, 'string']]);
		expect(c.known).toEqual(['SD-001']);
		const e = await b.load(routes.enforcement);
		expect(e.rows.map((r: J) => [r.step, r.override, r.version === 'none'])).toEqual([['Invented step', 'Done', false], ['Second step', null, true]]);
		expect(e.known).toEqual(['OD-001', 'OD-002']);

		const s = await split();
		expect(s.authorities.merge(s.authorities.pure(b.input()), { rows: await rows(STORES.authorities) }, a.addId)).toEqual(a);
		expect(s.crossexam.merge(s.crossexam.pure(b.input()), { seeds: await seeds(), rows: await rows(STORES.crossexam) }, c.addId)).toEqual(c);
		expect(s.enforcement.merge(s.enforcement.pure(b.input()), { rows: await rows(STORES.enforcement) })).toEqual(e);
		expect(sansAddId(a)).toEqual(sansAddId(await b.load(routes.authorities)));
	});
});
