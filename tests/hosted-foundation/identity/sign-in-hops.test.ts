// GRS-266: fewer of ClearCase's own redirect hops in a hosted sign-in. The Worker answers from London and every hop costs
// a round trip, so the return chain (handshake return, 303 to the clean URL, 303 dropping the reauth mark, 303 to the
// target) collapses to one 303 to the target, and a sign-in page the handshake has just returned to renders where it
// lands. Every check the longer chain made still runs: the handshake token is verified as before, the session through
// the identity provider, and the target through the route's return-target allow-list. SYNTHETIC keys and hosts; unit
// and handler evidence only, not a browser or a real Clerk instance.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clerkBrowserHandshakeFromEnv, handshakeAnswer, handshakeResponse, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { readClerkIdentityConfig } from '../../../src/lib/auth/clerk/config.ts';
import { bootstrapProof } from '../../../src/lib/auth/clerk/flow.ts';
import { createHandle } from '../../../src/lib/server/runtime/hosted/handle.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';
import { bindingStarted, clientTie } from './started-here.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', DEV_BROWSER = 'dvb_synthetic0123456789abcdef';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_b1', 'user_b1');
});
afterAll(() => status.close());

// The staging shape: app sessions on, so a client session is verified on /sign-in only, to mint the app session there.
const env = (): Record<string, unknown> => ({
	CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} },
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_SIGN_IN_URL: 'https://accounts.client-a.clerk.test/sign-in', CLERK_STAFF_SIGN_IN_URL: 'https://accounts.staff-b.clerk.test/sign-in',
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey, CLERK_API_URL: status.url,
});
const handshake = () => {
	const made = clerkBrowserHandshakeFromEnv(env());
	if (!made.ok) throw new Error(made.reason);
	return bindingStarted(made.handshake, env());
};
const identityOf = async (request: Request) => {
	const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request });
};
const doc = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const page = (path: string, cookie?: string, headers: Record<string, string> = doc) => new Request(`${ORIGIN}${path}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });
const clientToken = () => A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN });
const staffToken = () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN });
const signedIn = (signer: typeof A, token: string) => signer.sign({ handshake: [`__session=${token}; Path=/; Max-Age=60`, '__client_uat=1761400000; Path=/', `__clerk_db_jwt=${DEV_BROWSER}; Path=/`] });
const signedOut = () => A.sign({ handshake: ['__client_uat=0; Path=/', `__clerk_db_jwt=${DEV_BROWSER}; Path=/`] });
const returning = (path: string, token: string, cookie?: string, headers?: Record<string, string>) => page(`${path}?__clerk_handshake=${token}&__clearcase_reauth=1`, cookie, headers);
const redirectOf = (o: HandshakeOutcome) => {
	if (o.kind !== 'redirect') throw new Error(`expected a redirect, got ${JSON.stringify(o)}`);
	return o;
};

describe('a signed-in handshake return on its own sign-in page hands the route a verified credential', () => {
	it('keeps the redirect it answered before, and adds a credential carrying only the new session token and its proof', async () => {
		const token = clientToken(), o = redirectOf(await handshake().handle(returning('/sign-in', signedIn(A, token))));
		expect(o.location).toMatch(new RegExp(`^${ORIGIN}/sign-in\\?__clearcase_reauth=\\d{10}$`));
		expect(o.setCookies.some((c) => c.startsWith(`__session=${token};`))).toBe(true);
		expect(o.credential).toBeDefined();
		expect(new URL(o.credential!.url).pathname).toBe('/sign-in');
		// the proof that this browser's own handshake set the token, without which it mints nothing (GRS-279)
		const read = readClerkIdentityConfig(env());
		if (!read.ok) throw new Error(read.reason);
		const proof = await bootstrapProof(read.config, token);
		expect(o.credential!.headers.get('cookie')).toBe(`__session=${token}; ${proof.pair}`);
		expect(o.setCookies).toContain(proof.setCookie);
		expect(await identityOf(o.credential!)).toMatchObject({ kind: 'verified', principal: { kind: 'client', subject: 'user_a1' }, sessionId: 'sess_a1' });
	});
	it('does the same for a staff return on the operator page, whose session the provider still checks at Clerk', async () => {
		const token = staffToken(), o = redirectOf(await handshake().handle(returning('/sign-in/operator', signedIn(B, token))));
		expect(o.credential!.headers.get('cookie')).toBe(`__session=${token}`);
		const calls = status.calls.length;
		expect(await identityOf(o.credential!)).toMatchObject({ kind: 'verified', principal: { kind: 'staff', subject: 'user_b1' } });
		expect(status.calls.length).toBeGreaterThan(calls);
	});
	it.each([
		['a page that is not a sign-in page', () => returning('/cases', signedIn(A, clientToken()))],
		['the other flow\'s sign-in page', () => returning('/sign-in', signedIn(B, staffToken()))],
		['a signed-out return', () => returning('/sign-in', signedOut())],
		['a browser that already carries a session cookie', () => returning('/sign-in', signedIn(A, clientToken()), `__session=${clientToken()}`)],
		['a browser that carries a session hold', () => returning('/sign-in', signedIn(A, clientToken()), `__Host-clearcase_refresh=${clientToken()}~${'r'.repeat(20)}`)],
		['a request that is not a document load', () => returning('/sign-in', signedIn(A, clientToken()), undefined, { accept: 'application/json', 'sec-fetch-dest': 'empty' })],
	])('adds none for %s', async (_name, request) => {
		const o = await handshake().handle(request());
		expect(o.kind === 'redirect' ? o.credential : undefined).toBeUndefined();
	});
	it('answers the browser exactly as before when the credential is not taken', async () => {
		const o = redirectOf(await handshake().handle(returning('/sign-in', signedIn(A, clientToken()))));
		const before = handshakeResponse({ kind: 'redirect', location: o.location, setCookies: o.setCookies })!;
		const answer = handshakeAnswer(o);
		expect(answer).not.toBeInstanceOf(Response);
		const { response, credential } = answer as { response: Response; credential: Request };
		expect(credential).toBe(o.credential);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe(before.headers.get('location'));
		expect(response.headers.getSetCookie()).toEqual(before.headers.getSetCookie());
		expect(handshakeAnswer({ kind: 'continue' })).toBeNull();
		expect(handshakeAnswer(redirectOf(await handshake().handle(returning('/cases', signedIn(A, clientToken())))))).toBeInstanceOf(Response);
	});
});

describe('a sign-in page the handshake has just returned to renders where it lands', () => {
	it('answers /sign-in carrying the return mark without another redirect, while a case page still drops the mark', async () => {
		// the jar a signed-out client return leaves, its dev browser tied to the client instance (GRS-279)
		const now = Math.floor(Date.now() / 1000), jar = `__clerk_db_jwt=${DEV_BROWSER}; ${await clientTie(env(), DEV_BROWSER)}; __client_uat=0`;
		expect(await handshake().handle(page(`/sign-in?__clearcase_reauth=${now}`, jar))).toEqual({ kind: 'continue' });
		expect(await handshake().handle(page(`/sign-in?returnTo=%2Fcases%2Fcase-7&__clearcase_reauth=${now}`, jar))).toEqual({ kind: 'continue' });
		expect(redirectOf(await handshake().handle(page(`/cases?__clearcase_reauth=${now}`, jar))).location).toBe(`${ORIGIN}/cases`);
	});
	it('still stops a browser that kept none of the return\'s cookies, instead of starting another handshake', async () => {
		expect(await handshake().handle(page(`/sign-in?__clearcase_reauth=${Math.floor(Date.now() / 1000)}`))).toEqual({ kind: 'stop', signIn: '/sign-in' });
	});
});

describe('the hosted handle answers a signed-in return with the route\'s own redirect', () => {
	const services = () => createUnavailableServices({ clientId: id('client', 'client-a'), now: () => new Date('2026-10-28T09:00:00.000Z') });
	const fallback = () => {
		const headers = new Headers({ location: `${ORIGIN}/sign-in?__clearcase_reauth=1761400000`, 'cache-control': 'no-store' });
		headers.append('set-cookie', '__session=synthetic; Path=/; SameSite=Lax; HttpOnly; Secure');
		headers.append('set-cookie', '__client_uat=1761400000; Path=/; SameSite=Lax; Secure');
		return new Response(null, { status: 303, headers });
	};
	const credential = new Request(`${ORIGIN}/sign-in`, { headers: { cookie: '__session=synthetic' } });
	async function invoke(route: () => Response, ready = true) {
		const build = vi.fn(async (_request: Request, _credential?: Request) => ({ ready, services: services(), ...(ready ? {} : { reason: 'synthetic' }) }) as Parameters<typeof createHandle>[0] extends (...a: never[]) => Promise<infer R> ? R : never);
		const refresh = vi.fn(async () => null), resolve = vi.fn(async () => route());
		const handle = createHandle(build, async () => ({ response: fallback(), credential }), undefined, refresh);
		const request = returning('/sign-in', 'synthetic.handshake.token');
		const response = await handle({ event: { request, url: new URL(request.url), locals: {} }, resolve } as unknown as Parameters<typeof handle>[0]);
		return { response, build, refresh, resolve };
	}
	it('reads the identity from the credential and answers one 303 to the target, with the route\'s cookies and the handshake\'s', async () => {
		const out = await invoke(() => {
			const headers = new Headers({ location: '/cases/case-7' });
			headers.append('set-cookie', '__Host-clearcase_session=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax');
			return new Response(null, { status: 303, headers });
		});
		expect(out.build.mock.calls[0]![1]).toBe(credential);
		expect(out.refresh).not.toHaveBeenCalled();
		expect(out.response.status).toBe(303);
		expect(out.response.headers.get('location')).toBe('/cases/case-7');
		expect(out.response.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['__Host-clearcase_session', '__session', '__client_uat']);
		expect(out.response.headers.get('cache-control')).toBe('no-store');
		expect(out.response.headers.get('x-content-type-options')).toBe('nosniff');
	});
	it('keeps the route\'s own directive for a cookie the handshake also sets: the bootstrap proof it spent minting (GRS-279)', async () => {
		const handshakeSets = fallback();
		handshakeSets.headers.append('set-cookie', '__Host-clearcase_boot=synthetic; Path=/; Max-Age=120; SameSite=Lax; HttpOnly; Secure');
		const handle = createHandle(async () => ({ ready: true, services: services() }) as never, async () => ({ response: handshakeSets, credential }), undefined, async () => null);
		const request = returning('/sign-in', 'synthetic.handshake.token');
		const response = await handle({ event: { request, url: new URL(request.url), locals: {} }, resolve: async () => {
			const headers = new Headers({ location: '/cases' });
			headers.append('set-cookie', '__Host-clearcase_session=synthetic; Path=/; HttpOnly; Secure; SameSite=Lax');
			headers.append('set-cookie', '__Host-clearcase_boot=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
			return new Response(null, { status: 303, headers });
		} } as unknown as Parameters<typeof handle>[0]);
		expect(response.headers.getSetCookie().filter((c) => c.startsWith('__Host-clearcase_boot='))).toEqual(['__Host-clearcase_boot=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax']);
		expect(response.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['__Host-clearcase_session', '__Host-clearcase_boot', '__session', '__client_uat']);
	});
	it('never renders a page at the URL that carries the handshake token: a route that answers a page gets the redirect of before', async () => {
		const out = await invoke(() => new Response('<h1>Sign in</h1>', { status: 200, headers: { 'set-cookie': '__Host-clearcase_session=synthetic; Path=/' } }));
		expect(out.resolve).toHaveBeenCalledOnce();
		expect(out.response.status).toBe(303);
		expect(out.response.headers.get('location')).toBe(`${ORIGIN}/sign-in?__clearcase_reauth=1761400000`);
		expect(out.response.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['__session', '__client_uat']);
		expect(await out.response.text()).toBe('');
		expect(out.response.headers.get('x-content-type-options')).toBe('nosniff');
	});
	it('answers the redirect of before, not a 503, when the request services are not ready', async () => {
		const out = await invoke(() => new Response(null, { status: 303, headers: { location: '/cases' } }), false);
		expect(out.resolve).not.toHaveBeenCalled();
		expect(out.response.status).toBe(303);
		expect(out.response.headers.get('location')).toBe(`${ORIGIN}/sign-in?__clearcase_reauth=1761400000`);
	});
});

describe('the sign-in route takes the credential straight to the target the POST kept', () => {
	type Jar = Map<string, string>;
	const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
	const cookiesOf = (jar: Jar, sets: string[]) => ({
		set: (name: string, value: string) => { sets.push(name); jar.set(name, value); },
		delete: (name: string) => { sets.push(`-${name}`); jar.delete(name); },
		get: (name: string) => jar.get(name),
	});
	const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
	const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return e as { status?: number; location?: string }; } throw new Error('expected a redirect'); };
	const post = async (returnTo: string, jar: Jar) => {
		const url = new URL(`${ORIGIN}/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
		return thrown(() => client.actions.default!({ locals: locals({ kind: 'anonymous', principal: null, sessionId: null }), url, request: new Request(url, { method: 'POST' }), cookies: cookiesOf(jar, []) } as never));
	};
	it.each([
		['a deep link to a case page', '/cases/case-7?tab=documents', '/cases/case-7?tab=documents'],
		['an absolute URL on another origin', 'https://attacker.example.test/cases', '/cases'],
		['a protocol-relative URL', '//attacker.example.test/cases', '/cases'],
		['a sign-out page', '/sign-out', '/cases'],
	])('lands %s on its allowed target in the same answer as the handshake return', async (_name, returnTo, target) => {
		workers.env = env();
		const jar: Jar = new Map();
		expect(await post(returnTo, jar)).toMatchObject({ status: 303 });
		const request = returning('/sign-in', signedIn(A, clientToken()), header(jar)), url = new URL(request.url);
		const o = redirectOf(await handshake().handle(request));
		const identity = await identityOf(o.credential!);
		expect(identity).toMatchObject({ kind: 'verified', principal: { kind: 'client' } });
		const sets: string[] = [];
		const r = await thrown(() => client.load({ locals: locals(identity), url, request, cookies: cookiesOf(jar, sets), isDataRequest: false } as never));
		expect(r).toMatchObject({ status: 303, location: target });
		expect(sets).toContain('__Host-clearcase_session');
		expect(sets.filter((n) => n.startsWith('-__Host-clearcase_return-'))).toHaveLength(1);
	});
});
