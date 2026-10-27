// The SDK-free half of the first-party browser contract (GRS-113): the sign-in identity switch, return-target allowlist,
// cookie clears and sign-out, as pure functions of a Request, the deployment config and fetch. The hosted routes import
// this module (the hosted import allowlist keeps @clerk/backend out of routes); the handshake and the session refresh,
// which need the SDK, are browser.ts, which re-exports this. Nothing here is wired into hooks, locals, CSP or wrangler, and nothing has run
// against a real Clerk instance or browser.
import type { Identity, Principal, SessionId } from '../../server/runtime/contracts.ts';
import { contractError } from '../../server/runtime/errors.ts';
import { isSignInFlowPage, readClerkIdentityConfig, type ClerkIdentityConfig, type ClerkInstanceConfig, type InstanceKind, type StaffDevBrowser } from './config.ts';
import { revocationEvidenceOf, type RevocationEvidence } from './revocation.ts';
import { CLEARABLE_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME, cookiePairs, inspectToken, presentedToken } from './session.ts';

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
/**
 * A refresh outcome for one request: a renewed session (the credential the provider verifies in place of the request's,
 * and the cookies to set), or, with no credential, only cookies to set on the request as it is (a refused renewal's
 * clear of its spent hold). `outage`: Clerk could not be asked (an outage, a network fault or its rate limit), so the
 * request is answered as it is and never handed to the handshake. `spent`: the renewal left the hold spent (SessionHold).
 */
export interface SessionRefresh { credential?: Request; setCookies: string[]; outage?: true; spent?: true }
/** A page-data request handed to a full page load through Clerk's handshake: where to send the browser, and the cookies to set. */
export interface SessionHandoff { location: string; setCookies: string[] }
export interface ClerkBrowserHandshake {
	handle(request: Request): Promise<HandshakeOutcome>;
	/** The request's expired session renewed at its instance (browser.ts), or null to treat the request as it is. */
	refresh(request: Request): Promise<SessionRefresh | null>;
	/**
	 * For a page-data request whose expired session was not renewed: the handshake a full load of `page` starts (browser.ts),
	 * or null when there is none to start.
	 */
	handoff(request: Request, page: URL): Promise<SessionHandoff | null>;
}

/**
 * The Cookie header the SDK may see: the request's cookies as `cookiePairs` read them, without the handshake cookie (a
 * handshake is only ever taken from the query, verified here) and without Clerk's refresh token (with it the SDK would
 * refresh an expired session through the Backend API on each request). Exact names, not a prefix.
 */
export function sdkCookieHeader(request: Request): string {
	return cookiePairs(request).filter((c) => c.name !== '__clerk_handshake' && !REFRESH_COOKIE_NAME.test(c.name) && !HOLD_NAMES.has(c.name)).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** The longest a Clerk session lives, 7 days: a session hold outlives its token by this, and no longer. */
export const MAX_SESSION_LIFETIME_MS = 7 * 86_400_000;
/**
 * The app-owned cookie that keeps what a session refresh needs (browser.ts refresh) after the browser drops the session
 * token's 60-second cookie: the last session token this app set and the instance's refresh token, as `<token>~<refresh>`,
 * HttpOnly, one name per instance kind. It is a `__Host-` cookie, so only this secure origin can set it and a sibling
 * under the parent domain can neither plant nor shadow it; Clerk's own `__refresh` names are never read. An http origin
 * holds none. It lives until its token has been expired for MAX_SESSION_LIFETIME_MS: by then Clerk has ended the session,
 * so the hold could renew nothing (the refresh refuses an older token before any Backend API call). It never authenticates: the
 * provider reads only `__session`, and a refresh must still succeed at Clerk.
 */
export const SESSION_HOLD_COOKIE: Readonly<Record<InstanceKind, string>> = { client: '__Host-clearcase_refresh', staff: '__Host-clearcase_staff_refresh' };
/**
 * Each kind's hold has two names, the handshake's (SESSION_HOLD_COOKIE) and its alternate, and a renewal moves the hold
 * to the other one. A Clerk refresh token renews once, so of two isolates renewing one hold at once, one is refused; it
 * clears the name it was sent, which the winner has already left, so the winner's hold survives in either arrival order
 * (session-renewal-live-3 fix 1).
 */
const HOLD_SLOTS: Readonly<Record<InstanceKind, readonly [string, string]>> = {
	client: [SESSION_HOLD_COOKIE.client, `${SESSION_HOLD_COOKIE.client}_2`],
	staff: [SESSION_HOLD_COOKIE.staff, `${SESSION_HOLD_COOKIE.staff}_2`],
};
const HOLD_KIND: ReadonlyMap<string, InstanceKind> = new Map((Object.entries(HOLD_SLOTS) as Array<[InstanceKind, readonly string[]]>).flatMap(([kind, names]) => names.map((n) => [n, kind] as const)));
const HOLD_NAMES: ReadonlySet<string> = new Set(HOLD_KIND.keys());
/** The other name of a hold's kind: where a renewal of the hold under `name` sets the next one. */
export const nextHoldName = (name: string) => { const [first, second] = HOLD_SLOTS[HOLD_KIND.get(name)!]; return name === first ? second : first; };
/**
 * A Clerk refresh token value: any RFC 6265 cookie-octet, which is all a value Clerk sets as a cookie can hold and all the
 * hold can carry back. Its format is Clerk's: the live development handshake of 27 October set letters, digits and `:`,
 * which a narrower class refused, so no hold was set and no session renewed (session-renewal-live).
 */
export const REFRESH_TOKEN_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{16,4096}$/;
const HOLD_TOKEN = /^[A-Za-z0-9._-]{16,8192}$/, COOKIE_MAX_BYTES = 4096;
/**
 * `spent`: a renewal used its refresh token and Clerk answered no new one (live Clerk never does, and a refresh token
 * renews once), so it renews nothing again; the hold keeps it so the next GET goes through the handshake (browser.ts
 * handoff), whose return holds a fresh one. Its value starts with `~`, which no session token does.
 */
export interface SessionHold { kind: InstanceKind; token: string; refreshToken: string; spent?: boolean }
/** A hold a request carries, with the name it carries it under. */
export interface CarriedHold extends SessionHold { name: string }

/** The one session hold a request carries, or null when it carries none, more than one, or one that does not parse. */
export function sessionHoldOf(request: Request): CarriedHold | null {
	const holds = cookiePairs(request).filter((c) => HOLD_NAMES.has(c.name));
	if (holds.length !== 1) return null;
	const { name } = holds[0]!, spent = holds[0]!.value.startsWith('~'), value = spent ? holds[0]!.value.slice(1) : holds[0]!.value, sep = value.indexOf('~');
	const token = value.slice(0, sep), refreshToken = value.slice(sep + 1);
	if (sep < 0 || !HOLD_TOKEN.test(token) || !inspectToken(token) || !REFRESH_TOKEN_VALUE.test(refreshToken)) return null;
	return { kind: HOLD_KIND.get(name)!, token, refreshToken, name, ...(spent ? { spent } : {}) };
}
/**
 * The directive that sets a hold for a token expiring at `exp` (seconds), under `name` (the kind's handshake name by
 * default), or null when it is already useless or too big.
 */
export function sessionHoldCookie(hold: SessionHold, exp: number, name = SESSION_HOLD_COOKIE[hold.kind]): string | null {
	const maxAge = Math.floor((exp * 1000 + MAX_SESSION_LIFETIME_MS - Date.now()) / 1000), pair = `${name}=${hold.spent ? '~' : ''}${hold.token}~${hold.refreshToken}`;
	return maxAge > 0 && pair.length <= COOKIE_MAX_BYTES ? `${pair}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly; Secure` : null;
}
/** The directive that deletes a hold. */
export const sessionHoldClear = (name: string) => `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
/** The hold cookie names a request carries. */
export const sessionHoldNames = (request: Request) => [...new Set(cookiePairs(request).map((c) => c.name).filter((n) => HOLD_NAMES.has(n)))];

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

// Public suffixes above this app's origins, which browsers refuse as a Domain, so a clear for one would never match a cookie.
const PUBLIC_SUFFIXES = new Set(['workers.dev', 'pages.dev', 'co.za']);
/** Clerk's cookie suffix for an instance (@clerk/shared getCookieSuffix): base64url SHA-1 of its publishable key, 8 characters. */
export async function cookieSuffix(publishableKey: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(publishableKey)));
	return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 8);
}
/**
 * Every scope a cookie this origin receives can have a Domain at: host-only (null), the host, and each parent up to the
 * registrable domain. No public suffix is listed: browsers refuse one as a Domain. `workers.dev` is on the public suffix
 * list, so no cookie is ever scoped to it, but that makes the account subdomain (`<account>.workers.dev`) registrable,
 * and every Worker of the account, both sandboxes included, sits under it and can scope a cookie to it. On a custom
 * domain (`sbx-a.clearcase.co.za`) the registrable parent is `clearcase.co.za`.
 */
export function cookieDomains(url: URL): (string | null)[] {
	const labels = url.hostname.split('.');
	return [null, ...(labels.length > 1 ? labels.slice(0, -1).map((_, i) => labels.slice(i).join('.')).filter((d) => !PUBLIC_SUFFIXES.has(d)) : [])];
}
/**
 * The directives that expire the session cookie `name` at every scope this app or Clerk sets one at: host-only and each
 * cookieDomains Domain, at Path=/. Every session directive the Worker sets is rewritten to Path=/ (sanitizeDirective), and
 * Clerk's handshake and refresh answers set Path=/ (each one captured live on 27 October). The server never sees a
 * received cookie's scope, so a copy at another Path, which only a planted cookie has, is not reached: it stays beside
 * the others and the request stays refused as ambiguous (session.ts presentedToken), never resolved by picking one.
 */
export const sessionClears = (name: string, url: URL, secure: boolean) =>
	cookieDomains(url).map((d) => `${name}=; ${d === null ? '' : `Domain=${d}; `}Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`);

/**
 * The names of `base` this deployment owns: the plain name and its suffixed form for each configured instance. Only these
 * are ever cleared or written for a browser: a suffix of any other instance is not this app's to touch (review M2).
 */
export async function ownedCookieNames(config: ClerkIdentityConfig, base: '__session' | '__client_uat'): Promise<Set<string>> {
	return new Set([base, ...(await Promise.all((['client', 'staff'] as const).map(async (k) => `${base}_${await cookieSuffix(config[k].publishableKey)}`)))]);
}
/**
 * What sign-out clears beyond the host-only cookies it names, and what it may not: every owned session name at each
 * cookieDomains Domain (Path=/), the scopes the handshake clears, so no live copy a sibling or an earlier answer left on a
 * parent domain authorises the browser once the host-only one is gone (re-check M3); and the session cookie names it
 * carries that this deployment does not own, which it never clears, so sign-out must not report success beside them.
 */
export function signOutScopes(a: { env: Readonly<Record<string, unknown>>; request: Request; url: URL }): Promise<{ parents: Array<{ name: string; domain: string }>; unowned: string[] }> {
	// with no Clerk configured no Clerk token authenticates here, so no copy anywhere can sign the browser back in
	const read = readClerkIdentityConfig(a.env);
	if (!read.ok) return Promise.resolve({ parents: [], unowned: [] });
	return ownedCookieNames(read.config, '__session').then((owned) => ({
		parents: [...owned].flatMap((name) => cookieDomains(a.url).filter((d) => d !== null).map((domain) => ({ name, domain }))),
		unowned: [...new Set(cookiePairs(a.request).map((c) => c.name).filter((n) => SESSION_COOKIE_NAME.test(n) && !owned.has(n)))],
	}));
}

/** The cookie directives that delete exactly the session cookies a request carries (host-only, as they were set). */
export function clerkCookieClears(request: Request, secure: boolean): string[] {
	return clearableNames(request).map((name) => `${name}=; Path=/; Max-Age=0${name.startsWith('__client_uat') ? '' : '; HttpOnly'}; SameSite=Lax${secure || HOLD_NAMES.has(name) ? '; Secure' : ''}`);
}
/** The names of the session cookies a request carries, Clerk's and this app's session holds, in order of appearance. */
export function clearableNames(request: Request): string[] {
	return [...new Set(cookiePairs(request).map((c) => c.name).filter((n) => CLEARABLE_COOKIE_NAME.test(n) || HOLD_NAMES.has(n)))];
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
 * The return targets of the sign-ins in flight, one `__Host-` cookie per attempt. Clerk sees one fixed callback per
 * origin and flow (config.ts clerkSignInTarget), because an instance that allows only exact redirect URLs sends any
 * other one to its home URL, so the sign-in POST keeps the target here and the callback reads it. Each POST sets its own
 * cookie, the flow's prefix and a random attempt id, so two POSTs in flight at once never write the same cookie and
 * neither answer drops the other's attempt (a read-modify-write of one shared cookie cannot be made race-free). Its
 * value is the target (base64url), its issue time and an HMAC-SHA-256 under the flow's own instance secret key over
 * this app, client, instance, flow and attempt id, so a value from another origin, client, flow or attempt counts as
 * none. A sibling origin cannot plant a `__Host-` cookie; a plain http origin cannot hold one, so its sign-ins return to
 * DEFAULT_RETURN.
 *
 * Two tabs of one browser share the cookies and come back to the same callback with the same cookies, so a callback
 * cannot tell which attempt is its own. It never guesses: a document navigation follows one fresh attempt, but
 * several are all cleared and land on the flow's safe home with a plain notice. Data requests, preloads and fetches
 * change no cookies. Deletion consumes a browser hint, not a credential: replay remains possible until its expiry.
 */
export const SIGN_IN_RETURN_PREFIX: Readonly<Record<InstanceKind, string>> = { client: '__Host-clearcase_return-', staff: '__Host-clearcase_staff_return-' };
/** How long a sign-in may take at the portal before its return target lapses, in seconds. */
export const SIGN_IN_RETURN_TTL = 900;
/** How many sign-ins of one flow may be in flight in one browser; a further one evicts the oldest. */
export const SIGN_IN_RETURN_LIMIT = 4;
/**
 * Seconds a multi-tab marker outlives the clear that wrote it, beyond SIGN_IN_RETURN_TTL. Responses can reach the browser
 * out of order and the last marker written wins, so an earlier clear's late response must not shorten the protection a
 * later clear gave. Every attempt that later clear saw lapses by its own time plus 60 seconds of accepted clock skew plus
 * the TTL; dating the marker from the clearing time covers it while the late response is at most MARKER_SLACK - 60
 * seconds behind. Cloudflare closes a response after about 100 seconds, well inside this.
 */
const MARKER_SLACK = 600;
/**
 * A callback that clears attempts it does not follow leaves the flow's marker: its expiry, under a MAC like an
 * attempt's, is the clearing time plus SIGN_IN_RETURN_TTL plus MARKER_SLACK. A cleared tab's callback still to come
 * cannot tell its own attempt is gone, so while the marker is valid every callback that finds an attempt clears them all
 * and lands home, and none takes a later tab's attempt for its own. Nothing deletes it: the browser drops it at its
 * max-age, and an invalid or expired one is ignored, because a late response's delete would erase a newer clear's marker.
 */
const SIGN_IN_RETURN_MARKER: Readonly<Record<InstanceKind, string>> = { client: '__Host-clearcase_multi_tab', staff: '__Host-clearcase_staff_multi_tab' };
// A browser holds a cookie of up to 4096 bytes, name included. One flow's attempts together stay within
// RETURN_STATE_MAX bytes of Cookie header less the marker's MARKER_BYTES, oldest evicted first; POSTs that overlap may
// each add one before the next request bounds them again. At most RETURN_SCAN of a flow's cookies are read.
// RETURN_MAX_BYTES keeps two sequential attempts and the marker together: a staff attempt is 52 bytes of name, 55 of
// issue time and MAC, 3 of separators and the target as base64url, so 2 × (110 + ⌈1300 × 4/3⌉) + 91 = 3779 ≤ 3800.
const RETURN_LABEL = 'clearcase sign-in return v2', MARKER_LABEL = 'clearcase sign-in multi-tab v1';
const RETURN_MAX_BYTES = 1300, RETURN_STATE_MAX = 3800, RETURN_SCAN = 2 * SIGN_IN_RETURN_LIMIT;
const MARKER_BYTES = Math.max(...Object.values(SIGN_IN_RETURN_MARKER).map((n) => n.length)) + 3 + 12 + 1 + 43;
const RETURN_ID = /^[A-Za-z0-9_-]{22}$/;
const RETURN_STATE = /^([A-Za-z0-9_-]{2,2731})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const MARKER_STATE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const returnParts = (config: ClerkIdentityConfig, kind: InstanceKind, id: string, issued: string, to: string) => [kind, config[kind].issuer, id, issued, to];
const markerParts = (config: ClerkIdentityConfig, kind: InstanceKind, expires: string) => [kind, config[kind].issuer, expires];
const returnOptions = { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SIGN_IN_RETURN_TTL } as const;
type ReturnCookieOptions = Omit<typeof returnOptions, 'maxAge'> & { maxAge: number };
type Attempt = { name: string; id: string; to: string; issued: number; bytes: number };
/** The cookies a route changes for the return targets: at most one cookie to set (an attempt or the marker), and those to delete. */
export type SignInReturnChange = { set: { name: string; value: string; options: ReturnCookieOptions } | null; delete: string[] };

/** A new attempt's cookie for a target exactly as given (signInReturnCookie validates it first), or null on an http origin. */
export async function sealSignInReturn(config: ClerkIdentityConfig, kind: InstanceKind, returnTo: string): Promise<{ name: string; value: string } | null> {
	if (!hostCookies(config)) return null;
	const id = b64url(crypto.getRandomValues(new Uint8Array(16))), issued = String(Math.floor(Date.now() / 1000));
	const mac = await macOf(RETURN_LABEL, config, returnParts(config, kind, id, issued, returnTo), config[kind]);
	return { name: `${SIGN_IN_RETURN_PREFIX[kind]}${id}`, value: `${b64url(new TextEncoder().encode(returnTo))}.${issued}.${mac}` };
}
/**
 * The target one attempt carries for this flow, or null: issued for this app, client, instance, flow and attempt id
 * within SIGN_IN_RETURN_TTL, under a MAC that verifies, naming a target signInReturnTarget keeps unchanged.
 */
async function openSignInReturn(config: ClerkIdentityConfig, kind: InstanceKind, id: string, value: string): Promise<{ to: string; issued: number } | null> {
	const m = RETURN_STATE.exec(value);
	if (!RETURN_ID.test(id) || !m) return null;
	const issued = Number(m[2]), age = Math.floor(Date.now() / 1000) - issued;
	if (age < -60 || age > SIGN_IN_RETURN_TTL) return null;
	let to: string;
	try {
		to = new TextDecoder('utf-8', { fatal: true }).decode(fromB64url(m[1]!));
	} catch {
		return null;
	}
	if (!(await macVerifies(RETURN_LABEL, config, returnParts(config, kind, id, m[2]!, to), m[3]!, config[kind]))) return null;
	return signInReturnTarget(to) === to ? { to, issued } : null;
}
/**
 * This flow's attempts in `request`, oldest first. When a POST is `adding`, bound the retained attempts plus the new
 * one by SIGN_IN_RETURN_LIMIT and RETURN_STATE_MAX. Names to delete: each cookie openSignInReturn refuses or repeats,
 * those for the target being added, and the oldest valid ones beyond the bounds. None on an http origin.
 */
async function signInAttempts(config: ClerkIdentityConfig, request: Request, kind: InstanceKind, adding?: { to: string; bytes: number }): Promise<{ attempts: Attempt[]; drop: string[] }> {
	if (!hostCookies(config)) return { attempts: [], drop: [] };
	const prefix = SIGN_IN_RETURN_PREFIX[kind], pairs = cookiePairs(request).filter((c) => c.name.startsWith(prefix));
	const attempts: Attempt[] = [], drop: string[] = [];
	for (const name of [...new Set(pairs.map((c) => c.name))].slice(0, RETURN_SCAN)) {
		const values = pairs.filter((c) => c.name === name), id = name.slice(prefix.length);
		const opened = values.length === 1 ? await openSignInReturn(config, kind, id, values[0]!.value) : null;
		if (opened && opened.to !== adding?.to) attempts.push({ name, id, ...opened, bytes: name.length + values[0]!.value.length + 3 });
		else drop.push(name);
	}
	attempts.sort((a, b) => a.issued - b.issued || (a.name < b.name ? -1 : 1));
	const count = () => attempts.length + (adding ? 1 : 0), bytes = () => attempts.reduce((n, a) => n + a.bytes, adding?.bytes ?? 0);
	// Bound writes, not callback classification: evicting here on a read could turn two attempts into a false singleton.
	while (adding && attempts.length && (count() > SIGN_IN_RETURN_LIMIT || bytes() > RETURN_STATE_MAX - MARKER_BYTES)) drop.push(attempts.shift()!.name);
	return { attempts, drop };
}
/** This flow's marker in `request`: its expiry when exactly one verifies and has not passed, and whether any is present. */
async function multiTabMarker(config: ClerkIdentityConfig, request: Request, kind: InstanceKind): Promise<{ expires: number | null; present: boolean }> {
	const values = cookiePairs(request).filter((c) => c.name === SIGN_IN_RETURN_MARKER[kind]);
	const m = values.length === 1 ? MARKER_STATE.exec(values[0]!.value) : null;
	if (!m) return { expires: null, present: values.length > 0 };
	const expires = Number(m[1]), left = expires - Math.floor(Date.now() / 1000);
	const valid = left >= 0 && left <= SIGN_IN_RETURN_TTL + MARKER_SLACK + 60 && (await macVerifies(MARKER_LABEL, config, markerParts(config, kind, m[1]!), m[2]!, config[kind]));
	return { expires: valid ? expires : null, present: true };
}
async function sealMultiTabMarker(config: ClerkIdentityConfig, kind: InstanceKind, expires: number): Promise<NonNullable<SignInReturnChange['set']>> {
	const mac = await macOf(MARKER_LABEL, config, markerParts(config, kind, String(expires)), config[kind]);
	const maxAge = Math.max(1, expires - Math.floor(Date.now() / 1000));
	return { name: SIGN_IN_RETURN_MARKER[kind], value: `${expires}.${mac}`, options: { ...returnOptions, maxAge } };
}
/** A callback may consume return hints only on a real document GET, never on Kit's unmarked data preloads. */
const documentNavigation = (request: Request, url: URL, isDataRequest: boolean) => request.method === 'GET'
	&& !isDataRequest && ![url.pathname, new URL(request.url).pathname].some((p) => /\/__data\.json\/?$/.test(p))
	&& !['sec-purpose', 'purpose'].some((h) => /\b(prefetch|preload|prerender)\b/i.test(request.headers.get(h) ?? ''))
	&& (!request.headers.has('sec-fetch-mode') || request.headers.get('sec-fetch-mode') === 'navigate');
/**
 * The cookies a sign-in POST changes: a new attempt for the asked `returnTo`, validated by signInReturnTarget (a target
 * too long for a cookie is DEFAULT_RETURN), and deletes for this flow's refused attempts, those for the same target and
 * the oldest beyond the bounds. Null when Clerk is not configured or on an http origin.
 */
export async function signInReturnCookie(env: Readonly<Record<string, unknown>>, kind: InstanceKind, returnTo: unknown, request: Request): Promise<SignInReturnChange | null> {
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	if (!read.ok) return null;
	const target = signInReturnTarget(returnTo), to = new TextEncoder().encode(target).length <= RETURN_MAX_BYTES ? target : DEFAULT_RETURN;
	const sealed = await sealSignInReturn(read.config, kind, to);
	if (sealed === null) return null;
	const { drop } = await signInAttempts(read.config, request, kind, { to, bytes: sealed.name.length + sealed.value.length + 3 });
	return { set: { ...sealed, options: returnOptions }, delete: drop };
}
/** Safe home for either flow on this per-client Worker; the query carries only a fixed, non-sensitive notice. */
export const MULTI_TAB_RETURN = `${DEFAULT_RETURN}?signIn=multiple-tabs`;
/**
 * A verified callback consumes only on document navigation. One valid, fresh attempt goes to its signed target;
 * several, or any under a valid marker, clear every cookie for this flow and land home, never on another tab's target,
 * and leave the marker (SIGN_IN_RETURN_MARKER) past any attempt they could have seen. No chooser or consumed-id
 * store exists. With none, retain the explicit safe returnTo fallback or DEFAULT_RETURN.
 */
export async function signInReturn(env: Readonly<Record<string, unknown>>, request: Request, url: URL, kind: InstanceKind, isDataRequest = false): Promise<{ location: string; change: SignInReturnChange }> {
	const fallback = url.searchParams.has('returnTo') ? signInReturnTarget(url.searchParams.get('returnTo')) : DEFAULT_RETURN;
	if (!documentNavigation(request, url, isDataRequest)) return { location: fallback, change: { set: null, delete: [] } };
	const read = readClerkIdentityConfig(env, { keys: 'optional' });
	if (!read.ok || !hostCookies(read.config)) return { location: fallback, change: { set: null, delete: [] } };
	const names = [...new Set(cookiePairs(request).filter((c) => c.name.startsWith(SIGN_IN_RETURN_PREFIX[kind])).map((c) => c.name))];
	const { attempts } = await signInAttempts(read.config, request, kind), marker = await multiTabMarker(read.config, request, kind);
	// Beyond the validation cap we cannot establish a singleton; fail safely and clear even the unscanned names.
	const multiple = attempts.length > 1 || names.length > RETURN_SCAN || (marker.expires !== null && attempts.length > 0);
	if (!multiple) return { location: attempts[0]?.to ?? fallback, change: { set: null, delete: names } };
	if (!attempts.length) return { location: MULTI_TAB_RETURN, change: { set: null, delete: names } };
	const expires = Math.max(marker.expires ?? 0, Math.floor(Date.now() / 1000) + SIGN_IN_RETURN_TTL + MARKER_SLACK);
	return { location: MULTI_TAB_RETURN, change: { set: await sealMultiTabMarker(read.config, kind, expires), delete: names } };
}
/** Applies a SignInReturnChange to a route's cookies. */
export function applySignInReturnChange(cookies: { set(name: string, value: string, options: ReturnCookieOptions): void; delete(name: string, options: { path: string; secure: boolean }): void }, change: SignInReturnChange): void {
	for (const name of new Set(change.delete)) cookies.delete(name, { path: '/', secure: true });
	if (change.set) cookies.set(change.set.name, change.set.value, change.set.options);
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
 * pending), with the config it was checked against; null for no credential, an ambiguous one, or anything that is not a
 * genuine token of a pinned instance. Throws identity-unavailable when a token-shaped credential cannot be checked
 * because Clerk is not configured: whether a live session exists is then unknown.
 */
async function expiredSessionEvidence(a: { env: Readonly<Record<string, unknown>>; request: Request }): Promise<(RevocationEvidence & { config: ClerkIdentityConfig }) | null> {
	// a browser drops the session cookie a minute after it is set; the token this app last set is then in the session hold
	const presented = presentedToken(a.request), token = presented === null ? (sessionHoldOf(a.request)?.token ?? null) : presented;
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
 * Anything else (no credential, a forged, key-confused, wrong-issuer, unsigned or ambiguous one) revokes nothing and
 * still clears. It throws identity-unavailable, clearing nothing, when Clerk is not configured or the revocation cannot
 * be confirmed, and invalid-session when the session is not owned by the token's subject: a session still live at Clerk
 * is not reported as ended.
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

// What this isolate recently learned from Clerk about a revoke-only session, so a replayed token causes no further
// Backend API call: 'done' (gone, ended, or revoked here) or 'not-owner' (the token's subject does not own it), each kept
// for SETTLED_TTL_MS only, never for good. The key is the signed issuer, subject and session, which only a genuine token
// of that session names, so no caller can settle or occupy another user's entry. A failure is never remembered. A session
// being looked up is busy for at most BUSY_MS (a request the runtime cancels mid-lookup never reaches its `finally`), and
// a concurrent request for it is identity-unavailable (retry) rather than a second lookup. Both maps are bounded; dropping
// an entry only costs one more lookup.
const settledSessions = new Map<string, { outcome: 'done' | 'not-owner'; at: number }>(), busySessions = new Map<string, number>();
const SESSIONS_LIMIT = 4096, BUSY_MS = 30_000;
// No Clerk promise that an ended session stays ended is relied on, so a remembered answer is trusted briefly: 10 minutes
// caps a replaying token at one lookup and one revoke per session per window, and caps how long a session Clerk
// reactivated after this isolate settled it can be reported signed out without asking Clerk again.
export const SETTLED_TTL_MS = 10 * 60_000;
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
 * subject per isolate within SETTLED_TTL_MS: a settled answer is reused until then, and a concurrent duplicate is
 * identity-unavailable. `now` is the clock, injectable for tests.
 */
export async function revokeOwnedSession(a: { config: ClerkIdentityConfig; evidence: RevocationEvidence; fetcher?: typeof fetch; now?: () => number }): Promise<void> {
	const { config, evidence } = a;
	const key = [config.apiUrl ?? CLERK_API, evidence.instance.issuer, evidence.subject, evidence.sessionId].join('\0');
	const now = a.now?.() ?? Date.now();
	const settled = settledSessions.get(key);
	if (settled && now - settled.at < SETTLED_TTL_MS) {
		if (settled.outcome === 'not-owner') throw contractError('invalid-session');
		return;
	}
	settledSessions.delete(key);
	if (now - (busySessions.get(key) ?? -Infinity) < BUSY_MS) throw contractError('identity-unavailable', true);
	remember(busySessions, key, now);
	let outcome: 'done' | 'not-owner';
	try {
		outcome = await lookUpAndRevoke(a);
	} finally {
		if (busySessions.get(key) === now) busySessions.delete(key);
	}
	remember(settledSessions, key, { outcome, at: now });
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
