// The Clerk IdentityProvider and its configuration (GRS-113), through the pinned @clerk/backend with SYNTHETIC keys and a
// loopback session lookup. Unit evidence for our adapter only; never evidence that a real Clerk instance behaves so.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLERK_ENV, clerkSignInTarget, frontendApiHost, readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { clerkIdentityProviderFromEnv, createClerkIdentityProvider, presentedToken, type CaseAuthorizer } from '../../../src/lib/auth/clerk/provider.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';
import { installWorkerdRedirectContract } from '../workerd-redirect-contract.ts';
import { revokeClerkSession, revokeOwnedSession } from '../../../src/lib/auth/clerk/flow.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), C = craftedInstance('client-c.clerk.test'), B = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
// Both revoke calls run in a Worker, where workerd refuses fetch with redirect 'error'. Bun does not, so model that rule for the whole file.
let restoreRedirectRule: (() => void) | undefined;
beforeAll(async () => {
	restoreRedirectRule = installWorkerdRedirectContract();
	status = await statusDouble();
	status.set('sess_a1', 'user_a1');
	status.set('sess_b1', 'user_b1');
	status.set('sess_c1', 'user_c1');
});
afterAll(async () => { restoreRedirectRule?.(); await status.close(); });

const env = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_API_URL: status.url, ...extra,
});
function provider(extra: Record<string, unknown> = {}, authorizeCase: CaseAuthorizer = async () => { throw contractError('forbidden'); }) {
	const made = clerkIdentityProviderFromEnv(env(extra), { authorizeCase });
	if (!made.ok) throw new Error(made.reason);
	return made.provider;
}
const bearer = (token: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}`, ...headers } });
const a1 = (claims: Record<string, unknown> = {}, now?: number) => A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN, claims, now });
const caseA = id('case', 'case-a1');

describe('configuration', () => {
	it('reads a complete deployment and derives each issuer from its publishable key', () => {
		const r = readClerkIdentityConfig(env());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config).toMatchObject({ clientId: 'client-a', appOrigin: ORIGIN, mfaRequired: false, signInUrl: null, client: { kind: 'client', issuer: A.iss }, staff: { kind: 'staff', issuer: B.iss } });
		expect(frontendApiHost(A.publishableKey)).toBe('client-a.clerk.test');
	});
	it('is unavailable when any value is missing or malformed, naming variables and never values', () => {
		for (const name of [CLERK_ENV.clientId, CLERK_ENV.appOrigin, CLERK_ENV.client.publishableKey, CLERK_ENV.client.secretKey, CLERK_ENV.staff.publishableKey, CLERK_ENV.staff.secretKey]) {
			const r = readClerkIdentityConfig(env({ [name]: undefined }));
			expect(r.ok, name).toBe(false);
			if (!r.ok) {
				expect(r.reason).toContain(name);
				for (const secret of [A.secretKey, B.secretKey, A.jwtKey]) expect(r.reason).not.toContain(secret);
			}
		}
		for (const [name, value] of [[CLERK_ENV.appOrigin, 'http://client-a.clearcase.test'], [CLERK_ENV.appOrigin, `${ORIGIN}/path`], [CLERK_ENV.client.jwtKey, 'not-a-pem'], [CLERK_ENV.mfaRequired, 'yes'], [CLERK_ENV.apiUrl, 'http://api.example.test'], [CLERK_ENV.client.secretKey, A.secretKey.replace('sk_test_', 'sk_live_')]] as const)
			expect(readClerkIdentityConfig(env({ [name]: value })).ok, `${name}=${value}`).toBe(false);
	});
	it('refuses one Clerk application standing in for both client and staff', () => {
		const r = readClerkIdentityConfig(env({ CLERK_STAFF_PUBLISHABLE_KEY: A.publishableKey, CLERK_STAFF_SECRET_KEY: A.secretKey, CLERK_STAFF_JWT_KEY: A.jwtKey }));
		expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('separate applications') });
	});
	it('needs the case authorizer; there is no default that allows', () => {
		const r = readClerkIdentityConfig(env());
		if (!r.ok) throw new Error(r.reason);
		expect(() => createClerkIdentityProvider({ config: r.config, authorizeCase: undefined as unknown as CaseAuthorizer })).toThrow(TypeError);
	});
	it('offers a sign-in target only when configured, returning to this origin\'s sign-in page only', () => {
		expect(clerkSignInTarget(env())).toBeNull();
		const signIn = 'https://accounts.client-a.clerk.test/sign-in';
		expect(clerkSignInTarget(env({ CLERK_CLIENT_SIGN_IN_URL: signIn }))?.href).toBe(`${signIn}?redirect_url=${encodeURIComponent(`${ORIGIN}/sign-in`)}`);
		expect(clerkSignInTarget(env({ CLERK_CLIENT_SIGN_IN_URL: signIn }), 'staff')).toBeNull();
	});
});

describe('credential', () => {
	it('takes one Bearer token or one __session cookie, and refuses ambiguity', () => {
		const t = a1();
		expect(presentedToken(new Request(ORIGIN))).toBeNull();
		expect(presentedToken(bearer(t))).toBe(t);
		expect(presentedToken(new Request(ORIGIN, { headers: { cookie: `x=1; __session=${t}` } }))).toBe(t);
		expect(presentedToken(bearer(t, { cookie: `__session=${t}` }))).toBe(t);
		expect(presentedToken(bearer(t, { cookie: `__session=${a1({ jti: 'other' })}` }))).toBe('malformed');
		expect(presentedToken(new Request(ORIGIN, { headers: { cookie: `__session=${t}; __session=${t}` } }))).toBe('malformed');
		expect(presentedToken(new Request(ORIGIN, { headers: { authorization: 'Basic abc' } }))).toBe('malformed');
	});
});

describe('authenticate', () => {
	it('is anonymous and unauthenticated with no credential', async () => {
		const identity = await provider().authenticate({ request: new Request(`${ORIGIN}/cases`) });
		expect(identity).toMatchObject({ kind: 'anonymous', principal: null, sessionId: null, clientId: 'client-a' });
		await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'unauthenticated' });
		await expect(identity.authorize({ caseId: caseA, operation: 'read' })).rejects.toMatchObject({ code: 'unauthenticated' });
	});
	it('verifies a live client session and a live staff session as distinct principals', async () => {
		const client = await provider().authenticate({ request: bearer(a1()) });
		expect(client).toMatchObject({ kind: 'verified', sessionId: 'sess_a1', principal: { issuer: A.iss, subject: 'user_a1', kind: 'client' } });
		await expect(client.checkRevocation()).resolves.toBeUndefined();
		const staff = await provider().authenticate({ request: bearer(B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN })) });
		expect(staff).toMatchObject({ kind: 'verified', principal: { issuer: B.iss, subject: 'user_b1', kind: 'staff' } });
	});
	it.each([
		['expired', () => a1({}, Date.now() - 3_600_000)],
		['not yet valid', () => a1({ nbf: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000) + 600 })],
		['another issuer', () => a1({ iss: 'https://elsewhere.clerk.test' })],
		["another client's instance", () => C.token({ sub: 'user_c1', sid: 'sess_c1', azp: ORIGIN })],
		['another origin as authorized party', () => a1({ azp: 'https://client-c.clearcase.test' })],
		['no authorized party', () => a1({ azp: undefined })],
		['a pending session', () => a1({ sts: 'pending' })],
		['no session id', () => a1({ sid: undefined })],
		['a tampered payload', () => { const [h, , s] = a1().split('.'); return `${h}.${Buffer.from(JSON.stringify({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, iss: A.iss, exp: 9e9, iat: 1, nbf: 1 })).toString('base64url')}.${s}`; }],
		['an unknown session', () => A.token({ sub: 'user_a1', sid: 'sess_missing', azp: ORIGIN })],
		["someone else's session", () => A.token({ sub: 'user_a2', sid: 'sess_a1', azp: ORIGIN })],
	])('refuses %s as invalid-session', async (_name, token) => {
		const identity = await provider().authenticate({ request: bearer(token()) });
		expect(identity.kind).toBe('anonymous');
		await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
	});
	it('refuses a revoked session at authentication, and on the next check after a later revocation', async () => {
		status.set('sess_r', 'user_a1', 'revoked');
		const revoked = await provider().authenticate({ request: bearer(A.token({ sub: 'user_a1', sid: 'sess_r', azp: ORIGIN })) });
		await expect(revoked.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
		status.set('sess_l', 'user_a1');
		const authorizeCase = vi.fn(async () => {});
		const live = await provider({}, authorizeCase).authenticate({ request: bearer(A.token({ sub: 'user_a1', sid: 'sess_l', azp: ORIGIN })) });
		expect(live.kind).toBe('verified');
		status.set('sess_l', 'user_a1', 'revoked');
		await expect(live.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
		await expect(live.authorize({ caseId: caseA, operation: 'read' })).rejects.toMatchObject({ code: 'invalid-session' });
		expect(authorizeCase).not.toHaveBeenCalled();
	});
	it('fails closed as unavailable when the session lookup is down', async () => {
		status.outage(true);
		try {
			await expect(provider().authenticate({ request: bearer(a1()) })).rejects.toMatchObject({ code: 'identity-unavailable', retryable: true });
		} finally {
			status.outage(false);
		}
	});
	it('requires a second factor only when the MFA flag is on', async () => {
		await expect(provider({ AUTH_MFA_REQUIRED: 'true' }).authenticate({ request: bearer(a1({ fva: [0, -1] })) })).resolves.toMatchObject({ kind: 'anonymous' });
		await expect(provider({ AUTH_MFA_REQUIRED: 'true' }).authenticate({ request: bearer(a1({ fva: [0, 0] })) })).resolves.toMatchObject({ kind: 'verified' });
		await expect(provider({ AUTH_MFA_REQUIRED: 'false' }).authenticate({ request: bearer(a1({ fva: [0, -1] })) })).resolves.toMatchObject({ kind: 'verified' });
	});
});

describe('sign-out', () => {
	it('revokes the session at the instance that issued it, so its token is refused afterwards', async () => {
		status.set('sess_out', 'user_a1');
		const p = provider(), request = () => bearer(A.token({ sub: 'user_a1', sid: 'sess_out', azp: ORIGIN }));
		const identity = await p.authenticate({ request: request() });
		if (identity.kind !== 'verified') throw new Error('expected a verified identity');
		await p.signOut({ principal: identity.principal, sessionId: identity.sessionId });
		expect(status.calls.some((c) => c.startsWith('POST /v1/sessions/sess_out/revoke auth'))).toBe(true);
		await expect((await p.authenticate({ request: request() })).checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
		await expect(p.signOut({ principal: { ...identity.principal, issuer: C.iss }, sessionId: identity.sessionId })).rejects.toMatchObject({ code: 'invalid-session' });
	});
});

describe('sign-out and revoke-only calls under the workerd redirect rule', () => {
	const config = () => { const r = readClerkIdentityConfig(env()); if (!r.ok) throw new Error(r.reason); return r.config; };
	const answers = (status: number) => { const seen: { url: string; method: string | undefined; redirect: RequestRedirect | undefined }[] = [];
		const fetcher: typeof fetch = async (url, init) => { seen.push({ url: String(url), method: init?.method, redirect: init?.redirect }); return new Response(null, { status, headers: { location: 'https://attacker.example/' } }); };
		return { seen, fetcher }; };
	it.each([301, 302, 303, 307, 308])('asks for manual redirects and treats a %i answer as unavailable, never as a revoke', async code => {
		const c = config(), { seen, fetcher } = answers(code);
		const principal = { issuer: A.iss, subject: 'user_a1', kind: 'client' as const };
		await expect(revokeClerkSession({ config: c, principal, sessionId: 'sess_a1' as never, fetcher })).rejects.toMatchObject({ code: 'identity-unavailable' });
		expect(seen).toEqual([{ url: `${status.url}/v1/sessions/sess_a1/revoke`, method: 'POST', redirect: 'manual' }]);
		const evidence = { sessionId: 'sess_a1' as never, subject: 'user_a1', instance: c.client };
		const owned = answers(code);
		await expect(revokeOwnedSession({ config: c, evidence: evidence as never, fetcher: owned.fetcher })).rejects.toMatchObject({ code: 'identity-unavailable' });
		expect(owned.seen).toEqual([{ url: `${status.url}/v1/sessions/sess_a1`, method: 'GET', redirect: 'manual' }]);
	});
	it('revokes through the real global fetch, which the rule double would refuse for redirect error', async () => {
		status.set('sess_rule', 'user_a1');
		const c = config();
		await revokeClerkSession({ config: c, principal: { issuer: A.iss, subject: 'user_a1', kind: 'client' }, sessionId: 'sess_rule' as never });
		expect(status.statusOf('sess_rule')).toBe('revoked');
	});
});

describe('authorize: the case decision is the injected authorizer, never Clerk', () => {
	it('hands the principal, session, case and operation to the authorizer, and allows only what it allows', async () => {
		const authorizeCase = vi.fn<CaseAuthorizer>(async ({ caseId, operation }) => { if (caseId !== 'case-a1' || operation !== 'read') throw contractError('forbidden'); });
		const identity = await provider({}, authorizeCase).authenticate({ request: bearer(a1({ metadata: { role: 'firm_admin', cases: ['case-a2'] } })) });
		await expect(identity.authorize({ caseId: caseA, operation: 'read' })).resolves.toBeUndefined();
		expect(authorizeCase).toHaveBeenLastCalledWith({ principal: { issuer: A.iss, subject: 'user_a1', kind: 'client' }, sessionId: 'sess_a1', caseId: 'case-a1', operation: 'read' });
		await expect(identity.authorize({ caseId: id('case', 'case-a2'), operation: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
		await expect(identity.authorize({ caseId: caseA, operation: 'write-user-work' })).rejects.toMatchObject({ code: 'forbidden' });
	});
	it('gives a staff principal no case without a grant', async () => {
		const identity = await provider().authenticate({ request: bearer(B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, claims: { metadata: { role: 'global_admin' } } })) });
		expect(identity.principal?.kind).toBe('staff');
		await expect(identity.authorize({ caseId: caseA, operation: 'read' })).rejects.toMatchObject({ code: 'forbidden' });
	});
	it('turns an authorizer that throws without a contract code into unavailable, never an allow', async () => {
		const identity = await provider({}, async () => { throw new Error('grant store exploded'); }).authenticate({ request: bearer(a1()) });
		await expect(identity.authorize({ caseId: caseA, operation: 'read' })).rejects.toMatchObject({ code: 'identity-unavailable' });
	});
});
