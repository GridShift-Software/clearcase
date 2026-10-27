// Follow-ups of the GRS-113 revocation supplemental (43e7bcc7), alpha hardening 27 October 2026:
//  - L-rev-1: a genuinely signed `sts: 'pending'` token. Clerk documents `pending` as "signed in but hasn't completed
//    session tasks" (@clerk/shared SessionStatus; tasks choose-organization, reset-password, setup-mfa), and finishing a
//    task makes the SAME session active without a new sign-in. A pending token never authenticates here, but its session
//    can become one that does, so sign-out and a cross-kind switch revoke it through the same revoke-only path.
//  - L-rev-2: the Backend API calls an old genuine token can cause. A token that carries no `exp`, or that is not ours,
//    causes none. A genuine token of any age gets one revoke attempt (no assumed Clerk session lifetime), and one session
//    settled in this isolate (gone, ended, revoked or not the token's subject's) is not looked up again for
//    SETTLED_TTL_MS, so replaying a token costs nothing in that window, a session Clerk reactivates is revoked again
//    after it, and no caller can occupy another user's session.
// SYNTHETIC keys and hosts; the Backend API is the loopback double, and every other outbound fetch is trapped.
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

import { readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { prepareSignIn, revokeOwnedSession, SETTLED_TTL_MS, signOutClerkSession } from '../../../src/lib/auth/clerk/flow.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const signOut = await import('../../../deploy/client/routes/sign-out/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', CLIENT_SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('client-c.clerk.test');
const DAY = 86_400_000, HOUR_AGO = Date.now() - 3_600_000;
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

const env = (): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_CLIENT_SIGN_IN_URL: CLIENT_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
	CLERK_API_URL: status.url,
});
const post = (cookie: string, path = '/sign-out') => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { cookie } });
const pending = { sts: 'pending' };
const clientToken = (sid: string, a: { now?: number; sub?: string; claims?: Record<string, unknown> } = {}) => A.token({ sub: a.sub ?? 'user_a1', sid, azp: ORIGIN, now: a.now ?? HOUR_AGO, claims: a.claims });
const staffToken = (sid: string, a: { now?: number; claims?: Record<string, unknown> } = {}) => B.token({ sub: 'user_b1', sid, azp: ORIGIN, now: a.now ?? HOUR_AGO, claims: a.claims });
const callsFor = (sid: string) => status.calls.filter((c) => c.includes(`/v1/sessions/${sid}`));
const keysAt = (sid: string) => [...new Set(status.bearers.filter((b) => b.call.includes(`/v1/sessions/${sid}`)).map((b) => b.key))];
const anonymous = { kind: 'anonymous', principal: null, sessionId: null } as const;
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string; code?: string; body?: { code?: string } } }; } };
const jar = () => { const deleted: string[] = []; return { deleted, cookies: { delete: (name: string) => deleted.push(name) } }; };
const localsOf = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;

async function identityFor(request: Request) {
	const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request });
}
const signOutWith = (token: string) => signOutClerkSession({ env: env(), request: post(`__session=${token}`), identity: anonymous });

describe('a pending session never carries authority here', () => {
	it.each([['live', Date.now()], ['expired', HOUR_AGO]])('a genuine %s sts:pending token is anonymous on every check, with no Backend API call', async (_when, now) => {
		status.set('sess_pa', 'user_a1', 'pending');
		const before = status.calls.length;
		for (const request of [post(`__session=${clientToken('sess_pa', { now, claims: pending })}`), new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${clientToken('sess_pa', { now, claims: pending })}` } })]) {
			const identity = await identityFor(request);
			expect(identity).toMatchObject({ kind: 'anonymous', principal: null, sessionId: null });
			await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
			await expect(identity.authorize({ caseId: 'case-a1' as never, operation: 'read' })).rejects.toMatchObject({ code: 'invalid-session' });
		}
		expect(status.calls.length).toBe(before);
	});
	it('a live sts:active token whose session Clerk reports pending is refused as well', async () => {
		status.set('sess_pb', 'user_a1', 'pending');
		const identity = await identityFor(post(`__session=${clientToken('sess_pb', { now: Date.now() })}`));
		expect(identity.kind).toBe('anonymous');
		await expect(identity.checkRevocation()).rejects.toMatchObject({ code: 'invalid-session' });
	});
});

describe('sign-out revokes a pending session through the revoke-only path', () => {
	it.each([['live', Date.now()], ['expired', HOUR_AGO]])('revokes the session behind a genuine %s sts:pending client token, at the client instance only', async (when, now) => {
		const sid = `sess_pend_${when}`;
		status.set(sid, 'user_a1', 'pending');
		const token = clientToken(sid, { now, claims: pending });
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}; __client_uat=1`), identity: await identityFor(post(`__session=${token}`)) }))
			.resolves.toEqual({ revoked: true, clear: ['__session', '__client_uat'] });
		expect(status.statusOf(sid)).toBe('revoked');
		expect(callsFor(sid)).toEqual([`GET /v1/sessions/${sid} auth`, `POST /v1/sessions/${sid}/revoke auth`]);
		expect(keysAt(sid)).toEqual([A.secretKey]);
	});
	it('through the /sign-out route: revoke first, then 303 /sign-in with the cookies deleted', async () => {
		status.set('sess_pend_route', 'user_a1', 'pending');
		const token = clientToken('sess_pend_route', { claims: pending }), c = jar();
		const r = await outcome(async () => signOut.actions.default!({ locals: localsOf(await identityFor(post(`__session=${token}`))), request: post(`__session=${token}`), url: new URL(ORIGIN), cookies: c.cookies } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: '/sign-in' });
		expect(status.statusOf('sess_pend_route')).toBe('revoked');
		expect(c.deleted).toContain('__session');
	});
	it('signs a pending STAFF session out at the staff instance before a client sign-in proceeds', async () => {
		status.set('sess_pend_sw', 'user_b1', 'pending');
		const token = staffToken('sess_pend_sw', { claims: pending });
		await expect(prepareSignIn({ env: env(), request: post(`__session=${token}`, '/sign-in'), identity: await identityFor(post(`__session=${token}`)), target: 'client' }))
			.resolves.toEqual({ action: 'proceed', clear: ['__session'] });
		expect(status.statusOf('sess_pend_sw')).toBe('revoked');
		expect(keysAt('sess_pend_sw')).toEqual([B.secretKey]);
	});
	it('keeps every other fence for a pending token: 503 and nothing revoked when Clerk cannot confirm, invalid-session for another owner', async () => {
		status.set('sess_pend_out', 'user_a1', 'pending');
		status.failRevoke(true);
		await expect(signOutWith(clientToken('sess_pend_out', { claims: pending }))).rejects.toMatchObject({ code: 'identity-unavailable' });
		status.failRevoke(false);
		expect(status.statusOf('sess_pend_out')).toBe('pending');
		status.set('sess_pend_own', 'user_someone_else', 'pending');
		await expect(signOutWith(clientToken('sess_pend_own', { claims: pending }))).rejects.toMatchObject({ code: 'invalid-session' });
		expect(status.statusOf('sess_pend_own')).toBe('pending');
	});
	it.each(['ended', 'revoked', 'unknown', ''])('revokes nothing, and asks nothing, for a genuine token with sts:%j (Clerk signs only active or pending)', async (sts) => {
		const sid = `sess_sts_${sts || 'empty'}`;
		status.set(sid, 'user_a1');
		await expect(signOutWith(clientToken(sid, { claims: { sts } }))).resolves.toMatchObject({ revoked: false });
		expect(callsFor(sid)).toEqual([]);
	});
});

describe('the Backend API calls an old or foreign token can cause are bounded', () => {
	it('an 8-day-old genuine token of a session Clerk still holds gets exactly one revoke, reported only once Clerk confirms it', async () => {
		status.set('sess_8d', 'user_a1');
		const token = clientToken('sess_8d', { now: Date.now() - 8 * DAY });
		status.failRevoke(true);
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}; __client_uat=1`), identity: anonymous })).rejects.toMatchObject({ code: 'identity-unavailable' });
		expect(status.statusOf('sess_8d')).toBe('active');
		status.failRevoke(false);
		const before = callsFor('sess_8d').length;
		await expect(signOutClerkSession({ env: env(), request: post(`__session=${token}; __client_uat=1`), identity: anonymous })).resolves.toEqual({ revoked: true, clear: ['__session', '__client_uat'] });
		expect(callsFor('sess_8d').slice(before)).toEqual(['GET /v1/sessions/sess_8d auth', 'POST /v1/sessions/sess_8d/revoke auth']);
		expect(status.statusOf('sess_8d')).toBe('revoked');
		const switched = staffToken('sess_30d_sw', { now: Date.now() - 30 * DAY });
		status.set('sess_30d_sw', 'user_b1');
		await expect(prepareSignIn({ env: env(), request: post(`__session=${switched}`, '/sign-in'), identity: anonymous, target: 'client' })).resolves.toEqual({ action: 'proceed', clear: ['__session'] });
		expect(callsFor('sess_30d_sw')).toEqual(['GET /v1/sessions/sess_30d_sw auth', 'POST /v1/sessions/sess_30d_sw/revoke auth']);
		expect(status.statusOf('sess_30d_sw')).toBe('revoked');
	});
	it('still revokes a genuine token issued within that lifetime (6 days ago)', async () => {
		status.set('sess_6d', 'user_a1');
		await expect(signOutWith(clientToken('sess_6d', { now: Date.now() - 6 * DAY }))).resolves.toMatchObject({ revoked: true });
		expect(callsFor('sess_6d')).toHaveLength(2);
		expect(status.statusOf('sess_6d')).toBe('revoked');
	});
	it('makes no Backend API call for a genuine token that carries no exp (no Clerk session token lacks one)', async () => {
		status.set('sess_noexp', 'user_a1');
		await expect(signOutWith(clientToken('sess_noexp', { claims: { exp: undefined } }))).resolves.toMatchObject({ revoked: false });
		expect(callsFor('sess_noexp')).toEqual([]);
	});
	it('makes no Backend API call for a token that is not ours: wrong issuer, another origin, or another key', async () => {
		for (const [sid, token] of [
			['sess_n1', C.token({ sub: 'user_a1', sid: 'sess_n1', azp: ORIGIN, now: HOUR_AGO })],
			['sess_n2', A.token({ sub: 'user_a1', sid: 'sess_n2', azp: 'https://attacker.example.test', now: HOUR_AGO })],
			['sess_n3', C.token({ sub: 'user_a1', sid: 'sess_n3', azp: ORIGIN, now: HOUR_AGO, claims: { iss: A.iss } })],
		] as const) {
			status.set(sid, 'user_a1');
			await expect(signOutWith(token)).resolves.toMatchObject({ revoked: false });
			expect(callsFor(sid)).toEqual([]);
		}
	});
	it('replaying one genuine token 10 times costs one lookup and one revoke in total (before: one lookup per replay)', async () => {
		status.set('sess_replay', 'user_a1');
		const token = clientToken('sess_replay');
		for (let i = 0; i < 10; i++) await expect(signOutWith(token)).resolves.toMatchObject({ revoked: true });
		expect(callsFor('sess_replay')).toEqual(['GET /v1/sessions/sess_replay auth', 'POST /v1/sessions/sess_replay/revoke auth']);
	});
	it('replaying a token for a session already gone (404) or ended at Clerk costs one lookup each in total', async () => {
		status.set('sess_ended_r', 'user_a1', 'ended');
		for (let i = 0; i < 5; i++) {
			await expect(signOutWith(clientToken('sess_gone_r'))).resolves.toMatchObject({ revoked: true });
			await expect(signOutWith(clientToken('sess_ended_r'))).resolves.toMatchObject({ revoked: true });
		}
		expect(callsFor('sess_gone_r')).toHaveLength(1);
		expect(callsFor('sess_ended_r')).toHaveLength(1);
	});
	it('replaying a token whose session Clerk reports owned by someone else costs one lookup in total, and is refused every time', async () => {
		status.set('sess_own_r', 'user_someone_else');
		for (let i = 0; i < 5; i++) await expect(signOutWith(clientToken('sess_own_r'))).rejects.toMatchObject({ code: 'invalid-session' });
		expect(callsFor('sess_own_r')).toEqual(['GET /v1/sessions/sess_own_r auth']);
		expect(status.statusOf('sess_own_r')).toBe('active');
	});
	it('replaying a cross-kind switch 5 times costs one lookup and one revoke in total', async () => {
		status.set('sess_sw_replay', 'user_b1');
		const token = staffToken('sess_sw_replay');
		for (let i = 0; i < 5; i++) await expect(prepareSignIn({ env: env(), request: post(`__session=${token}`, '/sign-in'), identity: anonymous, target: 'client' })).resolves.toMatchObject({ action: 'proceed' });
		expect(callsFor('sess_sw_replay')).toHaveLength(2);
	});
	it('concurrent sign-outs with one token cost at most one lookup and one revoke, and none reports success before the revoke', async () => {
		status.set('sess_burst', 'user_a1');
		const token = clientToken('sess_burst');
		const results = await Promise.all(Array.from({ length: 8 }, () => outcome(() => signOutWith(token))));
		expect(callsFor('sess_burst')).toEqual(['GET /v1/sessions/sess_burst auth', 'POST /v1/sessions/sess_burst/revoke auth']);
		for (const r of results) if (!('value' in r)) expect(r.thrown).toMatchObject({ code: 'identity-unavailable' });
		expect(results.filter((r) => 'value' in r && (r.value as { revoked: boolean }).revoked)).not.toHaveLength(0);
		expect(status.statusOf('sess_burst')).toBe('revoked');
	});
	it('a failed lookup is not remembered: the next sign-out asks Clerk again and revokes', async () => {
		status.set('sess_retry', 'user_a1');
		const token = clientToken('sess_retry');
		status.outage(true);
		await expect(signOutWith(token)).rejects.toMatchObject({ code: 'identity-unavailable' });
		status.outage(false);
		await expect(signOutWith(token)).resolves.toMatchObject({ revoked: true });
		expect(status.statusOf('sess_retry')).toBe('revoked');
	});
	it('a lookup the runtime abandons mid-flight blocks only its own session, and for at most 30 seconds', async () => {
		const read = readClerkIdentityConfig(env());
		if (!read.ok) throw new Error(read.reason);
		const evidence = { instance: read.config.client, subject: 'user_a1', sessionId: 'sess_hung' as never };
		status.set('sess_hung', 'user_a1');
		status.set('sess_beside', 'user_a1');
		void revokeOwnedSession({ config: read.config, evidence, fetcher: () => new Promise<Response>(() => {}) });
		await expect(revokeOwnedSession({ config: read.config, evidence })).rejects.toMatchObject({ code: 'identity-unavailable' });
		await expect(signOutWith(clientToken('sess_beside'))).resolves.toMatchObject({ revoked: true });
		const later = Date.now() + 30_001;
		const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
		try {
			await expect(revokeOwnedSession({ config: read.config, evidence })).resolves.toBeUndefined();
		} finally {
			clock.mockRestore();
		}
		expect(status.statusOf('sess_hung')).toBe('revoked');
		expect(callsFor('sess_hung')).toHaveLength(2);
	});
	it('a settled answer is reused for at most SETTLED_TTL_MS (10 minutes), then Clerk is asked again', async () => {
		const read = readClerkIdentityConfig(env());
		if (!read.ok) throw new Error(read.reason);
		const t0 = Date.now(), at = (ms: number) => () => t0 + ms;
		const revoke = (sid: string, subject: string, now: () => number) => revokeOwnedSession({ config: read.config, evidence: { instance: read.config.client, subject, sessionId: sid as never }, now });
		status.set('sess_ttl_done', 'user_a1');
		await revoke('sess_ttl_done', 'user_a1', at(0));
		await revoke('sess_ttl_done', 'user_a1', at(SETTLED_TTL_MS - 1));
		expect(callsFor('sess_ttl_done')).toHaveLength(2);
		await revoke('sess_ttl_done', 'user_a1', at(SETTLED_TTL_MS));
		expect(callsFor('sess_ttl_done')).toEqual(['GET /v1/sessions/sess_ttl_done auth', 'POST /v1/sessions/sess_ttl_done/revoke auth', 'GET /v1/sessions/sess_ttl_done auth']);
		status.set('sess_ttl_own', 'user_someone_else');
		await expect(revoke('sess_ttl_own', 'user_a1', at(0))).rejects.toMatchObject({ code: 'invalid-session' });
		await expect(revoke('sess_ttl_own', 'user_a1', at(SETTLED_TTL_MS - 1))).rejects.toMatchObject({ code: 'invalid-session' });
		expect(callsFor('sess_ttl_own')).toHaveLength(1);
		await expect(revoke('sess_ttl_own', 'user_a1', at(SETTLED_TTL_MS))).rejects.toMatchObject({ code: 'invalid-session' });
		expect(callsFor('sess_ttl_own')).toHaveLength(2);
	});
	it('a session Clerk reactivates (ended, then active, same sid) is revoked again by the first sign-out after the TTL', async () => {
		const read = readClerkIdentityConfig(env());
		if (!read.ok) throw new Error(read.reason);
		const t0 = Date.now(), evidence = { instance: read.config.client, subject: 'user_a1', sessionId: 'sess_react' as never };
		const revoke = (ms: number) => revokeOwnedSession({ config: read.config, evidence, now: () => t0 + ms });
		status.set('sess_react', 'user_a1', 'ended');
		await expect(revoke(0)).resolves.toBeUndefined();
		expect(callsFor('sess_react')).toEqual(['GET /v1/sessions/sess_react auth']);
		status.set('sess_react', 'user_a1', 'active');
		await expect(revoke(SETTLED_TTL_MS)).resolves.toBeUndefined();
		expect(status.statusOf('sess_react')).toBe('revoked');
		expect(callsFor('sess_react')).toEqual(['GET /v1/sessions/sess_react auth', 'GET /v1/sessions/sess_react auth', 'POST /v1/sessions/sess_react/revoke auth']);
		const token = clientToken('sess_react_route');
		status.set('sess_react_route', 'user_a1', 'ended');
		await expect(signOutWith(token)).resolves.toMatchObject({ revoked: true });
		status.set('sess_react_route', 'user_a1', 'active');
		const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SETTLED_TTL_MS);
		try {
			await expect(signOutWith(token)).resolves.toMatchObject({ revoked: true });
		} finally {
			clock.mockRestore();
		}
		expect(status.statusOf('sess_react_route')).toBe('revoked');
		expect(callsFor('sess_react_route')).toHaveLength(3);
	});
	it("no caller can occupy another user's session: another user's replays, a forged token naming the victim's session, and a settled foreign entry leave the victim's sign-out untouched", async () => {
		status.set('sess_attacker', 'user_x');
		const attacker = clientToken('sess_attacker', { sub: 'user_x' });
		for (let i = 0; i < 20; i++) await signOutWith(attacker);
		status.set('sess_victim', 'user_a1');
		const forged = C.token({ sub: 'user_a1', sid: 'sess_victim', azp: ORIGIN, now: HOUR_AGO, claims: { iss: A.iss } });
		await expect(signOutWith(forged)).resolves.toMatchObject({ revoked: false });
		const confused = clientToken('sess_victim', { sub: 'user_x' });
		await expect(signOutWith(confused)).rejects.toMatchObject({ code: 'invalid-session' });
		await expect(signOutWith(clientToken('sess_victim'))).resolves.toMatchObject({ revoked: true });
		expect(status.statusOf('sess_victim')).toBe('revoked');
		expect(callsFor('sess_attacker')).toHaveLength(2);
	});
});
