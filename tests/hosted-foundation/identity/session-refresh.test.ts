// A signed-in user whose short-lived Clerk session token expired between page loads (Astra journeys A and B, 27 Oct:
// Save note answered 401 and "The note was not saved"; a reload recovered through the document handshake). Clerk session
// tokens live 60 seconds and this app runs no clerk-js, so nothing refreshes `__session` in the browser: only a document
// GET reaches the handshake, and every fetch, form post and `__data.json` request after the first minute is refused.
// These drive the REAL hosted hook (hooks.server.ts, with the real provider and services) over an expired token, and
// pin what must not change: the exact-Origin refusal, tenant isolation, sign-out clears and the document handshake.
// SYNTHETIC keys, hosts and tokens; a loopback Backend API stands in for Clerk. Unit evidence for our adapter only: no
// real Clerk, browser, cookie jar or workerd has run.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const trap = vi.hoisted(() => {
	const blocked: string[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
		if (url.hostname !== '127.0.0.1') {
			blocked.push(url.href);
			throw new TypeError(`outbound fetch blocked by the test: ${url.origin}`);
		}
		return real(input, init);
	}) as typeof fetch;
	return { blocked };
});
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown>, waitUntil: () => {} }));
vi.mock('cloudflare:workers', () => workers);

import { MAX_SESSION_LIFETIME_MS } from '../../../src/lib/auth/clerk/flow.ts';
import { clerkBrowserHandshakeFromEnv } from '../../../src/lib/auth/clerk/browser.ts';
import { presentedToken } from '../../../src/lib/auth/clerk/session.ts';
import { handle } from '../../../src/lib/server/runtime/hosted/hooks.server.ts';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; BrowserJar below types the part used here.
import { CookieJar } from 'jsdom';
import { craftedInstance } from './synthetic.ts';

const signOut = await import('../../../deploy/client/routes/sign-out/+page.server.ts');
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('client-c.clerk.test');
const suffix = (pk: string) => createHash('sha1').update(pk).digest('base64url').slice(0, 8);
const REFRESH_A = `__refresh_${suffix(A.publishableKey)}`;
// the app-owned cookies that hold what renewal needs, one per instance kind
const HOLD_A = '__Host-clearcase_refresh', HOLD_B = '__Host-clearcase_staff_refresh';
// a standard-base64 value, the class a real development handshake returned (browser-session.test.ts)
const RT = 'Zm9v+YmFy/YmF6cXV4+cXV1eA/c3ludGhldGljLXJlZnJlc2g=';
const STALE = () => Date.now() - 120_000; // issued two minutes ago: expired one minute ago

// Clerk's Backend API on loopback: the session lookup, and the session refresh (POST /v1/sessions/:id/refresh), which
// answers new cookies only for the refresh token this double issued for that session and an expired token of it.
type Call = { method: string; path: string; body: Record<string, unknown> | null; bearer: string };
let server: Server, api = '';
const calls: Call[] = [];
const sessions = new Map<string, { status: string; user_id: string; instance: typeof A; refresh: string }>();
let refreshAnswer: ((sid: string) => { status: number; body: unknown } | null) | null = null;
beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
			calls.push({ method: req.method ?? '', path: url.pathname, body, bearer: String(req.headers.authorization ?? '').replace(/^Bearer /, '') });
			const send = (status: number, payload: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(payload)));
			const refresh = /^\/v1\/sessions\/([^/]+)\/refresh$/.exec(url.pathname);
			if (refresh && req.method === 'POST') {
				const sid = refresh[1]!, row = sessions.get(sid), forced = refreshAnswer?.(sid);
				if (forced) return send(forced.status, forced.body);
				const expired = typeof body?.expired_token === 'string' ? JSON.parse(Buffer.from(body.expired_token.split('.')[1]!, 'base64url').toString()) : null;
				if (!row || row.status !== 'active' || body?.refresh_token !== row.refresh || expired?.sid !== sid || calls.at(-1)!.bearer !== row.instance.secretKey)
					return send(401, { errors: [{ code: 'authentication_invalid', message: 'synthetic refresh refused' }] });
				const token = row.instance.token({ sub: row.user_id, sid, azp: ORIGIN });
				const s = url.searchParams.get('suffixed_cookies') === 'true' ? `_${suffix(row.instance.publishableKey)}` : '';
				return send(200, { object: 'cookies', cookies: [`__session${s}=${token}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`, `__client_uat${s}=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure`] });
			}
			const m = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
			const row = m && req.method === 'GET' ? sessions.get(m[1]!) : undefined;
			if (!row) return send(404, { errors: [{ code: 'resource_not_found', message: 'not found' }] });
			send(200, { object: 'session', id: m![1], status: row.status, user_id: row.user_id, client_id: 'client_synthetic', last_active_at: 0, expire_at: 0, abandon_at: 0, created_at: 0, updated_at: 0 });
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	workers.env = {
		CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
		CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
		CLERK_STAFF_SIGN_IN_URL: 'https://staff-b.clerk.test/sign-in', CLERK_API_URL: api,
	};
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
let n = 0;
// every test gets its own sessions, so an isolate-scoped memo of one test never answers another
const session = (instance = A, status = 'active') => {
	const sid = `sess_r${++n}`, user = `user_r${n}`;
	sessions.set(sid, { status, user_id: user, instance, refresh: `${RT}${n}` });
	const stale = instance.token({ sub: user, sid, azp: ORIGIN, now: STALE() });
	return { sid, user, refresh: `${RT}${n}`, stale: () => stale };
};
beforeEach(() => {
	calls.length = 0;
	trap.blocked.length = 0;
	refreshAnswer = null;
});

const NOTES = '/cases/case-a/originals/asset-1/notes';
// The route's own identity gate, as notes-route.ts meets it: a verified identity writes (201), anyone else is refused (401).
const route = vi.fn(async (event: { locals: { identity: { kind: string; checkRevocation(): Promise<void> } } }) => {
	const identity = event.locals.identity;
	if (identity.kind !== 'verified') return new Response('Your session has ended. Sign in again.', { status: 401 });
	await identity.checkRevocation();
	return new Response(JSON.stringify({ note: {} }), { status: 201, headers: { 'content-type': 'application/json' } });
});
async function invoke(request: Request) {
	const event = { request, url: new URL(request.url), locals: {} as Record<string, unknown>, isSubRequest: false };
	return handle({ event, resolve: route } as unknown as Parameters<typeof handle>[0]);
}
const saveNote = (cookie: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${NOTES}`, {
	method: 'POST', body: JSON.stringify({ page: 1, body: 'synthetic note', operationId: 'note-1' }),
	headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', cookie, ...headers },
});
const dataRequest = (cookie: string) => new Request(`${ORIGIN}/operator/cases/case-a/preview/cand-1/__data.json?q=JN-001&x-sveltekit-invalidated=01`, { headers: { 'sec-fetch-dest': 'empty', accept: '*/*', cookie } });
const documentGet = (path: string, cookie: string) => new Request(`${ORIGIN}${path}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html', cookie } });
// What a browser holds for renewal beside its expired session token: the app's session hold, the token and its refresh token.
const hold = (token: string, refresh: string, name = HOLD_A) => `${name}=${token}~${refresh}`;
const held = (s: ReturnType<typeof session>, refresh = s.refresh) => hold(s.stale(), refresh);
const jar = (s: ReturnType<typeof session>, refresh = s.refresh) => `__client_uat=1761400000; __session=${s.stale()}; ${held(s, refresh)}`;
const refreshCalls = () => calls.filter((c) => c.path.endsWith('/refresh'));
// the session cookie a response sets (a renewal also expires the old copy at each scope first)
const sessionCookie = (r: Response) => r.headers.getSetCookie().find((c) => /^__session=[^;]/.test(c));

describe('a signed-in user whose session token expired between page loads', () => {
	it('saves the note: the Worker refreshes the session with the refresh token the handshake stored, and the write succeeds', async () => {
		const s = session();
		const r = await invoke(saveNote(jar(s)));
		expect(r.status).toBe(201);
		const set = sessionCookie(r);
		expect(set).toMatch(/^__session=[^;]+; Path=\/; Max-Age=60; SameSite=Lax; HttpOnly; Secure$/);
		// no cookie is set with Clerk's Domain: a Domain appears only on the clears of the old copy's other scopes
		expect(r.headers.getSetCookie().filter((c) => /^[^=]+=[^;]/.test(c)).join('\n')).not.toMatch(/Domain=/i);
		expect(r.headers.getSetCookie().filter((c) => /Domain=/i.test(c)).every((c) => /^__session=; Domain=[^;]+; Path=\/; Max-Age=0;/.test(c))).toBe(true);
		expect(refreshCalls()).toHaveLength(1);
		expect(refreshCalls()[0]).toMatchObject({ path: `/v1/sessions/${s.sid}/refresh`, bearer: A.secretKey, body: { refresh_token: s.refresh, request_origin: ORIGIN, format: 'cookie' } });
		expect(trap.blocked).toEqual([]);
		// the hold moves on to the refreshed token, under the other name of its kind (session-renewal-live-3 fix 1), spent:
		// this double answers no new refresh token (round 4b)
		const token = set!.split(';')[0]!.slice('__session='.length);
		expect(r.headers.getSetCookie().find((c) => c.startsWith(`${HOLD_A}_2=`))).toMatch(new RegExp(`^${HOLD_A}_2=~${token}~${s.refresh.replace(/[+/=]/g, '\\$&')}; Path=/; Max-Age=\\d+; SameSite=Lax; HttpOnly; Secure$`));
		expect(r.headers.getSetCookie()).toContain(`${HOLD_A}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`);
		// the refreshed cookie alone is a verified session at this origin
		const again = await invoke(saveNote(`__client_uat=1761400000; ${set!.split(';')[0]}`));
		expect(again.status).toBe(201);
		expect(refreshCalls()).toHaveLength(1);
	});
	it('answers a filtered search (a __data.json request) for the operator, not "your session has ended"', async () => {
		const s = session(B);
		const r = await invoke(dataRequest(`__client_uat=1761400000; __session=${s.stale()}; ${hold(s.stale(), s.refresh, HOLD_B)}`));
		// renewed, and with no new refresh token (spent) handed to the staff handshake for one (round 4b)
		expect((await dataRedirect(r))?.origin).toBe(B.iss);
		expect(sessionCookie(r)).toBeDefined();
		expect(refreshCalls()).toHaveLength(1);
		expect(refreshCalls()[0]!.bearer).toBe(B.secretKey);
	});
	it('holds the refresh token a handshake returns with its session token, in the __Host- hold of the instance that signed it', async () => {
		const s = session();
		const fresh = A.token({ sub: s.user, sid: s.sid, azp: ORIGIN });
		const directives = [
			'__client_uat=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure',
			`__session=${fresh}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`,
			`${REFRESH_A}=${s.refresh}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
		];
		const r = await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, ''));
		expect(r.status).toBe(303);
		expect(r.headers.getSetCookie().filter((c) => c.includes(s.refresh))).toEqual([expect.stringMatching(new RegExp(`^${hold(fresh, s.refresh).replace(/[+/=]/g, '\\$&')}; Path=/; Max-Age=\\d+; SameSite=Lax; HttpOnly; Secure$`))]);
	});
	it('keeps no refresh token from a handshake that does not sign the browser in', async () => {
		const s = session();
		const directives = [
			'__client_uat=0; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure',
			'__session=; Path=/; Domain=clearcase.test; Max-Age=0; SameSite=Lax; Secure',
			`${REFRESH_A}=${s.refresh}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
		];
		const r = await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, ''));
		expect(r.status).toBe(303);
		expect(r.headers.getSetCookie().join('\n')).not.toContain(s.refresh);
	});
	it('clears the hold a browser carries when a handshake signs it out', async () => {
		const s = session();
		const directives = ['__client_uat=0; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure', '__session=; Path=/; Domain=clearcase.test; Max-Age=0; SameSite=Lax; Secure'];
		const r = await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, held(s)));
		expect(r.status).toBe(303);
		expect(r.headers.getSetCookie()).toContain(`${HOLD_A}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`);
	});
	it('holds nothing on an http origin, which cannot keep a __Host- cookie, and renews nothing there', async () => {
		const s = session(), origin = 'http://localhost:5173';
		const made = clerkBrowserHandshakeFromEnv({ ...workers.env, CLEARCASE_APP_ORIGIN: origin });
		if (!made.ok) throw new Error(made.reason);
		const fresh = A.token({ sub: s.user, sid: s.sid, azp: origin });
		const directives = [`__session=${fresh}; Path=/; Max-Age=60; SameSite=Lax`, `${REFRESH_A}=${s.refresh}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax`];
		const o = await made.handshake.handle(new Request(`${origin}/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } }));
		expect(o).toMatchObject({ kind: 'redirect' });
		expect((o as { setCookies: string[] }).setCookies.join('\n')).not.toContain(s.refresh);
		const stale = A.token({ sub: s.user, sid: s.sid, azp: origin, now: STALE() });
		expect(await made.handshake.refresh(new Request(`${origin}${NOTES}`, { method: 'POST', headers: { cookie: hold(stale, s.refresh) } }))).toBeNull();
		expect(calls).toEqual([]);
	});
});

describe('what the refresh never changes', () => {
	it('refuses a cross-origin write before any refresh or Backend API call', async () => {
		const s = session();
		const r = await invoke(saveNote(jar(s), { origin: 'https://foreign.test' }));
		expect(r.status).toBe(403);
		expect(calls).toEqual([]);
	});
	it('still hands an expired session on a document GET to the handshake, with no Backend API call', async () => {
		const s = session();
		const r = await invoke(documentGet('/cases', `__clerk_db_jwt=dvb_synthetic0123456789abcdef; ${jar(s)}`));
		expect(r.status).toBe(303);
		expect(new URL(r.headers.get('location')!).pathname).toBe('/v1/client/handshake');
		expect(calls).toEqual([]);
	});
	it('makes no Backend API call for an expired session with no refresh token, and refuses it as before', async () => {
		const s = session();
		const r = await invoke(saveNote(`__client_uat=1761400000; __session=${s.stale()}`));
		expect(r.status).toBe(401);
		expect(calls).toEqual([]);
	});
	it.each([
		['another client instance', () => { const s = session(C); return `__session=${s.stale()}; ${held(s)}`; }],
		['a token naming this client but signed by another key', () => { const s = session(), t = C.token({ sub: s.user, sid: s.sid, azp: ORIGIN, now: STALE(), claims: { iss: A.iss } }); return `__session=${t}; ${hold(t, s.refresh)}`; }],
		['another origin as authorized party', () => { const s = session(), t = A.token({ sub: s.user, sid: s.sid, azp: 'https://client-b.clearcase.test', now: STALE() }); return `__session=${t}; ${hold(t, s.refresh)}`; }],
		['the staff instance hold beside a client session', () => { const s = session(); return `__session=${s.stale()}; ${hold(s.stale(), s.refresh, HOLD_B)}`; }],
		['the client instance hold of a staff session', () => { const s = session(B); return hold(s.stale(), s.refresh, HOLD_A); }],
		['the plain refresh name, which names no instance', () => { const s = session(); return `__session=${s.stale()}; __refresh=${s.refresh}`; }],
		['two holds of the instance', () => { const s = session(); return `__session=${s.stale()}; ${held(s)}; ${held(s, `${s.refresh}x`)}`; }],
		['a hold of each instance', () => { const s = session(); return `${held(s)}; ${hold(s.stale(), s.refresh, HOLD_B)}`; }],
		['a hold beside another session token', () => { const s = session(), other = session(); return `__session=${other.stale()}; ${held(s)}`; }],
		['a session token older than any Clerk session lives', () => { const s = session(), t = A.token({ sub: s.user, sid: s.sid, azp: ORIGIN, now: Date.now() - 8 * 86_400_000 }); return `__session=${t}; ${hold(t, s.refresh)}`; }],
	])('never refreshes %s, and refuses it with no Backend API call', async (_name, cookie) => {
		const r = await invoke(saveNote(cookie()));
		expect(r.status).toBe(401);
		expect(sessionCookie(r)).toBeUndefined();
		expect(calls).toEqual([]);
	});
	it('never refreshes an expired bearer token, which carries no browser session', async () => {
		const s = session();
		const r = await invoke(saveNote(held(s), { authorization: `Bearer ${s.stale()}` }));
		expect(r.status).toBe(401);
		expect(calls).toEqual([]);
	});
	it('refuses a session Clerk will not refresh (revoked, or a wrong refresh token) with 401, once per presented token', async () => {
		const revoked = session(A, 'revoked'), wrong = session();
		for (const cookie of [jar(revoked), jar(wrong, 'not-the-issued-refresh-token')]) {
			calls.length = 0;
			expect((await invoke(saveNote(cookie))).status).toBe(401);
			expect((await invoke(saveNote(cookie))).status).toBe(401);
			expect(refreshCalls()).toHaveLength(1);
		}
	});
	it('makes one refresh for concurrent requests carrying the same expired token', async () => {
		const s = session();
		const out = await Promise.all([invoke(saveNote(jar(s))), invoke(dataRequest(jar(s))), invoke(saveNote(jar(s)))]);
		// the data request, renewed with a spent hold, goes on to the handshake (round 4b)
		expect(out.map((r) => r.status)).toEqual([201, 200, 201]);
		expect(await dataRedirect(out[1]!)).not.toBeNull();
		expect(refreshCalls()).toHaveLength(1);
	});
	it.each([
		['refreshed cookies for another instance', (sid: string) => ({ status: 200, body: { object: 'cookies', cookies: [`__session=${C.token({ sub: sessions.get(sid)!.user_id, sid, azp: ORIGIN })}; Path=/`] } })],
		['a token of the other configured instance for the same user and session', (sid: string) => ({ status: 200, body: { object: 'cookies', cookies: [`__session=${B.token({ sub: sessions.get(sid)!.user_id, sid, azp: ORIGIN })}; Path=/`] } })],
		['a token for another session', (sid: string) => ({ status: 200, body: { object: 'cookies', cookies: [`__session=${A.token({ sub: sessions.get(sid)!.user_id, sid: 'sess_other', azp: ORIGIN })}; Path=/`] } })],
		['a cookie outside the allowlist', (sid: string) => ({ status: 200, body: { object: 'cookies', cookies: [`__session=${A.token({ sub: sessions.get(sid)!.user_id, sid, azp: ORIGIN })}; Path=/`, 'theme=dark; Path=/'] } })],
		['no session cookie', () => ({ status: 200, body: { object: 'cookies', cookies: ['__client_uat=1; Path=/'] } })],
		['an outage', () => ({ status: 503, body: { errors: [{ code: 'service_unavailable', message: 'synthetic outage' }] } })],
	])('sets nothing and refuses the request when the refresh answers %s', async (_name, answer) => {
		const s = session();
		refreshAnswer = answer;
		const r = await invoke(saveNote(jar(s)));
		expect(r.status).toBe(401);
		expect(r.headers.getSetCookie()).toEqual([]);
	});
	it('never refreshes on /sign-out or a sign-in page, whose expired-session semantics stay revoke-only', async () => {
		for (const path of ['/sign-out', '/sign-in', '/sign-in/operator']) {
			const s = session();
			await invoke(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, cookie: jar(s), 'content-type': 'application/x-www-form-urlencoded' }, body: '' }));
			expect(refreshCalls(), path).toEqual([]);
		}
	});
});

describe('the credential a refresh is answered for (review H1)', () => {
	it('never answers a wrong refresh token with the session the right one renewed for the same expired token', async () => {
		const s = session();
		expect((await invoke(saveNote(jar(s)))).status).toBe(201);
		const r = await invoke(saveNote(jar(s, `${RT}wrong`)));
		expect(r.status).toBe(401);
		expect(r.headers.getSetCookie()).toEqual([]);
		expect(refreshCalls()).toHaveLength(2);
		expect(refreshCalls()[1]!.body).toMatchObject({ refresh_token: `${RT}wrong` });
	});
	it('never lets a wrong refresh token settle the right one as refused', async () => {
		const s = session();
		expect((await invoke(saveNote(jar(s, `${RT}wrong`)))).status).toBe(401);
		expect((await invoke(saveNote(jar(s)))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(2);
	});
});

// A browser's cookie jar on the (faked) clock: tough-cookie's RFC 6265 store (jsdom's CookieJar), so a cookie is one
// name, domain and path, Max-Age and Expires end it, a `__Host-` cookie without Secure, with a Domain or off Path=/ is
// refused, and a request carries every cookie whose domain and path match it (review L1, session-renewal-live-2).
interface BrowserJar {
	setCookieSync(directive: string, url: string, options: { ignoreError: boolean }): unknown;
	getCookiesSync(url: string): Array<{ key: string }>;
	getCookieStringSync(url: string): string;
}
function browser() {
	const j: BrowserJar = new CookieJar(undefined, { looseMode: false });
	const set = (directive: string, from = `${ORIGIN}/`) => void j.setCookieSync(directive, from, { ignoreError: true });
	return {
		take(r: Response, from = `${ORIGIN}/`) {
			for (const d of r.headers.getSetCookie()) set(d, from);
			return r;
		},
		/** A cookie set by another response: a sibling origin's, or a planted one. */
		set,
		drop(names: string[]) {
			for (const name of names) set(`${name}=; Path=/; Max-Age=0; Secure`);
		},
		names: (path = '/cases/case-a/notes') => j.getCookiesSync(`${ORIGIN}${path}`).map((c) => c.key),
		cookie: (path = '/cases/case-a/notes') => j.getCookieStringSync(`${ORIGIN}${path}`),
	};
}
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
// A browser signs in through the real handshake return: Clerk's directive set, with the session token live for 60 seconds.
async function signIn(b: ReturnType<typeof browser>, s: ReturnType<typeof session>) {
	const directives = [
		'__client_uat=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure',
		`__session=${A.token({ sub: s.user, sid: s.sid, azp: ORIGIN })}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`,
		`${REFRESH_A}=${s.refresh}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
	];
	const r = b.take(await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, b.cookie())));
	expect(r.status).toBe(303);
	expect(b.names()).toContain('__session');
	calls.length = 0;
	return r;
}
// A sign-out or sign-in form action, with the locals the real hook gives its request and the browser applying its clears.
async function act(action: (event: never) => unknown, path: string, b: ReturnType<typeof browser>) {
	const request = new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, cookie: b.cookie(path) } });
	let locals: unknown;
	await handle({ event: { request, url: new URL(request.url), locals: {}, isSubRequest: false }, resolve: async (e: { locals: unknown }) => ((locals = e.locals), new Response(null)) } as never);
	// SvelteKit's cookies.delete as the browser applies it: at the Path and Domain it names (host-only without one)
	const deleted: string[] = [];
	const remove = (name: string, o: { path?: string; domain?: string } = {}) => deleted.push(`${name}=; Path=${o.path ?? '/'}; ${o.domain ? `Domain=${o.domain}; ` : ''}Max-Age=0; Secure`);
	let thrown: unknown;
	try {
		await action({ locals, request, url: new URL(request.url), cookies: { delete: remove, set: () => {} } } as never);
	} catch (e) {
		thrown = e;
	}
	for (const d of deleted) b.set(d);
	return thrown;
}
const revoked = (sid: string) => calls.some((c) => c.method === 'POST' && c.path === `/v1/sessions/${sid}/revoke`);

describe('a browser that drops each cookie at its Max-Age', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());

	it('saves the note after the browser dropped the expired session cookie, and again a minute later (review M1)', async () => {
		const s = session(), b = browser();
		await signIn(b, s);
		later(61_000);
		expect(b.names()).not.toContain('__session');
		expect(b.take(await invoke(saveNote(b.cookie()))).status).toBe(201);
		later(61_000);
		expect(b.names()).not.toContain('__session');
		expect(b.take(await invoke(saveNote(b.cookie()))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(2);
		expect(trap.blocked).toEqual([]);
	});
	it('keeps nothing that renews a session past the longest a Clerk session lives (review M1)', async () => {
		const s = session(), b = browser();
		await signIn(b, s);
		later(MAX_SESSION_LIFETIME_MS + 120_000);
		expect(b.cookie()).not.toContain(s.refresh);
		expect((await invoke(saveNote(b.cookie()))).status).toBe(401);
		expect(calls).toEqual([]);
	});
	it('keeps the renewal credential only in an app-owned __Host- cookie: Secure, HttpOnly, Path=/, no Domain (review M3)', async () => {
		const s = session(), b = browser();
		const r = await signIn(b, s);
		expect(b.names().filter((n) => /refresh/.test(n))).toEqual([HOLD_A]);
		const directive = r.headers.getSetCookie().find((c) => c.startsWith(`${HOLD_A}=`))!;
		expect(directive).toMatch(new RegExp(`^${HOLD_A}=[^;]+; Path=/; Max-Age=(\\d+); SameSite=Lax; HttpOnly; Secure$`));
		const age = Number(/Max-Age=(\d+)/.exec(directive)![1]);
		expect(age).toBeGreaterThan(MAX_SESSION_LIFETIME_MS / 1000);
		expect(age).toBeLessThanOrEqual(MAX_SESSION_LIFETIME_MS / 1000 + 60);
	});
	it.each([0, 61_000])('signs out %d ms after sign-in: the session is revoked and every renewal cookie cleared (review M2)', async (idle) => {
		const s = session(), b = browser();
		await signIn(b, s);
		later(idle);
		expect(await act(signOut.actions.default!, '/sign-out', b)).toMatchObject({ status: 303, location: '/sign-in' });
		expect(revoked(s.sid)).toBe(true);
		expect(b.cookie()).not.toContain(s.refresh);
		expect(b.names().filter((n) => /__session|__client_uat|refresh/.test(n))).toEqual([]);
	});
	it.each([0, 61_000])('switches to the operator sign-in %d ms after a client sign-in: the client session is revoked and its renewal cookie cleared (review M2)', async (idle) => {
		const s = session(), b = browser();
		await signIn(b, s);
		later(idle);
		expect(await act(operator.actions.default!, '/sign-in/operator', b)).toMatchObject({ status: 303 });
		expect(revoked(s.sid)).toBe(true);
		expect(b.cookie()).not.toContain(s.refresh);
	});
});

describe('a renewal cookie this app did not set (review M3)', () => {
	it('never renews from a Clerk-named refresh cookie, which a sibling host under the parent domain can plant', async () => {
		const s = session();
		const r = await invoke(saveNote(`__client_uat=1761400000; __session=${s.stale()}; ${REFRESH_A}=${s.refresh}`));
		expect(r.status).toBe(401);
		expect(calls).toEqual([]);
	});
	it('never renews with two renewal cookies of one name', async () => {
		const s = session();
		const r = await invoke(saveNote(`__client_uat=1761400000; __session=${s.stale()}; ${held(s)}; ${held(s)}`));
		expect(r.status).toBe(401);
		expect(calls).toEqual([]);
	});
});

// The live development handshake of 27 October (Astra auth matrix at b76ca49e, finding 1; session-renewal-live probe):
// Clerk set `__refresh_<suffix>` to a 48-character value of letters, digits and `:`, not the standard-base64 class the
// fixtures above use. The hold refused that value, so no hold was ever set, nothing renewed, and 60 seconds after any
// page load a note save answered 401 and a `__data.json` load carried "Your session has ended". The directives below
// copy the live set's names, attributes and value classes (SYNTHETIC values): a clear and a set of `__client_uat`, the
// session and refresh tokens and the dev browser with a year's Expires and SameSite=None, and no Domain but on the uat.
const LIVE_RT = (n: number) => `${`rt${n}`.padEnd(15, 'x')}:${'Synthetic0Refresh0Token0Value'.padEnd(32, '0')}`;
const YEAR = () => new Date(Date.now() + 365 * 86_400_000).toUTCString();
const liveHandshake = (token: string, refresh: string) => [
	'__client_uat=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=None',
	'__client_uat=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; Secure; SameSite=None',
	`__session=${token}; Path=/; Expires=${YEAR()}; Secure; SameSite=None`,
	`${REFRESH_A}=${refresh}; Path=/; Expires=${YEAR()}; HttpOnly; Secure; SameSite=None`,
	`__clerk_db_jwt=dvb_synthetic0123456789abcdefgh; Path=/; Expires=${YEAR()}; Secure; SameSite=None`,
];
const clientData = (cookie: string) => new Request(`${ORIGIN}/cases/case-a/__data.json?x-sveltekit-invalidated=01`, { headers: { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', accept: '*/*', cookie } });

describe('a refresh token of the shape a live Clerk handshake returns (session-renewal-live)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());

	it('saves a note 61 s after sign-in, and loads page data 61 s after that, renewing with the refresh token Clerk rotates to', async () => {
		const s = session(), b = browser(), row = sessions.get(s.sid)!;
		row.refresh = LIVE_RT(n);
		expect(row.refresh).toMatch(/^[A-Za-z0-9:]{48}$/);
		// Clerk's refresh answer: a new session token and, like its handshake, a rotated refresh token of the same class
		refreshAnswer = (sid) => {
			if (sid !== s.sid) return null;
			const token = A.token({ sub: s.user, sid, azp: ORIGIN });
			row.refresh = LIVE_RT(++n);
			return { status: 200, body: { object: 'cookies', cookies: [`__session=${token}; Path=/; Expires=${YEAR()}; Secure; SameSite=None`, `${REFRESH_A}=${row.refresh}; Path=/; Expires=${YEAR()}; HttpOnly; Secure; SameSite=None`] } };
		};
		const signedIn = b.take(await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), row.refresh) })}`, '')));
		expect(signedIn.status).toBe(303);
		expect(b.names()).toContain(HOLD_A);
		later(61_000);
		const saved = b.take(await invoke(saveNote(b.cookie())));
		expect(saved.status).toBe(201);
		expect(b.cookie()).toContain(row.refresh);
		later(61_000);
		expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(2);
		expect(trap.blocked).toEqual([]);
	});
});

// The live refresh answer of 27 October (Astra auth matrix at 939193b1, finding 1; session-renewal-live-2 probe): asked
// with `suffixed_cookies=false`, Clerk set the renewed token ONLY under the suffixed `__session_<suffix>`, and no
// `__client_uat`. The handshake keeps this browser on the plain `__session`, so after one renewal it carried two different
// session tokens: the request presented none (ambiguity is refused), and the handshake on the next document load re-set
// only `__session`, leaving the suffixed copy behind. A note saved after 90 s idle (303), and the reload straight after it
// went through the handshake to 401 "Your session has ended", which no later handshake undid.
const SESSION_SFX = `__session_${suffix(A.publishableKey)}`;
const liveRefreshAnswer = (s: ReturnType<typeof session>) => (sid: string) => sid !== s.sid ? null
	: { status: 200, body: { object: 'cookies', cookies: [`${SESSION_SFX}=${A.token({ sub: s.user, sid, azp: ORIGIN })}; Path=/; Expires=${YEAR()}; Secure; SameSite=None`] } };
// A document load as the browser makes it: through Clerk's handshake when the Worker sends it there (Clerk answers for
// the session it holds, with the live directive set), back to the page; the final answer.
async function load(b: ReturnType<typeof browser>, s: ReturnType<typeof session>, path: string) {
	let r = b.take(await invoke(documentGet(path, b.cookie(new URL(path, ORIGIN).pathname))));
	if ([303, 307].includes(r.status) && new URL(r.headers.get('location')!, ORIGIN).origin === A.iss) {
		const back = new URL(new URL(r.headers.get('location')!).searchParams.get('redirect_url')!);
		back.searchParams.set('__clerk_handshake', A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh) }));
		r = b.take(await invoke(documentGet(back.pathname + back.search, b.cookie(back.pathname))));
		expect(r.status).toBe(303);
		const to = new URL(r.headers.get('location')!, ORIGIN).pathname;
		r = b.take(await invoke(documentGet(to, b.cookie(to))));
	}
	return r;
}
const sessionValues = (b: ReturnType<typeof browser>) => new Set(b.cookie().split('; ').filter((c) => /^__session(_|=)/.test(c)).map((c) => c.slice(c.indexOf('=') + 1)));
const CASE_NOTES = '/cases/case-a/notes';

describe('a session Clerk renews under its suffixed cookie name (session-renewal-live-2)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());

	it.each([['straight after the save', 0], ['after the save has settled', 15_000]])('saves a note 90 s after sign-in and reloads %s: still signed in, with one session token', async (_, settle) => {
		const s = session(), b = browser();
		sessions.get(s.sid)!.refresh = LIVE_RT(n);
		refreshAnswer = liveRefreshAnswer(s);
		expect((await load(b, s, `/cases?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh) })}`)).status).toBe(303);
		later(90_000);
		expect(b.take(await invoke(saveNote(b.cookie()))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(1);
		later(settle);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		later(90_000);
		// renewed, then handed to the handshake: this double answers no new refresh token (round 4b)
		const data = b.take(await invoke(clientData(b.cookie())));
		expect(await dataRedirect(data)).not.toBeNull();
		expect(sessionValues(b).size).toBe(1);
		expect(trap.blocked).toEqual([]);
	});
	it('signs a browser that a renewal left with two session tokens back in on its next page load', async () => {
		const s = session(), b = browser();
		sessions.get(s.sid)!.refresh = LIVE_RT(n);
		// what the 939193b1 deploy left in a browser: the handshake's plain token and a renewed suffixed one
		b.take(new Response(null, { headers: [
			['set-cookie', `__session=${s.stale()}; Path=/; Secure`], ['set-cookie', `${SESSION_SFX}=${A.token({ sub: s.user, sid: s.sid, azp: ORIGIN, now: Date.now() - 30_000 })}; Path=/; Secure`],
			['set-cookie', `__client_uat=1761400000; Path=/; Secure`], ['set-cookie', `${hold(s.stale(), sessions.get(s.sid)!.refresh)}; Path=/; Secure`],
		] }));
		expect(sessionValues(b).size).toBe(2);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		expect(sessionValues(b).size).toBe(1);
	});
});

// The Sol review of edfb069e (session-renewal-live-2-review.md), probes ported. A server never sees a cookie's Domain or
// Path, so the handshake and a renewal clear every scope this app or Clerk creates a session cookie at: host-only and each
// parent domain up to the registrable one, at Path=/ (every session directive the Worker sets is rewritten to Path=/, and
// each live handshake and refresh directive captured on 27 October was Path=/). A copy at any other scope (a narrower
// Path, which only a planted cookie has) keeps the ambiguity refusal: no token is ever picked. And only the session cookie
// names this deployment owns are cleared or written: `__session` and the suffixes of its client and staff instances (M2).
const SESSION_NAME = /^__session(?:_|$)/;
const SIBLING = 'https://client-b.clearcase.test/', PARENT = 'Domain=clearcase.test; Path=/', NARROW = 'Path=/cases';
const SESSION_B = `__session_${suffix(B.publishableKey)}`, SESSION_C = `__session_${suffix(C.publishableKey)}`;
const plant = (b: ReturnType<typeof browser>, name: string, token: string, scope: string) =>
	b.set(`${name}=${token}; ${scope}; Secure; HttpOnly; SameSite=Lax`, scope === PARENT ? SIBLING : `${ORIGIN}/cases`);
const handshakeBack = (s: ReturnType<typeof session>, path = CASE_NOTES) =>
	documentGet(`${path}?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), s.refresh) })}`, '');
const withCookie = (r: Request, cookie: string) => new Request(r, { headers: { ...Object.fromEntries(r.headers), cookie } });

describe('the scope and ownership of the session cookies a handshake or renewal rewrites (session-renewal-live-2 review)', () => {
	it.each([[SESSION_SFX], ['__session'], [SESSION_B]])('a handshake removes a stale %s a sibling set on the parent domain, and the page loads (M1)', async (name) => {
		const s = session(), b = browser();
		plant(b, name, s.stale(), PARENT);
		expect(b.take(await invoke(withCookie(handshakeBack(s), b.cookie())))).toHaveProperty('status', 303);
		expect(presentedToken(documentGet(CASE_NOTES, b.cookie()))).not.toBe('malformed');
		expect((await invoke(documentGet(CASE_NOTES, b.cookie()))).status).toBe(201);
	});
	it('a renewal beside a parent-domain session cookie leaves one session token, and the next request is served (M1)', async () => {
		const s = session(), b = browser();
		plant(b, '__session', s.stale(), PARENT);
		b.set(`${held(s)}; Path=/; Secure; HttpOnly`);
		b.set('__client_uat=1761400000; Path=/; Secure');
		expect(b.take(await invoke(saveNote(b.cookie(NOTES)))).status).toBe(201);
		expect(presentedToken(documentGet(CASE_NOTES, b.cookie()))).not.toBe('malformed');
		expect((await invoke(saveNote(b.cookie(NOTES)))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(1);
	});
	it('keeps refusing a session cookie at a narrower Path, which nothing here sets: no token is picked (M1 residual)', async () => {
		const s = session(), b = browser();
		plant(b, SESSION_SFX, s.stale(), NARROW);
		b.take(await invoke(withCookie(handshakeBack(s), b.cookie())));
		expect(presentedToken(documentGet(CASE_NOTES, b.cookie()))).toBe('malformed');
		expect((await invoke(documentGet(CASE_NOTES, b.cookie()))).status).toBe(401);
		// outside /cases the browser carries one token, and is served
		expect((await invoke(documentGet('/sign-in', b.cookie('/sign-in')))).status).not.toBe(401);
	});
	it('never clears the session cookie of an instance this deployment does not configure (M2)', async () => {
		const s = session(), foreign = session(C);
		const r = await invoke(withCookie(handshakeBack(s, '/cases'), `${SESSION_C}=${foreign.stale()}`));
		expect(r.status).toBe(303);
		expect(r.headers.getSetCookie().filter((d) => d.startsWith(`${SESSION_C}=`))).toEqual([]);
	});
	it('never renews into the session cookie name of an instance this deployment does not configure (M2)', async () => {
		const s = session();
		const r = await invoke(saveNote(`__client_uat=1761400000; ${SESSION_C}=${s.stale()}; ${held(s)}`));
		expect(r.status).toBe(201);
		expect(r.headers.getSetCookie().filter((d) => d.startsWith(`${SESSION_C}=`))).toEqual([]);
	});
	it('still refuses a conflicting token under an unknown name, with no refresh and no cookies (M2)', async () => {
		const s = session(), other = session(C);
		const r = await invoke(saveNote(`${jar(s)}; __session_other=${other.stale()}`));
		expect(r.status).toBe(401);
		expect(refreshCalls()).toHaveLength(0);
		expect(r.headers.getSetCookie()).toEqual([]);
	});
});

// The Sol re-check of 059237e0 (session-renewal-live-2-fix1-recheck.md), probes ported. M3: sign-out deleted only the
// host-only copy of an ambiguous session, so a live parent-Domain `__session` it left behind authorised the next request.
// Sign-out now clears every owned session name at the scopes the handshake clears, and never reports success while a
// session cookie it may not clear (another instance's name) survives. L2: a signed handshake never writes such a name.
describe('sign-out and the handshake against session cookies at other scopes or names (session-renewal-live-2 re-check)', () => {
	it('sign-out clears a live parent-domain session beside an ambiguous host-only copy, so nothing authorises afterwards (M3)', async () => {
		const s = session(), b = browser();
		plant(b, '__session', A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), PARENT);
		b.set(`__session=${s.stale()}; Path=/; Secure; HttpOnly`);
		expect(presentedToken(documentGet('/cases', b.cookie()))).toBe('malformed');
		expect((await invoke(saveNote(b.cookie(NOTES)))).status).toBe(401);
		expect(await act(signOut.actions.default!, '/sign-out', b)).toMatchObject({ status: 303, location: '/sign-in' });
		expect((await invoke(saveNote(b.cookie(NOTES)))).status).toBe(401);
		expect(b.names().filter((n) => SESSION_NAME.test(n))).toEqual([]);
	});
	it.each([[SESSION_SFX], [SESSION_B]])('sign-out clears an owned %s on the parent domain (M3)', async (name) => {
		const s = session(), b = browser();
		plant(b, name, A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), PARENT);
		expect(await act(signOut.actions.default!, '/sign-out', b)).toMatchObject({ status: 303, location: '/sign-in' });
		expect(b.names().filter((n) => SESSION_NAME.test(n))).toEqual([]);
	});
	it('sign-out never reports success while another instance\'s session cookie, which it may not clear, survives (M3)', async () => {
		const s = session(), other = session(), b = browser();
		b.set(`__session=${s.stale()}; Path=/; Secure; HttpOnly`);
		// sign-out deletes every host-only session cookie it carries (GRS-113), but another instance's name on the parent
		// domain is not this deployment's to clear
		plant(b, SESSION_C, A.token({ sub: other.user, sid: other.sid, azp: ORIGIN }), PARENT);
		const out = await act(signOut.actions.default!, '/sign-out', b);
		expect(out).not.toMatchObject({ location: '/sign-in' });
		expect(out).toMatchObject({ status: 409 });
		expect(b.names()).not.toContain('__session');
		expect(b.names()).toContain(SESSION_C);
	});
	it('a configured instance\'s signed handshake never writes a session cookie name it does not own (L2)', async () => {
		const s = session(), token = A.token({ sub: s.user, sid: s.sid, azp: ORIGIN });
		const r = await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: [`${SESSION_C}=${token}; Path=/; Secure`] })}`, ''));
		expect(r.headers.getSetCookie().filter((d) => d.startsWith(`${SESSION_C}=`))).toEqual([]);
	});
});

// The live renewal of 27 October (Astra auth matrix at b5866e59, finding 1; session-renewal-live-3 probe): a refresh token
// renews once. After a renewal, a second one 90 s later presenting the same refresh token was refused, whichever expired
// token came with it, and the hold still carried that token: the Worker read a rotated refresh token only under the
// instance's suffixed `__refresh_<suffix>`, while Clerk's Backend API answers a cookie-format refresh with
// `__refresh=<new token>` (its reference example). So the first renewal worked and every later one before a document
// handshake was refused: a breadcrumb `__data.json` carried "Your session has ended". The double below answers like that:
// the renewed session under `__session_<suffix>` (as live), the rotated refresh token under the plain `__refresh`, and it
// refuses a refresh token that has already been used.
const rotatingRefreshAnswer = (s: ReturnType<typeof session>) => (sid: string) => {
	if (sid !== s.sid) return null;
	const row = sessions.get(sid)!, presented = calls.at(-1)!.body?.refresh_token;
	if (presented !== row.refresh) return { status: 401, body: { errors: [{ code: 'authentication_invalid', message: 'synthetic spent refresh token' }] } };
	row.refresh = LIVE_RT(++n);
	return { status: 200, body: { object: 'cookies', cookies: [
		`${SESSION_SFX}=${A.token({ sub: s.user, sid, azp: ORIGIN })}; Path=/; Expires=${YEAR()}; Secure; SameSite=None`,
		`__refresh=${row.refresh}; Path=/; Expires=${YEAR()}; HttpOnly; Secure; SameSite=None`,
	] } };
};

describe('a refresh token Clerk rotates on every renewal (session-renewal-live-3)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());
	const signedIn = async (b: ReturnType<typeof browser>, s: ReturnType<typeof session>) => {
		sessions.get(s.sid)!.refresh = LIVE_RT(n);
		refreshAnswer = rotatingRefreshAnswer(s);
		expect((await load(b, s, `/cases?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh) })}`)).status).toBe(303);
	};

	it('saves a note after 90 s idle, reloads twice, and loads the case 90 s later: still signed in (Astra b586)', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(b.take(await invoke(saveNote(b.cookie(NOTES)))).status).toBe(201);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		later(5_000);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		later(90_000);
		expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(201);
		// each renewal presented the refresh token Clerk last issued
		expect(refreshCalls().map((c) => c.body?.refresh_token)).toEqual([LIVE_RT(n - 2), LIVE_RT(n - 1)]);
		expect(sessionValues(b).size).toBe(1);
		expect(trap.blocked).toEqual([]);
	});
	it('renews on three page-data loads in a row, each 90 s after the last, with no document load between them', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		for (let i = 0; i < 3; i++) {
			later(90_000);
			expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(201);
		}
		expect(refreshCalls()).toHaveLength(3);
	});
});

// The Sol review of f0486bab (session-renewal-live-3-review.md, M1), probes 2 and 3 ported. Clerk's refusal of a refresh
// token (spent, wrong or revoked) left the hold behind: every later request was refused, and each other isolate asked
// Clerk again with the same spent token. A refusal now clears the hold under the name the request sent, and nothing else;
// an outage clears nothing and is asked again. A refresh token renews once, so of two isolates renewing one hold at once,
// one is refused: the winner moves the hold to the other of its kind's two names, and the loser's clear never reaches it,
// in either arrival order.
const HOLD_A2 = `${HOLD_A}_2`;
const HOLD_CLEAR = (name: string) => `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
// a browser that already carries the cookies a sign-in left (the session token expired, the hold of it)
const carrying = (s: ReturnType<typeof session>) => {
	const b = browser();
	b.set(`__client_uat=1761400000; Path=/; Secure`);
	b.set(`__session=${s.stale()}; Path=/; Secure; HttpOnly`);
	b.set(`${held(s)}; Path=/; Secure; HttpOnly`);
	return b;
};

describe('a renewal Clerk refuses, and two isolates renewing one hold (session-renewal-live-3 review M1)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());

	it('clears the hold of a spent refresh token once, so no later request asks Clerk again (probe 2)', async () => {
		const s = session(), b = browser();
		b.set(`${HOLD_A}=${s.stale()}~${s.refresh}; Path=/; Secure; HttpOnly`);
		sessions.get(s.sid)!.refresh = LIVE_RT(9998);
		const out = [];
		for (let i = 0; i < 3; i++) out.push(b.take(await invoke(clientData(b.cookie()))));
		// round 4: the refused request is handed to the handshake (its data redirect), and the requests after it, with no
		// hold and no session left, are refused with no Backend API call
		expect(await dataRedirect(out[0]!)).not.toBeNull();
		expect(out.slice(1).map((r) => r.status)).toEqual([401, 401]);
		expect(refreshCalls()).toHaveLength(1);
		expect(out[0]!.headers.getSetCookie()[0]).toBe(HOLD_CLEAR(HOLD_A));
		expect(out[0]!.headers.getSetCookie().filter((c) => /^(__session|__client_uat|__Host-clearcase_refresh)[^=]*=/.test(c))).toEqual([HOLD_CLEAR(HOLD_A)]);
		expect(b.names()).not.toContain(HOLD_A);
	});
	it('after a refusal, the next page load signs the browser in again through the handshake, with one hold', async () => {
		const s = session(), b = carrying(s);
		sessions.get(s.sid)!.refresh = LIVE_RT(9997);
		// round 4: the refused data request itself is the page load through the handshake (navigate follows its handoff)
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: true });
		expect(b.names().filter((n) => /refresh/.test(n))).toEqual([HOLD_A]);
	});
	it.each([['an outage', 503], ['a rate limit', 429]])('clears nothing when Clerk answers %s', async (_name, status) => {
		const s = session(), b = carrying(s);
		refreshAnswer = () => ({ status, body: { errors: [{ code: 'synthetic', message: 'synthetic' }] } });
		const r = b.take(await invoke(clientData(b.cookie())));
		expect(r.status).toBe(401);
		expect(r.headers.getSetCookie()).toEqual([]);
		expect(b.names()).toContain(HOLD_A);
	});
	it('asks Clerk again after an outage, and renews once it is over', async () => {
		const s = session(), b = carrying(s);
		refreshAnswer = () => ({ status: 503, body: { errors: [{ code: 'service_unavailable', message: 'synthetic outage' }] } });
		expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(401);
		refreshAnswer = null;
		// renewed (and, the hold spent, handed to the handshake: round 4b)
		const renewed = b.take(await invoke(clientData(b.cookie())));
		expect(sessionCookie(renewed)).toBeDefined();
		expect(await dataRedirect(renewed)).not.toBeNull();
		expect(refreshCalls()).toHaveLength(2);
	});
	it.each([['the winner first', [0, 1]], ['the loser first', [1, 0]]])('two isolates race one single-use refresh token, the browser applying %s: it stays signed in and renews again (probe 3)', async (_order, order) => {
		const s = session();
		refreshAnswer = rotatingRefreshAnswer(s);
		vi.resetModules();
		const second = (await import('../../../src/lib/server/runtime/hosted/hooks.server.ts')).handle;
		const b = carrying(s), request = clientData(b.cookie());
		const out = await Promise.all([
			invoke(clientData(b.cookie())),
			second({ event: { request, url: new URL(request.url), locals: {}, isSubRequest: false }, resolve: route } as never),
		]);
		// round 4: the refused loser is handed to the handshake (a data redirect) instead of answering 401
		expect(out.filter((r) => r.status === 201)).toHaveLength(1);
		expect(refreshCalls()).toHaveLength(2);
		const ranked = [out.find((r) => r.status === 201)!, out.find((r) => r.status !== 201)!];
		expect(await dataRedirect(ranked[1]!)).not.toBeNull();
		expect(ranked[1]!.headers.get('location')).toBeNull();
		expect(sessionCookie(ranked[1]!)).toBeUndefined();
		for (const i of order) b.take(ranked[i]!);
		expect(b.names().filter((n) => /refresh/.test(n))).toEqual([HOLD_A2]);
		expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(201);
		later(90_000);
		expect(b.take(await invoke(clientData(b.cookie()))).status).toBe(201);
		expect(refreshCalls()).toHaveLength(3);
		expect(b.names().filter((n) => /refresh/.test(n))).toEqual([HOLD_A]);
		expect(sessionValues(b).size).toBe(1);
	});
	it('sign-out after a renewal clears the hold under either name', async () => {
		const s = session(), b = browser();
		await signIn(b, s);
		later(61_000);
		expect(b.take(await invoke(saveNote(b.cookie()))).status).toBe(201);
		expect(b.names().filter((n) => /refresh/.test(n))).toEqual([HOLD_A2]);
		expect(await act(signOut.actions.default!, '/sign-out', b)).toMatchObject({ status: 303, location: '/sign-in' });
		expect(b.names().filter((n) => /__session|__client_uat|refresh/.test(n))).toEqual([]);
	});
});

// Live at 7614d88b (astra-renewal-7614, 27 October): with f0486bab deployed the first renewal still worked and the second
// still failed, on A after a save and on B with no saves at all. So Clerk's refresh answer carries no rotated refresh
// token this Worker can read, and a refresh token renews once. The app must be right without one: a page-data request
// whose expired session cannot be renewed hands the browser to a full page load through Clerk's handshake (Kit turns a
// data redirect to another origin into one), which mints a fresh session and refresh token, and the user lands on the
// page still signed in. A transient fault (an outage, a rate limit) is answered as before. One handshake per handoff: its
// return marks the browser for a short while, and a data request carrying the mark is answered session-ended instead.
const neverRotating = (s: ReturnType<typeof session>) => (sid: string) => {
	if (sid !== s.sid) return null;
	const row = sessions.get(sid)!;
	if (calls.at(-1)!.body?.refresh_token !== row.refresh) return { status: 401, body: { errors: [{ code: 'authentication_invalid', message: 'synthetic spent refresh token' }] } };
	row.refresh = `spent-${row.refresh}`;
	return { status: 200, body: { object: 'cookies', cookies: [`${SESSION_SFX}=${A.token({ sub: s.user, sid, azp: ORIGIN })}; Path=/; Expires=${YEAR()}; Secure; SameSite=None`] } };
};
/** The location of a data response that redirects (Kit's `{"type":"redirect"}` node), or null. */
async function dataRedirect(r: Response): Promise<URL | null> {
	if (r.status !== 200 || !(r.headers.get('content-type') ?? '').includes('application/json')) return null;
	const body = (await r.clone().json()) as { type?: string; location?: string };
	return body.type === 'redirect' && body.location ? new URL(body.location, ORIGIN) : null;
}
/**
 * A client-side navigation's data request as the browser and Kit make it: when the data response redirects to another
 * origin, a full page load of that location, here Clerk's handshake, which answers for the session it holds (`signedIn`,
 * with a fresh refresh token, as its handshake does) back to the page. The final answer, and whether a handoff happened.
 */
async function navigate(b: ReturnType<typeof browser>, s: ReturnType<typeof session>, signedIn = true) {
	const r = b.take(await invoke(clientData(b.cookie())));
	const to = await dataRedirect(r);
	if (to === null) return { status: r.status, handoff: false };
	expect(to.origin).toBe(A.iss);
	expect(to.pathname).toBe('/v1/client/handshake');
	const back = new URL(to.searchParams.get('redirect_url')!);
	expect(back.origin + back.pathname).toBe(`${ORIGIN}/cases/case-a`);
	const row = sessions.get(s.sid)!;
	row.refresh = LIVE_RT(++n);
	back.searchParams.set('__clerk_handshake', A.sign({ handshake: signedIn ? liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), row.refresh)
		: ['__client_uat=0; Path=/; Domain=clearcase.test; Max-Age=315360000; Secure; SameSite=None', '__session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=None'] }));
	const returned = b.take(await invoke(documentGet(back.pathname + back.search, b.cookie(back.pathname))));
	expect(returned.status).toBe(303);
	const clean = new URL(returned.headers.get('location')!, ORIGIN);
	expect(clean.pathname + clean.search).toBe('/cases/case-a');
	return { status: b.take(await invoke(documentGet(clean.pathname, b.cookie(clean.pathname)))).status, handoff: true };
}
const holds = (b: ReturnType<typeof browser>) => b.names().filter((n) => /refresh/.test(n));

describe('a refresh token Clerk never rotates (astra-renewal-7614, round 4)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());
	const signedIn = async (b: ReturnType<typeof browser>, s: ReturnType<typeof session>) => {
		sessions.get(s.sid)!.refresh = LIVE_RT(n);
		refreshAnswer = neverRotating(s);
		expect((await load(b, s, `/cases?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh) })}`)).status).toBe(303);
	};

	it('Astra B: three idle breadcrumbs with no saves all render the case, each through the handshake', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		const out = [];
		for (let i = 0; i < 3; i++) {
			later(90_000);
			out.push(await navigate(b, s));
		}
		// each renewal spends the hold, so each goes on to the handshake for a fresh one (round 4b), which the next renews
		expect(out).toEqual([{ status: 201, handoff: true }, { status: 201, handoff: true }, { status: 201, handoff: true }]);
		expect(refreshCalls()).toHaveLength(3);
		expect(sessionValues(b).size).toBe(1);
		expect(holds(b)).toHaveLength(1);
		expect(trap.blocked).toEqual([]);
	});
	it('Astra A: a save after 90 s idle, two reloads, then a breadcrumb after another 90 s renders the case', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(b.take(await invoke(saveNote(b.cookie(NOTES)))).status).toBe(201);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		later(5_000);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
		later(90_000);
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: true });
		expect(sessionValues(b).size).toBe(1);
	});
	it('a document load whose session cannot be renewed goes through the handshake, not session-ended', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: true });
		later(90_000);
		expect((await load(b, s, CASE_NOTES)).status).toBe(201);
	});
	it('when the handshake says signed out, the page is session-ended and the next data request is not handed off again', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		await navigate(b, s);
		later(90_000);
		expect(await navigate(b, s, false)).toEqual({ status: 401, handoff: true });
		expect(await navigate(b, s)).toEqual({ status: 401, handoff: false });
	});
	it('hands off at most once in a short while: a data request just after a handoff returned is answered session-ended', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		await navigate(b, s);
		later(90_000);
		expect((await navigate(b, s)).handoff).toBe(true);
		// the session that handshake set is already unusable here (as if its token had been refused): no second handshake
		const stale = () => b.cookie().split('; ').filter((c) => !/^__session=|^__Host-clearcase_refresh/.test(c)).concat(`__session=${s.stale()}`).join('; ');
		later(10_000);
		const again = await invoke(clientData(stale()));
		expect(await dataRedirect(again)).toBeNull();
		expect(again.status).toBe(401);
		later(60_000);
		expect(await dataRedirect(await invoke(clientData(stale())))).not.toBeNull();
	});
	it.each([
		['no session at all', () => '__client_uat=0'],
		['an ambiguous session', () => { const s = session(), o = session(); return `__client_uat=1761400000; __session=${s.stale()}; ${SESSION_SFX}=${o.stale()}`; }],
		['a token of an instance this deployment does not configure', () => { const c = session(C); return `__client_uat=1761400000; __session=${c.stale()}`; }],
	])('never hands off a data request with %s', async (_name, cookie) => {
		const r = await invoke(clientData(cookie()));
		expect(await dataRedirect(r)).toBeNull();
		expect(r.status).toBe(401);
	});
});

// Round 4b: a save after an idle that a renewal already spent the refresh token of (astra-renewal-7614). Live Clerk renews
// once per refresh token and answers no new one, so after a renewal the hold is spent: the next renewal, the one a later
// save needs, is refused, and a save cannot go through the handshake. So the first GET after a renewal, a page load or a
// page-data request (the renewing one itself), goes through the handshake, whose return holds a fresh refresh token.
/** A document load as the browser makes it, through Clerk's handshake when sent there (a fresh refresh token, as live). */
async function visit(b: ReturnType<typeof browser>, s: ReturnType<typeof session>, path: string) {
	const r = b.take(await invoke(documentGet(path, b.cookie(path))));
	if (![303, 307].includes(r.status) || new URL(r.headers.get('location')!, ORIGIN).origin !== A.iss) return { status: r.status, handshake: false };
	const back = new URL(new URL(r.headers.get('location')!).searchParams.get('redirect_url')!);
	const row = sessions.get(s.sid)!;
	row.refresh = LIVE_RT(++n);
	back.searchParams.set('__clerk_handshake', A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), row.refresh) }));
	const returned = b.take(await invoke(documentGet(back.pathname + back.search, b.cookie(back.pathname))));
	expect(returned.status).toBe(303);
	const to = new URL(returned.headers.get('location')!, ORIGIN).pathname;
	expect(to).toBe(path);
	return { status: b.take(await invoke(documentGet(to, b.cookie(to)))).status, handshake: true };
}

describe('a save after an idle, when an earlier renewal spent the refresh token (astra-renewal-7614, round 4b)', () => {
	beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'] }));
	afterEach(() => void vi.useRealTimers());
	const signedIn = async (b: ReturnType<typeof browser>, s: ReturnType<typeof session>) => {
		sessions.get(s.sid)!.refresh = LIVE_RT(n);
		refreshAnswer = neverRotating(s);
		expect((await load(b, s, `/cases?__clerk_handshake=${A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh) })}`)).status).toBe(303);
	};
	const save = async (b: ReturnType<typeof browser>) => b.take(await invoke(saveNote(b.cookie(NOTES)))).status;

	it('idle, save, its page load, idle, save: both saves are written (the user\'s writing flow)', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(await save(b)).toBe(201);
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: true });
		later(90_000);
		expect(await save(b)).toBe(201);
		expect(refreshCalls()).toHaveLength(2);
		expect(trap.blocked).toEqual([]);
	});
	it('idle, save, its page load, idle, a data load, idle, save: both saves are written, through one handshake per renewal', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(await save(b)).toBe(201);
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: true });
		later(90_000);
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: true });
		later(90_000);
		expect(await save(b)).toBe(201);
		// bounded: the page after a save goes through the handshake once, and the next ones through none
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: true });
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: false });
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: false });
		expect(sessionValues(b).size).toBe(1);
		expect(holds(b)).toHaveLength(1);
		expect(trap.blocked).toEqual([]);
	});
	it('adds no handshake to a page load or data load whose refresh token is unspent', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(5_000);
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: false });
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: false });
		expect(refreshCalls()).toHaveLength(0);
	});
	it('sends a spent hold through the handshake at most once in a short while, even if its return holds no fresh token', async () => {
		const s = session(), b = browser();
		await signedIn(b, s);
		later(90_000);
		expect(await save(b)).toBe(201);
		const first = await invoke(documentGet(CASE_NOTES, b.cookie(CASE_NOTES)));
		expect(new URL(first.headers.get('location')!).origin).toBe(A.iss);
		// a handshake return that signs in again but keeps the browser's spent hold: the marker stops a second handshake
		const back = new URL(new URL(first.headers.get('location')!).searchParams.get('redirect_url')!);
		back.searchParams.set('__clerk_handshake', A.sign({ handshake: liveHandshake(A.token({ sub: s.user, sid: s.sid, azp: ORIGIN }), sessions.get(s.sid)!.refresh).filter((c) => !c.startsWith(REFRESH_A)) }));
		b.take(await invoke(documentGet(back.pathname + back.search, b.cookie(back.pathname))));
		const spentAgain = holds(b).length;
		expect(await visit(b, s, CASE_NOTES)).toEqual({ status: 201, handshake: false });
		expect(await navigate(b, s)).toEqual({ status: 201, handoff: false });
		expect(spentAgain).toBeLessThanOrEqual(1);
	});
});
