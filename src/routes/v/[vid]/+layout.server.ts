import { error } from '@sveltejs/kit';
import { caseName } from '$lib/components/titles';
import { app } from '$lib/local-case/app.server';
import type { OverviewModel } from '$lib/local-case/model';
import { viewContentOf, viewText } from '$lib/local-case/results.server';
import type { LayoutServerLoad } from './$types';

const RV = /^sha256:[0-9a-f]{64}$/;

export const load: LayoutServerLoad = ({ params }) => {
	const a = app();
	if (!RV.test(params.vid)) error(404, 'Unknown results version');
	const v = a.store.getVersion(params.vid);
	if (!v) error(404, 'Unknown results version');
	// Verify-on-load (cached per process, dropped when another connection writes): a corrupt version gets a clear 409.
	const check = a.verify(v.id);
	if (!check.ok) error(409, `Results version ${v.id} failed its integrity check (${check.reason}). Import the same package again (same case folder) to repair it.`);
	const o = JSON.parse(v.overview) as OverviewModel;
	const name = caseName(o);
	// The shell's page title and brand come from the package's view-content (`_shell`); without them the case name
	// stands in, so the layout never depends on the dataset.
	const vc = viewContentOf(a.store, v.id);
	const shell = { caseName: name, resultsVersion: v.id };
	return {
		version: {
			id: v.id, caseId: v.case_id, caseName: name, importId: v.import_id, verdict: v.verdict, created: v.created, inputRevisionId: v.input_revision_id,
			/** the case part of every page title of this version (BA-16) */
			titleName: viewText(vc, '_shell', 'documentTitle', shell) ?? name,
			/** the case's brand at the top of the view navigation */
			brand: viewText(vc, '_shell', 'brandName', shell) ?? name,
		},
		isActive: a.effectiveActive(v.case_id) === v.id,
	};
};
