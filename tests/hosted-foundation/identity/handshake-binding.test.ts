// GRS-268: a Clerk handshake return counts only in the browser that started that handshake. The handshake token is signed
// by the instance but names no browser, so a return URL one user captured signed any other browser into that user's
// account (login CSRF, session fixation; the #197 review's probe 2, which the first test here repeats). Each start now
// binds its round trip to a per-attempt cookie, and the return consumes it. SYNTHETIC keys and hosts; handler and route
// evidence only, not a browser or a real Clerk instance. Each browser here is a cookie jar that follows the answers.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clerkBrowserHandshakeFromEnv, handshakeResponse, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { craftedInstance, statusDouble } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', DEV_BROWSER = 'dvb_synthetic0123456789abcdef', STAFF_DVB = 'dvb_staffsynthetic0123456789ab';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
let status: Awaited<ReturnType<typeof statusDouble>>;
beforeAll(async () => {
	status = await statusDouble();
	status.set('sess_b1', 'user_b1');
});
afterAll(() => status.close());
afterEach(() => vi.useRealTimers());

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
	return made.handshake;
};
const identityOf = async (request: Request) => {
	const made = clerkIdentityProviderFromEnv(env(), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request });
};

type Jar = Map<string, string>;
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
const doc = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const get = (url: string | URL, jar: Jar) => new Request(url, { headers: { ...doc, ...(jar.size ? { cookie: header(jar) } : {}) } });
/** The browser applying an answer's cookies, as it would: a Max-Age=0 directive deletes, any other sets. */
function apply(jar: Jar, setCookies: readonly string[]) {
	for (const d of setCookies) {
		const pair = d.split(';')[0]!, eq = pair.indexOf('=');
		if (/;\s*Max-Age=0(?:;|$)/i.test(d)) jar.delete(pair.slice(0, eq));
		else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
	}
	return jar;
}
const redirectOf = (o: HandshakeOutcome) => {
	if (o.kind !== 'redirect') throw new Error(`expected a redirect, got ${o.kind}`);
	return o;
};
const SESSION = /^__session(?:_|=)/;
const setsSession = (o: HandshakeOutcome) => o.kind === 'redirect' && o.setCookies.some((c) => SESSION.test(c) && !/;\s*Max-Age=0(?:;|$)/i.test(c));
const setsAnyClerkCookie = (o: HandshakeOutcome) => o.kind === 'redirect' && o.setCookies.some((c) => /^(__session|__client_uat|__clerk_db_jwt|__Host-clearcase_(staff_)?refresh)/.test(c) && !/;\s*Max-Age=0(?:;|$)/i.test(c));
const clientToken = () => A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN });
const staffToken = () => B.token({ sub: 'user_b1', sid: 'sess_b1', azp: ORIGIN });
const signedIn = (signer: typeof A, token: string, dvb = DEV_BROWSER) => signer.sign({ handshake: [`__session=${token}; Path=/; Max-Age=60`, '__client_uat=1761400000; Path=/', `__clerk_db_jwt=${dvb}; Path=/`] });

/** A browser's GET of `path` starts a handshake: the jar after its answer, and the URL the Frontend API sends it back to. */
async function start(path: string, jar: Jar = new Map()) {
	const o = redirectOf(await handshake().handle(get(`${ORIGIN}${path}`, jar)));
	const to = new URL(o.location);
	expect(`${to.origin}${to.pathname}`).toMatch(/\/v1\/client\/handshake$/);
	return { jar: apply(jar, o.setCookies), back: new URL(to.searchParams.get('redirect_url')!) };
}
/** The Frontend API's return to `back` with a handshake token. */
const returned = (back: URL, token: string) => { const u = new URL(back); u.searchParams.set('__clerk_handshake', token); return u; };

describe('a captured handshake return signs no other browser in', () => {
	it('refuses the #197 review\'s replay: one signed return into two cookie-free browsers', async () => {
		const { back } = await start('/sign-in'), url = returned(back, signedIn(A, clientToken()));
		for (let n = 0; n < 2; n++) {
			const o = await handshake().handle(get(url, new Map()));
			expect(setsAnyClerkCookie(o), `replay ${n}`).toBe(false);
			expect(o.kind === 'redirect' ? o.credential : undefined).toBeUndefined();
		}
	});
	it('refuses it on any page, not only a sign-in page', async () => {
		const { back } = await start('/cases/case-7');
		expect(setsAnyClerkCookie(await handshake().handle(get(returned(back, signedIn(A, clientToken())), new Map())))).toBe(false);
	});
	it('refuses a return bound to another browser\'s handshake, though this browser started one of its own', async () => {
		const mine = await start('/sign-in'), theirs = await start('/sign-in');
		const o = await handshake().handle(get(returned(theirs.back, signedIn(A, clientToken())), mine.jar));
		expect(setsAnyClerkCookie(o)).toBe(false);
	});
	it('refuses a second use of the same return in the browser that started it', async () => {
		const { jar, back } = await start('/sign-in'), url = returned(back, signedIn(A, clientToken()));
		const first = redirectOf(await handshake().handle(get(url, jar)));
		expect(setsSession(first)).toBe(true);
		apply(jar, first.setCookies);
		for (const n of [...jar.keys()].filter((k) => SESSION.test(`${k}=`) || k.startsWith('__client_uat') || k === '__clerk_db_jwt')) jar.delete(n);
		expect(setsAnyClerkCookie(await handshake().handle(get(url, jar)))).toBe(false);
	});
	it('refuses a return that comes back after its binding lapsed', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-28T09:00:00Z') });
		const { jar, back } = await start('/sign-in');
		vi.setSystemTime(Date.now() + 121_000);
		expect(setsAnyClerkCookie(await handshake().handle(get(returned(back, signedIn(A, A.token({ sub: 'user_a1', sid: 'sess_a1', azp: ORIGIN }))), jar)))).toBe(false);
	});
	it('answers a refused return with a plain 303 to the clean page, a reason code and no session', async () => {
		const { back } = await start('/sign-in'), o = redirectOf(await handshake().handle(get(returned(back, signedIn(A, clientToken())), new Map())));
		const r = handshakeResponse(o)!;
		expect(r.status).toBe(303);
		const to = new URL(r.headers.get('location')!);
		expect(`${to.origin}${to.pathname}`).toBe(`${ORIGIN}/sign-in`);
		expect([...to.searchParams.keys()]).toEqual(['__clearcase_reauth']);
		expect(r.headers.get('x-clearcase-auth')).toBe('handshake-unbound');
		expect(r.headers.getSetCookie().filter((c) => !/;\s*Max-Age=0(?:;|$)/i.test(c))).toEqual([]);
	});
});

describe('the browser that started the handshake still signs in', () => {
	type Cookies = { set(n: string, v: string): void; delete(n: string): void; get(n: string): string | undefined };
	const cookiesOf = (jar: Jar, sets: string[]): Cookies => ({ set: (n, v) => { sets.push(n); jar.set(n, v); }, delete: (n) => { jar.delete(n); }, get: (n) => jar.get(n) });
	const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
	const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return e as { status?: number; location?: string }; } throw new Error('expected a redirect'); };
	const flows = { client: { route: client, path: '/sign-in', signer: A, token: clientToken, dvb: DEV_BROWSER }, staff: { route: operator, path: '/sign-in/operator', signer: B, token: staffToken, dvb: STAFF_DVB } } as const;
	/** POST the flow's sign-in with `returnTo`, start the handshake on its page, come back signed in: where the route sends the browser. */
	async function signIn(kind: keyof typeof flows, returnTo: string | null, jar: Jar = new Map()) {
		workers.env = env();
		const f = flows[kind], post = new URL(`${ORIGIN}${f.path}${returnTo === null ? '' : `?returnTo=${encodeURIComponent(returnTo)}`}`);
		const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
		expect(await thrown(() => f.route.actions.default!({ locals: locals(anonymous), url: post, request: new Request(post, { method: 'POST', headers: jar.size ? { cookie: header(jar) } : {} }), cookies: cookiesOf(jar, []) } as never))).toMatchObject({ status: 303 });
		// the portal hands the browser back with its dev browser in the URL, which starts the handshake (the SDK's dev-browser sync)
		const { back } = await start(`${f.path}?__clerk_db_jwt=${f.dvb}`, jar);
		const request = get(returned(back, signedIn(f.signer, f.token(), f.dvb)), jar);
		const o = redirectOf(await handshake().handle(request));
		expect(o.credential).toBeDefined();
		const identity = await identityOf(o.credential!);
		expect(identity).toMatchObject({ kind: 'verified', principal: { kind } });
		apply(jar, o.setCookies);
		const sets: string[] = [];
		const r = await thrown(() => f.route.load({ locals: locals(identity), url: new URL(request.url), request, cookies: cookiesOf(jar, sets), isDataRequest: false } as never));
		return { location: r.location, status: r.status, sets, jar };
	}
	it('signs a client in and lands on /cases, consuming the binding', async () => {
		const out = await signIn('client', null);
		expect(out).toMatchObject({ status: 303, location: '/cases' });
		expect(out.sets).toContain('clearcase_session');
		expect([...out.jar.keys()].filter((n) => /clearcase_hs/.test(n))).toEqual([]);
	});
	it('signs staff in on the operator page', async () => {
		expect(await signIn('staff', '/operator')).toMatchObject({ status: 303, location: '/operator' });
	});
	it('lands a signed-out deep link on its case page', async () => {
		expect(await signIn('client', '/cases/case-7?tab=documents')).toMatchObject({ status: 303, location: '/cases/case-7?tab=documents' });
	});
	it('signs in again after sign-out in the same browser', async () => {
		const first = await signIn('client', null);
		for (const n of [...first.jar.keys()].filter((k) => /^(__session|__client_uat|clearcase_session|__Host-clearcase_refresh)/.test(k))) first.jar.delete(n);
		expect(await signIn('client', '/cases/case-2', first.jar)).toMatchObject({ status: 303, location: '/cases/case-2' });
	});
	it('still lets two tabs of one browser finish their own handshakes in either order', async () => {
		const one = await start('/sign-in'), jar = one.jar, two = await start('/cases/case-7', jar);
		const second = redirectOf(await handshake().handle(get(returned(two.back, signedIn(A, clientToken())), jar)));
		expect(setsSession(second)).toBe(true);
		apply(jar, second.setCookies);
		for (const n of [...jar.keys()].filter((k) => SESSION.test(`${k}=`) || k.startsWith('__client_uat') || k === '__clerk_db_jwt' || k.startsWith('__Host-clearcase_refresh'))) jar.delete(n);
		expect(setsSession(await handshake().handle(get(returned(one.back, signedIn(A, clientToken())), jar)))).toBe(true);
	});
});
