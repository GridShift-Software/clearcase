// The hosted /sign-in and /sign-out routes (GRS-113) with a SYNTHETIC Clerk configuration: production links to this
// client's Clerk sign-in page and holds no key; unconfigured stays 503; the hosted-gate double is unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedirect } from '@clerk/backend/internal';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const { load, actions } = await import('../../../deploy/client/routes/sign-in/+page.server.ts');
const signOut = await import('../../../deploy/client/routes/sign-out/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
const configured = {
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_CLIENT_SIGN_IN_URL: SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey,
};
const production = { runtime: { testIdentity: null }, identity: { sessionId: null } } as unknown as App.Locals;
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string; body?: { code?: string } } }; } };
beforeEach(() => { workers.env = {}; });

describe('/sign-in in production', () => {
	it('links to the client Clerk sign-in page, returning to /cases, with no key in the page data', async () => {
		workers.env = configured;
		const r = await outcome(() => load({ locals: production } as never));
		expect(r).toEqual({ value: { provider: 'clerk', href: `${SIGN_IN}?redirect_url=${encodeURIComponent(`${ORIGIN}/cases`)}`, options: [] } });
		const page = JSON.stringify(r);
		for (const secret of [A.secretKey, B.secretKey, A.publishableKey, B.publishableKey]) expect(page).not.toContain(secret);
		const post = await outcome(() => actions.default!({ locals: production, request: new Request(`${ORIGIN}/sign-in`, { method: 'POST' }) } as never));
		expect(post.thrown).toMatchObject({ status: 303, location: r.value && (r.value as { href: string }).href });
	});
	it('stays 503 identity-unavailable when the configuration is missing or incomplete', async () => {
		for (const env of [{}, { ...configured, CLERK_STAFF_SECRET_KEY: undefined }, { ...configured, CLERK_CLIENT_SIGN_IN_URL: undefined }]) {
			workers.env = env;
			expect((await outcome(() => load({ locals: production } as never))).thrown).toMatchObject({ status: 503, body: { code: 'identity-unavailable' } });
		}
	});
});

describe('/sign-in hands a development portal this browser\'s own Clerk client', () => {
	const DEV_BROWSER = 'dvb.synthetic-dev-browser_0123456789';
	const post = (cookie?: string) => outcome(() => actions.default!({ locals: production, request: new Request(`${ORIGIN}/sign-in`, { method: 'POST', headers: cookie ? { cookie } : {} }) } as never));
	const live = (k: string) => k.replace(/^(pk|sk)_test_/, '$1_live_');

	it('sends the dev browser to the portal exactly as @clerk/backend redirectToSignIn does, and never into page data', async () => {
		workers.env = configured;
		const sdk = createRedirect({ publishableKey: A.publishableKey, baseUrl: ORIGIN, signInUrl: SIGN_IN, devBrowserToken: DEV_BROWSER, redirectAdapter: (u: string) => u }).redirectToSignIn({ returnBackUrl: `${ORIGIN}/cases` });
		expect((await post(`__clerk_db_jwt=${DEV_BROWSER}; __client_uat=0`)).thrown).toMatchObject({ status: 303, location: sdk });
		expect(new URL(sdk).searchParams.get('__clerk_db_jwt')).toBe(DEV_BROWSER);
		const page = await outcome(() => load({ locals: production, request: new Request(`${ORIGIN}/sign-in`, { headers: { cookie: `__clerk_db_jwt=${DEV_BROWSER}` } }) } as never));
		expect(JSON.stringify(page)).not.toContain(DEV_BROWSER);
	});
	it('sends no dev browser for a production instance, an absent, repeated, suffixed-only or malformed cookie', async () => {
		const plainHref = `${SIGN_IN}?redirect_url=${encodeURIComponent(`${ORIGIN}/cases`)}`;
		workers.env = { ...configured, CLERK_CLIENT_PUBLISHABLE_KEY: live(A.publishableKey), CLERK_CLIENT_SECRET_KEY: live(A.secretKey) };
		expect((await post(`__clerk_db_jwt=${DEV_BROWSER}`)).thrown).toMatchObject({ status: 303, location: plainHref });
		workers.env = configured;
		for (const cookie of [undefined, `__clerk_db_jwt=${DEV_BROWSER}; __clerk_db_jwt=${DEV_BROWSER}x`, `__clerk_db_jwt_AbCd1234=${DEV_BROWSER}`, '__clerk_db_jwt=a"b', '__clerk_db_jwt=short', `__clerk_db_jwt=${'a'.repeat(4097)}`])
			expect((await post(cookie)).thrown, String(cookie)).toMatchObject({ status: 303, location: plainHref });
	});
	it('never hands the client origin\'s dev browser to the staff portal', async () => {
		const STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in';
		workers.env = { ...configured, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN };
		const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');
		const r = await outcome(() => operator.actions.default!({ locals: production, url: new URL(`${ORIGIN}/sign-in/operator`), request: new Request(`${ORIGIN}/sign-in/operator`, { method: 'POST', headers: { cookie: `__clerk_db_jwt=${DEV_BROWSER}` } }) } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: `${STAFF_SIGN_IN}?redirect_url=${encodeURIComponent(`${ORIGIN}/cases`)}` });
	});
});

describe('/sign-out', () => {
	it('stops presenting both the gate session and the Clerk session cookie', async () => {
		const deleted: string[] = [];
		const r = await outcome(() => signOut.actions.default!({ locals: production, url: new URL(ORIGIN), cookies: { delete: (name: string) => deleted.push(name) } } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: '/sign-in' });
		expect(deleted.sort()).toEqual(['__session', 'clearcase_session']);
	});
});
