// Adverse classes found by the GRS-113 source review (M1, M2 and the in-scope Lows), through the pinned @clerk/backend with
// SYNTHETIC keys and a loopback Backend API. An anonymous caller may make a request fail as "sign in again" (401) and may
// never make it "unavailable" (503) or make the Worker call Clerk. Unit evidence for our adapter only.
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLERK_ENV, readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { clerkIdentityProviderFromEnv, presentedToken } from '../../../src/lib/auth/clerk/provider.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { craftedInstance, forgedToken, statusDouble } from './synthetic.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
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
const noKeys = () => env({ CLERK_CLIENT_JWT_KEY: undefined, CLERK_STAFF_JWT_KEY: undefined });
function provider(extra: Record<string, unknown> = {}) {
	const made = clerkIdentityProviderFromEnv(env(extra), { authorizeCase: async () => { throw contractError('forbidden'); } });
	if (!made.ok) throw new Error(made.reason);
	return made.provider;
}
const bearer = (token: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}`, ...headers } });
const good = (header?: Record<string, unknown>) => A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, header });
const claims = { azp: ORIGIN, sub: 'user_a1', sid: 'sess_a1', iss: A.iss, exp: 9e9, iat: 1, nbf: 1 };
const rsaPem = (bits: number) => generateKeyPairSync('rsa', { modulusLength: bits }).publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '');
const ecPem = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '');

/** A refused credential: authenticate resolves (never throws), anonymous, and every check is invalid-session (401). */
async function expectSignInAgain(request: Request) {
	const calls = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
	const identity = await provider().authenticate({ request });
	expect(identity.kind).toBe('anonymous');
	await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
	await expect(identity.authorize({ caseId: 'case-a1' as never, operation: 'read' })).rejects.toMatchObject({ code: 'invalid-session' });
	expect(status.calls.length, 'no Clerk Backend API call for a refused token').toBe(calls);
	expect(fetched, 'no SDK network call for a refused token').not.toHaveBeenCalled();
}

describe('M1: an algorithm, signature or header shape the SDK throws on is a 401, never an anonymous-induced 503', () => {
	it.each([
		['RS384', { alg: 'RS384' }], ['RS512', { alg: 'RS512' }], ['ES256', { alg: 'ES256' }], ['PS256', { alg: 'PS256' }],
		['HS256', { alg: 'HS256' }], ['none', { alg: 'none' }], ['a numeric alg', { alg: 256 }], ['a missing alg', { alg: undefined }],
		['a foreign typ', { typ: 'at+jwt' }], ['an object kid', { kid: { x: 1 } }], ['jku and x5u headers', { jku: 'https://attacker.example.test/jwks', x5u: 'https://attacker.example.test/x5' }],
	])('refuses a token with %s in its header (signature by the real key)', async (_name, header) => {
		await expectSignInAgain(bearer(good(header)));
	});
	it.each([
		['a null header', forgedToken(null, claims)], ['an array header', forgedToken([], claims)], ['a string header', forgedToken('RS256', claims)],
		['a null payload', forgedToken({ alg: 'RS256', typ: 'JWT' }, null)], ['an array payload', forgedToken({ alg: 'RS256', typ: 'JWT' }, [])],
		['a numeric payload', forgedToken({ alg: 'RS256', typ: 'JWT' }, 7)], ['a junk signature', forgedToken({ alg: 'RS256', typ: 'JWT' }, claims, 'AAAA')],
		['an empty signature', `${forgedToken({ alg: 'RS256', typ: 'JWT' }, claims).split('.').slice(0, 2).join('.')}.`],
		['two segments', 'aGVhZGVy.cGF5bG9hZA'], ['four segments', `${good()}.extra`], ['non-base64 segments', 'a!b.c!d.e!f-0123456789'],
	])('refuses a token with %s', async (_name, token) => {
		await expectSignInAgain(bearer(token));
	});
	it('refuses an RS384 or RS512 token at both instances, client and staff alike', async () => {
		await expectSignInAgain(bearer(B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, header: { alg: 'RS512' } })));
	});
	it('stays unavailable for a genuine Backend API fault: the token is good and the session lookup is down', async () => {
		status.outage(true);
		try {
			await expect(provider().authenticate({ request: bearer(good()) })).rejects.toMatchObject({ code: 'identity-unavailable', retryable: true });
		} finally {
			status.outage(false);
		}
	});
});

describe('M2: an unauthenticated unknown kid never makes the Worker call Clerk', () => {
	it('refuses a configuration with no JWT key for either instance, naming the variables, with no JWKS fallback', () => {
		const r = readClerkIdentityConfig(noKeys());
		expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(CLERK_ENV.client.jwtKey) });
		if (!r.ok) expect(r.reason).toContain(CLERK_ENV.staff.jwtKey);
		expect(clerkIdentityProviderFromEnv(noKeys(), { authorizeCase: async () => {} }).ok).toBe(false);
	});
	it('makes no Backend API or JWKS request for a burst of random kids, whatever mode the configuration allows', async () => {
		const made = clerkIdentityProviderFromEnv(noKeys(), { authorizeCase: async () => {} });
		const before = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		if (made.ok) await Promise.allSettled(Array.from({ length: 12 }, (_, i) => made.provider.authenticate({ request: bearer(A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, header: { kid: `ins_unknown_${i}` } })) })));
		expect(status.calls.slice(before).filter((c) => c.includes('/jwks')), 'JWKS requests').toEqual([]);
		expect(fetched).not.toHaveBeenCalled();
		expect(made.ok, 'a deployment without both JWT keys is not configured').toBe(false);
	});
	it('refuses 25 random-kid tokens with 401 and no Clerk request when the keys are configured', async () => {
		const p = provider(), before = status.calls.length, fetched = vi.spyOn(globalThis, 'fetch');
		for (let i = 0; i < 25; i++) {
			const identity = await p.authenticate({ request: bearer(A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, header: { kid: `ins_random_${i}` }, claims: { iss: 'https://elsewhere.clerk.test' } })) });
			expect(identity.kind).toBe('anonymous');
			await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
		}
		expect(status.calls.length).toBe(before);
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe('in-scope Lows: a configured key the SDK can use, exact audience, one consistent cookie rule', () => {
	it.each([['an EC P-256 key', ecPem()], ['an RSA-1024 key', rsaPem(1024)], ['an RSA-4096 key', rsaPem(4096)]])('refuses %s as a JWT key at configuration, naming the variable', (_name, pem) => {
		for (const name of [CLERK_ENV.client.jwtKey, CLERK_ENV.staff.jwtKey]) {
			const r = readClerkIdentityConfig(env({ [name]: pem }));
			expect(r, name).toMatchObject({ ok: false, reason: expect.stringContaining(name) });
			if (!r.ok) expect(r.reason).not.toContain(pem);
		}
	});
	it('requires the audience claim when one is configured, and ignores it when none is', async () => {
		const withAud = (aud?: unknown) => bearer(A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, claims: { aud } }));
		const audience = { CLERK_SESSION_AUDIENCE: 'clearcase-client-a' };
		expect((await provider(audience).authenticate({ request: withAud(undefined) })).kind).toBe('anonymous');
		expect((await provider(audience).authenticate({ request: withAud('someone-else') })).kind).toBe('anonymous');
		expect((await provider(audience).authenticate({ request: withAud('clearcase-client-a') })).kind).toBe('verified');
		expect((await provider().authenticate({ request: withAud(undefined) })).kind).toBe('verified');
		expect(readClerkIdentityConfig(env({ CLERK_SESSION_AUDIENCE: 'has space' })).ok).toBe(false);
	});
	it('refuses a session cookie carried under two names with different values, and never silently misses a joined Cookie header', () => {
		const t = good(), other = good({ kid: 'other' });
		const cookie = (value: string) => new Request(ORIGIN, { headers: { cookie: value } });
		expect(presentedToken(cookie(`__session=${t}; __session_AbCd1234=${t}`))).toBe(t);
		expect(presentedToken(cookie(`__session=${t}; __session_AbCd1234=${other}`))).toBe('malformed');
		expect(presentedToken(cookie(`__session_AbCd1234=${t}; __session_EfGh5678=${other}`))).toBe('malformed');
		expect(presentedToken(cookie(`theme=dark, __session=${t}`))).not.toBeNull();
		expect(presentedToken(cookie(`__session="${t}"`))).toBe('malformed');
		expect(presentedToken(cookie('theme=dark; locale=en'))).toBeNull();
	});
});
