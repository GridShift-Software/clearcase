// A link to one page of an original. The hosted native viewer (/cases/<case>/originals/<asset>/view) reads the page from
// its `page` query parameter on the server, so a fragment there would open page 1; any other viewer (the local PDF viewer
// and the originals site) keeps the PDF `#page=` fragment. Browser-safe.
const NATIVE_VIEWER = /^\/cases\/[^/?#]+\/originals\/[^/?#]+\/view(?=$|[?#])/;

/** `href` opened at `page`: the query parameter for the hosted native viewer (other parameters kept), else `#page=`. */
export function viewerPageHref(href: string, page: number | null | undefined): string {
	if (!page) return href;
	if (!NATIVE_VIEWER.test(href)) return `${href}#page=${page}`;
	const url = new URL(href, 'https://viewer.invalid');
	url.searchParams.set('page', String(page));
	return `${url.pathname}${url.search}${url.hash}`;
}
