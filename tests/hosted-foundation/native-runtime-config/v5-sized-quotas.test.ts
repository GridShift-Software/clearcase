// U14 item 2. The per-case upload count and byte allowance come from the deployment's settings (CLEARCASE_NATIVE_CONFIG), never
// from code. This proves that the settings the runbook sets on sandbox B (docs/acceptance/native-staged-import.md, "U14") pass the
// real planner, reach the real quota parser unchanged, and admit B's earlier uploads plus a full v5-sized set of 1,689 originals
// through the real intake on the real migrations, while B's settings at b5866e59 refuse the 21st upload. Every byte is synthetic.
import { describe, expect, it } from 'vitest';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { storageBudgets } from '../../../src/lib/storage/cloud/budgets.ts';
import { storageQuotas, type StorageQuotas } from '../../../src/lib/storage/cloud/quotas.ts';
import { createOriginalIntake } from '../../../src/lib/storage/cloud/intake.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { deployment, ids, pdf, submit, submitSet, type Submitted } from '../storage/fixture.ts';
import { exampleInput } from './example-input.ts';
import { nativeConfigOf } from './harness.ts';

/** B's quotas and per-original budget at b5866e59 (settingsb586), which the U14 run must raise. */
const DEPLOYED = { maxUploadsPerCase: 20, maxOriginalBytesPerCase: 16 << 20, maxOriginalBytesPerClient: 64 << 20, maxPutAttemptsPerUpload: 3,
	maxVersionsPerCase: 10, maxPackageBytesPerCase: 32 << 20, maxPackageBytesPerClient: 128 << 20, maxStagingAttemptsPerCase: 20 };
const MAX_ORIGINAL = 2 << 20;
/** The U14 values: room for B's earlier uploads plus two full v5-sized sets, each original at the 2 MiB per-original budget. */
export const U14_QUOTAS = { ...DEPLOYED, maxUploadsPerCase: 4096, maxOriginalBytesPerCase: 4096 * MAX_ORIGINAL, maxOriginalBytesPerClient: 2 * 4096 * MAX_ORIGINAL };
const V5_ORIGINALS = 1689, EARLIER = DEPLOYED.maxUploadsPerCase;

/** The client-b settings exactly as the planner emits them and the hosted services parse them. */
function compiled(quotas: StorageQuotas) {
	const input = exampleInput();
	const policy = input.clients[1]!.policy;
	policy.storageQuotas = { ...quotas };
	policy.storageBudgets = { ...policy.storageBudgets, maxBufferedObjectBytes: MAX_ORIGINAL, maxOriginalBytes: MAX_ORIGINAL };
	const config = nativeConfigOf(planNativeRuntimeConfig(input).clients[1]!);
	return { quotas: storageQuotas(config.storageQuotas)!, budgets: storageBudgets(config.storageBudgets)! };
}

/** Declares `n` originals of `size` bytes for one case; returns how many were admitted before the first refusal. */
async function declared(settings: ReturnType<typeof compiled>, n: number, size = MAX_ORIGINAL) {
	const dep = deployment('client-b', ['case-b']);
	const intake = createOriginalIntake({ bindings: { db: dep.db, bucket: dep.bucket }, clientId: ids.clientB, budgets: settings.budgets, quotas: settings.quotas,
		authorize: async () => {}, now: () => new Date('2001-01-01T00:00:00Z') } as never);
	for (let i = 0; i < n; i++) {
		const out = await intake.declare({ caseId: id('case', 'case-b'), operationId: `u14q-${String(i).padStart(12, '0')}`, assetId: `a${i}`, sha256: i.toString(16).padStart(64, '0'),
			size, filename: `synthetic ${i}.pdf`, mediaType: 'application/pdf' });
		if (out.kind !== 'declared') return { admitted: i, refusal: out };
	}
	return { admitted: n, refusal: null };
}

describe('U14 quotas admit the earlier uploads plus a full v5-sized set, through the settings', () => {
	it('the planner keeps the U14 quotas exactly, and the quota parser reads them back unchanged', () => {
		expect(compiled(U14_QUOTAS).quotas).toEqual(U14_QUOTAS);
	});

	it("B's settings at b5866e59 refuse the 21st upload and the 9th worst-case original, so a v5-sized set needs the settings change", async () => {
		const count = await declared(compiled(DEPLOYED), EARLIER + 1, 1);
		expect(count).toEqual({ admitted: EARLIER, refusal: { kind: 'refused', reason: 'over-quota' } });
		const bytes = await declared(compiled(DEPLOYED), EARLIER, MAX_ORIGINAL);
		expect(bytes).toEqual({ admitted: DEPLOYED.maxOriginalBytesPerCase / MAX_ORIGINAL, refusal: { kind: 'refused', reason: 'over-quota' } });
	});

	it('the U14 quotas admit the earlier uploads plus 1,689 worst-case originals (count and declared bytes)', async () => {
		const settings = compiled(U14_QUOTAS);
		expect((EARLIER + V5_ORIGINALS) * MAX_ORIGINAL).toBeLessThanOrEqual(settings.quotas.maxOriginalBytesPerCase);
		expect(await declared(settings, EARLIER + V5_ORIGINALS)).toEqual({ admitted: EARLIER + V5_ORIGINALS, refusal: null });
	}, 120_000);

	it('the U14 quotas let the real intake take 20 earlier uploads and then seal a 1,689-file set', async () => {
		const { quotas } = compiled(U14_QUOTAS);
		const dep = deployment('client-a', ['case-q']);
		const one = (prefix: string, i: number): Submitted => ({ ref: `${prefix}${i}`, path: `${prefix}/OD-${String(i).padStart(4, '0')} letter.pdf`, bytes: pdf(`u14-${prefix}-${i}`) });
		await submit(dep, 'case-q', Array.from({ length: EARLIER }, (_, i) => one('EARLY', i)), { quotas });
		await submitSet(dep, 'case-q', 'v5', Array.from({ length: V5_ORIGINALS }, (_, i) => one('SET', i)), { quotas });
		const rows = dep.db.rows<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM rs_original_upload WHERE case_id = 'case-q' GROUP BY state");
		expect(rows).toEqual([{ state: 'finalized', n: EARLIER + V5_ORIGINALS }]);
	}, 300_000);
});
