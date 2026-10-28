import { appSessionConfig, mintAppSession, signAppSession } from '../../../src/lib/auth/app-session.ts';
// Under the custom-domain origin the deployment serves ONE origin (CLEARCASE_APP_ORIGIN). A valid session replayed at any other
// origin of the same Worker (workers.dev, a preview, another scheme or port) must be refused for every method before identity is
// resolved or a route runs: no protected read, no form action, and above all no sign-out revocation of the session.
// Drives the REAL hosted hook with the real provider, pinned Clerk SDK and sign-out action; SYNTHETIC RSA keys and a loopback
// session-status double stand in for Clerk. Not a deployed or browser acceptance.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { craftedInstance, statusDouble } from './synthetic.ts';

const injected = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => ({ env: injected.env, waitUntil: () => {} }));

import { handle } from '../../../src/lib/server/runtime/hosted/hooks.server.ts';
import { actions } from '../../../deploy/client/routes/sign-out/+page.server.ts';

const CUSTOM = 'https://sbx-a.clearcase.co.za';
const DEV = 'https://cc-sbx-a-20261023.shiny-sunset-211d.workers.dev';
const A = craftedInstance('pin-client.clerk.test'), B = craftedInstance('pin-staff.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
const pin = (value: unknown) => { injected.env.CLEARCASE_APP_ORIGIN = value; };

beforeAll(async () => {
	status = await statusDouble();
	Object.assign(injected.env, {
		CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} },
		CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: CUSTOM,
		CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
		CLERK_API_URL: status.url,
	});
});
beforeEach(() => pin(CUSTOM));
afterAll(async () => { await status.close(); });

/** One request carrying a valid session for the custom origin, sent to `origin` with that origin's own Origin header. */
async function invoke(origin: string, method: string, path = method === 'POST' ? '/sign-out' : '/cases') {
	status.set('sess_pin', 'user_pin');
	const config = appSessionConfig({ ...injected.env, CLEARCASE_APP_ORIGIN: CUSTOM }, A.iss)!;
	const token = await signAppSession(config, await mintAppSession(config, { sid: 'sess_pin', subject: 'user_pin', name: 'Synthetic Lawyer' }));
	const request = new Request(origin + path, {
		method, headers: { origin, cookie: `clearcase_session=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
		...(method === 'POST' ? { body: '' } : {}),
	});
	let resolved = false, identity = '';
	const event: any = { request, url: new URL(request.url), locals: {}, cookies: { delete() {} } };
	const response = await handle({ event, resolve: async (e: any) => {
		resolved = true;
		identity = e.locals.identity.kind;
		if (method !== 'POST') return new Response(identity);
		try { await actions.default!(e); return new Response('unexpected'); }
		catch (thrown: any) { if (typeof thrown.status === 'number') return new Response(null, { status: thrown.status }); throw thrown; }
	} } as any);
	return { code: response.status, resolved, session: status.statusOf('sess_pin'), headers: response.headers, body: await response.text() };
}

describe('the pinned origin is the only origin that is served', () => {
	it('serves the pinned origin: a read resolves a verified identity and sign-out revokes the session', async () => {
		const get = await invoke(CUSTOM, 'GET');
		expect([get.code, get.resolved, get.body]).toEqual([200, true, 'verified']);
		const post = await invoke(CUSTOM, 'POST');
		expect([post.code, post.session]).toEqual([303, 'revoked']);
	});
	it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s from workers.dev before routing, with no session effect', async (method) => {
		const before = status.calls.length;
		const out = await invoke(DEV, method);
		expect(out.code).toBe(403);
		expect(out.resolved).toBe(false);
		expect(out.session).toBe('active');
		// Nothing asked Clerk anything about this request: it was refused before identity resolution.
		expect(status.calls.slice(before)).toEqual([]);
	});
	it('does not revoke the session when sign-out is posted from workers.dev', async () => {
		const out = await invoke(DEV, 'POST', '/sign-out');
		expect([out.code, out.resolved, out.session]).toEqual([403, false, 'active']);
	});
	it.each([
		['a different scheme', 'http://sbx-a.clearcase.co.za'],
		['a different port', 'https://sbx-a.clearcase.co.za:8443'],
		['the other client host', 'https://sbx-b.clearcase.co.za'],
		['a look-alike suffix', 'https://sbx-a.clearcase.co.za.example.com'],
		['the apex', 'https://clearcase.co.za'],
	])('refuses %s', async (_label, origin) => {
		for (const method of ['GET', 'HEAD', 'POST']) {
			const out = await invoke(origin, method);
			expect([method, out.code, out.resolved, out.session]).toEqual([method, 403, false, 'active']);
		}
	});
	it('refuses without a body that names a binding, and keeps the security headers', async () => {
		const out = await invoke(DEV, 'GET', '/health');
		expect(out.code).toBe(403);
		expect(out.headers.get('cache-control')).toBe('no-store');
		expect(out.headers.get('x-content-type-options')).toBe('nosniff');
		expect(out.body).not.toMatch(/clearcase|workers\.dev|CLEARCASE_/i);
		expect(out.headers.getSetCookie()).toEqual([]);
	});
	it('compares against the canonical pin, so an unusual spelling of it still refuses every other origin', async () => {
		for (const spelling of [`${CUSTOM}/`, 'https://sbx-a.clearcase.co.za:443', 'HTTPS://SBX-A.CLEARCASE.CO.ZA']) {
			pin(spelling);
			expect([spelling, (await invoke(DEV, 'HEAD')).code]).toEqual([spelling, 403]);
			expect([spelling, (await invoke(DEV, 'POST')).session]).toEqual([spelling, 'active']);
		}
	});
	it('follows the pin: under the workers.dev pin the custom origin is the refused one', async () => {
		pin(DEV);
		expect((await invoke(CUSTOM, 'HEAD')).code).toBe(403);
	});
	it('adds nothing for an unconfigured deployment: with no pin there is no identity service, so nothing resolves and nothing is revoked', async () => {
		pin(undefined);
		for (const method of ['GET', 'HEAD', 'POST']) {
			const out = await invoke(DEV, method);
			expect([method, out.code >= 400, out.resolved, out.session]).toEqual([method, true, false, 'active']);
		}
	});
});
