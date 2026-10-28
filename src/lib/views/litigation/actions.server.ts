// The actions of Authorities, Heads of Argument, Cross-examination and the Enforcement Roadmap (sprint ticket 17b), over a
// `Ctx`: the local pages pass `localCtx` (`register.server.ts`), the hosted routes `hostedCtx` (`hosted.server.ts`).
import { fail, type RequestEvent } from '@sveltejs/kit';
import { AUTH_FIELDS, canAddAuthority, type AuthValues } from './authorities.ts';
import { CX_FIELDS, CX_SEED, canAddCx, type CxValues } from './crossexam.ts';
import { allowedStatus, type EnfRow } from './enforcement.ts';
import { HEADS_FIELDS, canAddHead, type HeadsValues } from './heads.ts';
import { SAY, STORES, addAnswer, deleteAnswerOf, deleteTarget, field, formAddId, unconfirmed, valuesOf, type Ctx, type CtxOf } from './answers.server.ts';
import type { StatusResult } from './writes.server.ts';

export const authoritiesActions = (ctxOf: CtxOf) => ({
	add: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const f = await e.request.formData();
		const values = valuesOf(f, AUTH_FIELDS) as AuthValues;
		if (!canAddAuthority(values)) return fail(400, { op: 'add', values, message: null });
		return addAnswer(ctx, STORES.authorities, values, formAddId(f));
	},
});

export const headsActions = (ctxOf: CtxOf) => ({
	add: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const f = await e.request.formData();
		const values = valuesOf(f, HEADS_FIELDS) as HeadsValues;
		if (!canAddHead(values)) return fail(400, { op: 'add', values, message: null });
		return addAnswer(ctx, STORES.heads, values, formAddId(f));
	},
	delete: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const f = await e.request.formData();
		const raw = field(f, 'rowId'), values = valuesOf(f, HEADS_FIELDS);
		const refused = unconfirmed(f, raw, values);
		if (refused) return refused;
		const { id, version } = deleteTarget(raw);
		return deleteAnswerOf(ctx, id, values, () => ctx.entries.remove(STORES.heads, id, version));
	},
});

export const crossexamActions = (ctxOf: CtxOf) => ({
	add: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const f = await e.request.formData();
		const values = valuesOf(f, CX_FIELDS) as CxValues;
		if (!canAddCx(values)) return fail(400, { op: 'add', values, message: null });
		return addAnswer(ctx, STORES.crossexam, values, formAddId(f));
	},
	delete: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const f = await e.request.formData();
		const values = valuesOf(f, CX_FIELDS);
		const row = field(f, 'rowId');
		const refused = unconfirmed(f, row || field(f, 'seedId'), values);
		if (refused) return refused;
		if (row) {
			const { id, version } = deleteTarget(row);
			return deleteAnswerOf(ctx, id, values, () => ctx.entries.remove(STORES.crossexam, id, version));
		}
		const { id, version } = deleteTarget(field(f, 'seedId'));
		return deleteAnswerOf(ctx, id, values, () => ctx.entries.removeSeed(CX_SEED, id, version));
	},
});

/** What the status action asks of a page: the steps as the page shows them, and one step's status saved against its version. */
export interface EnforcementCtx extends Ctx {
	rows(): Promise<readonly Pick<EnfRow, 'key' | 'status' | 'override'>[]>;
	save(stepKey: string, status: string, version: string | null): Promise<StatusResult>;
}

const SAY_STATUS = { ...SAY.add, busy: 'Not saved: the local store is busy. Your choice is kept; try again in a moment.', failed: 'Not saved: the app hit an error while saving. Your choice is kept.' };
const stale = (now: string) => `Not saved: this step's status was changed elsewhere (in another tab or window) to “${now || 'no status'}”. Your choice is kept; press Retry to save it over that change.`;

type Change = { stepKey: string; status: string; version: string | null };

function changesOf(f: FormData): { changes: Change[]; choices: Record<string, string> } {
	if (f.has('stepKey')) {
		const c = { stepKey: field(f, 'stepKey'), status: field(f, 'status'), version: field(f, 'version') || null };
		return { changes: [c], choices: { [c.stepKey]: c.status } };
	}
	const changes: Change[] = [], choices: Record<string, string> = {};
	for (const [k, v] of f) {
		if (!k.startsWith('status:') || typeof v !== 'string') continue;
		const key = k.slice(7);
		choices[key] = v;
		if (v !== field(f, `was:${key}`)) changes.push({ stepKey: key, status: v, version: field(f, `ver:${key}`) || null });
	}
	return { changes, choices };
}

export const enforcementActions = (ctxOf: CtxOf<EnforcementCtx>) => ({
	status: async (e: RequestEvent) => {
		const ctx = ctxOf(e);
		const { changes, choices } = changesOf(await e.request.formData());
		const errors: Record<string, { message: string; retry: boolean }> = {};
		const saved: string[] = [];
		let code = 0;
		for (const c of changes) {
			const row = (await ctx.rows()).find((r) => r.key !== null && r.key === c.stepKey);
			if (!row) { errors[c.stepKey] = { message: 'Not saved: that step is not in this results version, or it is not unique.', retry: false }; code ||= 404; continue; }
			if (!allowedStatus(row, c.status)) { errors[c.stepKey] = { message: 'Not saved: choose one of the listed statuses.', retry: false }; code ||= 400; continue; }
			const r = await ctx.guard('status', null, () => ctx.save(c.stepKey, c.status, c.version), SAY_STATUS);
			if (!r.ok) { errors[c.stepKey] = { message: r.failure.data.message, retry: r.failure.data.retry }; code ||= r.failure.status; continue; }
			if (r.value === 'stale') {
				const now = (await ctx.rows()).find((x) => x.key === c.stepKey);
				errors[c.stepKey] = { message: stale(now ? now.override ?? now.status : ''), retry: true };
				code ||= 409;
				continue;
			}
			saved.push(c.stepKey);
		}
		const one = changes.length === 1 ? changes[0]! : null;
		const answer = { op: 'status', saved: one && saved.length ? one.stepKey : null, savedKeys: saved, errors, choices, values: one ? { stepKey: one.stepKey, status: one.status } : null, message: one ? errors[one.stepKey]?.message ?? null : null, retry: one ? errors[one.stepKey]?.retry ?? false : false };
		return code ? fail(code, answer) : answer;
	},
});
