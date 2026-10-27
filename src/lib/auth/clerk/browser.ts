// The first-party browser contract of the Clerk identity (GRS-113): what the hosting hook and the sign-in and sign-out
// routes call so a browser that signed in at Clerk ends up with a session cookie on THIS origin, and out of it again.
// Everything here is a function of a Request and the deployment config; nothing is wired into hooks, locals, CSP or
// wrangler (those belong to the coordinator), and nothing here has run against a real Clerk instance or browser.
//
// The handshake is @clerk/backend's own authenticateRequest, narrowed so it can do nothing else than hand back cookies:
//   - only the browser's cookie and document hints reach the SDK (no Authorization, no forwarded host headers), and the
//     request must be for this deployment's own origin;
//   - the SDK's nonce format is never used. A nonce is resolved with a Backend API call, which an anonymous caller could
//     repeat per request, so the redirect asks the Frontend API for a signed handshake token (verified with the instance's
//     configured key, no network) and an incoming nonce is refused;
//   - the redirect must go to the picked instance's own Frontend API handshake and come back to this origin;
//   - the cookies a verified handshake returns are an allowlist of Clerk's names with checked values, rewritten host-only
//     (no Domain), Path=/, SameSite=Lax, Secure on https and HttpOnly for the session; anything else refuses the request.
//     Clerk's refresh cookies are never set here under Clerk's names. The refresh token Clerk sets under the exact
//     suffixed name of the instance that signed a signed-in handshake (`__refresh_<suffix>`) is kept, with that session
//     token, only in the app's `__Host-` session hold of that instance (flow.ts SESSION_HOLD_COOKIE), on https. Neither
//     reaches the SDK: with a refresh token the SDK refreshes an expired session through the Backend API on each GET,
//     without it the SDK hands a document to the handshake (its no-refresh-cookie path), as before;
//   - a returning handshake belongs to the instance whose configured key verifies its signature, so a first staff sign-in
//     back on /cases is not resolved with the client key;
//   - a development staff handshake on an https origin lets the SDK read no dev browser but the one tied here (staffView):
//     not the client instance's, which shares the plain name, nor one planted in the URL, a suffixed cookie or a
//     parent-Domain cookie. One it starts carries a correlation (flow.ts startStaffHandshake): a `__Host-` cookie and the
//     same random id in the redirect_url. Only a return that proves it, from a start no untied URL value came with, ties
//     the dev browser to the staff instance, again in a `__Host-` cookie. A signature shows which instance signed a
//     handshake, not which browser asked for it. An http origin starts no correlation and ties nothing.
// A request that is not a document (a fetch, a form post, a `__data.json` load) never reaches the handshake, and this app
// runs no clerk-js, so nothing renews the 60-second session token between page loads. `refresh` renews it on the Worker
// instead (Clerk's `POST /v1/sessions/{sid}/refresh`, the call the SDK makes for a GET) for a request that passed the
// handshake, from the one session hold it carries: only when the held token is a genuine, expired, active token of the
// hold's instance (revocation.ts) and the request presents no other session token, with the held refresh token, at that
// instance's Backend API with its own secret key. The hold outlives the 60-second session cookie, which a browser drops.
// The answer must set a session token of the same instance, subject and session; anything else sets nothing and the
// request is refused as before. One call per presented credential per isolate, keyed by the deployment, the expired
// token AND the refresh token: a concurrent or repeated request shares the answer and a refused credential is remembered,
// but another refresh value is another credential, so it neither shares a success nor settles the right one as refused.
// The SDK-free half (sign-in plan, return targets, cookie clears, sign-out) is flow.ts, which the hosted routes import
// directly (the hosted import allowlist keeps @clerk/backend out of routes); it is re-exported here.
// One browser session per origin: the client and staff instances share the cookie names `__session` and `__client_uat`
// on a client origin, so signing in as the other identity first signs the current one out, and an ambiguous credential
// is refused (planSignIn). Staff reach this origin only through the operator route (OPERATOR_PATH), never a third host.
import { createClerkClient } from '@clerk/backend';
import { isSignInFlowPage, readClerkIdentityConfig, rsaJwkOf, type ClerkIdentityConfig, type InstanceKind } from './config.ts';
import {
	MAX_SESSION_LIFETIME_MS, OPERATOR_PATH, nextHoldName, REFRESH_TOKEN_VALUE, cookieDomains, cookieSuffix, ownedCookieNames, sessionClears, SESSION_HOLD_COOKIE, STAFF_DEV_BROWSER_TIE, STAFF_HANDSHAKE_CLEAR, STAFF_HANDSHAKE_COOKIE, STAFF_HANDSHAKE_PARAM, cookiePairs, sdkCookieHeader, sessionHoldClear,
	sessionHoldCookie, sessionHoldNames, sessionHoldOf, staffDevBrowserTie, staffHandshakeOf, startStaffHandshake, tiedDevBrowser,
	type ClerkBrowserHandshake, type HandshakeOutcome, type SessionHold, type SessionRefresh,
} from './flow.ts';
import { revocationEvidenceOf } from './revocation.ts';
import { CLERK_COOKIE_NAME, CLIENT_UAT_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME, inspectToken, presentedToken, sessionCookieNames } from './session.ts';

// A handshake this app starts for a page-data request it could not renew (handoff) carries REAUTH_PARAM in its return URL,
// and its return marks the browser with REAUTH_COOKIE for REAUTH_MAX_AGE seconds: a data request carrying the mark is not
// handed off again, so one handoff costs at most one handshake, and a hover preload of a data redirect marks nothing.
const REAUTH_PARAM = '__clearcase_reauth', REAUTH_COOKIE = '__Host-clearcase_reauth', REAUTH_MAX_AGE = 30;
const HANDSHAKE_PARAMS = ['__clerk_handshake', '__clerk_handshake_nonce', '__clerk_help', '__clerk_db_jwt', STAFF_HANDSHAKE_PARAM, REAUTH_PARAM];
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;
const DEV_BROWSER = /^[A-Za-z0-9._-]{16,4096}$/;
const DEV_BROWSER_COOKIE = /^__clerk_db_jwt(?:_[A-Za-z0-9_-]{1,32})?$/;
const MAX_CLEAR_PATHS = 32;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

function issuerOf(token: string): string | null {
	try {
		const b64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
		const payload: unknown = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
		const iss = typeof payload === 'object' && payload !== null ? (payload as { iss?: unknown }).iss : null;
		return typeof iss === 'string' ? iss : null;
	} catch {
		return null;
	}
}

/**
 * Which instance's handshake a request needs: staff on the operator route, or when the browser holds a session token
 * whose (unverified) issuer is the staff instance; the client instance otherwise. The pick only chooses between the two
 * configured instances; the SDK then verifies against that instance's key.
 */
export function handshakeKind(request: Request, config: ClerkIdentityConfig): InstanceKind {
	const path = new URL(request.url).pathname;
	if (path === OPERATOR_PATH || path.startsWith(`${OPERATOR_PATH}/`)) return 'staff';
	const token = presentedToken(request);
	return token !== null && token !== 'malformed' && issuerOf(token) === config.staff.issuer ? 'staff' : 'client';
}

/** Whether a sanitised directive sets a session cookie (plain or suffixed) to a non-empty value. */
const setsSession = (directive: string) => {
	const m = /^([^=;]+)=([^;]+)/.exec(directive);
	return m !== null && SESSION_COOKIE_NAME.test(m[1]!);
};

/** The one non-empty session token sanitised directives set, or null for none or several. */
function sessionTokenOf(directives: readonly string[]): string | null {
	const values = new Set(directives.filter(setsSession).map((d) => d.slice(d.indexOf('=') + 1).split(';')[0]!));
	return values.size === 1 ? [...values][0]! : null;
}

/** The refresh token Clerk's raw directives set under exactly `name` (the instance's suffixed name), or null. */
function clerkRefreshOf(directives: readonly unknown[], name: string): string | null {
	let value: string | null = null;
	for (const d of directives) {
		const pair = typeof d === 'string' ? d.split(';')[0]!.trim() : '';
		if (pair.slice(0, pair.indexOf('=')) === name) value = pair.slice(pair.indexOf('=') + 1);
	}
	return value !== null && REFRESH_TOKEN_VALUE.test(value) ? value : null;
}

/**
 * One handshake or refresh cookie directive, rewritten to what this origin accepts, 'drop' for a refresh token (never set
 * under Clerk's names: what renewal needs goes in the session hold), or null when it must be refused.
 */
function sanitizeDirective(directive: string, secure: boolean): string | 'drop' | null {
	const [pair = '', ...attrs] = directive.split(';').map((s) => s.trim());
	const eq = pair.indexOf('=');
	if (eq < 1) return null;
	const name = pair.slice(0, eq), value = pair.slice(eq + 1);
	if (REFRESH_COOKIE_NAME.test(name)) return 'drop';
	if (!CLERK_COOKIE_NAME.test(name)) return null;
	const session = name.startsWith('__session');
	if (session ? !(value === '' || (TOKEN.test(value) && inspectToken(value))) : name.startsWith('__client_uat') ? !/^\d{0,12}$/.test(value) : name.startsWith('__clerk_db_jwt') ? !/^[A-Za-z0-9._-]{0,4096}$/.test(value) : !/^\d{1,2}$/.test(value)) return null;
	let maxAge: string | null = null, expires: string | null = null;
	for (const a of attrs) {
		const age = /^max-age=(-?\d{1,10})$/i.exec(a);
		if (age) maxAge = age[1]!;
		const exp = /^expires=(.+)$/i.exec(a);
		if (exp && !Number.isNaN(Date.parse(exp[1]!))) expires = new Date(exp[1]!).toUTCString();
	}
	const out = [`${name}=${value}`, 'Path=/'];
	if (maxAge !== null) out.push(`Max-Age=${maxAge}`);
	if (expires !== null) out.push(`Expires=${expires}`);
	out.push('SameSite=Lax');
	if (!name.startsWith('__client_uat')) out.push('HttpOnly');
	if (secure) out.push('Secure');
	return out.join('; ');
}

/** The payload of a token inspectToken accepted. */
const tokenClaims = (token: string) => JSON.parse(new TextDecoder().decode(fromB64url(token.split('.')[1]!))) as Record<string, unknown>;
// What this isolate learned about one presented refresh credential: the answer (shared by concurrent and repeated
// requests until the new token expires) or Clerk's refusal (never retried); a fault is forgotten once it settles. Keyed
// by the SHA-256 of the deployment (origin and Backend API), the issuer, the expired token and the refresh token, so only
// a request holding both the token and its refresh token meets an entry; bounded, so dropping one only costs a call.
// `session` and `uat` are Clerk's directives for those cookies without their name: refresh() sets them under the names
// this browser keeps, never the ones Clerk answered with, and the hold under the name the request's hold does not use.
// 'refused' is Clerk's own refusal of the refresh token (spent, wrong or revoked), remembered like null; 'limited' is its
// rate limit, remembered too, which says nothing about the credential.
type Refreshed = { token: string; session: string; uat: string | null; hold: SessionHold; setCookies: string[]; until: number };
const refreshes = new Map<string, Promise<Refreshed | null | 'refused' | 'limited' | 'fault'>>();
const REFRESHES_LIMIT = 4096;
// The expired tokens this isolate renewed, keyed like `refreshes` without the refresh token: a browser may already hold
// that renewal, so a refusal of the same token with another refresh token clears nothing (review H1 sets nothing).
const renewed = new Set<string>();
/**
 * The directives that expire every copy of the plain `__clerk_db_jwt` a browser can send with a request for `url`:
 * host-only, and with each Domain from the host up to its two-label parent, at each Path that path-matches the URL's path
 * (RFC 6265 5.1.4), each bare and with a trailing slash: up to MAX_CLEAR_PATHS, a safety cap above any app route, and none
 * that could end the attribute. A Domain on a hosting public suffix (`workers.dev`) is one browsers refuse, so it is not
 * emitted: the preview URL on a sandbox `*.workers.dev` host takes 3 Domains x 10 paths = 30 directives. A sibling origin
 * under the same parent domain can plant one with Domain=<parent> or a narrower Path beside this origin's host-only cookie, and
 * a repeated cookie never ties (flow.ts tiedDevBrowser), so a clear at Path=/ alone would leave the staff handshake
 * starting again on every return (carryover review, finding 3).
 */
function devBrowserClears(url: URL): string[] {
	const path = url.pathname, paths = new Set(['/']);
	for (let i = 1; i <= path.length; i++) if (i === path.length || path[i] === '/') paths.add(path.slice(0, i)).add(path.slice(0, i + 1));
	const safe = [...paths].filter((p) => !/[;\u0000-\u0020\u007f]/.test(p)).slice(0, MAX_CLEAR_PATHS);
	return cookieDomains(url).flatMap((d) => safe.map((p) => `__clerk_db_jwt=; ${d === null ? '' : `Domain=${d}; `}Path=${p}; Max-Age=0; SameSite=Lax; Secure`));
}
export function createClerkBrowserHandshake(a: { config: ClerkIdentityConfig }): ClerkBrowserHandshake {
	const { config } = a;
	const secure = config.appOrigin.startsWith('https://'), staffDevelopment = config.staff.publishableKey.startsWith('pk_test_');
	const clients = new Map<InstanceKind, ReturnType<typeof createClerkClient>>();
	const clientFor = (kind: InstanceKind) => {
		let c = clients.get(kind);
		if (!c) {
			const i = config[kind];
			c = createClerkClient({ secretKey: i.secretKey, publishableKey: i.publishableKey, jwtKey: i.jwtKey, apiUrl: config.apiUrl ?? undefined, telemetry: { disabled: true } });
			clients.set(kind, c);
		}
		return c;
	};
	const refuse = (status: 400 | 502, code: Extract<HandshakeOutcome, { kind: 'refuse' }>['code']): HandshakeOutcome => ({ kind: 'refuse', status, code });
	const keys = new Map<InstanceKind, Promise<CryptoKey | null>>();
	const keyFor = (kind: InstanceKind) => {
		let k = keys.get(kind);
		if (!k) keys.set(kind, (k = crypto.subtle.importKey('jwk', rsaJwkOf(config[kind].jwtKey), RS256, false, ['verify']).catch(() => null)));
		return k;
	};
	/** The one configured instance whose key verifies a handshake token's signature (local crypto only), or null. */
	const signerOf = async (token: string): Promise<InstanceKind | null> => {
		const parts = token.split('.');
		if (!TOKEN.test(token) || parts.length !== 3) return null;
		let signature: Uint8Array<ArrayBuffer>;
		try {
			signature = fromB64url(parts[2]!);
		} catch {
			return null;
		}
		const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		const signers: InstanceKind[] = [];
		for (const kind of ['client', 'staff'] as const) {
			const key = await keyFor(kind);
			if (key && (await crypto.subtle.verify(RS256, key, signature, data).catch(() => false))) signers.push(kind);
		}
		return signers.length === 1 ? signers[0]! : null;
	};
	/**
	 * The URL and Cookie header a development staff handshake on an https origin hands the SDK: every dev browser the SDK
	 * reads (the `__clerk_db_jwt` query value, else the plain or suffixed `__clerk_db_jwt` cookie it picks) is the one tied
	 * here (flow.ts tiedDevBrowser), or there is none and the SDK asks the staff Frontend API for a fresh one. Anything else
	 * may be the client instance's, which shares the plain name, or planted, in a link or by a sibling origin's
	 * parent-Domain cookie, and the Frontend API answers for whichever dev browser it is handed. The staff portal's own
	 * return carries the tied value in its URL and keeps it. `vouched`: no untied URL value came with this request, so the
	 * dev browser a correlated return of a handshake it starts sets may be tied; a crafted link's attempt ties nothing,
	 * and the next clean GET starts one that does. `clears`: an untied plain cookie is expired wherever this request could
	 * have it from (devBrowserClears) by the handshake it starts, whose return sets the one host-only cookie the tie needs.
	 */
	const staffView = async (request: Request, url: URL) => {
		const tied = (await tiedDevBrowser(request, config))?.value ?? null;
		const clears = tied === null && cookiePairs(request).some((c) => c.name === '__clerk_db_jwt') ? devBrowserClears(url) : [];
		const sdkUrl = new URL(url), vouched = sdkUrl.searchParams.getAll('__clerk_db_jwt').every((v) => v === tied);
		if (!vouched) sdkUrl.searchParams.delete('__clerk_db_jwt');
		const pairs: string[] = [], named = new Set<string>();
		for (const pair of sdkCookieHeader(request).split('; ')) {
			const name = pair.slice(0, pair.indexOf('='));
			if (!DEV_BROWSER_COOKIE.test(name)) pairs.push(pair);
			else if (tied !== null && !named.has(name)) pairs.push(`${name}=${tied}`), named.add(name);
		}
		return { url: sdkUrl, cookie: pairs.filter((p) => p !== '').join('; '), vouched, clears };
	};

	const suffixes = new Map<InstanceKind, Promise<string>>();
	const refreshNameOf = async (kind: InstanceKind) => {
		let sfx = suffixes.get(kind);
		if (!sfx) suffixes.set(kind, (sfx = cookieSuffix(config[kind].publishableKey)));
		return `__refresh_${await sfx}`;
	};
	// the session and uat names this deployment owns (flow.ts ownedCookieNames); no other is ever cleared or written
	const ownedNames = (base: '__session' | '__client_uat') => ownedCookieNames(config, base);

	/**
	 * Clerk's answer to one refresh: only a session token of the same instance, subject and session, live now, in
	 * directives this origin accepts (the instance's own refresh token included). 'refused' for Clerk's refusal of the
	 * credential, 'limited' for its rate limit (429), null for an answer this origin refuses, all remembered; 'fault' for
	 * an outage or network fault, which is not.
	 */
	async function refreshAt(a: SessionHold & { suffixed: boolean; subject: string; sessionId: string; userAgent: string | null }): Promise<Refreshed | null | 'refused' | 'limited' | 'fault'> {
		let cookies: unknown;
		try {
			cookies = (await clientFor(a.kind).sessions.refreshSession(a.sessionId, {
				format: 'cookie', suffixed_cookies: a.suffixed, expired_token: a.token, refresh_token: a.refreshToken, request_origin: config.appOrigin,
				// only the browser's own agent: never its cookies or forwarded headers
				request_headers: a.userAgent === null ? {} : { 'user-agent': [a.userAgent] },
			})).cookies;
		} catch (e) {
			// Clerk's own refusal (4xx) settles this token; an outage or a network fault does not. A rate limit says nothing
			// about the credential, so it is no refusal of it.
			const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
			return typeof status === 'number' && status >= 400 && status < 500 ? (status === 429 ? 'limited' : 'refused') : 'fault';
		}
		if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > 16) return null;
		const setCookies: string[] = [];
		let token: string | null = null, session = '', uat: string | null = null;
		for (const d of cookies) {
			const clean = typeof d === 'string' ? sanitizeDirective(d, secure) : null;
			if (clean === null) return null;
			if (clean === 'drop') continue;
			const name = clean.slice(0, clean.indexOf('=')), value = clean.slice(name.length + 1).split(';')[0]!;
			// a renewal signs nothing out: a session or uat clear in it is dropped, and the rest is readdressed by refresh()
			if (SESSION_COOKIE_NAME.test(name)) {
				if (value === '') continue;
				if (token !== null && token !== value) return null;
				token = value, session = clean.slice(name.length);
			} else if (CLIENT_UAT_COOKIE_NAME.test(name)) {
				if (value !== '') uat = clean.slice(name.length);
			} else setCookies.push(clean);
		}
		if (token === null) return null;
		const evidence = await revocationEvidenceOf(token, config).catch(() => null);
		const exp = tokenClaims(token).exp as number;
		if (!evidence || evidence.instance !== config[a.kind] || evidence.subject !== a.subject || evidence.sessionId !== a.sessionId || exp * 1000 <= Date.now()) return null;
		// the hold moves on to the new token, with the refresh token Clerk rotated to, if it did. A refresh token renews once,
		// and Clerk's refresh answer names the new one plain `__refresh` (its Backend API reference), not the suffixed name its
		// handshake uses: this is the answer of this instance's own Backend API to its secret key, so either name is this
		// instance's, the suffixed one first as the SDK reads it. Keeping the spent token refused the next renewal
		// (session-renewal-live-3).
		const refreshToken = clerkRefreshOf(cookies, await refreshNameOf(a.kind)) ?? clerkRefreshOf(cookies, '__refresh') ?? a.refreshToken;
		// with no new refresh token (live Clerk answers none, astra-renewal-7614) the hold is spent (SessionHold)
		const hold = { kind: a.kind, token, refreshToken, ...(refreshToken === a.refreshToken ? { spent: true } : {}) };
		return { token, session, uat, hold, setCookies, until: exp * 1000 };
	}
	/**
	 * The session-hold directives of a handshake answer: the hold of the session it signs in when given (https only), and
	 * a clear for every other hold the request carries, so no hold outlives the session it was set beside.
	 */
	async function holdDirectives(request: Request, next: { kind: InstanceKind; token: string | null; refreshToken: string | null } | null): Promise<string[]> {
		let set: string | null = null;
		if (secure && next?.token && next.refreshToken) {
			const evidence = await revocationEvidenceOf(next.token, config).catch(() => null);
			if (evidence?.instance === config[next.kind]) set = sessionHoldCookie({ kind: next.kind, token: next.token, refreshToken: next.refreshToken }, tokenClaims(next.token).exp as number);
		}
		const kept = set === null ? null : SESSION_HOLD_COOKIE[next!.kind];
		return [...(set === null ? [] : [set]), ...sessionHoldNames(request).filter((n) => n !== kept).map(sessionHoldClear)];
	}

	const api: ClerkBrowserHandshake = {
		async refresh(request) {
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return null;
			}
			if (!secure || url.origin !== config.appOrigin || isSignInFlowPage(url.pathname) || request.headers.has('authorization')) return null;
			// the one hold, beside no session token or the very token it holds: a request presenting another is never renewed
			const hold = sessionHoldOf(request), presented = presentedToken(request);
			if (hold === null || presented === 'malformed' || (presented !== null && presented !== hold.token)) return null;
			const { token, kind } = hold;
			// Time only refuses: a token expired longer ago than any Clerk session lives names a session Clerk has ended, so it
			// is never renewed and costs no Backend API call. Revocation (revocation.ts) has no such bound; sign-out revokes once.
			let claims: Record<string, unknown>;
			try {
				claims = tokenClaims(token);
			} catch {
				return null;
			}
			const { exp, sts } = claims;
			if (typeof exp !== 'number' || exp * 1000 > Date.now() || exp * 1000 + MAX_SESSION_LIFETIME_MS < Date.now() || (sts !== undefined && sts !== 'active')) return null;
			const evidence = await revocationEvidenceOf(token, config);
			if (!evidence || evidence.instance !== config[kind]) return null;
			const pairs = cookiePairs(request);
			const digest = async (parts: string[]) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('\0')))));
			const expired = [config.appOrigin, config.apiUrl ?? '', evidence.instance.issuer, token];
			const key = await digest([...expired, hold.refreshToken]), tokenKey = await digest(expired);
			let answer = refreshes.get(key);
			if (!answer) {
				answer = refreshAt({ ...hold, suffixed: pairs.some((c) => SESSION_COOKIE_NAME.test(c.name) && c.name !== '__session'), subject: evidence.subject, sessionId: evidence.sessionId, userAgent: request.headers.get('user-agent') });
				refreshes.delete(key);
				if (refreshes.size >= REFRESHES_LIMIT) refreshes.delete(refreshes.keys().next().value!);
				refreshes.set(key, answer);
			}
			const refreshed = await answer;
			// Clerk could not be asked: the request is answered as it is, and is never handed to the handshake (handoff)
			if (refreshed === 'fault' || refreshed === 'limited') {
				if (refreshed === 'fault' && refreshes.get(key) === answer) refreshes.delete(key);
				return { setCookies: [], outage: true };
			}
			if (refreshed !== null && refreshed !== 'refused' && refreshed.until <= Date.now()) {
				if (refreshes.get(key) === answer) refreshes.delete(key);
				return null;
			}
			if (refreshed === null) return null;
			// Clerk refused this hold's refresh token, which then renews nothing again, here or in another isolate: the hold
			// goes, under the one name this request sent it, and nothing else does (an expired `__session` authenticates
			// nothing, and a document load still meets the handshake). A sibling isolate that won the same token has moved the
			// hold to the other name (nextHoldName), so this clear never reaches it. Unless this isolate renewed the same
			// expired token with another refresh token: then this browser may hold that renewal, and nothing is cleared.
			if (refreshed === 'refused') return renewed.has(tokenKey) ? null : { setCookies: [sessionHoldClear(hold.name)] };
			renewed.delete(tokenKey);
			if (renewed.size >= REFRESHES_LIMIT) renewed.delete(renewed.values().next().value!);
			renewed.add(tokenKey);
			// the credential the provider verifies: the request's own cookies with the new session token in every session cookie,
			// or in `__session` when the browser has already dropped it
			const cookie = [...pairs.map((c) => `${c.name}=${SESSION_COOKIE_NAME.test(c.name) ? refreshed.token : c.value}`), ...(presented === null ? [`__session=${refreshed.token}`] : [])].join('; ');
			// and the same names in the browser. Clerk answers a renewal under `__session_<suffix>` even when asked for plain
			// names, while the handshake keeps the browser on `__session`: a second, different session token is ambiguous and
			// refused on every request, and the next handshake re-sets only its own name (session-renewal-live-2).
			// Only the names this deployment owns, and each at every scope it can have: the old copy goes before the new one is
			// set, so no name is left twice (review M1 and M2).
			const carried = async (base: '__session' | '__client_uat') => { const owned = await ownedNames(base); return [...new Set(pairs.map((c) => c.name).filter((n) => owned.has(n)))]; };
			const sessions = await carried('__session'), uats = await carried('__client_uat');
			const readdressed = [
				...(sessions.length ? sessions : ['__session']).flatMap((n) => [...sessionClears(n, url, secure), `${n}${refreshed.session}`]),
				...(refreshed.uat === null ? [] : (uats.length ? uats : ['__client_uat']).map((n) => `${n}${refreshed.uat}`)),
			];
			// the hold moves to its other name and leaves this one (nextHoldName)
			const next = nextHoldName(hold.name), holdSet = sessionHoldCookie(refreshed.hold, refreshed.until / 1000, next);
			return { credential: new Request(url, { headers: { cookie } }), setCookies: [...readdressed, ...refreshed.setCookies, sessionHoldClear(hold.name), ...(holdSet === null ? [] : [holdSet])], ...(refreshed.hold.spent ? { spent: true as const } : {}) };
		},
		async handle(request) {
			let url: URL;
			try {
				url = new URL(request.url);
			} catch {
				return refuse(400, 'wrong-origin');
			}
			if (url.origin !== config.appOrigin) return refuse(400, 'wrong-origin');
			if (request.method !== 'GET' && request.method !== 'HEAD') return { kind: 'continue' };
			const pairs = cookiePairs(request);
			if (url.searchParams.has('__clerk_handshake_nonce') || pairs.some((c) => c.name === '__clerk_handshake_nonce')) return refuse(400, 'handshake-format-unsupported');
			const hasToken = url.searchParams.has('__clerk_handshake');
			const path = url.pathname, operator = path === OPERATOR_PATH || path.startsWith(`${OPERATOR_PATH}/`);
			const kind = (!operator && hasToken ? await signerOf(url.searchParams.get('__clerk_handshake')!) : null) ?? handshakeKind(request, config), instance = config[kind];
			// only the browser's own hints reach the SDK: no Authorization header, no forwarded host or proto
			const headers = new Headers();
			for (const h of ['accept', 'sec-fetch-dest']) if (request.headers.has(h)) headers.set(h, request.headers.get(h)!);
			// A development staff handshake on an https origin sees no dev browser it cannot tie (staffView). With the client
			// instance's the SDK answered signed out and started no handshake, the operator POST handed the staff portal no dev
			// browser, and the portal fell back to its own, signed in for another origin (Astra auth matrix, 27 Oct, finding 2).
			const view = kind === 'staff' && staffDevelopment && secure ? await staffView(request, url) : { url, cookie: sdkCookieHeader(request), vouched: false, clears: [] };
			if (view.cookie) headers.set('cookie', view.cookie);
			let state: Awaited<ReturnType<ReturnType<typeof createClerkClient>['authenticateRequest']>>;
			try {
				state = await clientFor(kind).authenticateRequest(new Request(view.url, { method: 'GET', headers }), {
					publishableKey: instance.publishableKey, secretKey: instance.secretKey, jwtKey: instance.jwtKey, authorizedParties: [config.appOrigin],
					...(config.audience !== null ? { audience: config.audience } : {}),
				});
			} catch {
				return refuse(400, 'handshake-invalid');
			}
			const setCookies: string[] = [], ownedSessions = await ownedNames('__session');
			for (const d of state.headers.getSetCookie()) {
				const clean = sanitizeDirective(d, secure);
				if (clean === null) return refuse(502, 'handshake-cookie-refused');
				// a session cookie name this deployment does not own is never written, even from a verified payload (review L2)
				const name = clean === 'drop' ? '' : clean.slice(0, clean.indexOf('='));
				if (clean !== 'drop' && (!SESSION_COOKIE_NAME.test(name) || ownedSessions.has(name))) setCookies.push(clean);
			}
			if (state.status === 'handshake') {
				if (hasToken) return refuse(400, 'handshake-invalid'); // a handshake token that did not resolve is never retried
				let to: URL, back: URL;
				try {
					to = new URL(state.headers.get('location') ?? '');
					back = new URL(to.searchParams.get('redirect_url') ?? '');
				} catch {
					return refuse(502, 'handshake-invalid');
				}
				if (to.origin !== instance.issuer || to.pathname !== '/v1/client/handshake' || back.origin !== config.appOrigin) return refuse(502, 'handshake-invalid');
				to.searchParams.delete('format');
				if (kind === 'staff' && staffDevelopment) {
					setCookies.unshift(...view.clears);
					const started = await startStaffHandshake(config, view.vouched);
					if (started !== null) {
						back.searchParams.set(STAFF_HANDSHAKE_PARAM, started.id);
						to.searchParams.set('redirect_url', back.href);
						setCookies.push(started.setCookie);
					}
				}
				return { kind: 'redirect', location: to.href, setCookies };
			}
			if (hasToken) {
				if (setCookies.length === 0) return refuse(400, 'handshake-invalid');
				const clean = new URL(url);
				for (const p of HANDSHAKE_PARAMS) clean.searchParams.delete(p);
				if (state.status !== 'signed-in' && setCookies.some(setsSession)) return refuse(502, 'handshake-cookie-refused');
				// A session cookie the browser carries beside the ones this handshake sets would make its credential ambiguous, so
				// each owned one it carries goes, at every scope, before the handshake's own are set: a browser a renewal left with
				// `__session_<suffix>` beside `__session` is signed in again here. Another instance's name is left alone (M2).
				if (setCookies.some((c) => SESSION_COOKIE_NAME.test(c.slice(0, c.indexOf('='))))) {
					const owned = await ownedNames('__session');
					setCookies.unshift(...sessionCookieNames(request).filter((n) => owned.has(n)).flatMap((n) => sessionClears(n, url, secure)));
				}
				// a dev browser that a token only the staff key verifies set, on the return of a staff handshake this browser
				// started with no untied URL value (staffView), is tied to the staff instance (flow.ts tiedDevBrowser)
				const devBrowser = setCookies.findLast((c) => c.startsWith('__clerk_db_jwt='));
				const value = devBrowser === undefined ? '' : devBrowser.slice('__clerk_db_jwt='.length).split(';')[0]!;
				const correlated = kind === 'staff' ? await staffHandshakeOf(request, config) : null;
				if (pairs.some((c) => c.name === STAFF_HANDSHAKE_COOKIE)) setCookies.push(STAFF_HANDSHAKE_CLEAR);
				if (correlated?.vouched && DEV_BROWSER.test(value) && (await signerOf(url.searchParams.get('__clerk_handshake')!)) === 'staff')
					setCookies.push(devBrowser!.replace(/^__clerk_db_jwt=[^;]*/, `${STAFF_DEV_BROWSER_TIE}=${await staffDevBrowserTie(config, value)}`));
				// what a later refresh needs is held only from a verified handshake that signs this browser in, for its instance
				const signedIn = state.status === 'signed-in' ? sessionTokenOf(setCookies) : null;
				setCookies.push(...(await holdDirectives(request, signedIn === null ? null : { kind, token: signedIn, refreshToken: clerkRefreshOf(state.headers.getSetCookie(), await refreshNameOf(kind)) })));
				// the return of a handoff's handshake marks the browser, so it is not handed off again for a while (REAUTH_COOKIE)
				if (secure && url.searchParams.has(REAUTH_PARAM)) setCookies.push(`${REAUTH_COOKIE}=1; Path=/; Max-Age=${REAUTH_MAX_AGE}; SameSite=Lax; HttpOnly; Secure`);
				return { kind: 'redirect', location: clean.href, setCookies };
			}
			// a signed-in page load whose hold a renewal spent goes through the handshake for a fresh refresh token (handoff)
			if (state.status === 'signed-in' && request.headers.get('sec-fetch-dest') === 'document' && sessionHoldOf(request)?.spent) {
				const handed = await api.handoff(request, url);
				if (handed) return { kind: 'redirect', location: handed.location, setCookies: handed.setCookies };
			}
			return { kind: 'continue' };
		},
		/**
		 * A page-data request (Kit's `__data.json`) cannot meet the handshake, which only a document load can follow, so a
		 * client-side navigation whose expired session was not renewed (the refresh token was refused or spent, or there is
		 * none: live Clerk renews once per refresh token and its answer carries no new one, astra-renewal-7614) would say
		 * "Your session has ended" while Clerk's own session lives. Instead it is handed the handshake a full load of its page
		 * starts: the hosted handle answers it with a data redirect there, which Kit follows as a full page load because it
		 * is another origin, and the handshake's return mints a fresh session and refresh token, back on the page. Only for a
		 * genuine expired token of a configured instance, the one the request presents or, with none, the one its hold
		 * keeps: no session, an ambiguous one (refused, as everywhere) or a live token is left to the identity; and never
		 * twice within REAUTH_MAX_AGE of a handoff's return. If the handshake signs the browser out, its return clears the
		 * session, so the page is session-ended and nothing is handed off after it.
		 */
		async handoff(request, page) {
			if (!secure || page.origin !== config.appOrigin || isSignInFlowPage(page.pathname) || page.pathname === '/sign-out' || request.headers.has('authorization')) return null;
			if (cookiePairs(request).some((c) => c.name === REAUTH_COOKIE)) return null;
			const presented = presentedToken(request);
			if (presented === 'malformed') return null;
			const hold = sessionHoldOf(request), token = presented ?? hold?.token ?? null;
			if (token === null || !(await revocationEvidenceOf(token, config).catch(() => null))) return null;
			// a live session only when its hold is spent: the handshake is asked without it, so it starts one (round 4b)
			const live = (tokenClaims(token).exp as number) * 1000 > Date.now();
			if (live && !(hold?.spent && hold.token === token)) return null;
			const doc = new URL(page);
			doc.searchParams.set(REAUTH_PARAM, '1');
			const headers = new Headers({ 'sec-fetch-dest': 'document', accept: 'text/html' });
			const cookie = live ? cookiePairs(request).filter((c) => !SESSION_COOKIE_NAME.test(c.name)).map((c) => `${c.name}=${c.value}`).join('; ') : request.headers.get('cookie');
			if (cookie) headers.set('cookie', cookie);
			const started = await api.handle(new Request(doc, { method: 'GET', headers }));
			// only a handshake start, at the instance's Frontend API, is a handoff
			return started.kind === 'redirect' && new URL(started.location).origin !== config.appOrigin ? { location: started.location, setCookies: started.setCookies } : null;
		},
	};
	return api;
}

export function clerkBrowserHandshakeFromEnv(env: Readonly<Record<string, unknown>>): { ok: true; handshake: ClerkBrowserHandshake; config: ClerkIdentityConfig } | { ok: false; reason: string } {
	const read = readClerkIdentityConfig(env);
	return read.ok ? { ok: true, handshake: createClerkBrowserHandshake({ config: read.config }), config: read.config } : read;
}


export * from './flow.ts';
