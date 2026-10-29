import { describe, expect, it, vi } from 'vitest';
import { appCookieValue, appSetCookie, mintAppSession, readAppSession, revokeAppSession, SESSION_MAX, SESSION_WINDOW, signAppSession, slideAppSession, type AppSessionConfig } from '../../../src/lib/auth/app-session.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { appSessionRefresh, clerkBrowserNeeded } from '../../../src/lib/auth/app-browser.ts';
import { craftedInstance } from './synthetic.ts';
import { signOutClerkSession } from '../../../src/lib/auth/clerk/flow.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';

const client = craftedInstance('app-client.clerk.test'), staff = craftedInstance('app-staff.clerk.test');
function fixture() {
	const store = new Map<string, string>();
	const sessions = { get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string, _options: { expirationTtl: number }) => { store.set(k, v); }) };
	const config: AppSessionConfig = { key: 'a'.repeat(64), clientId: 'client-a', origin: 'https://client-a.test', issuer: client.iss, sessions };
	const env = { CLEARCASE_SESSION_KEY: config.key, CLEARCASE_CLIENT_ID: config.clientId, CLEARCASE_APP_ORIGIN: config.origin, SESSIONS: sessions,
		CLERK_CLIENT_PUBLISHABLE_KEY: client.publishableKey, CLERK_CLIENT_SECRET_KEY: client.secretKey, CLERK_CLIENT_JWT_KEY: client.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: staff.publishableKey, CLERK_STAFF_SECRET_KEY: staff.secretKey, CLERK_STAFF_JWT_KEY: staff.jwtKey };
	const session = () => mintAppSession(config, { sid: 'sess_app', subject: 'user_app', name: 'Synthetic Lawyer' });
	const request = (value: string) => new Request(`${config.origin}/cases`, { headers: { cookie: `clearcase_session=${value}` } });
	const provider = () => {
		const result = clerkIdentityProviderFromEnv(env, { authorizeCase: async () => {} });
		if (!result.ok) throw new Error(result.reason);
		return result.provider;
	};
	return { config, env, sessions, session, request, provider };
}
describe('app session', () => {
	it('refuses 8 hours and 1 minute after the last refresh', async () => {
		const f = fixture(), s = await f.session();
		expect(await readAppSession(f.config, await signAppSession(f.config, s), s.iat + SESSION_WINDOW + 60) === null).toBe(true);
	});
	it('slides only after five minutes and cannot survive its 24 hour cap', async () => {
		const f = fixture(); let s = await f.session();
		expect(slideAppSession(s, s.iat + 300) === null).toBe(true);
		const slid = slideAppSession(s, s.iat + 301)!;
		expect(slid.exp).toBe(s.iat + 301 + SESSION_WINDOW);
		const issued = s.iat;
		for (let hour = 1; hour < 24; hour++) s = slideAppSession(s, issued + hour * 3600)!;
		expect(s.max).toBe(issued + SESSION_MAX);
		expect(s.exp).toBe(s.max);
		expect(await readAppSession(f.config, await signAppSession(f.config, s), s.max) === null).toBe(true);
	});
	it('binds the signature to client, app origin and issuer; refuses tampering and ambiguous cookies', async () => {
		const f = fixture(), value = await signAppSession(f.config, await f.session());
		for (const change of [{ clientId: 'client-b' }, { issuer: staff.iss }, { origin: 'https://elsewhere.test' }])
			expect(await readAppSession({ ...f.config, ...change }, value) === null).toBe(true);
		expect(await readAppSession(f.config, `${value}x`) === null).toBe(true);
		expect(appCookieValue(new Request(f.config.origin, { headers: { cookie: 'clearcase_session=a; clearcase_session=b' } })) === 'malformed').toBe(true);
	});
	it('sets the required browser cookie attributes', async () => {
		const f = fixture(), s = await f.session();
		const header = appSetCookie('synthetic-placeholder', s);
		for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(header.includes(attribute)).toBe(true);
	});
	it('authenticates and authorizes with zero fetches and one KV read; a second Worker refuses after sign-out', async () => {
		const f = fixture(), s = await f.session(), request = f.request(await signAppSession(f.config, s));
		const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
		try {
			const identity = await f.provider().authenticate({ request });
			expect(identity.kind).toBe('verified');
			expect('name' in identity && identity.name === 'Synthetic Lawyer').toBe(true);
			await identity.checkRevocation();
			await identity.authorize({ caseId: id('case', 'case-a'), operation: 'read' });
			expect(clerkBrowserNeeded(f.env, request)).toBe(false);
			await appSessionRefresh(f.env, request);
			expect(network).toHaveBeenCalledTimes(0);
			expect(f.sessions.get).toHaveBeenCalledTimes(1);
			await revokeAppSession(f.config, request);
			expect(f.sessions.put.mock.calls[0]?.[2].expirationTtl).toBeGreaterThan(SESSION_MAX - 10);
			expect((await f.provider().authenticate({ request })).kind).toBe('anonymous');
		} finally { network.mockRestore(); }
	});
	it('fails closed on KV outage and never falls back to the Clerk cookie', async () => {
		const f = fixture(), request = f.request(await signAppSession(f.config, await f.session()));
		f.sessions.get.mockRejectedValueOnce(new Error('synthetic outage'));
		await expect(f.provider().authenticate({ request })).rejects.toMatchObject({ code: 'identity-unavailable' });
		const invalid = f.request('malformed');
		invalid.headers.set('cookie', `${invalid.headers.get('cookie')}; __session=${client.token({ sub: 'user_app', sid: 'sess_app', azp: f.config.origin })}`);
		expect((await f.provider().authenticate({ request: invalid })).kind).toBe('anonymous');
	});
	it('bootstraps only at sign-in, networklessly, from a pinned Clerk JWT', async () => {
		const f = fixture();
		const headers = { cookie: `__session=${client.token({ sub: 'user_app', sid: 'sess_app', azp: f.config.origin, claims: { name: 'Synthetic Lawyer' } })}` };
		const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network'));
		try {
			expect((await f.provider().authenticate({ request: new Request(`${f.config.origin}/sign-in`, { headers }) })).kind).toBe('verified');
			expect((await f.provider().authenticate({ request: new Request(`${f.config.origin}/cases`, { headers }) })).kind).toBe('anonymous');
			expect(network).toHaveBeenCalledTimes(0);
		} finally { network.mockRestore(); }
	});
	it('ends both independent devices, rejects old Clerk bootstrap, and permits a fresh sign-in', async () => {
		vi.useFakeTimers();
		try {
			const f = fixture(), first = await f.session();
			const second = await mintAppSession(f.config, { sid: 'sess_other', subject: first.subject, name: first.name });
			const a = f.request(await signAppSession(f.config, first)), b = f.request(await signAppSession(f.config, second));
			expect((await f.provider().authenticate({ request: b })).kind).toBe('verified');
			await revokeAppSession(f.config, a);
			f.sessions.get.mockClear();
			expect((await f.provider().authenticate({ request: b })).kind).toBe('anonymous');
			expect(f.sessions.get).toHaveBeenCalledTimes(1);
			const bootstrap = (iat: number) => new Request(`${f.config.origin}/sign-in`, { headers: { cookie: `__session=${client.token({ sub: first.subject, sid: 'sess_new', azp: f.config.origin, claims: { iat } })}` } });
			expect((await f.provider().authenticate({ request: bootstrap(first.iat) })).kind).toBe('anonymous');
			vi.advanceTimersByTime(2000);
			expect((await f.provider().authenticate({ request: bootstrap(Math.floor(Date.now() / 1000)) })).kind).toBe('verified');
			const fresh = await mintAppSession(f.config, { sid: 'sess_new', subject: first.subject, name: first.name });
			expect((await f.provider().authenticate({ request: f.request(await signAppSession(f.config, fresh)) })).kind).toBe('verified');
		} finally { vi.useRealTimers(); }
	});
	it('revokes every active Clerk session at sign-out', async () => {
		const f = fixture(), request = f.request(await signAppSession(f.config, await f.session()));
		const identity = await f.provider().authenticate({ request });
		const revoked: string[] = [];
		const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = new URL(String(input));
			if (url.pathname === '/v1/sessions') {
				expect(url.searchParams.get('user_id')).toBe('user_app');
				expect(url.searchParams.get('status')).toBe('active');
				return Response.json([{ id: 'sess_app' }, { id: 'sess_other' }]);
			}
			revoked.push(url.pathname);
			return Response.json({});
		});
		try {
			await signOutClerkSession({ env: f.env, request, identity });
			expect(revoked.sort()).toEqual(['/v1/sessions/sess_app/revoke', '/v1/sessions/sess_other/revoke']);
		} finally { network.mockRestore(); }
	});

	it('selects the staff protocol with app bindings for a refresh hold or handshake return on cases', () => {
		const f = fixture();
		for (const url of ['/cases?__clerk_handshake=synthetic', '/cases?__clearcase_staff_hs=synthetic']) expect(clerkBrowserNeeded(f.env, new Request(f.config.origin + url))).toBe(true);
		expect(clerkBrowserNeeded(f.env, new Request(f.config.origin + '/cases', { headers: { cookie: '__Host-clearcase_staff_refresh=synthetic' } }))).toBe(true);
	});

});

// The app cookie is `__Host-` (GRS-278 review M1): a sibling of the staging host on gridshift.co.za can set a
// Domain=gridshift.co.za cookie, never a `__Host-` one. A planted unprefixed copy, even one that carries a genuinely signed
// session of its own, authenticates nobody and does not make the browser's own cookie ambiguous.
describe('app session cookie name', () => {
	const at = (f: ReturnType<typeof fixture>, cookie: string) => new Request(`${f.config.origin}/cases`, { headers: { cookie } });
	const planted = async (f: ReturnType<typeof fixture>) => signAppSession(f.config, await mintAppSession(f.config, { sid: 'sess_sibling', subject: 'user_sibling', name: 'Sibling Planted' }));
	it('ignores an unprefixed clearcase_session that carries a validly signed session', async () => {
		const f = fixture(), request = at(f, `clearcase_session=${await planted(f)}`);
		expect(appCookieValue(request)).toBe(null);
		expect((await f.provider().authenticate({ request })).kind).toBe('anonymous');
		expect(await appSessionRefresh(f.env, request)).toBe(null);
	});
	it('authenticates the __Host- cookie, and only its identity beside a planted unprefixed one', async () => {
		const f = fixture(), own = await signAppSession(f.config, await f.session()), sibling = await planted(f);
		for (const cookie of [`__Host-clearcase_session=${own}`, `clearcase_session=${sibling}; __Host-clearcase_session=${own}`, `__Host-clearcase_session=${own}; clearcase_session=${sibling}`]) {
			const identity = await f.provider().authenticate({ request: at(f, cookie) });
			expect(identity.kind).toBe('verified');
			expect(identity.principal?.subject).toBe('user_app');
		}
	});
	it('still refuses two __Host- cookies or a comma-joined one', async () => {
		const f = fixture(), own = await signAppSession(f.config, await f.session()), sibling = await planted(f);
		for (const cookie of [`__Host-clearcase_session=${own}; __Host-clearcase_session=${sibling}`, `x=1, __Host-clearcase_session=${own}`]) {
			expect(appCookieValue(at(f, cookie))).toBe('malformed');
			expect((await f.provider().authenticate({ request: at(f, cookie) })).kind).toBe('anonymous');
		}
	});
	it('sets the __Host- name host-only on Path=/ with Secure', async () => {
		const f = fixture(), s = await f.session(), header = appSetCookie('synthetic-placeholder', s);
		expect(header.startsWith('__Host-clearcase_session=synthetic-placeholder;')).toBe(true);
		expect(/;\s*Domain=/i.test(header)).toBe(false);
		for (const attribute of ['Secure', 'Path=/']) expect(header.includes(attribute)).toBe(true);
	});
});
