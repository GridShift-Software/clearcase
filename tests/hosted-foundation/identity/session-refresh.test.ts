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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { handle } from '../../../src/lib/server/runtime/hosted/hooks.server.ts';
import { craftedInstance } from './synthetic.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('client-c.clerk.test');
const suffix = (pk: string) => createHash('sha1').update(pk).digest('base64url').slice(0, 8);
const REFRESH_A = `__refresh_${suffix(A.publishableKey)}`, REFRESH_B = `__refresh_${suffix(B.publishableKey)}`;
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
		CLERK_API_URL: api,
	};
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
let n = 0;
// every test gets its own sessions, so an isolate-scoped memo of one test never answers another
const session = (instance = A, status = 'active') => {
	const sid = `sess_r${++n}`, user = `user_r${n}`;
	sessions.set(sid, { status, user_id: user, instance, refresh: `${RT}${n}` });
	return { sid, user, refresh: `${RT}${n}`, stale: () => instance.token({ sub: user, sid, azp: ORIGIN, now: STALE() }) };
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
const jar = (s: ReturnType<typeof session>, extra = '') => `__client_uat=1761400000; __session=${s.stale()}; ${REFRESH_A}=${s.refresh}${extra}`;
const refreshCalls = () => calls.filter((c) => c.path.endsWith('/refresh'));
const sessionCookie = (r: Response) => r.headers.getSetCookie().find((c) => /^__session=/.test(c));

describe('a signed-in user whose session token expired between page loads', () => {
	it('saves the note: the Worker refreshes the session with the refresh token the handshake stored, and the write succeeds', async () => {
		const s = session();
		const r = await invoke(saveNote(jar(s)));
		expect(r.status).toBe(201);
		const set = sessionCookie(r);
		expect(set).toMatch(/^__session=[^;]+; Path=\/; Max-Age=60; SameSite=Lax; HttpOnly; Secure$/);
		expect(r.headers.getSetCookie().join('\n')).not.toMatch(/Domain=/i);
		expect(refreshCalls()).toHaveLength(1);
		expect(refreshCalls()[0]).toMatchObject({ path: `/v1/sessions/${s.sid}/refresh`, bearer: A.secretKey, body: { refresh_token: s.refresh, request_origin: ORIGIN, format: 'cookie' } });
		expect(trap.blocked).toEqual([]);
		// the refreshed cookie alone is a verified session at this origin
		const again = await invoke(saveNote(`__client_uat=1761400000; ${set!.split(';')[0]}; ${REFRESH_A}=${s.refresh}`));
		expect(again.status).toBe(201);
		expect(refreshCalls()).toHaveLength(1);
	});
	it('answers a filtered search (a __data.json request) for the operator, not "your session has ended"', async () => {
		const s = session(B);
		const r = await invoke(dataRequest(`__client_uat=1761400000; __session=${s.stale()}; ${REFRESH_B}=${s.refresh}`));
		expect(r.status).toBe(201);
		expect(refreshCalls()).toHaveLength(1);
		expect(refreshCalls()[0]!.bearer).toBe(B.secretKey);
	});
	it('stores the refresh token a handshake returns, host-only and HttpOnly, for the instance that signed the handshake', async () => {
		const s = session();
		const fresh = A.token({ sub: s.user, sid: s.sid, azp: ORIGIN });
		const directives = [
			'__client_uat=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure',
			`__session=${fresh}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`,
			`${REFRESH_A}=${s.refresh}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
		];
		const r = await invoke(documentGet(`/cases?__clerk_handshake=${A.sign({ handshake: directives })}`, ''));
		expect(r.status).toBe(303);
		expect(r.headers.getSetCookie()).toContain(`${REFRESH_A}=${s.refresh}; Path=/; Max-Age=315360000; SameSite=Lax; HttpOnly; Secure`);
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
		['another client instance', () => { const s = session(C); return `__session=${s.stale()}; ${REFRESH_A}=${s.refresh}`; }],
		['a token naming this client but signed by another key', () => { const s = session(); return `__session=${C.token({ sub: s.user, sid: s.sid, azp: ORIGIN, now: STALE(), claims: { iss: A.iss } })}; ${REFRESH_A}=${s.refresh}`; }],
		['another origin as authorized party', () => { const s = session(); return `__session=${A.token({ sub: s.user, sid: s.sid, azp: 'https://client-b.clearcase.test', now: STALE() })}; ${REFRESH_A}=${s.refresh}`; }],
		['the staff instance refresh cookie beside a client session', () => { const s = session(); return `__session=${s.stale()}; ${REFRESH_B}=${s.refresh}`; }],
		['the plain refresh name, which names no instance', () => { const s = session(); return `__session=${s.stale()}; __refresh=${s.refresh}`; }],
		['two refresh cookies of the instance', () => { const s = session(); return `__session=${s.stale()}; ${REFRESH_A}=${s.refresh}; ${REFRESH_A}=${s.refresh}x`; }],
		['a session token older than any Clerk session lives', () => { const s = session(); return `__session=${A.token({ sub: s.user, sid: s.sid, azp: ORIGIN, now: Date.now() - 8 * 86_400_000 })}; ${REFRESH_A}=${s.refresh}`; }],
	])('never refreshes %s, and refuses it with no Backend API call', async (_name, cookie) => {
		const r = await invoke(saveNote(cookie()));
		expect(r.status).toBe(401);
		expect(sessionCookie(r)).toBeUndefined();
		expect(calls).toEqual([]);
	});
	it('never refreshes an expired bearer token, which carries no browser session', async () => {
		const s = session();
		const r = await invoke(saveNote(`${REFRESH_A}=${s.refresh}`, { authorization: `Bearer ${s.stale()}` }));
		expect(r.status).toBe(401);
		expect(calls).toEqual([]);
	});
	it('refuses a session Clerk will not refresh (revoked, or a wrong refresh token) with 401, once per presented token', async () => {
		const revoked = session(A, 'revoked'), wrong = session();
		for (const cookie of [jar(revoked), `__session=${wrong.stale()}; ${REFRESH_A}=not-the-issued-refresh-token`]) {
			calls.length = 0;
			expect((await invoke(saveNote(cookie))).status).toBe(401);
			expect((await invoke(saveNote(cookie))).status).toBe(401);
			expect(refreshCalls()).toHaveLength(1);
		}
	});
	it('makes one refresh for concurrent requests carrying the same expired token', async () => {
		const s = session();
		const out = await Promise.all([invoke(saveNote(jar(s))), invoke(dataRequest(jar(s))), invoke(saveNote(jar(s)))]);
		expect(out.map((r) => r.status)).toEqual([201, 201, 201]);
		expect(refreshCalls()).toHaveLength(1);
	});
	it.each([
		['refreshed cookies for another instance', (sid: string) => ({ status: 200, body: { object: 'cookies', cookies: [`__session=${C.token({ sub: sessions.get(sid)!.user_id, sid, azp: ORIGIN })}; Path=/`] } })],
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
