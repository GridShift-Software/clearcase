import { fail, redirect } from '@sveltejs/kit';
import { homedir } from 'node:os';
import { app } from '$lib/local-case/app.server';
import { defaultDestination } from '$lib/local-case/case-pack.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ imports: app().store.listImports(), running: app().importProgress(), home: homedir(), defaultDestination: defaultDestination() });

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
		const destination = String(f.get('destination') ?? '').trim() || defaultDestination();
		const caseName = String(f.get('caseName') ?? '').trim();
		if (!caseSource) return fail(400, { caseSource, destination, caseName, packMessage: 'Choose the case pack with Add documents first.' });
		const r = await app().importCasePack(caseSource, destination, caseName);
		if (r.kind === 'failed') return fail(400, { caseSource, destination, caseName, packMessage: r.message });
		redirect(303, `/import/${r.importId}${r.kind === 'identical' ? '?noop=1' : r.kind === 'repaired' ? '?repaired=1' : ''}`);
	},
	cancel: () => ({ cancelled: app().cancelImport() }),
};
