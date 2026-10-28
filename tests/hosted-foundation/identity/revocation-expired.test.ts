import { legacyClerkProviderFromEnv as clerkIdentityProviderFromEnv } from './synthetic.ts';
// GRS-113 approved supplemental correction (25 October 2026): a still-live Clerk session is revoked at sign-out and at a
// cross-kind identity switch even after its short-lived signed session token has EXPIRED (Clerk tokens live about a
// minute; sign-out is a POST, which the handshake never refreshes). Revocation is a separate, revoke-only evidence path:
// it verifies the token's signature against the pinned issuer key and never grants an Identity, a case or a grant, so the
// authentication tests below prove an expired token is still anonymous.
// SYNTHETIC keys, a synthetic Frontend API host and a loopback Backend API. Every outbound fetch is trapped BEFORE any
// module that could call the SDK loads: only the loopback double is reachable, anything else is recorded and refused.
// Unit evidence for our adapter only: no real Clerk, browser, cookie jar or workerd has run.
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
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);

import { prepareSignIn, signOutClerkSession } from '../../../src/lib/auth/clerk/flow.ts';
import { craftedInstance, forgedToken, statusDouble } from './synthetic.ts';

const signIn = await import('../../../deploy/client/routes/sign-in/+page.server.ts');
const signOut = await import('../../../deploy/client/routes/sign-out/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', CLIENT_SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('client-c.clerk.test');
const EXPIRED_AT = Date.now() - 3_600_000, JUST_EXPIRED_AT = Date.now() - 61_000;
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
});
afterAll(async () => {
	expect(trap.blocked, 'no outbound fetch beyond the loopback double').toEqual([]);
	await status.close();
});
beforeEach(() => {
	status.outage(false);
	status.failRevoke(false);
	workers.env = env();
});

const env = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_CLIENT_SIGN_IN_URL: CLIENT_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_API_URL: status.url, ...extra,
});
const post = (cookie: string, path = '/sign-out') => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { cookie } });
const clientToken = (sid: string, now = EXPIRED_AT, sub = 'user_a1') => A.token({ sub, sid, azp: ORIGIN, now });
const staffToken = (sid: string, now = EXPIRED_AT, sub = 'user_b1') => B.token({ sub, sid, azp: ORIGIN, now });
const revokes = (sid: string) => status.calls.filter((c) => c.startsWith(`POST /v1/sessions/${sid}/revoke`));
const keysUsedAt = (call: string) => status.bearers.filter((b) => b.call === call).map((b) => b.key);

async function identityFor(request: Request) {
	const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request });
}
async function anonymousFor(token: string) {
	const identity = await identityFor(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: `__session=${token}` } }));
	expect(identity.kind).toBe('anonymous');
	return identity;
}
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string; code?: string; body?: { code?: string } } }; } };
// `all`: every delete, at any scope; `deleted`: the host-only ones (sign-out also deletes the owned session names on each
// parent Domain). A refusal or an outage must delete nothing at all, so it asserts on `all`.
const jar = () => {
	const deleted: string[] = [], all: string[] = [];
	const remove = (name: string, o?: { domain?: string }) => void (all.push(o?.domain === undefined ? name : `${name}@${o.domain}`), o?.domain === undefined && deleted.push(name));
	return { deleted, all, cookies: { delete: remove, set: () => {} } };
};
const localsOf = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;

describe('an expired token is still never an Identity (authentication is unchanged)', () => {
	it.each([['an hour ago', EXPIRED_AT], ['a minute ago', JUST_EXPIRED_AT]])('stays anonymous, with every check refused and no Backend API call, when it expired %s', async (_when, at) => {
		status.set('sess_auth1', 'user_a1');
		const calls = status.calls.length;
		const identity = await anonymousFor(clientToken('sess_auth1', at));
		await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
		await expect(identity.authorize({ caseId: 'case-a1' as never, operation: 'read' })).rejects.toMatchObject({ code: 'invalid-session' });
		expect(identity.principal).toBeNull();
		expect(identity.sessionId).toBeNull();
		expect(status.calls.length).toBe(calls);
	});
});

describe('sign-out revokes a live session whose signed token has expired', () => {
	it.each([['an hour', EXPIRED_AT], ['a minute', JUST_EXPIRED_AT]])('revokes an expired client token at the client instance (expired %s ago), then names the cookies to clear', async (_when, at) => {
		const sid = `sess_c_${at}`;
		status.set(sid, 'user_a1');
		const token = clientToken(sid, at), identity = await anonymousFor(token);
		const r = await signOutClerkSession({ env: env(), request: post(`__session=${token}; __client_uat=1; theme=dark`), identity });
		expect(r).toEqual({ revoked: true, clear: ['__session', '__client_uat'] });
		expect(revokes(sid)).toHaveLength(1);
		expect(status.statusOf(sid)).toBe('revoked');
		expect(keysUsedAt(`POST /v1/sessions/${sid}/revoke`)).toEqual([A.secretKey]);
	});
	it('revokes an expired staff token at the staff instance only, with the staff key', async () => {
		status.set('sess_s1', 'user_b1');
		const token = staffToken('sess_s1'), identity = await anonymousFor(token);
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}`), identity })).resolves.toMatchObject({ revoked: true });
		expect(status.statusOf('sess_s1')).toBe('revoked');
		for (const call of status.bearers.filter((b) => b.call.includes('sess_s1'))) expect(call.key).toBe(B.secretKey);
	});
	it('reads the token from a suffixed session cookie as well as the plain one', async () => {
		status.set('sess_sfx', 'user_a1');
		const token = clientToken('sess_sfx'), identity = await anonymousFor(token);
		await expect(signOutClerkSession({ env: env(), request: post(`__session_AbCd1234=${token}`), identity })).resolves.toEqual({ revoked: true, clear: ['__session_AbCd1234'] });
		expect(status.statusOf('sess_sfx')).toBe('revoked');
	});
	it('treats a session already gone at Clerk (404) or already ended there as done, without a second revoke', async () => {
		const gone = clientToken('sess_gone'), ended = clientToken('sess_ended');
		status.set('sess_ended', 'user_a1', 'revoked');
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${gone}`), identity: await anonymousFor(gone) })).resolves.toMatchObject({ revoked: true });
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${ended}`), identity: await anonymousFor(ended) })).resolves.toMatchObject({ revoked: true });
		expect(revokes('sess_ended')).toHaveLength(0);
	});
	it('through the /sign-out route: revoke first, then 303 /sign-in with the cookies deleted', async () => {
		status.set('sess_route', 'user_a1');
		const token = clientToken('sess_route'), c = jar();
		const r = await outcome(async () => signOut.actions.default!({ locals: localsOf(await anonymousFor(token)), request: post(`__session=${token}; __client_uat=1`), url: new URL(ORIGIN), cookies: c.cookies } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: '/sign-in' });
		expect(status.statusOf('sess_route')).toBe('revoked');
		expect(c.deleted.sort()).toEqual(['__client_uat', '__session', 'clearcase_session']);
	});
	it('tells the truth when Clerk cannot confirm it: 503, no cookie cleared, session still live (lookup outage and revoke failure)', async () => {
		for (const [sid, arm, disarm] of [['sess_out1', () => status.outage(true), () => status.outage(false)], ['sess_out2', () => status.failRevoke(true), () => status.failRevoke(false)]] as const) {
			status.set(sid, 'user_a1');
			const token = clientToken(sid), identity = await anonymousFor(token), c = jar();
			arm();
			try {
				await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}`), identity })).rejects.toMatchObject({ code: 'identity-unavailable' });
				const r = await outcome(() => signOut.actions.default!({ locals: localsOf(identity), request: post(`__session=${token}`), url: new URL(ORIGIN), cookies: c.cookies } as never));
				expect(r.thrown).toMatchObject({ status: 503, body: { code: 'identity-unavailable' } });
				expect(c.all).toEqual([]);
			} finally {
				disarm();
			}
			expect(status.statusOf(sid)).toBe('active');
		}
	});
	it('is unavailable, clearing nothing, when the token is genuine-looking but Clerk is not configured', async () => {
		const token = clientToken('sess_nocfg');
		await expect(signOutClerkSession({ env: {}, request: post(`__session=${token}`), identity: await anonymousFor(token) })).rejects.toMatchObject({ code: 'identity-unavailable' });
	});
});

describe('the revoke-only evidence refuses everything that is not a genuine token of a pinned issuer', () => {
	const request = (token: string) => post(`__session=${token}`);
	const noRevoke = async (token: string, cookie = `__session=${token}`) => {
		const before = status.calls.length;
		const identity = await identityFor(post(cookie));
		const r = await outcome(() => signOutClerkSession({ env: env(), request: post(cookie), identity }));
		expect(status.calls.slice(before).filter((c) => c.startsWith('POST')), 'no revoke').toEqual([]);
		return r;
	};
	const genuine = (sid: string) => { status.set(sid, 'user_a1'); return clientToken(sid); };
	it.each<[string, () => string]>([
		['a token signed by another instance that names the client issuer (forged signature)', () => (status.set('sess_f1', 'user_a1'), C.token({ sub: 'user_a1', sid: 'sess_f1', azp: ORIGIN, now: EXPIRED_AT, claims: { iss: A.iss } }))],
		['a staff-signed token claiming the client issuer (issuer/key confusion)', () => (status.set('sess_f2', 'user_a1'), B.token({ sub: 'user_a1', sid: 'sess_f2', azp: ORIGIN, now: EXPIRED_AT, claims: { iss: A.iss } }))],
		['a client-signed token claiming the staff issuer (issuer/key confusion)', () => (status.set('sess_f3', 'user_b1'), A.token({ sub: 'user_b1', sid: 'sess_f3', azp: ORIGIN, now: EXPIRED_AT, claims: { iss: B.iss } }))],
		['a genuine token of an issuer that is not configured (wrong issuer)', () => (status.set('sess_f4', 'user_c1'), C.token({ sub: 'user_c1', sid: 'sess_f4', azp: ORIGIN, now: EXPIRED_AT }))],
		['a genuine token with a payload swapped after signing', () => { status.set('sess_f5', 'user_a1'); status.set('sess_f5x', 'user_a1'); const [h, , s] = clientToken('sess_f5').split('.'); const [, p] = clientToken('sess_f5x').split('.'); return `${h}.${p}.${s}`; }],
		['an unsigned token naming a live sid (placeholder signature)', () => (status.set('sess_f6', 'user_a1'), forgedToken({ alg: 'RS256', typ: 'JWT' }, { iss: A.iss, sub: 'user_a1', sid: 'sess_f6', azp: ORIGIN, exp: 1, iat: 1, nbf: 1 }))],
		['an alg:none token', () => (status.set('sess_f7', 'user_a1'), forgedToken({ alg: 'none' }, { iss: A.iss, sub: 'user_a1', sid: 'sess_f7', azp: ORIGIN, exp: 1 }, 'x'))],
		['an HS256 token', () => (status.set('sess_f8', 'user_a1'), A.token({ sub: 'user_a1', sid: 'sess_f8', azp: ORIGIN, now: EXPIRED_AT, header: { alg: 'HS256' } }))],
		['a genuine token carrying a jku key-selection header', () => (status.set('sess_f9', 'user_a1'), A.token({ sub: 'user_a1', sid: 'sess_f9', azp: ORIGIN, now: EXPIRED_AT, header: { jku: 'https://attacker.example.test/keys' } }))],
		['a genuine token for another origin (azp)', () => (status.set('sess_f10', 'user_a1'), A.token({ sub: 'user_a1', sid: 'sess_f10', azp: 'https://attacker.example.test', now: EXPIRED_AT }))],
		['a genuine token with no sid', () => A.token({ sub: 'user_a1', sid: 'sess_f11', azp: ORIGIN, now: EXPIRED_AT, claims: { sid: undefined } })],
		['a genuine token with no sub', () => (status.set('sess_f12', 'user_a1'), A.token({ sub: 'user_a1', sid: 'sess_f12', azp: ORIGIN, now: EXPIRED_AT, claims: { sub: undefined } }))],
		['a genuine token whose sid is not a plain session id', () => A.token({ sub: 'user_a1', sid: '../../v1/users/user_a1', azp: ORIGIN, now: EXPIRED_AT })],
	])('revokes nothing for %s, and its cookies are cleared as an anonymous caller', async (_name, make) => {
		const token = make();
		const r = await noRevoke(token);
		expect(r.value, JSON.stringify(r.thrown)).toMatchObject({ revoked: false, clear: ['__session'] });
		for (const sid of ['sess_f1', 'sess_f2', 'sess_f3', 'sess_f4', 'sess_f5', 'sess_f5x', 'sess_f6', 'sess_f7', 'sess_f8', 'sess_f9', 'sess_f10', 'sess_f12']) expect(['active', undefined]).toContain(status.statusOf(sid));
		expect(['sess_f1', 'sess_f2', 'sess_f3', 'sess_f6', 'sess_f7'].map((s) => status.statusOf(s))).not.toContain('revoked');
	});
	it('revokes nothing, and asks no Clerk instance, for a cookie that is not a token, an ambiguous credential or a bearer that disagrees', async () => {
		const token = genuine('sess_amb');
		const before = status.calls.length;
		for (const cookie of ['__session=stale', `__session=${token}; __session_AbCd1234=${clientToken('sess_other')}`, `__session=${token}; __session=${token}`, `__session="${token}"`]) {
			const r = await outcome(() => signOutClerkSession({ env: env(), request: post(cookie), identity: { kind: 'anonymous', principal: null, sessionId: null } }));
			expect(r.value, cookie).toMatchObject({ revoked: false });
		}
		const mixed = new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: `__session=${token}`, authorization: `Bearer ${clientToken('sess_other')}` } });
		await expect(signOutClerkSession({ env: env(), request: mixed, identity: { kind: 'anonymous', principal: null, sessionId: null } })).resolves.toMatchObject({ revoked: false });
		expect(status.calls.length).toBe(before);
		expect(status.statusOf('sess_amb')).toBe('active');
	});
	it('refuses a genuine token whose sid the instance reports owned by someone else, revoking nothing (session ownership)', async () => {
		status.set('sess_own', 'user_someone_else');
		const token = clientToken('sess_own'), before = status.calls.length;
		const identity = await anonymousFor(token), c = jar();
		await expect(signOutClerkSession({ env: env(), request: request(token), identity })).rejects.toMatchObject({ code: 'invalid-session' });
		const r = await outcome(() => signOut.actions.default!({ locals: localsOf(identity), request: request(token), url: new URL(ORIGIN), cookies: c.cookies } as never));
		expect(r.thrown).toMatchObject({ status: 401, body: { code: 'invalid-session' } });
		expect(c.all).toEqual([]);
		expect(status.statusOf('sess_own')).toBe('active');
		expect(status.calls.slice(before).filter((x) => x.startsWith('POST'))).toEqual([]);
	});
	it('never uses the other instance for a token: a staff-signed token is not looked up with the client key', async () => {
		status.set('sess_iso', 'user_b1');
		const token = staffToken('sess_iso'), identity = await anonymousFor(token);
		await signOutClerkSession({ env: env(), request: request(token), identity });
		expect(status.bearers.filter((b) => b.call.includes('sess_iso')).every((b) => b.key === B.secretKey)).toBe(true);
	});
	it('does not widen the verified path: a verified identity is revoked exactly as before, one revoke', async () => {
		status.set('sess_ver', 'user_a1');
		const token = A.token({ sub: 'user_a1', sid: 'sess_ver', azp: ORIGIN });
		const identity = await identityFor(new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}` } }));
		expect(identity.kind).toBe('verified');
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}`), identity })).resolves.toEqual({ revoked: true, clear: ['__session'] });
		expect(revokes('sess_ver')).toHaveLength(1);
	});
});

describe('a cross-kind identity switch revokes the expired session first; same-kind and ambiguity are unchanged', () => {
	const signInRequest = (cookie: string) => new Request(`${ORIGIN}/sign-in`, { method: 'POST', headers: { cookie } });
	it('signs an expired STAFF session out at the staff instance before a client sign-in proceeds', async () => {
		status.set('sess_sw_s', 'user_b1');
		const token = staffToken('sess_sw_s'), identity = await anonymousFor(token);
		const r = await prepareSignIn({ env: env(), request: signInRequest(`__session=${token}; __client_uat=1`), identity, target: 'client' });
		expect(r).toEqual({ action: 'proceed', clear: ['__session', '__client_uat'] });
		expect(status.statusOf('sess_sw_s')).toBe('revoked');
		expect(keysUsedAt('POST /v1/sessions/sess_sw_s/revoke')).toEqual([B.secretKey]);
	});
	it('through the /sign-in route: revoked, cookies deleted, then 303 to the client Clerk sign-in', async () => {
		status.set('sess_sw_r', 'user_b1');
		const token = staffToken('sess_sw_r'), c = jar(), url = new URL(`${ORIGIN}/sign-in`);
		const r = await outcome(async () => signIn.actions.default!({ locals: localsOf(await anonymousFor(token)), request: signInRequest(`__session=${token}`), url, cookies: c.cookies } as never));
		expect(status.statusOf('sess_sw_r')).toBe('revoked');
		expect(c.deleted).toContain('__session');
		expect(r.thrown).toMatchObject({ status: 303 });
		expect(r.thrown?.location).toMatch(new RegExp(`^${CLIENT_SIGN_IN}\\?redirect_url=`));
	});
	it('never reports a switch as done when the revocation cannot be confirmed: 503, nothing cleared, nobody sent to Clerk', async () => {
		status.set('sess_sw_o', 'user_b1');
		const token = staffToken('sess_sw_o'), identity = await anonymousFor(token), c = jar();
		status.failRevoke(true);
		const r = await outcome(() => signIn.actions.default!({ locals: localsOf(identity), request: signInRequest(`__session=${token}`), url: new URL(`${ORIGIN}/sign-in`), cookies: c.cookies } as never));
		expect(r.thrown).toMatchObject({ status: 503, body: { code: 'identity-unavailable' } });
		expect(c.all).toEqual([]);
		expect(status.statusOf('sess_sw_o')).toBe('active');
	});
	it('does not revoke an expired SAME-kind session when signing in again (Clerk replaces it), and still refuses ambiguity', async () => {
		status.set('sess_sw_a', 'user_a1');
		const token = clientToken('sess_sw_a'), identity = await anonymousFor(token);
		await expect(prepareSignIn({ env: env(), request: signInRequest(`__session=${token}`), identity, target: 'client' })).resolves.toEqual({ action: 'proceed', clear: [] });
		expect(status.statusOf('sess_sw_a')).toBe('active');
		const ambiguous = `__session=${token}; __session_AbCd1234=${staffToken('sess_x')}`;
		await expect(prepareSignIn({ env: env(), request: signInRequest(ambiguous), identity, target: 'client' })).resolves.toEqual({ action: 'refuse', clear: ['__session', '__session_AbCd1234'] });
		expect(status.statusOf('sess_sw_a')).toBe('active');
	});
	it('revokes nothing on a switch for a forged expired staff token', async () => {
		status.set('sess_sw_f', 'user_b1');
		const token = A.token({ sub: 'user_b1', sid: 'sess_sw_f', azp: ORIGIN, now: EXPIRED_AT, claims: { iss: B.iss } }), identity = await anonymousFor(token);
		await expect(prepareSignIn({ env: env(), request: signInRequest(`__session=${token}`), identity, target: 'client' })).resolves.toEqual({ action: 'proceed', clear: [] });
		expect(status.statusOf('sess_sw_f')).toBe('active');
	});
});
