import { fail, redirect } from '@sveltejs/kit';
import { citedRefs } from '$lib/components/cite';
import { app } from '$lib/local-case/app.server';
import { anyDateBasis, documentCounts } from '$lib/local-case/documents.server';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import { slotStates } from '$lib/local-case/overview-widgets.server';
import { versionPath, type OverviewModel } from '$lib/local-case/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent }) => {
	const { version, isActive } = await parent();
	const a = app();
	const v = a.store.getVersion(version.id)!;
	const overview = JSON.parse(v.overview) as OverviewModel;
	// Values from the package (bundle and type names, META keys) never become object keys in page data: a key such as
	// '__proto__' is refused by the serializer. Tallies and claims travel as [key, value] entries.
	const entries = <T>(m: Record<string, T>) => Object.entries(m);
	const tallies = { byBundle: entries(overview.counts.byBundle), byDocType: entries(overview.counts.byDocType), byTextStatus: entries(overview.counts.byTextStatus), claims: entries(overview.sourceClaims) };
	const { byBundle: _b, byDocType: _t, byTextStatus: _s, ...counts } = overview.counts;
	const { sourceClaims: _c, ...rest } = overview;
	const narrative = overview.matter?.storyline[0]?.t ?? null;
	const documents = documentCounts(a.store, v.id);
	// Case wording v5 hard-coded in its overview renderer, imported as view-content data (GRS-38). Template params come
	// from imported data only; an absent field leaves the view's own neutral layout.
	const vc = viewContentOf(a.store, v.id);
	const params = { docCount: documents.total, bundleCount: Object.keys(overview.counts.byBundle).length, invoiceCount: overview.quantum?.invoiceCount ?? overview.counts.invoices, caseName: version.caseName };
	const content = {
		subtitle: viewText(vc, 'overview', 'subtitle', params),
		kpiDocumentsNote: viewText(vc, 'overview', 'kpiDocumentsNote', params),
		kpiInvoicesNote: viewText(vc, 'overview', 'kpiInvoicesNote', params),
	};
	return {
		overview: { ...rest, counts },
		tallies,
		// the document count of the document-row contract (imported register plus provider rows), as the chronology lists them
		documents,
		content,
		dateBasisKnown: anyDateBasis(a.store, v.id),
		// the originals counts are the import-time check (a live re-check of every original would be expensive)
		originalsCheckedAt: v.stored_at,
		narrative,
		known: narrative ? [...a.store.existingRefs(v.id, citedRefs([narrative]))] : [],
		notes: a.userWork.summary(v.case_id, v.id),
		previous: isActive ? a.previousVersion(v.case_id) : null,
		slots: await slotStates({ app: a, caseId: v.case_id, caseName: version.caseName, resultsVersion: v.id }),
	};
};

export const actions: Actions = {
	rollback: async ({ params, request }) => {
		const a = app();
		const v = a.store.getVersion(params.vid);
		if (!v) return fail(404, { message: 'Unknown results version' });
		const f = await request.formData();
		const str = (k: string) => { const x = f.get(k); return typeof x === 'string' && x ? x : null; };
		const refused = await a.rollback(v.case_id, str('expect'), str('to'));
		if (refused) return fail(refused.message.startsWith('Nothing was changed') ? 409 : 400, { message: refused.message });
		redirect(303, '/');
	},
};
