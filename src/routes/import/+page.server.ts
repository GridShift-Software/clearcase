import { fail, redirect } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ imports: app().store.listImports(), running: app().importProgress() });

export const actions: Actions = {
	import: async ({ request }) => {
		const f = await request.formData();
		const caseFolder = String(f.get('caseFolder') ?? '').trim();
		const packageSource = String(f.get('packageSource') ?? '').trim();
		if (!caseFolder || !packageSource) return fail(400, { caseFolder, packageSource, message: 'Both the case folder and the results package are required.' });
		const r = await app().importPackage(caseFolder, packageSource);
		redirect(303, `/import/${r.importId}${r.kind === 'identical' ? '?noop=1' : r.kind === 'repaired' ? '?repaired=1' : ''}`);
	},
	importCase: async ({ request }) => {
		const f = await request.formData();
		const caseSource = String(f.get('caseSource') ?? '').trim();
		const destination = String(f.get('destination') ?? '').trim();
		if (!caseSource || !destination) return fail(400, { caseSource, destination, packMessage: 'Choose the case (step 1) and where to store it (step 2).' });
		const r = await app().importCasePack(caseSource, destination);
		if (r.kind === 'failed') return fail(400, { caseSource, destination, packMessage: r.message });
		redirect(303, `/import/${r.importId}${r.kind === 'identical' ? '?noop=1' : r.kind === 'repaired' ? '?repaired=1' : ''}`);
	},
	cancel: () => ({ cancelled: app().cancelImport() }),
};
