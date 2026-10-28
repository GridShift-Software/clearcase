import { fail } from '@sveltejs/kit';
import { actionCase, guarded } from '$lib/local-case/answer.server';
import { app } from '$lib/local-case/app.server';
import { viewContentOf } from '$lib/local-case/results.server';
import { allowedStatus, enforcementMerge } from '$lib/views/litigation/enforcement';
import { enforcementPure } from '$lib/views/litigation/enforcement.server';
import { SAY, STORES, field, orderedRows } from '$lib/views/litigation/register.server';
import { saveStatus } from '$lib/views/litigation/writes.server';
import type { Actions, PageServerLoad } from './$types';

const pageOf = (rv: string, caseId: string) => {
	const store = app().store;
	return enforcementMerge(enforcementPure({ store, vid: rv, vc: viewContentOf(store, rv) }), { rows: orderedRows(caseId, STORES.enforcement) });
};

const rowsOf = (rv: string, caseId: string) => pageOf(rv, caseId).rows;

export const load: PageServerLoad = async ({ parent }) => {
	const { version } = await parent();
	return pageOf(version.id, version.caseId);
};

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

export const actions: Actions = {
	status: async ({ params, request }) => {
		const { vid, caseId } = actionCase(params);
		const { changes, choices } = changesOf(await request.formData());
		const errors: Record<string, { message: string; retry: boolean }> = {};
		const saved: string[] = [];
		let code = 0;
		for (const c of changes) {
			const row = rowsOf(vid, caseId).find((r) => r.key !== null && r.key === c.stepKey);
			if (!row) { errors[c.stepKey] = { message: 'Not saved: that step is not in this results version, or it is not unique.', retry: false }; code ||= 404; continue; }
			if (!allowedStatus(row, c.status)) { errors[c.stepKey] = { message: 'Not saved: choose one of the listed statuses.', retry: false }; code ||= 400; continue; }
			const r = await guarded('status', null, () => saveStatus(app().userWork, caseId, STORES.enforcement, c.stepKey, c.status, c.version), SAY_STATUS);
			if (!r.ok) { errors[c.stepKey] = { message: r.failure.data.message, retry: r.failure.data.retry }; code ||= r.failure.status; continue; }
			if (r.value === 'stale') {
				const now = rowsOf(vid, caseId).find((x) => x.key === c.stepKey);
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
};
