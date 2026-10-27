// The SDK-free half of the first-party browser contract (GRS-113): the sign-in identity switch, return-target allowlist,
// cookie clears and sign-out, as pure functions of a Request, the deployment config and fetch. The hosted routes import
// this module (the hosted import allowlist keeps @clerk/backend out of routes); the handshake that needs the SDK is
// browser.ts, which re-exports this. Nothing here is wired into hooks, locals, CSP or wrangler, and nothing has run
// against a real Clerk instance or browser.
import type { Identity, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { isSignInFlowPage, readClerkIdentityConfig, type ClerkIdentityConfig, type ClerkInstanceConfig, type InstanceKind, type StaffDevBrowser } from './config.ts';
import { revocationEvidenceOf, type RevocationEvidence } from './revocation.ts';
import { CLEARABLE_COOKIE_NAME, REFRESH_COOKIE_NAME, cookiePairs, inspectToken, presentedToken } from './session.ts';

export { cookiePairs, type CookiePair } from './session.ts';

/** The per-client staff (operator) sign-in route on a client origin. */
export const OPERATOR_PATH = '/sign-in/operator';
/** Where a sign-in returns when no safe target was asked for. */
export const DEFAULT_RETURN = '/cases';

export type HandshakeOutcome =
	| { kind: 'continue' }
	/** Answer 303 to `location` with every `setCookies` entry (a handshake redirect, or the clean URL once cookies are set). */
	| { kind: 'redirect'; location: string; setCookies: string[] }
	/** Answer `status` and stop: a handshake that must not be followed. */
	| { kind: 'refuse'; status: 400 | 502; code: 'wrong-origin' | 'handshake-invalid' | 'handshake-format-unsupported' | 'handshake-cookie-refused' };
export interface ClerkBrowserHandshake {
	handle(request: Request): Promise<HandshakeOutcome>;
}

/**
 * The Cookie header the SDK may see: the request's cookies as `cookiePairs` read them, without the handshake cookie (a
 * handshake is only ever taken from the query, verified here) and without Clerk's refresh token (with it the SDK would
 * refresh an expired session through the Backend API on each request). Exact names, not a prefix.
 */
export function sdkCookieHeader(request: Request): string {
	return cookiePairs(request).filter((c) => c.name !== '__clerk_handshake' && !REFRESH_COOKIE_NAME.test(c.name)).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** The browser's one `__clerk_db_jwt` (the dev browser a handshake set host-only here), or null when absent or repeated. */
export function devBrowserOf(request: Request): string | null {
	const values = cookiePairs(request).filter((c) => c.name === '__clerk_db_jwt').map((c) => c.value);
	return values.length === 1 ? values[0]! : null;
}

/**
 * The cookie that ties the browser's `__clerk_db_jwt` to the staff instance. Both instances set that one plain name on a
 * client origin, so the handshake sets this beside it only for a staff handshake this browser started here
 * (staffHandshakeOf) from a dev browser it could vouch for, and only when a token the staff key alone verifies set it.
 *
 * It and the correlation are `__Host-` cookies: the browser takes one only with Secure, Path=/ and no Domain, from this
 * secure origin, so a sibling origin under the same parent domain cannot plant either (a host-only clear cannot remove
 * a parent-Domain cookie). Only those names count; the unprefixed names used before (`__clearcase_staff_dvb`,
 * `__clearcase_staff_hs`) are proof of nothing. A plain http origin cannot hold them, so it mints and reads neither
 * (hostCookies) and its operator POST forwards no dev browser.
 */
export const STAFF_DEV_BROWSER_TIE = '__Host-clearcase_staff_dvb';
/**
 * The correlation of a staff handshake this browser started on this origin: the start sets this cookie and puts the same
 * random id in the handshake's redirect_url as this query parameter, and only a return carrying both counts.
 */
export const STAFF_HANDSHAKE_COOKIE = '__Host-clearcase_staff_hs';
export const STAFF_HANDSHAKE_PARAM = '__clearcase_staff_hs';
/** Whether this app's origin can hold the `__Host-` tie and correlation: https only. */
const hostCookies = (config: ClerkIdentityConfig) => config.appOrigin.startsWith('https://');
/** How long a started staff handshake may take to come back, in seconds (its round trip is automatic redirects). */
export const STAFF_HANDSHAKE_TTL = 600;
const TIE_LABEL = 'clearcase staff dev browser v2', HANDSHAKE_LABEL = 'clearcase staff handshake v1';
const B64URL = /^[A-Za-z0-9_-]{43}$/;
const CORRELATION = /^([A-Za-z0-9_-]{43})\.(\d{1,12})\.([01])\.([A-Za-z0-9_-]{43})$/;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const macKey = (staff: ClerkInstanceConfig) => crypto.subtle.importKey('raw', new TextEncoder().encode(staff.secretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
// Every MAC names what it is for and the receiving app, client and staff instance, so no value counts in another scope.
// It is keyed by the staff secret unless a flow names its own instance.
const macData = (label: string, config: ClerkIdentityConfig, parts: readonly string[]) => new TextEncoder().encode([label, config.appOrigin, config.clientId, config.staff.issuer, ...parts].join('\0'));
const macOf = async (label: string, config: ClerkIdentityConfig, parts: readonly string[], key = config.staff) => b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(key), macData(label, config, parts))));
const macVerifies = async (label: string, config: ClerkIdentityConfig, parts: readonly string[], mac: string, key = config.staff) => crypto.subtle.verify('HMAC', await macKey(key), fromB64url(mac), macData(label, config, parts));

/** The tie's value for a staff dev browser: base64url HMAC-SHA-256 under the staff secret key, over this app's scope. */
export function staffDevBrowserTie(config: ClerkIdentityConfig, devBrowser: string): Promise<string> {
	return macOf(TIE_LABEL, config, [devBrowser]);
}

/**
 * The browser's one `__clerk_db_jwt` as a StaffDevBrowser when its one tie verifies for this app, client and staff
 * instance, else null (no tie, a repeated cookie, another value, app, client or staff instance, or an http origin).
 * Transport only.
 */
export async function tiedDevBrowser(request: Request, config: ClerkIdentityConfig): Promise<StaffDevBrowser | null> {
	if (!hostCookies(config)) return null;
	const value = devBrowserOf(request), ties = cookiePairs(request).filter((c) => c.name === STAFF_DEV_BROWSER_TIE);
	if (value === null || ties.length !== 1 || !B64URL.test(ties[0]!.value) || !(await macVerifies(TIE_LABEL, config, [value], ties[0]!.value))) return null;
	return { instance: 'staff', value, appOrigin: config.appOrigin, clientId: config.clientId, issuer: config.staff.issuer } as StaffDevBrowser;
}
/** tiedDevBrowser for a route, with this deployment's config; null when it is not configured. */
export async function staffDevBrowserOf(request: Request, env: Readonly<Record<string, unknown>>): Promise<StaffDevBrowser | null> {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	return read.ok ? tiedDevBrowser(request, read.config) : null;
}

/**
 * A new staff handshake correlation: a random 256-bit id for the redirect_url and the cookie that carries it, its issue
 * time and whether the start could vouch for the dev browser it hands the Frontend API (`vouched`), under one MAC. Null
 * on an http origin, which cannot hold the `__Host-` cookie.
 */
export async function startStaffHandshake(config: ClerkIdentityConfig, vouched: boolean): Promise<{ id: string; setCookie: string } | null> {
	if (!hostCookies(config)) return null;
	const id = b64url(crypto.getRandomValues(new Uint8Array(32))), parts = [id, String(Math.floor(Date.now() / 1000)), vouched ? '1' : '0'];
	const value = `${parts.join('.')}.${await macOf(HANDSHAKE_LABEL, config, parts)}`;
	return { id, setCookie: `${STAFF_HANDSHAKE_COOKIE}=${value}; Path=/; Max-Age=${STAFF_HANDSHAKE_TTL}; SameSite=Lax; HttpOnly; Secure` };
}
/**
 * The staff handshake correlation a returning request proves, or null: exactly one correlation cookie and one id in the
 * URL, equal, issued for this app, client and staff instance within STAFF_HANDSHAKE_TTL, under a MAC that verifies.
 * `vouched` says whether the start could vouch for the dev browser it handed the Frontend API. Null on an http origin.
 */
export async function staffHandshakeOf(request: Request, config: ClerkIdentityConfig): Promise<{ vouched: boolean } | null> {
	if (!hostCookies(config)) return null;
	const cookies = cookiePairs(request).filter((c) => c.name === STAFF_HANDSHAKE_COOKIE), ids = new URL(request.url).searchParams.getAll(STAFF_HANDSHAKE_PARAM);
	const m = cookies.length === 1 && ids.length === 1 ? CORRELATION.exec(cookies[0]!.value) : null;
	if (!m || m[1] !== ids[0]) return null;
	const age = Math.floor(Date.now() / 1000) - Number(m[2]);
	if (age < -60 || age > STAFF_HANDSHAKE_TTL) return null;
	return (await macVerifies(HANDSHAKE_LABEL, config, [m[1]!, m[2]!, m[3]!], m[4]!)) ? { vouched: m[3] === '1' } : null;
}
/** The directive that deletes the staff handshake correlation (an accepted handshake return consumes it in this browser). */
export const STAFF_HANDSHAKE_CLEAR = `${STAFF_HANDSHAKE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;

/** The cookie directives that delete exactly the Clerk session cookies a request carries (host-only, as they were set). */
export function clerkCookieClears(request: Request, secure: boolean): string[] {
	return clearableNames(request).map((name) => `${name}=; Path=/; Max-Age=0${name.startsWith('__client_uat') ? '' : '; HttpOnly'}; SameSite=Lax${secure ? '; Secure' : ''}`);
}
/** The names of the Clerk session cookies a request carries, in order of appearance. */
export function clearableNames(request: Request): string[] {
	return [...new Set(cookiePairs(request).map((c) => c.name).filter((n) => CLEARABLE_COOKIE_NAME.test(n)))];
}


/** A no-store 303 for a redirect outcome, a bare error for a refusal, null to let the request continue. */
export function handshakeResponse(o: HandshakeOutcome): Response | null {
	if (o.kind === 'continue') return null;
	if (o.kind === 'refuse') return new Response(null, { status: o.status, headers: { 'cache-control': 'no-store', 'x-clearcase-auth': o.code } });
	const headers = new Headers({ location: o.location, 'cache-control': 'no-store' });
	for (const c of o.setCookies) headers.append('set-cookie', c);
	return new Response(null, { status: 303, headers });
}

export type SignInPlan = { action: 'proceed' } | { action: 'sign-out-first'; current: InstanceKind } | { action: 'refuse'; reason: 'ambiguous-credential' };
/**
 * The identity switch for one browser session per origin. A verified session of the other kind is signed out first; a
 * session of the same kind or none proceeds (Clerk replaces a stale cookie); an ambiguous credential is refused.
 */
export function planSignIn(a: { target: InstanceKind; identity: Pick<Identity, 'kind' | 'principal'>; credential: string | null | 'malformed' }): SignInPlan {
	if (a.credential === 'malformed') return { action: 'refuse', reason: 'ambiguous-credential' };
	if (a.identity.kind === 'verified' && a.identity.principal !== null && a.identity.principal.kind !== a.target) return { action: 'sign-out-first', current: a.identity.principal.kind };
	return { action: 'proceed' };
}

/** A same-origin path to return to after sign-in; anything else (absolute, protocol-relative, backslash, control) is the default. */
export function safeReturnTo(value: unknown): string {
	if (typeof value !== 'string' || !/^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/.test(value)) return DEFAULT_RETURN;
	const path = value.split(/[?#]/)[0]!;
	return path === '/sign-out' || path.startsWith('/sign-out/') ? DEFAULT_RETURN : value;
}
/** Where a finished sign-in may go on to: a safeReturnTo path that is not a sign-in or sign-out page (that would loop). */
export function signInReturnTarget(value: unknown): string {
	const to = safeReturnTo(value);
	return isSignInFlowPage(new URL(to, 'https://path.invalid').pathname) ? DEFAULT_RETURN : to;
}

/**
 * The return target of a sign-in in flight, one cookie per flow. Clerk sees one fixed callback per origin and flow
 * (config.ts clerkSignInTarget), because an instance that allows only exact redirect URLs sends any other one to its
 * home URL, so the sign-in POST keeps the target here and the callback reads it once. The value is the target
 * (base64url), its issue time and an HMAC-SHA-256 under the flow's own instance secret key over this app, client,
 * instance and flow: a state from another origin, client or flow counts as none. It is a `__Host-` cookie a sibling
 * origin cannot plant; a plain http origin cannot hold one, so its sign-ins return to DEFAULT_RETURN.
 */
export const SIGN_IN_RETURN_COOKIE: Readonly<Record<InstanceKind, string>> = { client: '__Host-clearcase_return', staff: '__Host-clearcase_staff_return' };
/** How long a sign-in may take at the portal before its return target lapses, in seconds. */
export const SIGN_IN_RETURN_TTL = 900;
const RETURN_LABEL = 'clearcase sign-in return v1', RETURN_MAX_BYTES = 2048;
const RETURN_STATE = /^([A-Za-z0-9_-]{2,2731})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const returnParts = (config: ClerkIdentityConfig, kind: InstanceKind, issued: string, to: string) => [kind, config[kind].issuer, issued, to];

/** The state value for a target exactly as given (signInReturnCookie validates it first), or null on an http origin. */
export async function sealSignInReturn(config: ClerkIdentityConfig, kind: InstanceKind, returnTo: string): Promise<string | null> {
	if (!hostCookies(config)) return null;
	const issued = String(Math.floor(Date.now() / 1000));
	return `${b64url(new TextEncoder().encode(returnTo))}.${issued}.${await macOf(RETURN_LABEL, config, returnParts(config, kind, issued, returnTo), config[kind])}`;
}
/**
 * The state cookie a sign-in POST sets for the asked `returnTo`, validated by signInReturnTarget (a target too long for
 * a cookie is DEFAULT_RETURN); null when Clerk is not configured or on an http origin.
 */
export async function signInReturnCookie(env: Readonly<Record<string, unknown>>, kind: InstanceKind, returnTo: unknown) {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	if (!read.ok) return null;
	const target = signInReturnTarget(returnTo), to = new TextEncoder().encode(target).length <= RETURN_MAX_BYTES ? target : DEFAULT_RETURN;
	const value = await sealSignInReturn(read.config, kind, to);
	return value === null ? null : { name: SIGN_IN_RETURN_COOKIE[kind], value, options: { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SIGN_IN_RETURN_TTL } as const };
}
/**
 * The target a callback's state carries for this flow, or null: exactly one cookie, issued for this app, client, instance
 * and flow within SIGN_IN_RETURN_TTL, under a MAC that verifies, naming a target signInReturnTarget keeps unchanged.
 */
export async function signInReturnOf(env: Readonly<Record<string, unknown>>, request: Request, kind: InstanceKind): Promise<string | null> {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	if (!read.ok || !hostCookies(read.config)) return null;
	const states = cookiePairs(request).filter((c) => c.name === SIGN_IN_RETURN_COOKIE[kind]);
	const m = states.length === 1 ? RETURN_STATE.exec(states[0]!.value) : null;
	if (!m) return null;
	const age = Math.floor(Date.now() / 1000) - Number(m[2]);
	if (age < -60 || age > SIGN_IN_RETURN_TTL) return null;
	let to: string;
	try {
		to = new TextDecoder('utf-8', { fatal: true }).decode(fromB64url(m[1]!));
	} catch {
		return null;
	}
	if (!(await macVerifies(RETURN_LABEL, read.config, returnParts(read.config, kind, m[2]!, to), m[3]!, read.config[kind]))) return null;
	return signInReturnTarget(to) === to ? to : null;
}
/**
 * Where a sign-in page sends a session already verified for its flow: an explicit `returnTo` in the page URL, else the
 * target its state carries, else DEFAULT_RETURN. The state is read once, so `clear` names the cookie to delete.
 */
export async function signInReturn(env: Readonly<Record<string, unknown>>, request: Request, url: URL, kind: InstanceKind): Promise<{ location: string; clear: string }> {
	const location = url.searchParams.has('returnTo') ? signInReturnTarget(url.searchParams.get('returnTo')) : ((await signInReturnOf(env, request, kind)) ?? DEFAULT_RETURN);
	return { location, clear: SIGN_IN_RETURN_COOKIE[kind] };
}

/**
 * What a sign-in route does before it sends the browser to Clerk: the identity switch. Proceed (clearing the cookies of
 * a session it just signed out), or refuse an ambiguous credential (clearing it). A session of the other kind is signed
 * out first whether its token is still valid (a verified identity), has EXPIRED while the Clerk session stayed live, or
 * is PENDING (revoke-only evidence, revocation.ts); such a session of the SAME kind is not revoked, Clerk replaces it.
 * Throws identity-unavailable, clearing nothing, when the first session cannot be confirmed revoked.
 */
export async function prepareSignIn(a: { env: Readonly<Record<string, unknown>>; request: Request; identity: Pick<Identity, 'kind' | 'principal' | 'sessionId'>; target: InstanceKind }): Promise<{ action: 'proceed' | 'refuse'; clear: string[] }> {
	const plan = planSignIn({ target: a.target, identity: a.identity, credential: presentedToken(a.request) });
	if (plan.action === 'refuse') return { action: 'refuse', clear: clearableNames(a.request) };
	if (plan.action === 'sign-out-first') return { action: 'proceed', clear: (await signOutClerkSession(a)).clear };
	if (a.identity.kind !== 'verified') {
		const evidence = await expiredSessionEvidence(a);
		if (evidence !== null && evidence.instance.kind !== a.target) {
			await revokeOwnedSession({ config: evidence.config, evidence });
			return { action: 'proceed', clear: clearableNames(a.request) };
		}
	}
	return { action: 'proceed', clear: [] };
}

/**
 * The revoke-only evidence of a request's session token when its caller is not verified (typically: expired, or
 * pending), with the config it was checked against; null for no credential, an ambiguous one, anything that is not a
 * genuine token of a pinned instance, or a token older than any Clerk session lives. Throws identity-unavailable when a
 * token-shaped credential cannot be checked because Clerk is not configured: whether a live session exists is then
 * unknown.
 */
async function expiredSessionEvidence(a: { env: Readonly<Record<string, unknown>>; request: Request }): Promise<(RevocationEvidence & { config: ClerkIdentityConfig }) | null> {
	const token = presentedToken(a.request);
	if (token === null || token === 'malformed' || !inspectToken(token)) return null;
	const read = readClerkIdentityConfig(a.env);
	if (!read.ok) throw contractError('identity-unavailable', true);
	const evidence = await revocationEvidenceOf(token, read.config);
	return evidence === null ? null : { ...evidence, config: read.config };
}

/**
 * Sign-out for the hosted route: revokes the caller's Clerk session at the instance that issued it, then names the Clerk
 * session cookies to clear. A verified identity is revoked by its principal. Otherwise a session token that EXPIRED while
 * its Clerk session stayed live, or a PENDING one, is revoked on revoke-only evidence (revocation.ts: a genuine signature
 * of a pinned instance, its own Backend API, and an owner that matches `sub`); that evidence is never an Identity.
 * Anything else (no credential, a forged, key-confused, wrong-issuer, unsigned, ambiguous or too old one) revokes nothing
 * and still clears. It throws identity-unavailable, clearing nothing, when Clerk is not configured or the revocation
 * cannot be confirmed, and invalid-session when the session is not owned by the token's subject: a session still live at
 * Clerk is not reported as ended.
 */
export async function signOutClerkSession(a: { env: Readonly<Record<string, unknown>>; request: Request; identity: Pick<Identity, 'kind' | 'principal' | 'sessionId'> }): Promise<{ revoked: boolean; clear: string[] }> {
	const { identity } = a;
	let revoked = false;
	if (identity.kind === 'verified' && identity.principal !== null && identity.sessionId !== null) {
		const read = readClerkIdentityConfig(a.env);
		if (!read.ok) throw contractError('identity-unavailable', true);
		await revokeClerkSession({ config: read.config, principal: identity.principal, sessionId: identity.sessionId });
		revoked = true;
	} else {
		const evidence = await expiredSessionEvidence(a);
		if (evidence !== null) {
			await revokeOwnedSession({ config: evidence.config, evidence });
			revoked = true;
		}
	}
	return { revoked, clear: clearableNames(a.request) };
}

/** The Clerk Backend API origin when the config names none. */
const CLERK_API = 'https://api.clerk.com';

/**
 * Revokes a session at the Clerk instance that issued it (found by the principal's issuer and kind), with that
 * instance's secret key: POST /v1/sessions/{id}/revoke. A session already gone (404) is done; any other failure is
 * identity-unavailable, so a session still live at Clerk is never reported as ended.
 */
export async function revokeClerkSession(a: { config: ClerkIdentityConfig; principal: Principal; sessionId: SessionId; fetcher?: typeof fetch }): Promise<void> {
	const instance = [a.config.client, a.config.staff].find((i) => i.issuer === a.principal.issuer && i.kind === a.principal.kind);
	if (!instance) throw contractError('invalid-session');
	await postRevoke({ config: a.config, instance, sessionId: a.sessionId, fetcher: a.fetcher });
}

async function postRevoke(a: { config: ClerkIdentityConfig; instance: ClerkInstanceConfig; sessionId: SessionId; fetcher?: typeof fetch }): Promise<void> {
	let res: Response;
	try {
		res = await (a.fetcher ?? fetch)(`${a.config.apiUrl ?? CLERK_API}/v1/sessions/${encodeURIComponent(a.sessionId)}/revoke`, {
			method: 'POST',
			headers: { authorization: `Bearer ${a.instance.secretKey}`, 'content-type': 'application/json' },
			redirect: 'manual', // workerd has no 'error' mode; a 3xx comes back unfollowed and is not ok
		});
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (res.status === 404) return;
	if (!res.ok) throw contractError('identity-unavailable', true);
}

// Session states that need no revoke: Clerk has already ended the session.
const ENDED = new Set(['revoked', 'ended', 'expired', 'removed', 'abandoned', 'replaced']);

// What this isolate already learned from Clerk about a revoke-only session, so a replayed token causes no further Backend
// API call: 'done' (gone, ended, or revoked here) or 'not-owner' (the token's subject does not own it); neither changes
// at Clerk. The key is the signed issuer, subject and session, which only a genuine token of that session names, so no
// caller can settle or occupy another user's entry. A failure is never remembered. A session being looked up is busy
// for at most BUSY_MS (a request the runtime cancels mid-lookup never reaches its `finally`), and a concurrent request
// for it is identity-unavailable (retry) rather than a second lookup. Both maps are bounded; dropping an entry only costs
// one more lookup.
const settledSessions = new Map<string, 'done' | 'not-owner'>(), busySessions = new Map<string, number>();
const SESSIONS_LIMIT = 4096, BUSY_MS = 30_000;
const remember = <V>(map: Map<string, V>, key: string, value: V) => {
	map.delete(key);
	if (map.size >= SESSIONS_LIMIT) map.delete(map.keys().next().value!);
	map.set(key, value);
};

/**
 * Revokes the session a revoke-only token names, at that token's own instance with that instance's secret key, after the
 * instance's Backend API confirms the session belongs to the token's `sub` (GET /v1/sessions/{id}; the session's user_id
 * must equal it, else invalid-session and nothing is revoked). A session already gone (404) or ended is done; a failed or
 * unreadable lookup, or a failed revoke, is identity-unavailable. At most one lookup and one revoke per session and
 * subject per isolate: a settled answer is reused, and a concurrent duplicate is identity-unavailable.
 */
export async function revokeOwnedSession(a: { config: ClerkIdentityConfig; evidence: RevocationEvidence; fetcher?: typeof fetch }): Promise<void> {
	const { config, evidence } = a;
	const key = [config.apiUrl ?? CLERK_API, evidence.instance.issuer, evidence.subject, evidence.sessionId].join('\0');
	const settled = settledSessions.get(key);
	if (settled === 'done') return;
	if (settled === 'not-owner') throw contractError('invalid-session');
	const now = Date.now();
	if (now - (busySessions.get(key) ?? -Infinity) < BUSY_MS) throw contractError('identity-unavailable', true);
	remember(busySessions, key, now);
	let outcome: 'done' | 'not-owner';
	try {
		outcome = await lookUpAndRevoke(a);
	} finally {
		if (busySessions.get(key) === now) busySessions.delete(key);
	}
	remember(settledSessions, key, outcome);
	if (outcome === 'not-owner') throw contractError('invalid-session');
}

async function lookUpAndRevoke(a: { config: ClerkIdentityConfig; evidence: RevocationEvidence; fetcher?: typeof fetch }): Promise<'done' | 'not-owner'> {
	const { config, evidence } = a;
	let res: Response;
	try {
		res = await (a.fetcher ?? fetch)(`${config.apiUrl ?? CLERK_API}/v1/sessions/${encodeURIComponent(evidence.sessionId)}`, {
			method: 'GET',
			headers: { authorization: `Bearer ${evidence.instance.secretKey}` },
			redirect: 'manual', // workerd has no 'error' mode; a 3xx comes back unfollowed and is not ok
		});
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (res.status === 404) return 'done';
	if (!res.ok) throw contractError('identity-unavailable', true);
	let session: { user_id?: unknown; status?: unknown };
	try {
		session = (await res.json()) as typeof session;
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (typeof session !== 'object' || session === null || typeof session.user_id !== 'string') throw contractError('identity-unavailable', true);
	if (session.user_id !== evidence.subject) return 'not-owner';
	if (typeof session.status === 'string' && ENDED.has(session.status)) return 'done';
	await postRevoke({ config, instance: evidence.instance, sessionId: evidence.sessionId, fetcher: a.fetcher });
	return 'done';
}
