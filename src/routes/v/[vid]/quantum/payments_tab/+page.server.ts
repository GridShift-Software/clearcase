import { fail } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { viewText } from '$lib/local-case/results.server';
import { parseAmount } from '$lib/calculations/money';
import { caseOf, content, dataset, guardedWrite, payments, resolvableRefs, type ReconRow, type Settlement } from '$lib/views/quantum/data.server';
import { nextSeq, paymentFields, PAYMENTS_STORE } from '$lib/views/quantum/payments';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const settlement = dataset<Settlement>(version.id, 'lit-settlement');
	const recon = dataset<ReconRow[]>(version.id, 'lit-recon') ?? [];
	const known = resolvableRefs(version.id);
	const cited = new Set(recon.flatMap((m) => [...m.invoice, ...m.supporting, ...m.charging, ...m.pod, ...m.statement, ...m.amountdue]));
	return {
		subtitle: viewText(content(version.id), 'payments_tab', 'subtitle'),
		claim: settlement?.claim ?? '',
		claimDate: settlement?.claimDate ?? '',
		recon,
		known: [...cited].filter((r) => known.has(r)),
		// stored amounts travel as text: page data cannot carry a BigInt through every path
		payments: payments(version.caseId).map((p) => ({ ...p, amountCents: p.amountCents === null ? null : String(p.amountCents) })),
	};
};

const FIELDS = ['date', 'amount', 'method', 'note'] as const;

export const actions: Actions = {
	add: async ({ params, request }) => {
		const f = await request.formData();
		const values = Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? '')])) as Record<(typeof FIELDS)[number], string>;
		// S-payments_tab-2: an amount outside the grammar is refused visibly and the typed text is kept
		const parsed = parseAmount(values.amount);
		if (!parsed.ok) return fail(400, { values, error: parsed.error, field: 'amount' });
		const caseId = caseOf(params.vid);
		const failed = await guardedWrite(values, async () => app().userWork.putRow(caseId, PAYMENTS_STORE, null, paymentFields(values, parsed.value, nextSeq(payments(caseId)))));
		return failed ?? { added: true };
	},
	delete: async ({ params, request }) => {
		const f = await request.formData();
		const rowId = String(f.get('rowId') ?? '');
		const caseId = caseOf(params.vid);
		// deleted by the row's stable id, never by its position (v5 deleted by array index)
		const failed = await guardedWrite({ rowId }, async () => app().userWork.deleteRow(caseId, PAYMENTS_STORE, rowId));
		return failed ?? { deleted: true };
	},
};
