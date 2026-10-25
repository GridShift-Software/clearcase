// The planned combined Browser allocation. It is arithmetic over explicit policy and the real checker's own worst-case reservation:
// a plan, not proof that the account has the capacity, that Browser Run exists, or what anything costs.
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createNativePreviewRenderChecker, NATIVE_PDF_RENDER_CEILINGS, type NativePreviewRenderOptions } from '../../../src/lib/viewer/hosted/native-render-check.ts';
import { prepareHostedStaticInput } from '../../../scripts/hosted-static-input.ts';
import { nativeRenderLeaseMs, planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { exampleInput, exampleWithBrowserAllocation } from './example-input.ts';
import { refusalOf } from './harness.ts';

const input = prepareHostedStaticInput(process.cwd());
afterAll(() => input.dispose());
const RENDER = { maxFileBytes: 1_000_000, maxPages: 4, maxCanvasPixels: 1_000_000, maxRunMs: 10_000, maxRunsPerCasePerDay: 1, maxRunsPerClientPerDay: 2 };

describe('planned allocation arithmetic', () => {
	it('charges each opted-in client its full worst-case lease for every permitted run, and nothing for a client without a budget', () => {
		const allocation = planNativeRuntimeConfig(exampleWithBrowserAllocation()).manifest.plannedBrowserAllocation!;
		expect(allocation).toMatchObject({ kind: 'planned-allocation', accountAvailabilityProven: false, spendProven: false, totals: { concurrentBrowsers: 2, reservedMsPerDay: 211_000 } });
		expect(allocation.clients.map((c) => [c.clientId, c.leaseMsWorstCase, c.reservedMsPerDay, c.maxConcurrentBrowsers])).toEqual([['client-a', 72_000, 144_000, 1], ['client-b', 67_000, 67_000, 1]]);
		const one = exampleInput(); one.browserAllocation = { maxConcurrentBrowsers: 1, maxReservedBrowserMsPerDay: 144_000 };
		expect(planNativeRuntimeConfig(one).manifest.plannedBrowserAllocation!.totals).toEqual({ concurrentBrowsers: 1, reservedMsPerDay: 144_000 });
	});
	it('accepts a policy that exactly fits and refuses one millisecond or one browser short', () => {
		const fits = exampleWithBrowserAllocation();
		expect(() => planNativeRuntimeConfig(fits)).not.toThrow();
		const day = exampleWithBrowserAllocation(); day.browserAllocation!.maxReservedBrowserMsPerDay -= 1;
		expect(refusalOf(day)).toMatch(/aggregate policy/);
		const browsers = exampleWithBrowserAllocation(); browsers.browserAllocation!.maxConcurrentBrowsers -= 1;
		expect(refusalOf(browsers)).toMatch(/aggregate policy/);
	});
	it('plans no allocation at all, and says so, when the caller supplies no aggregate policy', () => {
		const withBudgets = exampleWithBrowserAllocation(); withBudgets.browserAllocation = null;
		expect(planNativeRuntimeConfig(withBudgets).manifest.plannedBrowserAllocation).toBeNull();
	});
});

describe('the lease the planner charges is the lease the real code reserves', () => {
	// Drive the REAL checker far enough to read the reservation it would insert, then stop before any Browser exists.
	async function reservedLease(budget: typeof RENDER) {
		let lease: unknown = null;
		const primary = {
			prepare: (_sql: string) => ({ bind: (...args: unknown[]) => ({ args, first: async () => null }), first: async () => null }),
			batch: async (statements: { args?: unknown[] }[]) => { lease = statements[0]!.args![12]; return []; }, // rejected below as an unacknowledged reservation
		};
		const options = {
			db: { withSession: () => primary }, clientId: 'client-a', browser: { fetch: async () => new Response('unused') }, assets: { fetch: async () => new Response('unused') },
			appOrigin: 'https://client-a.clearcase.test', pins: input.inventory, budget, now: () => new Date('2001-01-01T01:00:00Z'),
		} as unknown as NativePreviewRenderOptions;
		const checker = await createNativePreviewRenderChecker(options);
		expect(checker).not.toBeNull();
		const bytes = new TextEncoder().encode('%PDF-1.4\n% SYNTHETIC ONLY\n%%EOF\n');
		const outcome = await checker!.verify({ clientId: 'client-a' as never, caseId: 'case-1' as never, candidateId: 'cand-1', resultsVersion: `sha256:${'a'.repeat(64)}` as never,
			assetId: 'OD-001', bytes, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/pdf' });
		expect(outcome).toMatchObject({ state: 'pending', reason: 'render-admission-unavailable' }); // stopped at the reservation: nothing rendered
		return lease;
	}
	it.each([1, 5_000, 10_000, 20_000])('maxRunMs %i: lease_ms equals maxRunMs + 2 s cleanup + the 60 s idle tail', async (maxRunMs) => {
		expect(await reservedLease({ ...RENDER, maxRunMs })).toBe(nativeRenderLeaseMs(maxRunMs));
	});
	it('the migration bounds the same lease (62_001 to 82_000 ms), matching the renderer ceilings', () => {
		const sql = readFileSync('src/lib/viewer/hosted/migrations/0001_preview_render_work.sql', 'utf8');
		expect(sql).toContain('lease_ms BETWEEN 62001 AND 82000');
		expect([nativeRenderLeaseMs(1), nativeRenderLeaseMs(NATIVE_PDF_RENDER_CEILINGS.maxRunMs)]).toEqual([62_001, 82_000]);
		expect(sql).toContain('client_limit BETWEEN 1 AND 4');
		expect(NATIVE_PDF_RENDER_CEILINGS.maxRunsPerClientPerDay).toBe(4);
	});
});

describe('one client holds at most one browser at a time (the reservation SQL serializes launches)', () => {
	function reserve(db: DatabaseSync, token: string, caseId: string, startedMs: number, lease = 72_000) {
		const sha = 'b'.repeat(64);
		db.prepare(`INSERT INTO npr_reservations (token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,binding_sha256,day,started_ms,lease_ms,case_limit,client_limit)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(token, 'client-a', caseId, 'c', 'v', 'a', sha, 100, 'r', createHash('sha256').update(token).digest('hex'), 0, startedMs, lease, 2, 2);
	}
	it('refuses a launch before the previous lease ends, accepts it at the end, and refuses the run past the client day limit', () => {
		const db = new DatabaseSync(':memory:');
		db.exec(readFileSync('src/lib/viewer/hosted/migrations/0001_preview_render_work.sql', 'utf8'));
		reserve(db, 't1', 'case-1', 1_000);
		expect(() => reserve(db, 't2', 'case-2', 1_000 + 71_999)).toThrow(/client admission refused/);
		expect(() => reserve(db, 't2', 'case-2', 1_000 + 72_000)).not.toThrow();
		expect(() => reserve(db, 't3', 'case-3', 1_000 + 144_000)).toThrow(/client admission refused/); // client_limit 2 per day
		db.close();
	});
});

describe('the planner\'s render-budget rule agrees with the real checker constructor', () => {
	const cases: [string, Partial<typeof RENDER>][] = [
		['the example', {}], ['every ceiling exactly', { ...NATIVE_PDF_RENDER_CEILINGS }], ['all ones', { maxFileBytes: 1, maxPages: 1, maxCanvasPixels: 1, maxRunMs: 1, maxRunsPerCasePerDay: 1, maxRunsPerClientPerDay: 1 }],
		['file bytes over', { maxFileBytes: 4_000_001 }], ['pages over', { maxPages: 9 }], ['pixels over', { maxCanvasPixels: 4_000_001 }], ['run over', { maxRunMs: 20_001 }],
		['case runs over', { maxRunsPerCasePerDay: 3 }], ['client runs over', { maxRunsPerClientPerDay: 5 }], ['case above client', { maxRunsPerCasePerDay: 2, maxRunsPerClientPerDay: 1 }],
		['zero', { maxPages: 0 }], ['negative', { maxRunMs: -1 }], ['fractional', { maxPages: 1.5 }], ['NaN', { maxPages: NaN }], ['Infinity', { maxRunMs: Infinity }],
	];
	it.each(cases)('%s', async (_name, change) => {
		const budget = { ...RENDER, ...change };
		const real = await createNativePreviewRenderChecker({ db: { withSession: () => ({}) }, clientId: 'client-a', browser: { fetch: async () => new Response('x') }, assets: { fetch: async () => new Response('x') },
			appOrigin: 'https://client-a.clearcase.test', pins: input.inventory, budget, now: () => new Date() } as unknown as NativePreviewRenderOptions);
		const planned = exampleInput(); planned.clients[0]!.policy.nativeRenderBudget = budget;
		let accepted = true; try { planNativeRuntimeConfig(planned); } catch { accepted = false; }
		expect(accepted).toBe(real !== null);
	});
});
