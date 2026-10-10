import { viewText } from '$lib/local-case/results.server';
import { importedUnits } from '$lib/calculations/money';
import { content, dataset, payments, type Settlement } from '$lib/views/quantum/data.server';
import { totals } from '$lib/views/quantum/payments';
import { claimPrefill } from '$lib/views/quantum/settlement';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const s = dataset<Settlement>(version.id, 'lit-settlement');
	const vc = content(version.id);
	// S-settlement_tab-2: the prefill is the claim net of the payments recorded on Payments & Net Claim
	const pays = payments(version.caseId);
	const t = totals(importedUnits(s?.claim) ?? 0n, pays);
	return {
		subtitle: viewText(vc, 'settlement_tab', 'subtitle'),
		narrative: viewText(vc, 'settlement_tab', 'narrative'),
		defaults: {
			probability: vc.number('settlement_tab', 'defaultProbability'), years: vc.number('settlement_tab', 'defaultYears'),
			discount: vc.number('settlement_tab', 'defaultDiscountRate'), cost: vc.number('settlement_tab', 'defaultEnforcementCost'),
		},
		claim: claimPrefill(t.net),
		payments: { count: pays.length, counted: pays.length - t.uncounted, gross: String(t.gross), paid: String(t.paid), claimDate: s?.claimDate ?? '' },
	};
};
