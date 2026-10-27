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
//     Clerk's refresh token (`__refresh_<suffix>`) is never stored and a presented one never reaches the SDK: with it the
//     SDK refreshes an expired session through the Backend API on each request, without it the SDK hands the browser to
//     the handshake (its no-refresh-cookie path), as before;
//   - a returning handshake belongs to the instance whose configured key verifies its signature, so a first staff sign-in
//     back on /cases is not resolved with the client key;
//   - a development staff handshake on an https origin lets the SDK read no dev browser but the one tied here (staffView):
//     not the client instance's, which shares the plain name, nor one planted in the URL, a suffixed cookie or a
//     parent-Domain cookie. One it starts carries a correlation (flow.ts startStaffHandshake): a `__Host-` cookie and the
//     same random id in the redirect_url. Only a return that proves it, from a start no untied URL value came with, ties
//     the dev browser to the staff instance, again in a `__Host-` cookie. A signature shows which instance signed a
//     handshake, not which browser asked for it. An http origin starts no correlation and ties nothing.
// The SDK-free half (sign-in plan, return targets, cookie clears, sign-out) is flow.ts, which the hosted routes import
// directly (the hosted import allowlist keeps @clerk/backend out of routes); it is re-exported here.
// One browser session per origin: the client and staff instances share the cookie names `__session` and `__client_uat`
// on a client origin, so signing in as the other identity first signs the current one out, and an ambiguous credential
// is refused (planSignIn). Staff reach this origin only through the operator route (OPERATOR_PATH), never a third host.
import { createClerkClient } from '@clerk/backend';
import { readClerkIdentityConfig, rsaJwkOf, type ClerkIdentityConfig, type InstanceKind } from './config.ts';
import {
	OPERATOR_PATH, STAFF_DEV_BROWSER_TIE, STAFF_HANDSHAKE_CLEAR, STAFF_HANDSHAKE_COOKIE, STAFF_HANDSHAKE_PARAM, cookiePairs, sdkCookieHeader, staffDevBrowserTie, staffHandshakeOf, startStaffHandshake, tiedDevBrowser,
	type ClerkBrowserHandshake, type HandshakeOutcome,
} from './flow.ts';
import { CLERK_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME, inspectToken, presentedToken } from './session.ts';

const HANDSHAKE_PARAMS = ['__clerk_handshake', '__clerk_handshake_nonce', '__clerk_help', '__clerk_db_jwt', STAFF_HANDSHAKE_PARAM];
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;
const DEV_BROWSER = /^[A-Za-z0-9._-]{16,4096}$/;
const DEV_BROWSER_COOKIE = /^__clerk_db_jwt(?:_[A-Za-z0-9_-]{1,32})?$/;
const MAX_CLEAR_PATHS = 32;
// Hosting suffixes browsers refuse as a Domain, so a clear for one would never match a cookie.
const PUBLIC_SUFFIXES = new Set(['workers.dev', 'pages.dev']);
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
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

/** One handshake cookie directive, rewritten to what this origin accepts, 'drop' for the refresh token, or null when it must be refused. */
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
	const labels = url.hostname.split('.'), path = url.pathname, paths = new Set(['/']);
	for (let i = 1; i <= path.length; i++) if (i === path.length || path[i] === '/') paths.add(path.slice(0, i)).add(path.slice(0, i + 1));
	const domains = [null, ...(labels.length > 1 ? labels.slice(0, -1).map((_, i) => labels.slice(i).join('.')).filter((d) => !PUBLIC_SUFFIXES.has(d)) : [])];
	const safe = [...paths].filter((p) => !/[;\u0000-\u0020\u007f]/.test(p)).slice(0, MAX_CLEAR_PATHS);
	return domains.flatMap((d) => safe.map((p) => `__clerk_db_jwt=; ${d === null ? '' : `Domain=${d}; `}Path=${p}; Max-Age=0; SameSite=Lax; Secure`));
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

	return {
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
			const setCookies: string[] = [];
			for (const d of state.headers.getSetCookie()) {
				const clean = sanitizeDirective(d, secure);
				if (clean === null) return refuse(502, 'handshake-cookie-refused');
				if (clean !== 'drop') setCookies.push(clean);
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
				// a dev browser that a token only the staff key verifies set, on the return of a staff handshake this browser
				// started with no untied URL value (staffView), is tied to the staff instance (flow.ts tiedDevBrowser)
				const devBrowser = setCookies.findLast((c) => c.startsWith('__clerk_db_jwt='));
				const value = devBrowser === undefined ? '' : devBrowser.slice('__clerk_db_jwt='.length).split(';')[0]!;
				const correlated = kind === 'staff' ? await staffHandshakeOf(request, config) : null;
				if (pairs.some((c) => c.name === STAFF_HANDSHAKE_COOKIE)) setCookies.push(STAFF_HANDSHAKE_CLEAR);
				if (correlated?.vouched && DEV_BROWSER.test(value) && (await signerOf(url.searchParams.get('__clerk_handshake')!)) === 'staff')
					setCookies.push(devBrowser!.replace(/^__clerk_db_jwt=[^;]*/, `${STAFF_DEV_BROWSER_TIE}=${await staffDevBrowserTie(config, value)}`));
				return { kind: 'redirect', location: clean.href, setCookies };
			}
			return { kind: 'continue' };
		},
	};
}

export function clerkBrowserHandshakeFromEnv(env: Readonly<Record<string, unknown>>): { ok: true; handshake: ClerkBrowserHandshake; config: ClerkIdentityConfig } | { ok: false; reason: string } {
	const read = readClerkIdentityConfig(env);
	return read.ok ? { ok: true, handshake: createClerkBrowserHandshake({ config: read.config }), config: read.config } : read;
}


export * from './flow.ts';
