// Where a refused page sends a person to sign in. Pure and import-free so a Svelte page can use it without pulling the
// Clerk flow into the client bundle. The link only carries the requested path; the sign-in POST still validates it with
// signInReturnTarget (flow.ts) before it keeps it, so a path built here never widens where a sign-in may return.

const OPERATOR_SIGN_IN = '/sign-in/operator', CLIENT_SIGN_IN = '/sign-in';

/** Whether the path routes to an operator page: the router decodes the pathname once and the server collapses doubled slashes. */
function isOperatorRoute(path: string): boolean {
	const pathname = path.split(/[?#]/)[0]!;
	let decoded = pathname;
	try { decoded = decodeURIComponent(pathname); } catch { /* an undecodable path stays as given */ }
	return /^\/operator(\/|$)/.test(decoded.replace(/\/{2,}/g, '/'));
}

/**
 * The sign-in page for the identity that owns `requested` (a path with its query): operator pages sign in as ClearCase
 * staff, everything else as a client, each coming back to exactly this path. Staff and client accounts live in separate
 * identity tenants, so the wrong page ends in "account not found".
 */
export function signInHref(requested: string): string {
	return `${isOperatorRoute(requested) ? OPERATOR_SIGN_IN : CLIENT_SIGN_IN}?returnTo=${encodeURIComponent(requested)}`;
}
