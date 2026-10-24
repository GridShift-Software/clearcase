// The hosted /sign-in and /sign-out routes with a verified Clerk identity (GRS-113): sign-out revokes the right Clerk
// session before it clears cookies, and signing in as the other identity signs the first out or refuses ambiguity.
// SYNTHETIC keys and a loopback Backend API. Route-handler unit evidence only: no browser, no hook, no real Clerk.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const signIn = await import('../../../deploy/client/routes/sign-in/+page.server.ts');
const signOut = await import('../../../deploy/client/routes/sign-out/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', CLIENT_SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in', STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_a1', 'user_a1');
	status.set('sess_b1', 'user_b1');
});
afterAll(() => status.close());
const configured = () => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_CLIENT_SIGN_IN_URL: CLIENT_SIGN_IN, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey, CLERK_API_URL: status.url,
});
beforeEach(() => { workers.env = configured(); });

async function locals(token: string | null) {
	const made = clerkIdentityProviderFromEnv(configured(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	const identity = await made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
	return { runtime: { testIdentity: null }, identity } as unknown as App.Locals;
}
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string; body?: { code?: string } } }; } };
const jar = () => { const deleted: string[] = []; return { deleted, cookies: { delete: (name: string) => deleted.push(name) } }; };
const post = (cookie: string) => new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie } });

describe('/sign-out with a Clerk session', () => {
	it('revokes the session at the instance that issued it, then clears the Clerk cookies the browser sent', async () => {
		status.set('sess_so1', 'user_a1');
		const l = await locals(A.token({ sub: 'user_a1', sid: 'sess_so1', azp: ORIGIN })), c = jar();
		const r = await outcome(() => signOut.actions.default!({ locals: l, request: post('__session=x; __client_uat=1; theme=dark'), url: new URL(ORIGIN), cookies: c.cookies } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: '/sign-in' });
		expect(status.calls.filter((x) => x.includes('POST /v1/sessions/sess_so1/revoke auth'))).toHaveLength(1);
		expect(c.deleted.sort()).toEqual(['__client_uat', '__session', 'clearcase_session']);
	});
	it('revokes a staff session at the staff instance', async () => {
		status.set('sess_so2', 'user_b1');
		const l = await locals(B.token({ sub: 'user_b1', sid: 'sess_so2', azp: ORIGIN }));
		await outcome(() => signOut.actions.default!({ locals: l, request: post('__session=x'), url: new URL(ORIGIN), cookies: jar().cookies } as never));
		expect(status.calls.some((x) => x.includes('POST /v1/sessions/sess_so2/revoke'))).toBe(true);
	});
	it('stays signed in and says so, clearing no cookie, when Clerk cannot confirm the revocation', async () => {
		status.set('sess_so3', 'user_a1');
		const l = await locals(A.token({ sub: 'user_a1', sid: 'sess_so3', azp: ORIGIN })), c = jar();
		status.outage(true);
		try {
			const r = await outcome(() => signOut.actions.default!({ locals: l, request: post('__session=x'), url: new URL(ORIGIN), cookies: c.cookies } as never));
			expect(r.thrown).toMatchObject({ status: 503, body: { code: 'identity-unavailable' } });
			expect(c.deleted).toEqual([]);
		} finally {
			status.outage(false);
		}
	});
});

describe('/sign-in as one browser session per origin', () => {
	it('signs a staff session out before sending the browser to the client instance, and never reuses the old cookie', async () => {
		status.set('sess_sw1', 'user_b1');
		const token = B.token({ sub: 'user_b1', sid: 'sess_sw1', azp: ORIGIN }), l = await locals(token), c = jar();
		const r = await outcome(() => signIn.actions.default!({ locals: l, request: new Request(`${ORIGIN}/sign-in`, { method: 'POST', headers: { cookie: `__session=${token}` } }), url: new URL(`${ORIGIN}/sign-in`), cookies: c.cookies } as never));
		expect(status.calls.some((x) => x.includes('POST /v1/sessions/sess_sw1/revoke'))).toBe(true);
		expect(c.deleted).toContain('__session');
		expect(r.thrown).toMatchObject({ status: 303 });
		expect(r.thrown?.location).toMatch(new RegExp(`^${CLIENT_SIGN_IN}\\?redirect_url=`));
	});
	it('refuses an ambiguous session credential, clearing it, and sends nobody to Clerk', async () => {
		const l = await locals(null), c = jar();
		const request = new Request(`${ORIGIN}/sign-in`, { method: 'POST', headers: { cookie: `__session=${A.token({ sub: 'a', sid: 'b', azp: ORIGIN })}; __session_AbCd1234=${B.token({ sub: 'a', sid: 'b', azp: ORIGIN })}` } });
		const r = await outcome(() => signIn.actions.default!({ locals: l, request, url: new URL(`${ORIGIN}/sign-in`), cookies: c.cookies } as never));
		expect(r.value).toMatchObject({ status: 409 });
		expect(c.deleted.sort()).toEqual(['__session', '__session_AbCd1234']);
	});
	it('sends an anonymous browser straight to the client instance, returning to a safe path only', async () => {
		const l = await locals(null);
		for (const [returnTo, back] of [['/cases/case-a1', '/cases/case-a1'], ['//attacker.example.test', '/cases'], ['https://attacker.example.test', '/cases']] as const) {
			const url = new URL(`${ORIGIN}/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
			const r = await outcome(() => signIn.actions.default!({ locals: l, request: new Request(url, { method: 'POST' }), url, cookies: jar().cookies } as never));
			expect(new URL(r.thrown!.location!).searchParams.get('redirect_url'), returnTo).toBe(`${ORIGIN}${back}`);
		}
	});
});
