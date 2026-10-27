/**
 * A fetch the hosted handle refused 401 with `x-clearcase-reauth: 1` (handle.ts): the session expired and only the
 * identity handshake, which a page load meets, renews it. The current page is loaded again, through the handshake and
 * back here; the request is never retried, so a write is repeated only by the user (heavy review M4). True when the page
 * is being reloaded, false to leave the response to the caller.
 */
export function reloadForSignIn(r: Response): boolean {
	if (r.status !== 401 || r.headers.get('x-clearcase-reauth') !== '1') return false;
	location.assign(location.href);
	return true;
}
