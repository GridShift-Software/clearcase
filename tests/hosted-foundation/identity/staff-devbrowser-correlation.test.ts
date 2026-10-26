// The staff dev-browser tie (native alpha, 26 Oct) is minted only for a staff handshake this browser started on this
// origin, and it is bound to the receiving app. A Clerk signature shows which instance signed a handshake, not which
// browser asked for it: a signed-out staff handshake captured in one browser and replayed into another must not tie the
// captured dev browser there, or the operator sign-in would hand a known Clerk client to the staff portal (login-client
// fixation, review H1). A tie or checked value from one app must not count in another app that shares the staff
// instance (review M1). SYNTHETIC keys and hosts; handler unit evidence only, not a browser or a real Clerk instance.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clerkSignInTarget, type StaffDevBrowser } from '../../../src/lib/auth/clerk/config.ts';
import { STAFF_DEV_BROWSER_TIE, clerkBrowserHandshakeFromEnv, staffDevBrowserOf, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');

const ORIGIN_A = 'https://client-a.clearcase.test', ORIGIN_C = 'https://client-c.clearcase.test', STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in';
const A = craftedInstance('client-a.clerk.test'), C = craftedInstance('client-c.clerk.test'), B = craftedInstance('staff-b.clerk.test');
const OWN_DVB = 'dvb_synthetic_own_staff_0123456789abcdef', ATTACKER_DVB = 'dvb_synthetic_attacker_0123456789abcdef';
const apps = {
	[ORIGIN_A]: { id: 'client-a', client: A },
	[ORIGIN_C]: { id: 'client-c', client: C },
};
type Origin = keyof typeof apps;
const app = (origin: Origin): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: apps[origin].id, CLEARCASE_APP_ORIGIN: origin, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: apps[origin].client.publishableKey, CLERK_CLIENT_SECRET_KEY: apps[origin].client.secretKey, CLERK_CLIENT_JWT_KEY: apps[origin].client.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
});
afterEach(() => { vi.useRealTimers(); });

const doc = { 'sec-fetch-dest': 'document', accept: 'text/html' };
const crossSite = { ...doc, 'sec-fetch-site': 'cross-site', referer: 'https://attacker.example.test/' };
type Jar = Map<string, string>;
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
/** A browser cookie jar after `o`'s Set-Cookie directives (host-only; Max-Age=0 deletes); a refusal sets nothing. */
const apply = (jar: Jar, o: HandshakeOutcome): Jar => {
	const next = new Map(jar);
	for (const d of o.kind === 'redirect' ? o.setCookies : []) {
		const [pair] = d.split(';'), eq = pair!.indexOf('=');
		if (/;\s*Max-Age=0(?:;|$)/i.test(d)) next.delete(pair!.slice(0, eq));
		else next.set(pair!.slice(0, eq), pair!.slice(eq + 1));
	}
	return next;
};
const handle = (origin: Origin, url: URL | string, jar: Jar, headers: Record<string, string> = doc) => {
	const made = clerkBrowserHandshakeFromEnv(app(origin));
	if (!made.ok) throw new Error(made.reason);
	return made.handshake.handle(new Request(url, { headers: { ...headers, ...(jar.size ? { cookie: header(jar) } : {}) } }));
};
/** The browser's GET of `path` on `origin`: the staff handshake redirect it takes, and its jar afterwards. */
const start = async (origin: Origin, path: string, jar: Jar = new Map()) => {
	const o = await handle(origin, `${origin}${path}`, jar);
	if (o.kind !== 'redirect') throw new Error(`expected a handshake redirect, got ${JSON.stringify(o)}`);
	const to = new URL(o.location);
	expect(`${to.origin}${to.pathname}`).toBe(`${B.iss}/v1/client/handshake`);
	return { jar: apply(jar, o), back: new URL(to.searchParams.get('redirect_url')!), handedDvb: to.searchParams.get('__clerk_db_jwt') };
};
const directives = (dvb: string) => ['__client_uat=0; Path=/; Max-Age=315360000; SameSite=Lax; Secure', `__clerk_db_jwt=${dvb}; Path=/; Max-Age=315360000; SameSite=Lax; Secure`];
/** Where the staff Frontend API sends the browser back: the handshake's redirect_url with a signed-out token for `dvb`. */
const handedBack = (back: URL, dvb: string) => {
	const u = new URL(back);
	u.searchParams.set('__clerk_handshake', B.sign({ handshake: directives(dvb) }));
	return u;
};
const tied = (jar: Jar) => jar.has(STAFF_DEV_BROWSER_TIE);
/** The cookies in a jar that are neither Clerk's nor the tie: the handshake correlation, if any. */
const correlation = (jar: Jar) => [...jar.keys()].filter((n) => !/^__(?:clerk_|client_uat|session)/.test(n) && n !== STAFF_DEV_BROWSER_TIE);
const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
/** The dev browser the operator POST on `origin` hands the staff portal for this jar, or null. */
const forwarded = async (origin: Origin, jar: Jar): Promise<string | null> => {
	workers.env = app(origin);
	const url = new URL(`${origin}/sign-in/operator`);
	try {
		await operator.actions.default!({ url, request: new Request(url, { method: 'POST', headers: jar.size ? { cookie: header(jar), origin } : { origin } }), locals: { runtime: { testIdentity: null }, identity: anonymous }, cookies: { delete: () => {} } } as never);
	} catch (e) {
		const location = (e as { location?: string }).location;
		if (location) return new URL(location).searchParams.get('__clerk_db_jwt');
		throw e;
	}
	throw new Error('the operator POST did not redirect');
};
/** The jar of a browser that ran its own fresh staff handshake on `origin`. */
const ownStaffJar = async (origin: Origin = ORIGIN_A) => {
	const s = await start(origin, '/sign-in/operator');
	return apply(s.jar, await handle(origin, handedBack(s.back, OWN_DVB), s.jar));
};
/** A return URL an attacker captured from a staff handshake their own browser ran on `origin`. */
const captured = async (origin: Origin = ORIGIN_A) => handedBack((await start(origin, '/sign-in/operator')).back, ATTACKER_DVB);

describe('the staff tie needs a staff handshake this browser started here (H1)', () => {
	it('ties and forwards the dev browser of the browser\'s own fresh staff handshake', async () => {
		const jar = await ownStaffJar();
		expect(jar.get('__clerk_db_jwt')).toBe(OWN_DVB);
		expect(tied(jar)).toBe(true);
		expect(await forwarded(ORIGIN_A, jar)).toBe(OWN_DVB);
	});
	it('ties nothing when a captured signed-out staff handshake is replayed into fresh cookie-free browsers', async () => {
		const url = await captured(), bare = new URL(`${ORIGIN_A}/sign-in/operator?__clerk_handshake=${url.searchParams.get('__clerk_handshake')}`);
		for (const replay of [url, url, bare]) {
			const jar = apply(new Map(), await handle(ORIGIN_A, replay, new Map(), crossSite));
			expect(tied(jar)).toBe(false);
			expect(await forwarded(ORIGIN_A, jar)).toBeNull();
		}
	});
	it('ties nothing when another browser\'s handshake comes back to a browser that started its own', async () => {
		const own = await start(ORIGIN_A, '/sign-in/operator');
		const jar = apply(own.jar, await handle(ORIGIN_A, await captured(), own.jar, crossSite));
		expect(tied(jar)).toBe(false);
		expect(await forwarded(ORIGIN_A, jar)).toBeNull();
	});
	it('ties nothing for a dev browser the handshake start was handed in its URL or in a cookie it cannot tie', async () => {
		const viaUrl = await start(ORIGIN_A, `/sign-in/operator?__clerk_db_jwt=${ATTACKER_DVB}`);
		expect(viaUrl.handedDvb).toBe(ATTACKER_DVB);
		const afterUrl = apply(viaUrl.jar, await handle(ORIGIN_A, handedBack(viaUrl.back, ATTACKER_DVB), viaUrl.jar));
		expect(tied(afterUrl)).toBe(false);
		expect(await forwarded(ORIGIN_A, afterUrl)).toBeNull();
		const viaCookie = await start(ORIGIN_A, '/sign-in/operator', new Map([['__clerk_db_jwt', ATTACKER_DVB], ['__client_uat', '1700000000']]));
		expect(viaCookie.handedDvb).toBe(ATTACKER_DVB);
		const afterCookie = apply(viaCookie.jar, await handle(ORIGIN_A, handedBack(viaCookie.back, ATTACKER_DVB), viaCookie.jar));
		expect(tied(afterCookie)).toBe(false);
		expect(await forwarded(ORIGIN_A, afterCookie)).toBeNull();
	});
	it('ties nothing for an expired, tampered, missing or repeated correlation, or one another app issued', async () => {
		const own = await start(ORIGIN_A, '/sign-in/operator');
		const names = correlation(own.jar);
		expect(names).toHaveLength(1);
		const [cookieName] = names as [string];
		const cookie = own.jar.get(cookieName)!;
		const params = [...own.back.searchParams.keys()].filter((p) => p !== 'returnTo');
		expect(params).toHaveLength(1);
		const [param] = params as [string];
		const id = own.back.searchParams.get(param)!;
		const withParam = (values: string[]) => { const u = new URL(own.back); u.searchParams.delete(param); for (const v of values) u.searchParams.append(param, v); return u; };
		const variants: Array<[string, URL, Jar]> = [
			['tampered cookie', own.back, new Map([...own.jar, [cookieName, `${cookie}x`]])],
			['tampered id', withParam([`${id.slice(0, -1)}${id.endsWith('A') ? 'B' : 'A'}`]), own.jar],
			['missing id', withParam([]), own.jar],
			['repeated id', withParam([id, id]), own.jar],
			['missing cookie', own.back, new Map([...own.jar].filter(([n]) => n !== cookieName))],
		];
		const repeated = `${header(own.jar)}; ${cookieName}=${cookie}`;
		for (const [what, back, jar] of variants) {
			const after = apply(jar, await handle(ORIGIN_A, handedBack(back, ATTACKER_DVB), jar));
			expect(tied(after), what).toBe(false);
		}
		const made = clerkBrowserHandshakeFromEnv(app(ORIGIN_A));
		if (!made.ok) throw new Error(made.reason);
		const twice = await made.handshake.handle(new Request(handedBack(own.back, ATTACKER_DVB), { headers: { ...doc, cookie: repeated } }));
		expect(tied(apply(new Map(), twice)), 'repeated cookie').toBe(false);
		const foreign = await start(ORIGIN_C, '/sign-in/operator');
		const graft = new URL(`${ORIGIN_A}${foreign.back.pathname}${foreign.back.search}`);
		const grafted = apply(foreign.jar, await handle(ORIGIN_A, handedBack(graft, ATTACKER_DVB), foreign.jar));
		expect(tied(grafted), 'another app\'s correlation').toBe(false);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.now() + 3_600_000);
		const late = apply(own.jar, await handle(ORIGIN_A, handedBack(own.back, OWN_DVB), own.jar));
		expect(tied(late), 'expired').toBe(false);
	});
	it('clears the correlation when its handshake returns, so the same return in this browser ties nothing again', async () => {
		const s = await start(ORIGIN_A, '/sign-in/operator');
		const url = handedBack(s.back, OWN_DVB);
		const first = apply(s.jar, await handle(ORIGIN_A, url, s.jar));
		expect(tied(first)).toBe(true);
		expect(correlation(s.jar)).toHaveLength(1);
		expect(correlation(first)).toEqual([]);
		const again = await handle(ORIGIN_A, url, new Map([...first].filter(([n]) => n !== STAFF_DEV_BROWSER_TIE)));
		expect(tied(apply(new Map(), again))).toBe(false);
	});
});

describe('the tie and its checked value are bound to the receiving app (M1)', () => {
	it('does not accept app A\'s tie and dev browser in app C, which shares the staff instance', async () => {
		const jar = await ownStaffJar(ORIGIN_A);
		expect(await staffDevBrowserOf(new Request(`${ORIGIN_C}/sign-in/operator`, { method: 'POST', headers: { cookie: header(jar) } }), app(ORIGIN_C))).toBeNull();
		expect(await forwarded(ORIGIN_C, jar)).toBeNull();
	});
	it('does not let app C hand the staff portal a value checked for app A, or one built outside the check', async () => {
		const jar = await ownStaffJar(ORIGIN_A);
		const checked = await staffDevBrowserOf(new Request(`${ORIGIN_A}/sign-in/operator`, { method: 'POST', headers: { cookie: header(jar) } }), app(ORIGIN_A));
		expect(checked).not.toBeNull();
		expect(new URL(clerkSignInTarget(app(ORIGIN_A), '/cases', 'staff', checked)!.href).searchParams.get('__clerk_db_jwt')).toBe(OWN_DVB);
		expect(new URL(clerkSignInTarget(app(ORIGIN_C), '/cases', 'staff', checked)!.href).searchParams.has('__clerk_db_jwt')).toBe(false);
		const built = { instance: 'staff', value: OWN_DVB } as unknown as StaffDevBrowser;
		expect(new URL(clerkSignInTarget(app(ORIGIN_A), '/cases', 'staff', built)!.href).searchParams.has('__clerk_db_jwt')).toBe(false);
	});
});
