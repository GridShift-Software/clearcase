// The actions of Payments & Net Claim over a `Ctx` (sprint ticket 17b): the local page passes `localCtx`, the hosted route
// `hostedCtx`. A sibling of `writes.server.ts` rather than part of it because that file reaches the local work store, which the
// hosted import graph forbids; the add and delete themselves are `Entries.add` and `Entries.remove` of the context.
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { Say } from '../../local-case/answer.server.ts';
import { formAddId, type CtxOf } from '../litigation/answers.server.ts';
import { checkEntry, paymentFields, PAYMENTS_STORE } from './payments.ts';

const ADD_REFUSED = 'Not saved: the workspace store refused this entry, and would refuse it again unchanged. Your entry is kept.';
const DELETE_REFUSED = 'Not deleted: the workspace store refused the deletion.';
export const SAY = {
	add: { busy: 'Not saved: the workspace store is busy (another process holds it). Your entry is kept; try again.', refused: ADD_REFUSED, failed: ADD_REFUSED },
	delete: { busy: 'Not deleted: the workspace store is busy (another process holds it); try again.', refused: DELETE_REFUSED, failed: DELETE_REFUSED },
} satisfies Record<string, Say>;

const FIELDS = ['date', 'amount', 'method', 'note'] as const;
const entryOf = (f: FormData) => Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? '')])) as Record<(typeof FIELDS)[number], string>;

export const paymentsActions = (ctxOf: CtxOf) => ({
	add: async (e: RequestEvent) => {
		const f = await e.request.formData();
		const values = entryOf(f);
		const c = checkEntry(values);
		if (!c.ok) return fail(400, { op: 'add', values, message: c.error, field: c.field, retry: false });
		const ctx = ctxOf(e);
		const w = await ctx.guard('add', values, () => ctx.entries.add(PAYMENTS_STORE, paymentFields(values, c.cents), formAddId(f)), SAY.add);
		return w.ok ? { op: 'add', added: true } : w.failure;
	},
	delete: async (e: RequestEvent) => {
		const f = await e.request.formData();
		const values = entryOf(f);
		const rowId = String(f.get('rowId') ?? '');
		const hash = String(f.get(`hash.${rowId}`) ?? f.get('hash') ?? '');
		const typed = FIELDS.some((k) => values[k] !== '');
		const c = typed ? checkEntry(values) : null;
		const pending = typed ? { addError: c && !c.ok ? c.error : 'The entry in the form is not saved yet: press Add to save it.', field: c && !c.ok ? c.field : null } : {};
		const ctx = ctxOf(e);
		const w = await ctx.guard('delete', values, () => ctx.entries.remove(PAYMENTS_STORE, rowId, hash), SAY.delete, { target: rowId, ...pending });
		if (!w.ok) return w.failure;
		if (w.value === 'gone') return fail(404, { op: 'delete', target: rowId, values, ...pending, gone: true, message: 'This payment was already deleted elsewhere (another tab or window). Nothing else changed.', retry: false });
		if (w.value === 'stale') return fail(409, { op: 'delete', target: rowId, values, ...pending, message: 'Not deleted: this payment changed since the page showed it (a restore or an import). The table now shows it as stored; check it, then delete it again if you still want to.', retry: false });
		return { op: 'delete', deleted: true, target: rowId, values, ...pending };
	},
});
