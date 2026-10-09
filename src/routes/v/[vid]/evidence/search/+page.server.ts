import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { optionsOf, statusOptions } from '$lib/local-case/chronology';
import { pageParam } from '$lib/views/evidence/common';
import { bundlesOf } from '$lib/views/evidence/documents';
import { searchRowsOf } from '$lib/views/evidence/rows.server';
import { actionItems, coverage, invalidReason, queryFromParams, runSearch, searchRows } from '$lib/views/evidence/search';
import type { PageServerLoad } from './$types';

// The submitted search is the URL; the server searches the cached rows and sends one page of results.
export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const rows = searchRowsOf(app().store, version.id);
	if (!rows) error(404, 'Unknown results version');
	const { query, submitted } = queryFromParams(url.searchParams);
	// v5's action items read the last submitted search (the defaults before any search), not the form
	const wantsActions = url.searchParams.get('actions') === '1';
	const invalid = invalidReason(query);
	return {
		query,
		submitted,
		result: wantsActions ? null : runSearch(rows, query, submitted, pageParam(url.searchParams.get('page'))),
		actions: wantsActions ? (invalid ? { invalid } : actionItems(searchRows(rows, query))) : null,
		options: { bundles: bundlesOf(rows).map((b) => b.name), types: optionsOf(rows, 'docType'), statuses: statusOptions(rows) },
		coverage: coverage(rows),
	};
};
