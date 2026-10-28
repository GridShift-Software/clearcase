import { legacyClerkProviderFromEnv as clerkIdentityProviderFromEnv } from './synthetic.ts';
// The staff portal's native return (GRS-113): the staff portal hands the browser back to the operator route, not to
// /cases, so the first unsigned callback already takes the staff handshake; once a verified staff session is installed,
// the operator page sends it on to the safe final target. SYNTHETIC keys; handler unit evidence only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkSignInTarget, readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { createClerkBrowserHandshake } from '../../../src/lib/auth/clerk/browser.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in', CLIENT_SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in';
const DEV_BROWSER = 'dvb_synthetic0123456789abcdef';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('other-c.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_a1', 'user_a1');
	status.set('sess_b1', 'user_b1');
});
afterAll(() => status.close());
const configured = (extra: Record<string, unknown> = {}) => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN, CLERK_CLIENT_SIGN_IN_URL: CLIENT_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey, CLERK_API_URL: status.url, ...extra,
});
beforeEach(() => { workers.env = configured(); });

const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
const outcome = async (f: () => unknown) => { try { return { value: await f() as { href?: string } }; } catch (e) { return { thrown: e as { status?: number; location?: string } }; } };
const identityOf = async (token: string) => {
	const made = clerkIdentityProviderFromEnv(configured(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request: new Request(`${ORIGIN}/sign-in/operator`, { headers: { cookie: `__client_uat=1761400000; __session=${token}` } }) });
};
const staffToken = () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN });
const clientToken = () => A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN });
const operatorPage = (query = '') => new URL(`${ORIGIN}/sign-in/operator${query}`);
const cookies = { set: () => {}, delete: () => {} };
const load = (identity: unknown, query = '') => outcome(() => operator.load({ locals: locals(identity), url: operatorPage(query), request: new Request(operatorPage(query)), cookies } as never));
const callbackOf = (href: string) => new URL(new URL(href).searchParams.get('redirect_url')!);

describe('the staff portal returns to the operator route', () => {
	it('names the bare operator route as the staff portal\'s redirect_url, whatever the final target', async () => {
		const r = await load(anonymous, `?returnTo=${encodeURIComponent('/cases/case-1?tab=documents')}`);
		const back = callbackOf(r.value!.href!);
		expect(back.href).toBe(`${ORIGIN}/sign-in/operator`);
		expect(callbackOf((await load(anonymous)).value!.href!).href).toBe(`${ORIGIN}/sign-in/operator`);
	});
	it('sends the sign-in POST to the staff portal with the same operator callback', async () => {
		const r = await outcome(() => operator.actions.default!({ locals: locals(anonymous), url: operatorPage('?returnTo=%2Fcases%2Fcase-1'), request: new Request(operatorPage('?returnTo=%2Fcases%2Fcase-1'), { method: 'POST', headers: { cookie: `__clerk_db_jwt=${DEV_BROWSER}` } }), cookies } as never));
		expect(r.thrown).toMatchObject({ status: 303 });
		expect(new URL(r.thrown!.location!).searchParams.has('__clerk_db_jwt')).toBe(false);
		expect(callbackOf(r.thrown!.location!).href).toBe(`${ORIGIN}/sign-in/operator`);
	});
	it('takes the staff handshake on the first unsigned callback, which only carries a dev browser', async () => {
		const read = readClerkIdentityConfig(configured());
		if (!read.ok) throw new Error(read.reason);
		const r = await load(anonymous);
		const callback = callbackOf(r.value!.href!);
		callback.searchParams.set('__clerk_db_jwt', DEV_BROWSER);
		const o = await createClerkBrowserHandshake({ config: read.config }).handle(new Request(callback, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document', cookie: `__clerk_db_jwt=${DEV_BROWSER}` } }));
		expect(o.kind).toBe('redirect');
		const to = new URL((o as { location: string }).location);
		expect(`${to.origin}${to.pathname}`).toBe(`${B.iss}/v1/client/handshake`);
		expect(new URL(to.searchParams.get('redirect_url')!).pathname).toBe('/sign-in/operator');
	});
	it('keeps the client portal returning to the client sign-in page, and the client dev browser away from the staff portal', () => {
		expect(clerkSignInTarget(workers.env, 'client')?.href).toBe(`${CLIENT_SIGN_IN}?redirect_url=${encodeURIComponent(`${ORIGIN}/sign-in`)}`);
		expect(new URL(clerkSignInTarget(workers.env, 'staff', DEV_BROWSER)!.href).searchParams.has('__clerk_db_jwt')).toBe(false);
	});
	it.each(['/sign-in/operator?returnTo=/cases', '/sign-in', '/sign-out', '/SIGN-IN/operator', '/sign-in%2Foperator', '/cases/../sign-in/operator', '/%73ign-in/operator', '/sign-in%252Foperator', '/%2F%2Fsign-in/operator'])(
		'never nests a sign-in or sign-out page (%s) in the staff callback', async (back) => {
			expect(callbackOf((await load(anonymous, `?returnTo=${encodeURIComponent(back)}`)).value!.href!).href).toBe(`${ORIGIN}/sign-in/operator`);
		},
	);
});

describe('the operator page once the staff handshake has installed a session', () => {
	it('sends a verified staff session on to the final target', async () => {
		const staff = await identityOf(staffToken());
		expect(staff).toMatchObject({ kind: 'verified', principal: { kind: 'staff' } });
		expect((await load(staff, `?returnTo=${encodeURIComponent('/cases/case-1?tab=documents')}`)).thrown).toMatchObject({ status: 303, location: '/cases/case-1?tab=documents' });
		expect((await load(staff)).thrown).toMatchObject({ status: 303, location: '/cases' });
	});
	it.each([
		'https://attacker.example.test/cases', '//attacker.example.test/cases', '/\\attacker.example.test', '/cases\u0000x', '/cases\nx', 'javascript:alert(1)',
		'/sign-in/operator?returnTo=/cases', '/sign-in/operator', '/sign-in', '/sign-out', '/sign-out/x', '/SIGN-IN/operator', '/sign-in%2Foperator', '/cases/../sign-in/operator', '/%73ign-in/operator', '/sign-in%252Foperator', '/%2F%2Fsign-in/operator', '/%E0%A4%A',
	])('sends a verified staff session to /cases instead of the return target %j', async (returnTo) => {
		const staff = await identityOf(staffToken());
		expect((await load(staff, `?returnTo=${encodeURIComponent(returnTo)}`)).thrown).toMatchObject({ status: 303, location: '/cases' });
	});
	it('does not short-circuit a verified client session: the page stays, and signing in signs it out first', async () => {
		const client = await identityOf(clientToken());
		expect(client).toMatchObject({ kind: 'verified', principal: { kind: 'client' } });
		const r = await load(client, '?returnTo=%2Fcases%2Fcase-1');
		expect(r.thrown).toBeUndefined();
		expect(r.value).toMatchObject({ provider: 'clerk-staff' });
	});
	it.each([
		['no session', () => ''],
		['a staff-issued token signed by an unconfigured instance', () => C.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, claims: { iss: B.iss } })],
		['an expired staff token', () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN, now: Date.now() - 3_600_000 })],
		['a staff token for another origin', () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: 'https://client-b.clearcase.test' })],
	])('never treats %s as verified', async (_name, token) => {
		const identity = token() ? await identityOf(token()) : anonymous;
		expect(identity).toMatchObject({ kind: 'anonymous' });
		const r = await load(identity, '?returnTo=%2Fcases%2Fcase-1');
		expect(r.thrown).toBeUndefined();
		expect(r.value).toMatchObject({ provider: 'clerk-staff' });
	});
});
