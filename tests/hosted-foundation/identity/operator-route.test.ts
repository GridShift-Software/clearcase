import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
// The per-client staff (B) operator sign-in route (GRS-113): staff sign in at the internal Clerk instance THROUGH this
// client's origin. There is no third Worker or staff host. SYNTHETIC keys; handler unit evidence only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { craftedInstance, statusDouble } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_op1', 'user_a1');
});
afterAll(() => status.close());
const configured = (extra: Record<string, unknown> = {}) => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey, CLERK_API_URL: status.url, ...extra,
});
beforeEach(() => { workers.env = configured(); });
const production = { runtime: { testIdentity: null }, identity: { kind: 'anonymous', principal: null, sessionId: null } } as unknown as App.Locals;
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string; body?: { code?: string } } }; } };

describe('/sign-in/operator', () => {
	it('links to the staff instance sign-in page, returning to this origin, with no key in the page data', async () => {
		const r = await outcome(() => operator.load({ locals: production, url: new URL(`${ORIGIN}/sign-in/operator`) } as never));
		expect(r.value).toEqual({ provider: 'clerk-staff', href: `${STAFF_SIGN_IN}?redirect_url=${encodeURIComponent(`${ORIGIN}/sign-in/operator`)}`, options: [] });
		expect(JSON.stringify(r)).not.toContain(B.secretKey);
	});
	it('stays 503 without the staff sign-in URL and 404 on the hosted-gate profile, which has no operator sign-in', async () => {
		workers.env = configured({ CLERK_STAFF_SIGN_IN_URL: undefined });
		expect((await outcome(() => operator.load({ locals: production, url: new URL(`${ORIGIN}/sign-in/operator`) } as never))).thrown).toMatchObject({ status: 503, body: { code: 'identity-unavailable' } });
		workers.env = configured();
		const gate = { runtime: { testIdentity: { options: async () => [] } }, identity: { kind: 'anonymous' } } as unknown as App.Locals;
		expect((await outcome(() => operator.load({ locals: gate, url: new URL(`${ORIGIN}/sign-in/operator`) } as never))).thrown).toMatchObject({ status: 404 });
	});
	it('signs a client session out first, then sends the browser to the staff instance', async () => {
		const made = clerkIdentityProviderFromEnv(configured(), { authorizeCase: async () => {} });
		if (!made.ok) throw new Error(made.reason);
		const token = A.token({ sub: 'user_a1', sid: 'sess_op1', azp: ORIGIN });
		const identity = await made.provider.authenticate({ request: new Request(`${ORIGIN}/cases`, { headers: { authorization: `Bearer ${token}` } }) });
		const deleted: string[] = [];
		const r = await outcome(() => operator.actions.default!({ locals: { ...production, identity } as App.Locals, request: new Request(`${ORIGIN}/sign-in/operator`, { method: 'POST', headers: { cookie: `__session=${token}` } }), url: new URL(`${ORIGIN}/sign-in/operator`), cookies: { delete: (n: string) => deleted.push(n), set: () => {} } } as never));
		expect(status.calls.some((c) => c.includes('POST /v1/sessions/sess_op1/revoke'))).toBe(true);
		expect(deleted).toContain('__session');
		expect(r.thrown).toMatchObject({ status: 303 });
		expect(r.thrown?.location).toMatch(new RegExp(`^${STAFF_SIGN_IN}\\?redirect_url=`));
	});
});
