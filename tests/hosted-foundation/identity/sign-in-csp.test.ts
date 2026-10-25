// The sign-in pages' form-action (GRS-113 live blocker, native096). The app CSP is `form-action 'self'`, and a browser
// applies form-action to every redirect of a form submission, so the sign-in POST's 303 to this client's Clerk Account
// Portal never left the page. Only the two sign-in pages may name, beside 'self', the exact origins of the configured
// portal and of that instance's own Frontend API; nothing comes from the request, and every other page is unchanged.
// SYNTHETIC hosts and keys only: unit evidence, not a browser or Clerk run.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInFormActionOrigins } from '../../../src/lib/auth/clerk/config.ts';
import { createHandle, withFormActions } from '../../../src/lib/server/runtime/hosted/handle.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { craftedInstance } from './synthetic.ts';

const ORIGIN = 'https://client-a.clearcase.test';
const clientA = craftedInstance('client-a.clerk.test'), staffB = craftedInstance('staff-b.clerk.test');
const CLIENT_PORTAL = 'https://accounts.client-a.clerk.test', STAFF_PORTAL = 'https://accounts.staff-b.clerk.test';
const env = (extra: Record<string, unknown> = {}) => ({
	CLEARCASE_CLIENT_ID: 'client-a',
	CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_PUBLISHABLE_KEY: clientA.publishableKey,
	CLERK_CLIENT_SECRET_KEY: clientA.secretKey,
	CLERK_STAFF_PUBLISHABLE_KEY: staffB.publishableKey,
	CLERK_STAFF_SECRET_KEY: staffB.secretKey,
	CLERK_CLIENT_SIGN_IN_URL: `${CLIENT_PORTAL}/sign-in`,
	CLERK_STAFF_SIGN_IN_URL: `${STAFF_PORTAL}/sign-in`,
	...extra,
});
// The CSP SvelteKit renders from vite.config.ts, nonce included.
const APP_CSP = "default-src 'self'; frame-src blob:; connect-src 'self'; img-src 'self'; object-src 'none'; script-src 'self' 'nonce-c3ludGhldGlj'; style-src 'self' 'unsafe-hashes' 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const page = () => new Response('<form method="POST"></form>', { headers: { 'content-type': 'text/html', 'content-security-policy': APP_CSP } });
const services = () => createUnavailableServices({ clientId: id('client', 'client-a'), now: () => new Date('2026-10-25T09:00:00.000Z') });
async function invoke(handle: ReturnType<typeof createHandle>, request: Request) {
	const event = { request, url: new URL(request.url), locals: {} };
	return handle({ event, resolve: async () => page() } as unknown as Parameters<typeof handle>[0]);
}
const directives = (csp: string) => csp.split(';').map((d) => d.trim());

describe('the sign-in form-action origins come from the reviewed configuration only', () => {
	it('names the client portal and client Frontend API for /sign-in, the staff ones for /sign-in/operator', () => {
		expect(signInFormActionOrigins(env(), '/sign-in')).toEqual([CLIENT_PORTAL, clientA.iss]);
		expect(signInFormActionOrigins(env(), '/sign-in/operator')).toEqual([STAFF_PORTAL, staffB.iss]);
	});
	it('never lends one instance’s hosts to the other route', () => {
		expect(signInFormActionOrigins(env(), '/sign-in')).not.toContain(STAFF_PORTAL);
		expect(signInFormActionOrigins(env(), '/sign-in')).not.toContain(staffB.iss);
		expect(signInFormActionOrigins(env(), '/sign-in/operator')).not.toContain(CLIENT_PORTAL);
		expect(signInFormActionOrigins(env(), '/sign-in/operator')).not.toContain(clientA.iss);
	});
	it.each(['/', '/cases', '/sign-out', '/sign-in/', '/sign-inx', '/SIGN-IN', '/sign-in/operator/', '/operator/cases', '/health'])('names nothing for %s', (path) => {
		expect(signInFormActionOrigins(env(), path)).toEqual([]);
	});
	it('names nothing when the deployment is unconfigured or the route’s sign-in URL is absent', () => {
		expect(signInFormActionOrigins({}, '/sign-in')).toEqual([]);
		expect(signInFormActionOrigins(env({ CLERK_CLIENT_SIGN_IN_URL: undefined }), '/sign-in')).toEqual([]);
		expect(signInFormActionOrigins(env({ CLERK_STAFF_SIGN_IN_URL: '' }), '/sign-in/operator')).toEqual([]);
		expect(signInFormActionOrigins(env({ CLERK_CLIENT_PUBLISHABLE_KEY: 'pk_test_bad' }), '/sign-in')).toEqual([]);
	});
	it.each([
		'https://*.accounts.dev/sign-in',
		'https://*/sign-in',
		'https://a;b.accounts.dev/sign-in',
		"https://a'b.accounts.dev/sign-in",
		'https://a,b.accounts.dev/sign-in',
		'https://accounts.dev./sign-in',
		'https://localhost/sign-in',
		'http://127.0.0.1:8787/sign-in',
		'http://accounts.client-a.clerk.test/sign-in',
		'https://user:pw@accounts.client-a.clerk.test/sign-in',
		'javascript:alert(1)',
		'data:text/html,x',
	])('names nothing for a hostile or non-https sign-in URL %s', (signIn) => {
		const out = signInFormActionOrigins(env({ CLERK_CLIENT_SIGN_IN_URL: signIn }), '/sign-in');
		expect(out).toEqual([]);
	});
});

describe('the hosted handle widens form-action on the sign-in pages only', () => {
	const formActions = (path: string) => signInFormActionOrigins(env(), path);
	const handle = () => createHandle(async () => ({ ready: true, services: services() }), undefined, formActions);

	it.each([
		['/sign-in', `form-action 'self' ${CLIENT_PORTAL} ${clientA.iss}`],
		['/sign-in/operator', `form-action 'self' ${STAFF_PORTAL} ${staffB.iss}`],
	])('%s names its own instance and keeps every other directive byte for byte', async (path, expected) => {
		for (const request of [new Request(ORIGIN + path), new Request(ORIGIN + path, { method: 'POST', headers: { origin: ORIGIN } })]) {
			const csp = (await invoke(handle(), request)).headers.get('content-security-policy')!;
			expect(directives(csp)).toEqual(directives(APP_CSP).map((d) => (d === "form-action 'self'" ? expected : d)));
		}
	});
	it('ignores the request: a hostile returnTo, Host or Referer adds no origin', async () => {
		const request = new Request(`${ORIGIN}/sign-in?returnTo=https://attacker.example.test/&redirect_url=https://attacker.example.test/`, { headers: { host: 'attacker.example.test', referer: 'https://attacker.example.test/' } });
		const csp = (await invoke(handle(), request)).headers.get('content-security-policy')!;
		expect(csp).not.toContain('attacker');
		expect(csp).toContain(`form-action 'self' ${CLIENT_PORTAL} ${clientA.iss};`);
	});
	it.each(['/', '/cases', '/sign-out', '/operator/cases', '/sign-in/'])('leaves the CSP of %s unchanged', async (path) => {
		expect((await invoke(handle(), new Request(ORIGIN + path))).headers.get('content-security-policy')).toBe(APP_CSP);
	});
	it('leaves the gate profile (no form-action source) unchanged', async () => {
		const gate = createHandle(async () => ({ ready: true, services: services() }));
		expect((await invoke(gate, new Request(`${ORIGIN}/sign-in`))).headers.get('content-security-policy')).toBe(APP_CSP);
	});
	it('keeps the existing security headers on the widened page', async () => {
		const response = await invoke(handle(), new Request(`${ORIGIN}/sign-in`));
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
	});
});

describe('withFormActions only extends an exact form-action \'self\' with exact https origins', () => {
	it('adds the origins once, after self', () => {
		expect(withFormActions(APP_CSP, [CLIENT_PORTAL])).toContain(`; form-action 'self' ${CLIENT_PORTAL}; frame-ancestors 'none'`);
	});
	it.each([
		["a CSP without form-action", "default-src 'self'; frame-ancestors 'none'"],
		["a form-action other than 'self'", "default-src 'self'; form-action 'none'"],
		['an empty CSP', ''],
	])('leaves %s as it is', (_label, csp) => {
		expect(withFormActions(csp, [CLIENT_PORTAL])).toBe(csp);
	});
	it.each([
		'https://*.accounts.dev',
		'*',
		'https:',
		"'unsafe-inline'",
		'https://a.test; script-src *',
		'https://a.test https://b.test',
		'http://accounts.client-a.clerk.test',
		'https://accounts.client-a.clerk.test/sign-in',
		'https://a;b.test',
	])('adds nothing when given the unsafe source %s', (source) => {
		expect(withFormActions(APP_CSP, [source])).toBe(APP_CSP);
		expect(withFormActions(APP_CSP, [CLIENT_PORTAL, source])).toBe(APP_CSP);
	});
	it('adds nothing for no origins', () => {
		expect(withFormActions(APP_CSP, [])).toBe(APP_CSP);
	});
});

describe('the production hooks wire the sign-in origins from the Worker env', () => {
	afterEach(() => {
		vi.doUnmock('cloudflare:workers');
		vi.doUnmock('../../../src/lib/server/runtime/hosted/services.ts');
		vi.resetModules();
	});
	it('a sign-in page gets the configured client portal; the cases page keeps the app CSP', async () => {
		vi.resetModules();
		vi.doMock('cloudflare:workers', () => ({ env: Object.freeze(env()) }));
		vi.doMock('../../../src/lib/server/runtime/hosted/services.ts', () => ({ hostedServices: async () => ({ ready: true, services: services() }) }));
		const { handle } = await import('../../../src/lib/server/runtime/hosted/hooks.server.ts');
		const post = (path: string) => new Request(ORIGIN + path, { method: 'POST', headers: { origin: ORIGIN } });
		expect((await invoke(handle as ReturnType<typeof createHandle>, post('/sign-in'))).headers.get('content-security-policy')).toContain(`form-action 'self' ${CLIENT_PORTAL} ${clientA.iss};`);
		expect((await invoke(handle as ReturnType<typeof createHandle>, post('/sign-in/operator'))).headers.get('content-security-policy')).toContain(`form-action 'self' ${STAFF_PORTAL} ${staffB.iss};`);
		expect((await invoke(handle as ReturnType<typeof createHandle>, post('/cases'))).headers.get('content-security-policy')).toBe(APP_CSP);
	});
});
