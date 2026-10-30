import type { PageLoad } from './$types';

// The server load already holds the first list page; the page fetches every row itself once it shows.
export const load: PageLoad = ({ data }) => data;
