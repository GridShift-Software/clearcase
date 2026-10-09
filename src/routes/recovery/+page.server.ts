import { fail, redirect } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { versionPath } from '$lib/local-case/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const a = app();
	const s = a.startupReport;
	return { recovery: a.anyRecovery() ?? null, startup: s && { ...s, checked: Object.entries(s.checked).map(([vid, v]) => ({ vid, ok: v.ok, reason: v.reason ?? null, ms: v.ms })) } };
};

export const actions: Actions = {
	adopt: async ({ request }) => {
		const a = app();
		const caseId = String((await request.formData()).get('case') ?? '') || a.anyRecovery()?.caseId;
		const r = caseId ? a.cases.get(caseId) : undefined;
		if (!r?.effective) return fail(400, { message: 'Nothing to adopt.' });
		const refused = await a.adoptRecovery(r.caseId);
		if (refused) return fail(409, { message: refused.message });
		redirect(303, `${versionPath(r.effective)}/overview`);
	},
};
