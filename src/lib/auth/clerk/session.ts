// The credential a request presents, read without the Clerk SDK so a route can name it (GRS-113). One rule for every
// reader: at most one credential; ambiguity is refused, never resolved by picking one.
export const SESSION_COOKIE = '__session';
// The suffix @clerk/backend gives a cookie of one instance: `_` and base64url characters (it derives 8, from the publishable
// key; the bound is generous). One grammar for every Clerk cookie name, so no reader recognises less than another.
const SUFFIX = '(?:_[A-Za-z0-9_-]{1,32})?';
/** The cookie names Clerk keeps a session token in: the plain name and its per-instance suffixed form. */
export const SESSION_COOKIE_NAME = new RegExp(`^__session${SUFFIX}$`);
/** The cookie names that carry a browser's Clerk state and that sign-out and a handshake may set or clear. */
export const CLERK_COOKIE_NAME = new RegExp(`^(?:__session|__client_uat|__clerk_db_jwt|__clerk_redirect_count)${SUFFIX}$`);
/** The session cookies a sign-out clears. */
export const CLEARABLE_COOKIE_NAME = new RegExp(`^(?:__session|__client_uat)${SUFFIX}$`);
/** Clerk's refresh token, exactly `__refresh` or `__refresh_<suffix>`: never stored here and never shown to the SDK. */
export const REFRESH_COOKIE_NAME = new RegExp(`^__refresh${SUFFIX}$`);

const BEARER = /^Bearer ([A-Za-z0-9._-]{16,8192})$/;
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;
// A session cookie after a ',' (a runtime that joined repeated Cookie headers) hides inside the previous cookie's value.
const JOINED_SESSION_COOKIE = new RegExp(`,[ \\t]*__session${SUFFIX}[ \\t]*=`);
const trimmed = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '');

export interface CookiePair { name: string; value: string }
/**
 * The cookies a request carries, in order, read the way @clerk/backend reads them: split on ';', a name and a value
 * trimmed of SP and HTAB only (so `name =v` and `name\t=v` are `name`), a segment with no '=' not a cookie, and a repeated
 * name kept (the SDK takes the first; every caller here refuses or counts the repeat). Every decision about what the SDK
 * will see or what a request presents is made on this reading, never on the raw header.
 */
export function cookiePairs(request: Request): CookiePair[] {
	const pairs: CookiePair[] = [];
	for (const segment of (request.headers.get('cookie') ?? '').split(';')) {
		const eq = segment.indexOf('=');
		if (eq >= 0) pairs.push({ name: trimmed(segment.slice(0, eq)), value: trimmed(segment.slice(eq + 1)) });
	}
	return pairs;
}

/** The session cookie names a request carries, so sign-out can clear exactly those. */
export function sessionCookieNames(request: Request): string[] {
	return [...new Set(cookiePairs(request).map((c) => c.name).filter((n) => SESSION_COOKIE_NAME.test(n)))];
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
	if (JOINED_SESSION_COOKIE.test(request.headers.get('cookie') ?? '')) return 'malformed';
	for (const { name, value } of cookiePairs(request)) {
		if (!SESSION_COOKIE_NAME.test(name)) continue;
		if (seen.has(name) || !TOKEN.test(value)) return 'malformed';
		seen.add(name);
		values.add(value);
	}
	if (bearer !== null) values.add(bearer);
	if (values.size > 1) return 'malformed';
	return [...values][0] ?? null;
}

const FORBIDDEN_HEADERS = ['jku', 'x5u', 'x5c', 'x5t', 'x5t#S256', 'jwk', 'crit'];
// The `cat` Clerk puts in a session token's header (@clerk/backend JWT_CATEGORY_SESSION_TOKEN); tokens minted before
// the category rollout have none. Every other category (M2M, JWT template, ignore, unknown) is not a session token.
const SESSION_CATEGORY = 'cl_B7d4PD111AAA';
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const decodePart = (part: string): unknown => {
	const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
	const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};
const finite = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
const text = (v: unknown) => v === undefined || typeof v === 'string';

/**
 * The shape gate in front of the SDK: true only for a three-part base64url token with an RS256 header (no category, or the
 * session-token one) and an object payload whose registered claims have their registered types. A token that fails is
 * refused as invalid-session, with no SDK call and no network. It decides shape, never validity: signature and claims
 * are verified afterwards.
 */
export function inspectToken(token: string): boolean {
	const parts = token.split('.');
	if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
	try {
		const header = decodePart(parts[0]!), payload = decodePart(parts[1]!);
		if (!plain(header) || !plain(payload)) return false;
		if (header.alg !== 'RS256' || (header.typ !== undefined && header.typ !== 'JWT') || !(header.kid === undefined || (typeof header.kid === 'string' && header.kid.length <= 200))) return false;
		if (FORBIDDEN_HEADERS.some((h) => h in header) || (header.cat !== undefined && header.cat !== SESSION_CATEGORY)) return false;
		const aud = payload.aud;
		return text(payload.iss) && text(payload.sub) && text(payload.sid) && text(payload.azp) && text(payload.sts) && finite(payload.exp) && finite(payload.nbf) && finite(payload.iat)
			&& (aud === undefined || typeof aud === 'string' || (Array.isArray(aud) && aud.every((a) => typeof a === 'string')));
	} catch {
		return false;
	}
}

