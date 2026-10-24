// The hosted /sign-in and /sign-out routes (GRS-113) with a SYNTHETIC Clerk configuration: production links to this
// client's Clerk sign-in page and holds no key; unconfigured stays 503; the hosted-gate double is unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('/sign-out', () => {
	it('stops presenting both the gate session and the Clerk session cookie', async () => {
		const deleted: string[] = [];
		const r = await outcome(() => signOut.actions.default!({ locals: production, url: new URL(ORIGIN), cookies: { delete: (name: string) => deleted.push(name) } } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: '/sign-in' });
		expect(deleted.sort()).toEqual(['__session', 'clearcase_session']);
	});
});
