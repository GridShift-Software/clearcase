// Synthetic hook/action smoke evidence; staging browser timing is a separate phase-2 gate.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { craftedInstance, statusDouble } from '../../hosted-foundation/identity/synthetic.ts';
import { appSessionConfig, mintAppSession, readAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown>, waitUntil: () => {} }));
vi.mock('cloudflare:workers', () => workers);
import { handle } from '../../../src/lib/server/runtime/hosted/hooks.server.ts';
import { load } from '../../../deploy/client/routes/sign-in/+page.server.ts';
import { actions } from '../../../deploy/client/routes/sign-out/+page.server.ts';
const client = craftedInstance('smoke-client.clerk.test'), staff = craftedInstance('smoke-staff.clerk.test');
const ORIGIN = 'https://smoke.clearcase.test';
let clerk: Awaited<ReturnType<typeof statusDouble>>;
const revoked = new Map<string, string>();
const kv = { get: vi.fn(async (key: string) => revoked.get(key) ?? null), put: vi.fn(async (key: string, value: string) => { revoked.set(key, value); }) };
beforeAll(async () => {
	clerk = await statusDouble();
	Object.assign(workers.env, {
		CLEARCASE_CLIENT_ID: 'smoke', CLEARCASE_APP_ORIGIN: ORIGIN, CLEARCASE_SESSION_KEY: 'b'.repeat(64), SESSIONS: kv,
		CLERK_CLIENT_PUBLISHABLE_KEY: client.publishableKey, CLERK_CLIENT_SECRET_KEY: client.secretKey, CLERK_CLIENT_JWT_KEY: client.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: staff.publishableKey, CLERK_STAFF_SECRET_KEY: staff.secretKey, CLERK_STAFF_JWT_KEY: staff.jwtKey,
		CLERK_API_URL: clerk.url,
	});
});
afterAll(() => clerk.close());
afterEach(() => { vi.useRealTimers(); });
const config = () => appSessionConfig(workers.env, client.iss)!;
async function cookie(sid: string) {
	return `clearcase_session=${await signAppSession(config(), await mintAppSession(config(), { sid, subject: 'user_smoke', name: 'Smoke Lawyer' }))}`;
}
async function invoke(request: Request, signOut = false) {
	const cleared: string[] = [];
	const event = { request, url: new URL(request.url), locals: {}, cookies: { delete: (name: string) => cleared.push(name) } };
	const response = await handle({ event: event as never, resolve: async (e) => {
		if (signOut) {
			try { await actions.default!(e); } catch (error) {
				if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') return new Response(null, { status: error.status });
				throw error;
			}
		}
		return new Response(null, { status: e.locals.identity.kind === 'verified' ? 200 : 401 });
	} });
	return { response, cleared };
}
describe('client app-session hook and actions', () => {
	it('sets the app cookie on the pinned Clerk callback and returns to the case list', async () => {
		const request = new Request(`${ORIGIN}/sign-in`, { headers: { cookie: `__session=${client.token({ sub: 'user_smoke', sid: 'sess_callback', azp: ORIGIN })}` } });
		const provider = clerkIdentityProviderFromEnv(workers.env, { authorizeCase: async () => {} });
		if (!provider.ok) throw new Error(provider.reason);
		const identity = await provider.provider.authenticate({ request });
		const installed: Promise<boolean>[] = [];
		const cookies = { set: (name: string, value: string, options: { httpOnly: boolean; secure: boolean; sameSite: string; path: string }) => {
			installed.push((async () => name === 'clearcase_session' && (await readAppSession(config(), value))?.name === 'user_smoke' && options.httpOnly && options.secure && options.sameSite === 'lax' && options.path === '/')());
		}, delete: () => {} };
		let location = '';
		try { await load({ request, url: new URL(request.url), locals: { identity, runtime: { testIdentity: null } }, cookies, isDataRequest: false } as never); }
		catch (error) { if (typeof error === 'object' && error !== null && 'location' in error && typeof error.location === 'string') location = error.location; else throw error; }
		expect(await Promise.all(installed)).toEqual([true]);
		expect(location).toBe('/cases');
	});
	it('survives 20 minutes idle, slides through the real hook, and never calls Clerk or marks reauthentication', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const issued = Date.now(), credential = await cookie('sess_idle');
		vi.setSystemTime(issued + 20 * 60 * 1000);
		const calls = clerk.calls.length, reads = kv.get.mock.calls.length;
		const { response } = await invoke(new Request(`${ORIGIN}/cases`, { headers: { cookie: credential } }));
		expect(response.status).toBe(200);
		expect(clerk.calls.length - calls).toBe(0);
		expect(kv.get.mock.calls.length - reads).toBe(1);
		expect(response.headers.has('x-clearcase-reauth')).toBe(false);
		const header = response.headers.get('set-cookie') ?? '';
		const renewed = header.split(';')[0]?.slice('clearcase_session='.length) ?? '';
		expect((await readAppSession(config(), renewed))?.refreshed === Math.floor(Date.now() / 1000)).toBe(true);
	});
	it('revokes in KV before Clerk sign-out, clears the cookie, and refuses the same cookie on another request', async () => {
		clerk.set('sess_logout', 'user_smoke');
		const credential = await cookie('sess_logout');
		const result = await invoke(new Request(`${ORIGIN}/sign-out`, { method: 'POST', headers: { cookie: credential, origin: ORIGIN } }), true);
		expect(result.response.status).toBe(303);
		expect(revoked.has('revoked:sess_logout')).toBe(true);
		expect(result.cleared.includes('clearcase_session')).toBe(true);
		expect(clerk.statusOf('sess_logout')).toBe('revoked');
		expect((await invoke(new Request(`${ORIGIN}/cases`, { headers: { cookie: credential } }))).response.status).toBe(401);
	});
});
