// One cookie parsing policy for the Clerk identity (GRS-113): the Cookie header is read the way @clerk/backend reads it
// (split on ';', name and value trimmed of SP and HTAB only, a repeated name kept) and every decision that guards the SDK
// or names a credential uses that one reading: nonce preflight, handshake and refresh stripping, the dev browser, the
// presented session token and the cookie clears. Cookie suffixes are the SDK's base64url ones (8 characters of
// [A-Za-z0-9_-]), shared by session recognition, handshake sanitising, clears and the signed-out-session detector.
// SYNTHETIC keys, hosts and tokens; fetch is spied on, no provider is contacted, nothing here is wired-browser evidence.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clerkBrowserHandshakeFromEnv, clerkCookieClears, signOutClerkSession, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { clearableNames, cookiePairs, devBrowserOf, sdkCookieHeader } from '../../../src/lib/auth/clerk/flow.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { CLERK_COOKIE_NAME, REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME, presentedToken, sessionCookieNames } from '../../../src/lib/auth/clerk/session.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const ORIGIN = 'https://client-a.clearcase.test';
// Hosts whose publishable key gives a cookie suffix with an underscore (zW_MaF8B) and a hyphen (a3-vmljj), as the SDK derives it.
const U = craftedInstance('client-ae.clerk.test'), H = craftedInstance('client-ah.clerk.test'), B = craftedInstance('staff-b.clerk.test');
const suffix = (pk: string) => createHash('sha1').update(pk).digest('base64url').slice(0, 8);
const SU = suffix(U.publishableKey), SH = suffix(H.publishableKey);
const REFRESH = 'Zm9v+YmFy/YmF6cXV4+cXV1eA/c3ludGhldGljLXJlZnJlc2g=';
const NONCE = 'nonce_synthetic0123456789';
const DEV = 'dvb_synthetic0123456789abcdef';
const expired = Date.now() - 3_600_000;

let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_u1', 'user_u1');
	status.set('sess_h1', 'user_h1');
});
afterAll(() => status.close());
afterEach(() => vi.restoreAllMocks());

const env = (client: typeof U): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: client.publishableKey, CLERK_CLIENT_SECRET_KEY: client.secretKey, CLERK_CLIENT_JWT_KEY: client.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_API_URL: status.url,
});
const handshake = (client: typeof U) => {
	const made = clerkBrowserHandshakeFromEnv(env(client));
	if (!made.ok) throw new Error(made.reason);
	return made.handshake;
};
const page = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: { 'sec-fetch-dest': 'document', accept: 'text/html', ...(cookie ? { cookie } : {}) } });
const cookie = (value: string) => new Request(ORIGIN, { headers: { cookie: value } });
const redirectOf = (o: HandshakeOutcome) => {
	if (o.kind !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(o)}`);
	return o;
};
const tokenU = (now?: number) => U.token({ sub: 'user_u1', sid: 'sess_u1', azp: ORIGIN, now });
const tokenH = (now?: number) => H.token({ sub: 'user_h1', sid: 'sess_h1', azp: ORIGIN, now });
const T = tokenU();
const T2 = tokenH();

describe('the suffixes this probe relies on are the SDK ones', () => {
	it('has an underscore and a hyphen in the two derived suffixes', () => {
		expect(SU).toMatch(/_/);
		expect(SH).toMatch(/-/);
	});
});

describe('one reading of the Cookie header', () => {
	it('trims the name and the value of SP and HTAB only, like the SDK, and keeps repeated names', () => {
		expect(cookiePairs(cookie(`a =1; \t__refresh_x\t=2 ;__refresh_x=3`))).toEqual([{ name: 'a', value: '1' }, { name: '__refresh_x', value: '2' }, { name: '__refresh_x', value: '3' }]);
		expect(cookiePairs(cookie(' a=1; a\u000b=2')).map((c) => c.name)).toEqual([' a', 'a\u000b']);
	});
	it('builds the SDK Cookie header from the same reading, without the handshake cookie and the refresh cookies', () => {
		const header = (c: string) => sdkCookieHeader(cookie(c));
		expect(header(`__clerk_db_jwt=${DEV}; __client_uat=1`)).toBe(`__clerk_db_jwt=${DEV}; __client_uat=1`);
		expect(header(`__client_uat =1; __clerk_handshake\t=x; __refresh =r; __refresh_${SU}\t=r; __refresh_${SH} =r`)).toBe('__client_uat=1');
		// exact policy, not a prefix drop: look-alikes and everything else reach the SDK
		expect(header('__refreshing=1; __refresh.x=1; __refresh_a.b=1; __clerk_refresh=1; __refresh_=1; __clerk_handshakes=1; theme=dark'))
			.toBe('__refreshing=1; __refresh.x=1; __refresh_a.b=1; __clerk_refresh=1; __refresh_=1; __clerk_handshakes=1; theme=dark');
		expect(header(`__refresh_${'a'.repeat(33)}=1`)).toBe(`__refresh_${'a'.repeat(33)}=1`);
	});
});

describe('cookie-name whitespace cannot defeat the handshake boundary', () => {
	// the SDK refreshes an expired unsuffixed session through the Backend API when it finds `__refresh_<suffix>` of its instance
	const hostile = (s: string) => [
		['SP before =', `__refresh_${s} =${REFRESH}`], ['HTAB before =', `__refresh_${s}\t=${REFRESH}`], ['leading and trailing SP and HTAB', ` \t__refresh_${s} \t=${REFRESH}`],
		['HTAB after =', `__refresh_${s}=\t${REFRESH}`], ['the plain name', `__refresh_${s}=${REFRESH}`],
	] as const;
	it.each([['underscore', U, SU, tokenU], ['hyphen', H, SH, tokenH]] as const)('makes no Backend API call for a refresh cookie, however its name is spaced, next to an expired session (%s suffix)', async (_name, client, s, token) => {
		for (const [what, refresh] of hostile(s)) {
			const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
			const o = redirectOf(await handshake(client).handle(page('/cases', `__clerk_db_jwt=${DEV}; __client_uat=1761400000; __session=${token(expired)}; ${refresh}`)));
			expect(new URL(o.location).pathname, what).toBe('/v1/client/handshake');
			expect(status.calls.slice(calls), what).toEqual([]);
			expect(fetched, what).not.toHaveBeenCalled();
			fetched.mockRestore();
		}
	});
	it.each([
		['SP before =', '__clerk_handshake_nonce =' + NONCE], ['HTAB before =', '__clerk_handshake_nonce\t=' + NONCE], ['SP and HTAB around the name', ' \t__clerk_handshake_nonce \t=' + NONCE],
		['the plain name', '__clerk_handshake_nonce=' + NONCE],
	])('refuses the nonce format when the cookie name has %s, with no Backend API call', async (_name, nonce) => {
		const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		expect(await handshake(U).handle(page('/cases', `__clerk_db_jwt=${DEV}; ${nonce}`))).toEqual({ kind: 'refuse', status: 400, code: 'handshake-format-unsupported' });
		expect(status.calls.slice(calls)).toEqual([]);
		expect(fetched).not.toHaveBeenCalled();
	});
	it('treats a handshake cookie with whitespace in its name as the handshake cookie, which never reaches the SDK', async () => {
		const token = U.sign({ handshake: [`__session=${T}; Path=/`, '__client_uat=1761400000; Path=/'] });
		const plain = await handshake(U).handle(page('/cases', `__clerk_handshake=${token}; __clerk_db_jwt=${DEV}`));
		const spaced = await handshake(U).handle(page('/cases', `__clerk_handshake =${token}; __clerk_db_jwt=${DEV}`));
		const tabbed = await handshake(U).handle(page('/cases', `__clerk_db_jwt=${DEV}; \t__clerk_handshake\t=${token}`));
		expect(plain.kind).toBe('redirect');
		expect(spaced).toEqual(plain);
		expect(tabbed).toEqual(plain);
		expect(redirectOf(plain).setCookies.every((c) => !c.startsWith('__session='))).toBe(true);
	});
	it('keeps an unrelated look-alike cookie out of the refresh policy: it reaches the SDK and changes nothing', async () => {
		const o = await handshake(U).handle(page('/cases', `__clerk_db_jwt=${DEV}; __client_uat=1761400000; __session=${T}; __refreshing=1; __refresh.x=1`));
		expect(o).toEqual({ kind: 'continue' });
	});
});

describe('the dev browser is one cookie by the SDK reading', () => {
	it.each([
		[`__clerk_db_jwt=one; __clerk_db_jwt =two`], [`__clerk_db_jwt=one; __clerk_db_jwt\t=two`], [`__clerk_db_jwt=one; \t__clerk_db_jwt \t=one`],
		[`__clerk_db_jwt =one; __clerk_db_jwt=two`], [`__clerk_db_jwt=one; __clerk_db_jwt=two`],
	])('is ambiguous, so none, for %s', (c) => expect(devBrowserOf(cookie(c))).toBeNull());
	it.each([
		[`__clerk_db_jwt =${DEV}`], [`__clerk_db_jwt\t=${DEV}`], [` \t__clerk_db_jwt \t= \t${DEV} \t`], [`theme=dark; __clerk_db_jwt =${DEV}`],
	])('is the one value, trimmed, for %s', (c) => expect(devBrowserOf(cookie(c))).toBe(DEV));
	it('is none for an absent one and for a suffixed name', () => {
		expect(devBrowserOf(cookie('theme=dark'))).toBeNull();
		expect(devBrowserOf(cookie(`__clerk_db_jwt_${SU}=${DEV}`))).toBeNull();
	});
});

describe('the base64url suffix grammar is one grammar', () => {
	const suffixes = [SU, SH, '_', '-', '__', 'a-b_c', 'A'.repeat(32)];
	it.each(suffixes)('recognises every Clerk name with the suffix %s', (s) => {
		expect(SESSION_COOKIE_NAME.test(`__session_${s}`)).toBe(true);
		for (const n of ['__session', '__client_uat', '__clerk_db_jwt', '__clerk_redirect_count']) {
			expect(CLERK_COOKIE_NAME.test(n)).toBe(true);
			expect(CLERK_COOKIE_NAME.test(`${n}_${s}`)).toBe(true);
		}
		expect(REFRESH_COOKIE_NAME.test(`__refresh_${s}`)).toBe(true);
	});
	it.each(['__session_', '__session_a.b', '__session-a', '__sessionx', 'x__session', '__session_a b', `__session_${'a'.repeat(33)}`, '__session_é', '__Session', '__session__session='])('does not recognise %s as a session cookie', (n) => {
		expect(SESSION_COOKIE_NAME.test(n)).toBe(false);
		expect(CLERK_COOKIE_NAME.test(n)).toBe(false);
		expect(sessionCookieNames(cookie(`${n}=${T}`))).toEqual([]);
		expect(clearableNames(cookie(`${n}=${T}`))).toEqual([]);
		expect(presentedToken(cookie(`${n}=${T}`))).toBeNull();
	});
	it.each(['__refresh', '__refresh_a', `__refresh_${SU}`, `__refresh_${SH}`])('recognises %s as a refresh cookie', (n) => expect(REFRESH_COOKIE_NAME.test(n)).toBe(true));
	it.each(['__refreshing', '__refresh_', '__refresh_a.b', '__refresh-a', '__clerk_refresh', `__refresh_${'a'.repeat(33)}`])('does not recognise %s as a refresh cookie', (n) => expect(REFRESH_COOKIE_NAME.test(n)).toBe(false));

	it.each([[SU], [SH]])('reads the one session token under the suffixed name _%s, and refuses duplicates and different credentials', (s) => {
		expect(sessionCookieNames(cookie(`theme=dark; __session_${s}=${T}`))).toEqual([`__session_${s}`]);
		expect(presentedToken(cookie(`theme=dark; __session_${s}=${T}`))).toBe(T);
		expect(presentedToken(cookie(`__session=${T}; __session_${s}=${T}`))).toBe(T);
		expect(presentedToken(cookie(`__session=${T}; __session_${s}=${T2}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session_${s}=${T}; __session_${s}=${T}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session_${s}=${T}; __session_ab-cd_EF=${T2}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session_${s}="${T}"`))).toBe('malformed');
		expect(presentedToken(new Request(ORIGIN, { headers: { authorization: `Bearer ${T2}`, cookie: `__session_${s}=${T}` } }))).toBe('malformed');
		expect(presentedToken(cookie(`theme=dark, __session_${s}=${T}`))).toBe('malformed');
	});
	it('reads a session token by the SDK name reading: SP and HTAB around the name and value, never other characters', () => {
		expect(presentedToken(cookie(`__session =${T}`))).toBe(T);
		expect(presentedToken(cookie(`__session_${SH}\t=\t${T}`))).toBe(T);
		expect(presentedToken(cookie(` \t__session \t=${T}; theme=dark`))).toBe(T);
		expect(presentedToken(cookie(`__session=${T}; __session =${T2}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session=${T}; __session\t=${T}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session_${SU}=${T}; __session_${SU} =${T}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session =${T}`))).toBeNull();
		expect(presentedToken(cookie(`\u000b__session=${T}`))).toBeNull();
	});
	it('clears exactly the session and client_uat cookies it carries, hyphen and underscore suffixes included, and nothing else', () => {
		const names = (c: string) => clerkCookieClears(cookie(c), true).map((d) => d.split('=')[0]).sort();
		expect(names(`__session_${SU}=${T}; __client_uat_${SU}=1; __session_${SH}=${T}; __client_uat_${SH}=1; __client_uat_-=1; __session__=${T}`))
			.toEqual([`__client_uat_${SH}`, `__client_uat_${SU}`, '__client_uat_-', `__session_${SH}`, `__session_${SU}`, '__session__'].sort());
		expect(names(`__clerk_db_jwt_${SU}=${DEV}; __refresh_${SU}=r; __session_a.b=1; __client_uat-x=1; __sessionx=1; theme=dark`)).toEqual([]);
		for (const d of clerkCookieClears(cookie(`__session_${SH}=${T}; __client_uat_${SH}=1`), false)) expect(d).toBe(d.startsWith('__session') ? `__session_${SH}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` : `__client_uat_${SH}=; Path=/; Max-Age=0; SameSite=Lax`);
	});
	it('clears the canonical name of a cookie whose name carries SP or HTAB', () => {
		const names = (c: string) => clerkCookieClears(cookie(c), true).map((d) => d.split('=')[0]);
		expect(names(`__session =${T}; __client_uat\t=1; \t__session_${SH} =${T}; __session=${T}`)).toEqual(['__session', '__client_uat', `__session_${SH}`]);
		expect(clearableNames(cookie(`__session\t=${T}`))).toEqual(['__session']);
	});
	it('signs out a caller with a suffixed hyphen or underscore session, naming its cookies to clear', async () => {
		const identity = { kind: 'anonymous' as const, principal: null, sessionId: null };
		const r = await signOutClerkSession({ env: env(U), request: cookie(`__session_${SU}=x; __client_uat_${SH}\t=1; theme=dark`), identity });
		expect(r).toEqual({ revoked: false, clear: [`__session_${SU}`, `__client_uat_${SH}`] });
	});
});

describe('a handshake with base64url-suffixed cookies', () => {
	const identityOf = async (client: typeof U, jar: string) => {
		const made = clerkIdentityProviderFromEnv(env(client), { authorizeCase: async () => {} });
		if (!made.ok) throw new Error(made.reason);
		return made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { cookie: jar } }) });
	};
	const suffixed = (s: string, session: string) => [
		`__client_uat_${s}=; Path=/; Domain=clearcase.test; Max-Age=0; SameSite=Lax`,
		`__client_uat_${s}=1761400000; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure`,
		`__session_${s}=${session}; Path=/; Domain=clearcase.test; Max-Age=60; SameSite=Lax; Secure`,
		`__refresh_${s}=${REFRESH}; Path=/; Domain=clearcase.test; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure`,
		'__clerk_db_jwt=dvb_synthetic0123456789abcdef; Path=/; Max-Age=315360000; SameSite=Lax; Secure',
	];
	it.each([['an underscore', U, SU, tokenU], ['a hyphen', H, SH, tokenH]] as const)('signs a browser in whose cookie suffix has %s, storing the session and never the refresh token', async (_name, client, s, token) => {
		const session = token();
		const o = redirectOf(await handshake(client).handle(page(`/cases?__clerk_handshake=${client.sign({ handshake: suffixed(s, session) })}`)));
		expect(o.location).toBe(`${ORIGIN}/cases`);
		expect(o.setCookies.map((c) => c.split('=')[0])).toEqual([`__client_uat_${s}`, `__client_uat_${s}`, `__session_${s}`, '__clerk_db_jwt']);
		expect(o.setCookies.join('\n')).not.toContain(REFRESH);
		for (const c of o.setCookies) expect(c).not.toMatch(/Domain=/i);
		expect(o.setCookies[2]).toBe(`__session_${s}=${session}; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure`);
		const jar = o.setCookies.slice(1).map((c) => c.split(';')[0]).join('; ');
		expect(await identityOf(client, jar)).toMatchObject({ kind: 'verified', principal: { kind: 'client', subject: client === U ? 'user_u1' : 'user_h1' } });
		expect(await handshake(client).handle(page('/cases', jar))).toEqual({ kind: 'continue' });
	});
	it.each([['underscore', U, SU], ['hyphen', H, SH]] as const)('still refuses a malformed %s suffix, a suffix over 32 characters and an unknown suffixed name', async (_name, client, s) => {
		for (const bad of [`__session_${s}.x`, `__session_${'a'.repeat(33)}`, `__clerk_session_${s}`, `__sessionx`]) {
			const directives = suffixed(s, client === U ? tokenU() : tokenH()).map((d, i) => (i === 2 ? d.replace(`__session_${s}=`, `${bad}=`) : d));
			expect(await handshake(client).handle(page(`/cases?__clerk_handshake=${client.sign({ handshake: directives })}`)), bad).toEqual({ kind: 'refuse', status: 502, code: 'handshake-cookie-refused' });
		}
	});
	it.each([['underscore', U, SU], ['hyphen', H, SH]] as const)('refuses a non-empty %s-suffixed session cookie from a handshake that did not sign in', async (_name, client, s) => {
		const token = client.sign({ handshake: suffixed(s, client === U ? tokenU(expired) : tokenH(expired)) });
		expect(await handshake(client).handle(page(`/cases?__clerk_handshake=${token}`))).toEqual({ kind: 'refuse', status: 502, code: 'handshake-cookie-refused' });
	});
});
