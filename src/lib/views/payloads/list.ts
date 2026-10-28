import type { ChronologyListRow } from '../../local-case/model.ts';

/** Rows per `list/page-<n>.json` shard. */
export const LIST_PAGE_ROWS = 200;

/** `list/page-<n>.json`: one page of the chronology list, `page` counted from 1. */
export interface ListPage {
	page: number;
	pages: number;
	total: number;
	rows: ChronologyListRow[];
}

/** A facet's values with their document counts. */
export type FacetCounts = [value: string, count: number][];

/** `list/facets.json`: the filter options of the list views, as counts, not rows. */
export interface FacetsShard {
	bundles: FacetCounts;
	docTypes: FacetCounts;
	textStatuses: FacetCounts;
	years: FacetCounts;
}
