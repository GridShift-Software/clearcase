import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
// The first-party browser contract of the Clerk identity (GRS-113), as the hosting hook will call it: the handshake that
// puts a session cookie on THIS origin, the identity switch between client and staff, safe return targets and sign-out.
// SYNTHETIC keys, a synthetic Frontend API host and a loopback Backend API. The unit contract only: no real Clerk
// handshake, browser, cookie jar or CSP has run, so none of this is wired-browser evidence.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clerkBrowserHandshakeFromEnv, clerkCookieClears, handshakeResponse, planSignIn, safeReturnTo, signOutClerkSession, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';
import { bindingStarted, clientTie, consumed, startedBound } from './started-here.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('client-c.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_a1', 'user_a1');
	status.set('sess_b1', 'user_b1');
});
afterAll(() => status.close());
afterEach(() => vi.restoreAllMocks());

const env = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_API_URL: status.url, ...extra,
});
function handshake(extra: Record<string, unknown> = {}) {
	const made = clerkBrowserHandshakeFromEnv(env(extra));
	if (!made.ok) throw new Error(made.reason);
	return bindingStarted(made.handshake, env(extra));
}
const doc = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const page = (path: string, cookie?: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers: { ...doc, ...(cookie ? { cookie } : {}), ...headers } });
const tokenA = (sid = 'sess_a1', now?: number) => A.token({ sub: 'user_a1', sid, azp: ORIGIN, now });
const tokenB = (now?: number) => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, now });
const expired = Date.now() - 3_600_000;
const redirectOf = (o: HandshakeOutcome) => {
	if (o.kind !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(o)}`);
	return o;
};

describe('the handshake that returns a session cookie to this origin', () => {
	it('sends a browser with no session to its own Clerk instance handshake and back to the same page, never with a nonce format', async () => {
		const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		const o = startedBound(redirectOf(await handshake().handle(page('/cases?tab=1'))));
		const to = new URL(o.location);
		expect(`${to.origin}${to.pathname}`).toBe('https://client-a.clerk.test/v1/client/handshake');
		// marked, so a return the browser kept no cookies of stops (heavy review M2)
		expect(to.searchParams.get('redirect_url')).toBe(`${ORIGIN}/cases?tab=1&__clearcase_reauth=1`);
		expect(to.searchParams.has('format')).toBe(false);
		expect(o.location).not.toContain(A.secretKey);
		expect(o.setCookies.every((c) => /^__clerk_redirect_count=\d+; Path=\/; /.test(c) && /HttpOnly/.test(c) && /Secure/.test(c) && !/Domain=/i.test(c))).toBe(true);
		expect(status.calls.length).toBe(calls);
		expect(fetched).not.toHaveBeenCalled();
	});
	it('applies the cookies of a verified handshake token host-only, and the session it sets signs the user in at this origin', async () => {
		const session = tokenA();
		const handshakeToken = A.sign({ iss: A.iss, handshake: [`__session=${session}; Path=/; Max-Age=60; Domain=.attacker.example.test; SameSite=None; Secure`, '__client_uat=1700000000; Path=/; Domain=.attacker.example.test'] });
		const o = consumed(redirectOf(await handshake().handle(page(`/cases?__clerk_handshake=${handshakeToken}`, '__client_uat=1699999999'))));
		expect(o.location).toBe(`${ORIGIN}/cases`);
		const jar = o.setCookies.map((c) => c.split(';')[0]).join('; ');
		expect(jar).toBe(`__session=${session}; __client_uat=1700000000`);
		for (const c of o.setCookies) {
			expect(c).not.toMatch(/Domain=/i);
			expect(c).toMatch(/; Path=\//);
			expect(c).toMatch(/; Secure/);
			expect(c).toMatch(/; SameSite=Lax/);
		}
		expect(o.setCookies[0]).toMatch(/; HttpOnly/);
		const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => { throw contractError('forbidden'); } });
		if (!made.ok) throw new Error(made.reason);
		const identity = await made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { cookie: jar } }) });
		expect(identity).toMatchObject({ kind: 'verified', principal: { kind: 'client', subject: 'user_a1' }, sessionId: 'sess_a1' });
	});
	it.each([
		['a handshake signed by another instance', () => C.sign({ handshake: [`__session=${tokenA()}; Path=/`] })],
		['a handshake for a session token another instance signed', () => A.sign({ handshake: [`__session=${C.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN })}; Path=/`] })],
		['a cookie name outside the Clerk set', () => A.sign({ handshake: ['theme=dark; Path=/'] })],
		['a session cookie that is not a token', () => A.sign({ handshake: ['__session=not-a-token-at-all-1234; Path=/'] })],
		['a malformed handshake token', () => 'not.a.handshake'],
	])('refuses %s and sets no cookie', async (_name, token) => {
		const o = await handshake().handle(page(`/cases?__clerk_handshake=${token()}`));
		expect(o).toMatchObject({ kind: 'refuse' });
		expect(JSON.stringify(o)).not.toContain('Set-Cookie');
	});
	it('never resolves a handshake nonce, which would cost one Backend API call per request', async () => {
		const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		for (const request of [page('/cases?__clerk_handshake_nonce=zzz'), page('/cases', '__clerk_handshake_nonce=zzz')]) expect(await handshake().handle(request)).toMatchObject({ kind: 'refuse' });
		expect(status.calls.length).toBe(calls);
		expect(fetched).not.toHaveBeenCalled();
	});
	it('continues for anything that is not a document GET, and refuses a request that is not for this origin', async () => {
		expect(await handshake().handle(new Request(`${ORIGIN}/cases`, { headers: { accept: 'application/json', 'sec-fetch-dest': 'empty' } }))).toEqual({ kind: 'continue' });
		expect(await handshake().handle(new Request(`${ORIGIN}/cases`, { method: 'POST', headers: doc }))).toEqual({ kind: 'continue' });
		expect(await handshake().handle(new Request('https://attacker.example.test/cases', { headers: doc }))).toMatchObject({ kind: 'refuse' });
		expect(await handshake().handle(page('/cases', undefined, { 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'https' }))).toMatchObject({ kind: 'redirect' });
		const o = startedBound(redirectOf(await handshake().handle(page('/cases', undefined, { 'x-forwarded-host': 'attacker.example.test' }))));
		expect(new URL(o.location).searchParams.get('redirect_url')).toBe(`${ORIGIN}/cases?__clearcase_reauth=1`);
	});
	it('continues without a redirect for a browser that holds a live session', async () => {
		// with the dev browser its own client handshake tied here (GRS-279, client-signin-tie.test.ts)
		expect(await handshake().handle(page('/cases', `__clerk_db_jwt=abc; ${await clientTie(env(), 'abc')}; __client_uat=1700000000; __session=${tokenA()}`))).toEqual({ kind: 'continue' });
	});
	it('picks the staff instance for the operator route and for a stale staff session, the client instance otherwise', async () => {
		const host = async (r: Request) => new URL(redirectOf(await handshake().handle(r)).location).host;
		expect(await host(page('/sign-in/operator'))).toBe('staff-b.clerk.test');
		expect(await host(page('/cases', `__client_uat=1700000000; __session=${tokenB(expired)}`))).toBe('staff-b.clerk.test');
		expect(await host(page('/cases', `__client_uat=1700000000; __session=${tokenA('sess_a1', expired)}`))).toBe('client-a.clerk.test');
		expect(await host(page('/cases', `__client_uat=1700000000; __session=${C.token({ sub: 'x', sid: 'y', azp: ORIGIN, now: expired })}`))).toBe('client-a.clerk.test');
	});
	it('turns an outcome into a no-store 303 carrying every cookie, and a refusal into a bare error status', () => {
		const r = handshakeResponse({ kind: 'redirect', location: `${ORIGIN}/cases`, setCookies: ['a=1; Path=/', 'b=2; Path=/'] });
		expect(r?.status).toBe(303);
		expect(r?.headers.get('location')).toBe(`${ORIGIN}/cases`);
		expect(r?.headers.get('cache-control')).toBe('no-store');
		expect(r?.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		expect(handshakeResponse({ kind: 'continue' })).toBeNull();
		expect(handshakeResponse({ kind: 'refuse', status: 400, code: 'handshake-invalid' })?.status).toBe(400);
	});
});

describe('one browser session per origin: signing in as the other identity signs the first out, and ambiguity refuses', () => {
	const verified = (kind: 'client' | 'staff') => ({ kind: 'verified' as const, principal: { issuer: kind === 'client' ? A.iss : B.iss, subject: 'u', kind } });
	const anonymous = { kind: 'anonymous' as const, principal: null };
	it('plans the switch', () => {
		expect(planSignIn({ target: 'client', identity: anonymous, credential: null })).toEqual({ action: 'proceed' });
		expect(planSignIn({ target: 'client', identity: anonymous, credential: tokenA('sess_a1', expired) })).toEqual({ action: 'proceed' });
		expect(planSignIn({ target: 'client', identity: verified('client'), credential: 'x'.repeat(20) })).toEqual({ action: 'proceed' });
		expect(planSignIn({ target: 'staff', identity: verified('client'), credential: 'x'.repeat(20) })).toEqual({ action: 'sign-out-first', current: 'client' });
		expect(planSignIn({ target: 'client', identity: verified('staff'), credential: 'x'.repeat(20) })).toEqual({ action: 'sign-out-first', current: 'staff' });
		expect(planSignIn({ target: 'client', identity: anonymous, credential: 'malformed' })).toEqual({ action: 'refuse', reason: 'ambiguous-credential' });
		expect(planSignIn({ target: 'staff', identity: verified('client'), credential: 'malformed' })).toEqual({ action: 'refuse', reason: 'ambiguous-credential' });
	});
	it('allowlists return targets to a same-origin path', () => {
		for (const ok of ['/cases', '/cases/case-a1?tab=1#x']) expect(safeReturnTo(ok)).toBe(ok);
		for (const bad of ['//attacker.example.test', 'https://attacker.example.test/cases', '/\\attacker.example.test', '\\\\attacker', 'javascript:alert(1)', '/cases\r\nSet-Cookie: x=1', '', null, undefined, 7, '/sign-out'])
			expect(safeReturnTo(bad as never), String(bad)).toBe('/cases');
	});
	it('clears exactly the Clerk cookies a request carries', () => {
		const names = (c: string) => clerkCookieClears(new Request(ORIGIN, { headers: { cookie: c } }), true).map((d) => d.split('=')[0]).sort();
		expect(names('theme=dark; __session=a; __client_uat=1; __session_AbCd1234=b; __client_uat_AbCd1234=1')).toEqual(['__client_uat', '__client_uat_AbCd1234', '__session', '__session_AbCd1234']);
		expect(names('theme=dark')).toEqual([]);
		for (const d of clerkCookieClears(new Request(ORIGIN, { headers: { cookie: '__session=a' } }), true)) expect(d).toMatch(/^__session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
	});
});

describe('sign-out: revoke the right Clerk session at its own instance, then name the cookies to clear', () => {
	const identityOf = async (token: string) => {
		const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
		if (!made.ok) throw new Error(made.reason);
		return made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}` } }) });
	};
	const cookieReq = (cookie: string) => new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie } });
	it('revokes a client session with the client instance key, then lists the session cookies the request carried', async () => {
		status.set('sess_out_a', 'user_a1');
		const identity = await identityOf(A.token({ sub: 'user_a1', sid: 'sess_out_a', azp: ORIGIN }));
		const r = await signOutClerkSession({ env: env(), request: cookieReq('__session=x; __client_uat=1; theme=dark'), identity });
		expect(r).toEqual({ revoked: true, clear: ['__session', '__client_uat'] });
		expect(status.calls.filter((c) => c.includes('POST /v1/sessions/sess_out_a/revoke auth'))).toHaveLength(1);
		await expect((await identityOf(A.token({ sub: 'user_a1', sid: 'sess_out_a', azp: ORIGIN }))).checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
	});
	it('revokes a staff session at the staff instance', async () => {
		status.set('sess_out_b', 'user_b1');
		const identity = await identityOf(B.token({ sub: 'user_b1', sid: 'sess_out_b', azp: ORIGIN }));
		await expect(signOutClerkSession({ env: env(), request: cookieReq('__session=x'), identity })).resolves.toMatchObject({ revoked: true });
		expect(status.calls.some((c) => c.includes('POST /v1/sessions/sess_out_b/revoke'))).toBe(true);
	});
	it('revokes nothing for an anonymous caller but still clears its Clerk cookies', async () => {
		const before = status.calls.length;
		const identity = await identityOf('x'.repeat(20));
		await expect(signOutClerkSession({ env: env(), request: cookieReq('__session=stale'), identity })).resolves.toEqual({ revoked: false, clear: ['__session'] });
		expect(status.calls.length).toBe(before);
	});
	it('fails closed, clearing nothing, when the revocation cannot be confirmed or Clerk is not configured', async () => {
		status.set('sess_out_c', 'user_a1');
		const identity = await identityOf(A.token({ sub: 'user_a1', sid: 'sess_out_c', azp: ORIGIN }));
		status.outage(true);
		try {
			await expect(signOutClerkSession({ env: env(), request: cookieReq('__session=x'), identity })).rejects.toMatchObject({ code: 'identity-unavailable' });
		} finally {
			status.outage(false);
		}
		await expect(signOutClerkSession({ env: {}, request: cookieReq('__session=x'), identity })).rejects.toMatchObject({ code: 'identity-unavailable' });
	});
});

// The shapes a real development handshake returned (GRS-113, 25 Oct): a payload holding only `handshake`, five directives
// (__client_uat cleared then set, __session, __refresh_<suffix> with a standard-base64 value, __clerk_db_jwt). Names and
// value classes only; every value here is synthetic.
describe('the cookies a real development handshake returns', () => {
	const suffix = (pk: string) => createHash('sha1').update(pk).digest('base64url').slice(0, 8);
	const REFRESH = 'Zm9v+YmFy/YmF6cXV4+cXV1eA/c3ludGhldGljLXJlZnJlc2g=';
	const real = (session: string, refresh = `__refresh_${suffix(A.publishableKey)}`) => [
		'__client_uat=; Path=/; Domain=clearcase.test; Max-Age=0; SameSite=Lax',
		'__client_uat=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure',
		`__session=${session}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`,
		`${refresh}=${REFRESH}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
		'__clerk_db_jwt=dvb_synthetic0123456789abcdef; Path=/; Max-Age=315360000; SameSite=Lax; Secure',
	];
	const identityOf = async (jar: string) => {
		const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
		if (!made.ok) throw new Error(made.reason);
		return made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { cookie: jar } }) });
	};
	const SESSION_CATEGORY = { cat: 'cl_B7d4PD111AAA' };

	it('signs the browser in from the real directive set, storing the session and the instance refresh token HttpOnly', async () => {
		const session = tokenA();
		const o = consumed(redirectOf(await handshake().handle(page(`/cases?__clerk_handshake=${A.sign({ handshake: real(session) })}`))));
		expect(o.location).toBe(`${ORIGIN}/cases`);
		const names = o.setCookies.map((c) => c.split('=')[0]);
		// the dev browser of a client handshake this browser started is tied to the client instance (GRS-279)
		expect(names).toEqual(['__client_uat', '__client_uat', '__session', '__clerk_db_jwt', '__Host-clearcase_dvb', '__Host-clearcase_refresh']);
		expect(o.setCookies.slice(0, 5).join('\n')).not.toContain(REFRESH);
		expect(o.setCookies[5]).toMatch(new RegExp(`^__Host-clearcase_refresh=${session}~${REFRESH.replace(/[+/=]/g, '\\$&')}; Path=/; Max-Age=\\d+; SameSite=Lax; HttpOnly; Secure$`));
		for (const c of o.setCookies) expect(c).not.toMatch(/Domain=/i);
		expect(o.setCookies[2]).toMatch(/^__session=[^;]+; Path=\/; Max-Age=60; SameSite=Lax; HttpOnly; Secure$/);
		const jar = o.setCookies.slice(1).map((c) => c.split(';')[0]).join('; ');
		expect(await identityOf(jar)).toMatchObject({ kind: 'verified', principal: { kind: 'client', subject: 'user_a1' }, sessionId: 'sess_a1' });
	});
	it('signs in with a session token carrying the session-token category in its header', async () => {
		const session = A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, header: SESSION_CATEGORY });
		const o = redirectOf(await handshake().handle(page(`/cases?__clerk_handshake=${A.sign({ handshake: real(session) }, SESSION_CATEGORY)}`)));
		expect(o.setCookies.some((c) => c.startsWith(`__session=${session};`))).toBe(true);
		expect(await identityOf(`__session=${session}`)).toMatchObject({ kind: 'verified', principal: { kind: 'client', subject: 'user_a1' } });
		expect(await handshake().handle(page('/cases', `__clerk_db_jwt=dvb_synthetic0123456789abcdef; ${await clientTie(env(), 'dvb_synthetic0123456789abcdef')}; __client_uat=1761400000; __session=${session}`))).toEqual({ kind: 'continue' });
	});
	it.each([
		['an M2M token', 'cl_B7d4PD333AAA'], ['a JWT template token', 'cl_B7d4PD222AAA'], ['the ignore category', 'cl_I7d4PD111III'],
		['an unknown category', 'cl_B7d4PD999AAA'], ['a numeric category', 7], ['an empty category', ''],
	])('still refuses a session token whose header names %s', async (_name, cat) => {
		const session = A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, header: { cat } });
		expect(await handshake().handle(page(`/cases?__clerk_handshake=${A.sign({ handshake: real(session) })}`))).toMatchObject({ kind: 'refuse' });
		expect(await identityOf(`__session=${session}`)).toMatchObject({ kind: 'anonymous' });
	});
	it.each([
		['a refresh-like name', '__refreshing'], ['a refresh name with a dotted suffix', '__refresh_a.b'], ['a foreign prefix', '__clerk_refresh'],
		['a suffix over 32 characters', `__refresh_${'a'.repeat(33)}`], ['an unknown Clerk-like name', '__clerk_session'],
	])('still refuses the whole handshake for %s', async (_name, name) => {
		expect(await handshake().handle(page(`/cases?__clerk_handshake=${A.sign({ handshake: real(tokenA(), name) })}`))).toEqual({ kind: 'refuse', status: 502, code: 'handshake-cookie-refused' });
	});
	it('refuses a handshake that returns only a refresh token, which sets nothing', async () => {
		const only = A.sign({ handshake: [real(tokenA())[3]!] });
		expect(await handshake().handle(page(`/cases?__clerk_handshake=${only}`))).toEqual({ kind: 'refuse', status: 400, code: 'handshake-invalid' });
	});
	it('never lets a presented refresh cookie make the Worker call the Backend API, and hands an expired session to the handshake', async () => {
		const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		const cookie = `__clerk_db_jwt=dvb_synthetic0123456789abcdef; __client_uat=1761400000; __session=${tokenA('sess_a1', expired)}; __refresh_${suffix(A.publishableKey)}=${REFRESH}; __refresh=${REFRESH}`;
		const o = redirectOf(await handshake().handle(page('/cases', cookie)));
		expect(`${new URL(o.location).origin}${new URL(o.location).pathname}`).toBe('https://client-a.clerk.test/v1/client/handshake');
		expect(status.calls.length).toBe(calls);
		expect(fetched).not.toHaveBeenCalled();
	});
});

// A staff browser comes back from the staff portal to /cases with no staff session yet: only the signed handshake token
// shows which instance answered. The pick follows a signature that verifies with a configured key, never the URL alone.
describe('the instance a returning handshake belongs to', () => {
	const staffSession = () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN });
	const identityOf = async (jar: string) => {
		const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
		if (!made.ok) throw new Error(made.reason);
		return made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { cookie: jar } }) });
	};
	// the cookies a browser keeps from the answer: a directive that expires one (Max-Age=0) sets nothing
	const jarOf = (o: HandshakeOutcome) => redirectOf(o).setCookies.filter((c) => !/;\s*Max-Age=0(;|$)/i.test(c)).map((c) => c.split(';')[0]).join('; ');

	it('applies a staff-signed handshake on /cases for a browser with no session, as a staff session', async () => {
		const o = await handshake().handle(page(`/cases?__clerk_handshake=${B.sign({ handshake: [`__session=${staffSession()}; Path=/`, '__client_uat=1761400000; Path=/'] })}`));
		expect(redirectOf(o).location).toBe(`${ORIGIN}/cases`);
		expect(await identityOf(jarOf(o))).toMatchObject({ kind: 'verified', principal: { kind: 'staff', subject: 'user_b1' } });
	});
	it('follows the verified signer over a stale session of the other instance', async () => {
		const o = await handshake().handle(page(`/cases?__clerk_handshake=${A.sign({ handshake: [`__session=${tokenA()}; Path=/`] })}`, `__client_uat=1; __session=${tokenB(expired)}`));
		expect(await identityOf(jarOf(o))).toMatchObject({ kind: 'verified', principal: { kind: 'client' } });
	});
	it.each([
		['signed by an unconfigured instance', () => C.sign({ handshake: [`__session=${staffSession()}; Path=/`] })],
		['staff-signed but carrying a client session', () => B.sign({ handshake: [`__session=${tokenA()}; Path=/`] })],
		['client-signed but carrying a staff session', () => A.sign({ handshake: [`__session=${staffSession()}; Path=/`] })],
		['with a staff header and a client signature', () => `${B.sign({ handshake: [] }).split('.')[0]}.${A.sign({ handshake: [`__session=${tokenA()}; Path=/`] }).split('.').slice(1).join('.')}`],
		['an unsigned token', () => `${B.sign({ handshake: [`__session=${staffSession()}; Path=/`] }).split('.').slice(0, 2).join('.')}.`],
	])('sets no session for a handshake %s', async (_name, token) => {
		const o = await handshake().handle(page(`/cases?__clerk_handshake=${token()}`));
		if (o.kind === 'redirect') expect(await identityOf(jarOf(o))).toMatchObject({ kind: 'anonymous' });
		else expect(o).toMatchObject({ kind: 'refuse' });
	});
	it('keeps the operator route on the staff instance even for a client-signed handshake', async () => {
		expect(await handshake().handle(page(`/sign-in/operator?__clerk_handshake=${A.sign({ handshake: [`__session=${tokenA()}; Path=/`] })}`))).toMatchObject({ kind: 'refuse' });
	});
	it('still sends a browser with no session and no handshake token to the client instance, whatever the query says', async () => {
		const host = async (r: Request) => new URL(redirectOf(await handshake().handle(r)).location).host;
		expect(await host(page('/cases?kind=staff&__clerk_db_jwt=dvb_synthetic0123456789abcdef'))).toBe('client-a.clerk.test');
	});
});
