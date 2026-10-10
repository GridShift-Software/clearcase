import { error } from '@sveltejs/kit';
import { app } from '$lib/local-case/app.server';
import { pageNotice, pageParam } from '$lib/views/evidence/common';
import { searchRowsOf } from '$lib/views/evidence/rows.server';
import { actionItems, coverage, invalidReason, queryFromParams, runSearch, searchOptions, searchRows } from '$lib/views/evidence/search';
import type { PageServerLoad } from './$types';

// The submitted search is the URL; the server searches the cached rows and sends one page of results.
export const load: PageServerLoad = async ({ parent, url }) => {
	const { version } = await parent();
	const sr = searchRowsOf(app().store, version.id);
	if (!sr) error(404, 'Unknown results version');
	const { rows, failed } = sr;
	const { query, submitted } = queryFromParams(url.searchParams);
	// v5's action items read the last submitted search (the defaults before any search), not the form
	const wantsActions = url.searchParams.get('actions') === '1';
	const options = searchOptions(rows);
	const invalid = invalidReason(query, options);
	const result = wantsActions ? null : runSearch(rows, query, submitted, pageParam(url.searchParams.get('page')), options);
	return {
		query,
		submitted,
		result,
		// a page the URL asks for that is not shown (not a number, or past the last page) is said, not silently replaced
		pageNotice: result?.kind === 'results' ? pageNotice(url.searchParams.get('page'), result.page) : null,
		actions: wantsActions ? (invalid ? { invalid } : actionItems(searchRows(rows, query))) : null,
		options,
		coverage: coverage(rows),
		failed,
	};
};
