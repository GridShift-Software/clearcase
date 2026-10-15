import { actionCase, guarded } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { exportFileName, viewText } from '$lib/local-case/results.server';
import { content, dataset, payments, resolvableRefs, SAY, type ReconRow, type Settlement } from '$lib/views/quantum/data.server';
import { checkEntry } from '$lib/views/quantum/payments';
import { addPayment, deletePayment } from '$lib/views/quantum/writes.server';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	const settlement = dataset<Settlement>(version.id, 'lit-settlement');
	const recon = dataset<ReconRow[]>(version.id, 'lit-recon') ?? [];
	const cited = new Set(recon.flatMap((m) => [...m.invoice, ...m.supporting, ...m.charging, ...m.pod, ...m.statement, ...m.amountdue]));
	const known = resolvableRefs(version.id, cited);
	return {
		subtitle: viewText(content(version.id), 'payments_tab', 'subtitle'),
		claim: settlement?.claim ?? '',
		claimDate: settlement?.claimDate ?? '',
		recon,
		exportName: exportFileName(content(version.id), 'payments_tab', 'payments.csv'),
		known: [...cited].filter((r) => known.has(r)),
		payments: payments(version.caseId).map((p) => ({ ...p, amountCents: p.amountCents === null ? null : String(p.amountCents) })),
	};
};

const FIELDS = ['date', 'amount', 'method', 'note'] as const;
const entryOf = (f: FormData) => Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? '')])) as Record<(typeof FIELDS)[number], string>;

export const actions: Actions = {
	add: async ({ params, request }) => {
		const values = entryOf(await request.formData());
		const c = checkEntry(values);
		if (!c.ok) return fail(400, { op: 'add', values, message: c.error, field: c.field, retry: false });
		const { caseId } = actionCase(params);
		const w = await guarded('add', values, () => addPayment(app().userWork, caseId, values, c.cents), SAY.add);
		return w.ok ? { op: 'add', added: true } : w.failure;
	},
	delete: async ({ params, request }) => {
		const f = await request.formData();
		const values = entryOf(f);
		const rowId = String(f.get('rowId') ?? '');
		const hash = String(f.get(`hash.${rowId}`) ?? f.get('hash') ?? '');
		const typed = FIELDS.some((k) => values[k] !== '');
		const c = typed ? checkEntry(values) : null;
		const pending = typed ? { addError: c && !c.ok ? c.error : 'The entry in the form is not saved yet: press Add to save it.', field: c && !c.ok ? c.field : null } : {};
		const { caseId } = actionCase(params);
		const w = await guarded('delete', values, () => deletePayment(app().userWork, caseId, rowId, hash), SAY.delete, { target: rowId, ...pending });
		if (!w.ok) return w.failure;
		if (w.value === 'gone') return fail(404, { op: 'delete', target: rowId, values, ...pending, gone: true, message: 'This payment was already deleted elsewhere (another tab or window). Nothing else changed.', retry: false });
		if (w.value === 'stale') return fail(409, { op: 'delete', target: rowId, values, ...pending, message: 'Not deleted: this payment changed since the page showed it (a restore or an import). The table now shows it as stored; check it, then delete it again if you still want to.', retry: false });
		return { op: 'delete', deleted: true, target: rowId, values, ...pending };
	},
};
