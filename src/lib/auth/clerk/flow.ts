// The SDK-free half of the first-party browser contract (GRS-113): the sign-in identity switch, return-target allowlist,
// cookie clears and sign-out, as pure functions of a Request, the deployment config and fetch. The hosted routes import
// this module (the hosted import allowlist keeps @clerk/backend out of routes); the handshake that needs the SDK is
// browser.ts, which re-exports this. Nothing here is wired into hooks, locals, CSP or wrangler, and nothing has run
// against a real Clerk instance or browser.
import type { Identity, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { readClerkIdentityConfig, type ClerkIdentityConfig, type ClerkInstanceConfig, type InstanceKind } from './config.ts';
import { revocationEvidenceOf, type RevocationEvidence } from './revocation.ts';
import { inspectToken, presentedToken } from './session.ts';

const CLEARABLE = /^(?:__session|__client_uat)(?:_[A-Za-z0-9]{1,32})?$/;

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

export const cookiePairs = (request: Request): { name: string; value: string }[] =>
	(request.headers.get('cookie') ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const i = p.indexOf('='); return i < 0 ? { name: p, value: '' } : { name: p.slice(0, i), value: p.slice(i + 1) }; });

/** The cookie directives that delete exactly the Clerk session cookies a request carries (host-only, as they were set). */
export function clerkCookieClears(request: Request, secure: boolean): string[] {
	return clearableNames(request).map((name) => `${name}=; Path=/; Max-Age=0${name.startsWith('__client_uat') ? '' : '; HttpOnly'}; SameSite=Lax${secure ? '; Secure' : ''}`);
}
/** The names of the Clerk session cookies a request carries, in order of appearance. */
export function clearableNames(request: Request): string[] {
	return [...new Set(cookiePairs(request).map((c) => c.name).filter((n) => CLEARABLE.test(n)))];
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

/**
 * What a sign-in route does before it sends the browser to Clerk: the identity switch. Proceed (clearing the cookies of
 * a session it just signed out), or refuse an ambiguous credential (clearing it). A session of the other kind is signed
 * out first whether its token is still valid (a verified identity) or has EXPIRED while the Clerk session stayed live
 * (revoke-only evidence, revocation.ts); an expired session of the SAME kind is not revoked, Clerk replaces it. Throws
 * identity-unavailable, clearing nothing, when the first session cannot be confirmed revoked.
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
 * The revoke-only evidence of a request's session token when its caller is not verified (typically: expired), with the
 * config it was checked against; null for no credential, an ambiguous one, or anything that is not a genuine token of a
 * pinned instance. Throws identity-unavailable when a token-shaped credential cannot be checked because Clerk is not
 * configured: whether a live session exists is then unknown.
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
 * its Clerk session stayed live is revoked on revoke-only evidence (revocation.ts: a genuine signature of a pinned
 * instance, its own Backend API, and an owner that matches `sub`); that evidence is never an Identity. Anything else
 * (no credential, a forged, key-confused, wrong-issuer, unsigned or ambiguous one) revokes nothing and still clears. It
 * throws identity-unavailable, clearing nothing, when Clerk is not configured or the revocation cannot be confirmed, and
 * invalid-session when the session is not owned by the token's subject: a session still live at Clerk is not reported
 * as ended.
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
			redirect: 'error',
		});
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (res.status === 404) return;
	if (!res.ok) throw contractError('identity-unavailable', true);
}

// Session states that need no revoke: Clerk has already ended the session.
const ENDED = new Set(['revoked', 'ended', 'expired', 'removed', 'abandoned', 'replaced']);

/**
 * Revokes the session a revoke-only token names, at that token's own instance with that instance's secret key, after the
 * instance's Backend API confirms the session belongs to the token's `sub` (GET /v1/sessions/{id}; the session's user_id
 * must equal it, else invalid-session and nothing is revoked). A session already gone (404) or ended is done; a failed or
 * unreadable lookup, or a failed revoke, is identity-unavailable.
 */
export async function revokeOwnedSession(a: { config: ClerkIdentityConfig; evidence: RevocationEvidence; fetcher?: typeof fetch }): Promise<void> {
	const { config, evidence } = a;
	let res: Response;
	try {
		res = await (a.fetcher ?? fetch)(`${config.apiUrl ?? CLERK_API}/v1/sessions/${encodeURIComponent(evidence.sessionId)}`, {
			method: 'GET',
			headers: { authorization: `Bearer ${evidence.instance.secretKey}` },
			redirect: 'error',
		});
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (res.status === 404) return;
	if (!res.ok) throw contractError('identity-unavailable', true);
	let session: { user_id?: unknown; status?: unknown };
	try {
		session = (await res.json()) as typeof session;
	} catch {
		throw contractError('identity-unavailable', true);
	}
	if (typeof session !== 'object' || session === null || typeof session.user_id !== 'string') throw contractError('identity-unavailable', true);
	if (session.user_id !== evidence.subject) throw contractError('invalid-session');
	if (typeof session.status === 'string' && ENDED.has(session.status)) return;
	await postRevoke({ config, instance: evidence.instance, sessionId: evidence.sessionId, fetcher: a.fetcher });
}
