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
// The SDK-free half (sign-in plan, return targets, cookie clears, sign-out) is flow.ts, which the hosted routes import
// directly (the hosted import allowlist keeps @clerk/backend out of routes); it is re-exported here.
// One browser session per origin: the client and staff instances share the cookie names `__session` and `__client_uat`
// on a client origin, so signing in as the other identity first signs the current one out, and an ambiguous credential
// is refused (planSignIn). Staff reach this origin only through the operator route (OPERATOR_PATH), never a third host.
import { createClerkClient } from '@clerk/backend';
import { readClerkIdentityConfig, type ClerkIdentityConfig, type InstanceKind } from './config.ts';
import { OPERATOR_PATH, cookiePairs, type ClerkBrowserHandshake, type HandshakeOutcome } from './flow.ts';
import { CLERK_COOKIE_NAME, inspectToken, presentedToken } from './session.ts';

const HANDSHAKE_PARAMS = ['__clerk_handshake', '__clerk_handshake_nonce', '__clerk_help', '__clerk_db_jwt'];
const TOKEN = /^[A-Za-z0-9._-]{16,8192}$/;

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

/** One handshake cookie directive, rewritten to what this origin accepts, or null when it must be refused. */
function sanitizeDirective(directive: string, secure: boolean): string | null {
	const [pair = '', ...attrs] = directive.split(';').map((s) => s.trim());
	const eq = pair.indexOf('=');
	if (eq < 1) return null;
	const name = pair.slice(0, eq), value = pair.slice(eq + 1);
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

export function createClerkBrowserHandshake(a: { config: ClerkIdentityConfig }): ClerkBrowserHandshake {
	const { config } = a;
	const secure = config.appOrigin.startsWith('https://');
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
			const kind = handshakeKind(request, config), instance = config[kind];
			const hasToken = url.searchParams.has('__clerk_handshake');
			// only the browser's own hints reach the SDK: no Authorization header, no forwarded host or proto
			const headers = new Headers();
			for (const h of ['accept', 'sec-fetch-dest']) if (request.headers.has(h)) headers.set(h, request.headers.get(h)!);
			const cookie = pairs.filter((c) => c.name !== '__clerk_handshake').map((c) => `${c.name}=${c.value}`).join('; ');
			if (cookie) headers.set('cookie', cookie);
			let state: Awaited<ReturnType<ReturnType<typeof createClerkClient>['authenticateRequest']>>;
			try {
				state = await clientFor(kind).authenticateRequest(new Request(url, { method: 'GET', headers }), {
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
				setCookies.push(clean);
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
				return { kind: 'redirect', location: to.href, setCookies };
			}
			if (hasToken) {
				if (setCookies.length === 0) return refuse(400, 'handshake-invalid');
				const clean = new URL(url);
				for (const p of HANDSHAKE_PARAMS) clean.searchParams.delete(p);
				if (state.status !== 'signed-in' && setCookies.some((c) => /^__session[A-Za-z0-9_]*=[^;]/.test(c))) return refuse(502, 'handshake-cookie-refused');
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
