// GRS-279: a client sign-in mints the app session only for the session this browser's own handshake set, and a client
// dev browser reaches Clerk (the SDK, the Frontend API handshake or the sign-in portal) only when this browser tied it.
// Before, a link to /sign-in?__clerk_db_jwt=<attacker's dev browser> was handed to the handshake as it was, so Clerk
// answered for the attacker's Clerk client, and a sibling origin under the parent domain could plant its own dev browser,
// or (production) its own fresh `__session` and `__client_uat`, which /sign-in then minted (278 re-check). The real
// @clerk/backend runs every handshake here. SYNTHETIC keys, hosts and tokens; handler evidence only, not a browser or a
// real Clerk instance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkBrowserHandshakeFromEnv, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { clerkIdentityProviderFromEnv } from '../../../src/lib/auth/clerk/provider.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const route = await import('../../../deploy/client/routes/sign-in/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', PORTAL = 'https://accounts.client-a.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
const OWN_DVB = 'dvb_synthetic_own_client_0123456789', ATTACKER_DVB = 'dvb_synthetic_attacker_0123456789ab';
const APP_COOKIE = '__Host-clearcase_session';

const env = (live = false): Record<string, unknown> => {
	const key = (v: string) => (live ? v.replace('_test_', '_live_') : v);
	return {
		CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} },
		CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_CLIENT_SIGN_IN_URL: PORTAL,
		CLERK_CLIENT_PUBLISHABLE_KEY: key(A.publishableKey), CLERK_CLIENT_SECRET_KEY: key(A.secretKey), CLERK_CLIENT_JWT_KEY: A.jwtKey,
		CLERK_STAFF_PUBLISHABLE_KEY: key(B.publishableKey), CLERK_STAFF_SECRET_KEY: key(B.secretKey), CLERK_STAFF_JWT_KEY: B.jwtKey,
	};
};
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => { network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test')); });
afterEach(() => { expect(network).not.toHaveBeenCalled(); network.mockRestore(); });

const doc = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };
const offSite = { ...doc, 'sec-fetch-site': 'cross-site', referer: 'https://attacker.example.test/' };
type Jar = Map<string, string>;
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
const get = (url: URL | string, jar: Jar, headers: Record<string, string> = doc) => new Request(url, { headers: { ...headers, ...(jar.size ? { cookie: header(jar) } : {}) } });
/** The jar after `o`'s Set-Cookie directives, host-only as a browser keeps them; Max-Age=0 deletes. */
const apply = (jar: Jar, o: HandshakeOutcome): Jar => {
	const next = new Map(jar);
	for (const d of o.kind === 'redirect' ? o.setCookies : []) {
		if (/;\s*Domain=/i.test(d)) continue;
		const [pair] = d.split(';'), eq = pair!.indexOf('=');
		if (/;\s*Max-Age=0(?:;|$)/i.test(d)) next.delete(pair!.slice(0, eq));
		else next.set(pair!.slice(0, eq), pair!.slice(eq + 1));
	}
	return next;
};
const handle = (live: boolean, request: Request) => {
	const made = clerkBrowserHandshakeFromEnv(env(live));
	if (!made.ok) throw new Error(made.reason);
	return made.handshake.handle(request);
};
const identityOf = async (live: boolean, request: Request) => {
	const made = clerkIdentityProviderFromEnv(env(live), { authorizeCase: async () => {} });
	if (!made.ok) throw new Error(made.reason);
	return made.provider.authenticate({ request });
};
/** The /sign-in load for `request` (or a handshake's credential): the app cookie it set, or null for none. */
const minted = async (live: boolean, request: Request, credential: Request = request): Promise<string | null> => {
	workers.env = env(live);
	const identity = await identityOf(live, credential), set = vi.fn();
	await route.load({ locals: { runtime: { testIdentity: null }, identity }, request, url: new URL(request.url), cookies: { set, delete: vi.fn(), get: () => undefined }, isDataRequest: false } as never).catch((e: unknown) => {
		if ((e as { status?: number }).status !== 303) throw e;
	});
	return (set.mock.calls.find(([name]) => name === APP_COOKIE)?.[1] as string | undefined) ?? null;
};
/** The portal URL the sign-in POST sends this jar to. */
const portal = async (jar: Jar): Promise<URL> => {
	workers.env = env();
	const url = new URL(`${ORIGIN}/sign-in`);
	try {
		await route.actions.default!({ url, request: new Request(url, { method: 'POST', headers: { origin: ORIGIN, ...(jar.size ? { cookie: header(jar) } : {}) } }), locals: { runtime: { testIdentity: null }, identity: { kind: 'anonymous', principal: null, sessionId: null } }, cookies: { delete: () => {}, set: () => {} } } as never);
	} catch (e) {
		const location = (e as { location?: string }).location;
		if (location) return new URL(location);
		throw e;
	}
	throw new Error('the sign-in POST did not redirect');
};
/** The Frontend API handshake `o` redirects to, which must be the client instance's. */
const handshakeAt = (o: HandshakeOutcome) => {
	if (o.kind !== 'redirect') throw new Error(`expected a handshake redirect, got ${JSON.stringify(o)}`);
	const to = new URL(o.location);
	expect(`${to.origin}${to.pathname}`).toBe(`${A.iss}/v1/client/handshake`);
	return to;
};
/**
 * The client Frontend API's answer to the handshake at `to`: back to its redirect_url with a token for the dev browser it
 * was handed, or a fresh one, signed in as `session` when given.
 */
const answered = (to: URL, session: string | null = null, fresh = OWN_DVB) => {
	const dvb = to.searchParams.get('__clerk_db_jwt') ?? fresh, back = new URL(to.searchParams.get('redirect_url')!);
	const directives = [`__client_uat=${session ? Math.floor(Date.now() / 1000) - 10 : 0}; Path=/; Max-Age=315360000`, `__clerk_db_jwt=${dvb}; Path=/; Max-Age=315360000`, ...(session ? [`__session=${session}; Path=/; Max-Age=60`] : [])];
	back.searchParams.set('__clerk_handshake', A.sign({ handshake: directives }));
	return back;
};
const tokenOf = (sub: string, sid: string) => A.token({ sub, sid, azp: ORIGIN });
/** A browser's own development sign-in, up to the portal: the jar its first /sign-in handshake left, and the portal URL. */
const ownStart = async () => {
	let jar: Jar = new Map();
	const first = await handle(false, get(`${ORIGIN}/sign-in`, jar));
	jar = apply(jar, first);
	jar = apply(jar, await handle(false, get(answered(handshakeAt(first)), jar)));
	return { jar, portal: await portal(jar) };
};
/** The rest of it: the portal's return with the dev browser it was handed, the handshake that follows, and its return. */
const ownReturn = async (start: { jar: Jar; portal: URL }, session: string) => {
	const back = new URL(start.portal.searchParams.get('redirect_url')!);
	const dvb = start.portal.searchParams.get('__clerk_db_jwt');
	if (dvb) back.searchParams.set('__clerk_db_jwt', dvb);
	const sync = await handle(false, get(back, start.jar));
	let jar = apply(start.jar, sync);
	const at = handshakeAt(sync), returning = get(answered(at, session), jar), o = await handle(false, returning);
	if (o.kind !== 'redirect') throw new Error(`expected the return's redirect, got ${JSON.stringify(o)}`);
	jar = apply(jar, o);
	return { handedDvb: at.searchParams.get('__clerk_db_jwt'), outcome: o, returning, jar };
};

describe('a client dev browser reaches Clerk only when this browser tied it (GRS-279)', () => {
	it('an off-domain link carrying a dev browser hands Clerk and the portal none of it', async () => {
		const o = await handle(false, get(`${ORIGIN}/sign-in?__clerk_db_jwt=${ATTACKER_DVB}`, new Map(), offSite));
		const to = handshakeAt(o);
		expect(to.href).not.toContain(ATTACKER_DVB);
		const jar = apply(apply(new Map(), o), await handle(false, get(answered(to), apply(new Map(), o))));
		expect((await portal(jar)).href).not.toContain(ATTACKER_DVB);
	});
	it('a browser with its own tied dev browser that follows such a link keeps its own', async () => {
		const { jar } = await ownStart();
		const o = await handle(false, get(`${ORIGIN}/sign-in?__clerk_db_jwt=${ATTACKER_DVB}`, jar, offSite));
		if (o.kind === 'redirect') expect(o.location).not.toContain(ATTACKER_DVB);
		expect((await portal(apply(jar, o))).searchParams.get('__clerk_db_jwt')).toBe(OWN_DVB);
	});
	it('a dev browser a sibling planted as a cookie reaches neither the handshake nor the portal', async () => {
		const planted: Jar = new Map([['__clerk_db_jwt', ATTACKER_DVB], ['__client_uat', '1700000000']]);
		const o = await handle(false, get(`${ORIGIN}/sign-in`, planted));
		expect(handshakeAt(o).href).not.toContain(ATTACKER_DVB);
		expect((await portal(planted)).href).not.toContain(ATTACKER_DVB);
	});
	it('the portal return of the browser\'s own sign-in still syncs its own dev browser', async () => {
		const start = await ownStart();
		expect(start.portal.searchParams.get('__clerk_db_jwt')).toBe(OWN_DVB);
		expect((await ownReturn(start, tokenOf('user_own', 'sess_own'))).handedDvb).toBe(OWN_DVB);
	});
});

describe('a client session mints the app session only from this browser\'s own handshake (GRS-279)', () => {
	it('the normal development sign-in mints, in place on the return and on the clean page after it', async () => {
		const { outcome, returning, jar } = await ownReturn(await ownStart(), tokenOf('user_own', 'sess_own'));
		expect(outcome.credential).toBeDefined();
		expect(await minted(false, returning, outcome.credential)).not.toBeNull();
		expect(await minted(false, get(outcome.location, jar))).not.toBeNull();
	});
	it('a `__session` and `__client_uat` a sibling planted under a production instance mint nothing and reach Clerk without the token', async () => {
		const attacker = tokenOf('user_attacker', 'sess_attacker');
		const planted: Jar = new Map([['__session', attacker], ['__client_uat', String(Math.floor(Date.now() / 1000) - 10)]]);
		const request = get(`${ORIGIN}/sign-in`, planted);
		const o = await handle(true, request);
		expect(o.kind).toBe('redirect');
		expect(handshakeAt(o).href).not.toContain(attacker);
		expect(await identityOf(true, request)).toMatchObject({ kind: 'anonymous' });
		expect(await minted(true, request)).toBeNull();
	});
	it('the same planted cookies under a development instance mint nothing either', async () => {
		const { jar } = await ownStart();
		jar.set('__session', tokenOf('user_attacker', 'sess_attacker')).set('__client_uat', String(Math.floor(Date.now() / 1000) - 10));
		expect(await minted(false, get(`${ORIGIN}/sign-in`, jar))).toBeNull();
	});
	it('the proof of this browser\'s own handshake mints nothing for another token', async () => {
		const { outcome, jar } = await ownReturn(await ownStart(), tokenOf('user_own', 'sess_own'));
		const attacker = tokenOf('user_attacker', 'sess_attacker');
		jar.set('__session', attacker);
		const request = get(outcome.location, jar);
		expect(await minted(false, request)).toBeNull();
		const o = await handle(false, request);
		if (o.kind === 'redirect') expect(o.location).not.toContain(attacker);
	});
});
