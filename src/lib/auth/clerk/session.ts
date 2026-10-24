// The credential a request presents, read without the Clerk SDK so a route can name it (GRS-113). One rule for every
// reader: at most one credential; ambiguity is refused, never resolved by picking one.
export const SESSION_COOKIE = '__session';
/** The cookie names Clerk keeps a session token in: the plain name and its per-instance suffixed form. */
export const SESSION_COOKIE_NAME = /^__session(?:_[A-Za-z0-9]{1,32})?$/;
/** The cookie names that carry a browser's Clerk state and that sign-out and a handshake may set or clear. */
export const CLERK_COOKIE_NAME = /^(?:__session|__client_uat|__clerk_db_jwt|__clerk_redirect_count)(?:_[A-Za-z0-9]{1,32})?$/;

const BEARER = /^Bearer ([A-Za-z0-9._-]{16,8192})$/;
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;
// A session cookie anywhere in the header, after a ';' (valid) or a ',' (a runtime that joined repeated Cookie headers).
const COOKIE = /(^|[;,])\s*(__session(?:_[A-Za-z0-9]{1,32})?)\s*=\s*([^;,]*)/g;

/** The session cookie names a request carries, so sign-out can clear exactly those. */
export function sessionCookieNames(request: Request): string[] {
	const names = new Set<string>();
	for (const m of (request.headers.get('cookie') ?? '').matchAll(COOKIE)) names.add(m[2]!);
	return [...names];
}

/**
 * The one presented credential, null when none, or 'malformed' (refused as invalid-session): an Authorization Bearer
 * token, or a session cookie (plain or suffixed), or several only when they all carry the same token. A name that
 * repeats, differing values, a quoted value or a comma-joined Cookie header are all 'malformed'.
 */
export function presentedToken(request: Request): string | null | 'malformed' {
	const header = request.headers.get('authorization');
	const bearer = header === null ? null : (BEARER.exec(header)?.[1] ?? 'malformed');
	if (bearer === 'malformed') return 'malformed';
	const seen = new Set<string>(), values = new Set<string>();
	for (const m of (request.headers.get('cookie') ?? '').matchAll(COOKIE)) {
		if (m[1] === ',' || seen.has(m[2]!) || !TOKEN.test(m[3]!)) return 'malformed';
		seen.add(m[2]!);
		values.add(m[3]!);
	}
	if (bearer !== null) values.add(bearer);
	if (values.size > 1) return 'malformed';
	return [...values][0] ?? null;
}
