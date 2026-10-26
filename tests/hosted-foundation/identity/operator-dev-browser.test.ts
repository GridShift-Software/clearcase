// The operator sign-in hands a development staff portal this browser's own STAFF dev browser (native alpha, 26 Oct). The
// `__clerk_db_jwt` cookie name is shared by both instances on a client origin, so the plain cookie alone never says which
// instance minted it: the operator POST forwards it only when a staff-signed handshake on this origin set it. The value is
// transport only; the staff session that comes back is still verified (signature, issuer, azp, live session) as before.
// SYNTHETIC keys and hosts; handler unit evidence only, not a browser or a real Clerk instance.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedirect } from '@clerk/backend/internal';
import { signInFormActionOrigins } from '../../../src/lib/auth/clerk/config.ts';
import { clerkBrowserHandshakeFromEnv, type HandshakeOutcome } from '../../../src/lib/auth/clerk/browser.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test', STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in', CLIENT_SIGN_IN = 'https://accounts.client-a.clerk.test/sign-in';
const STAFF_DVB = 'dvb_synthetic_staff_0123456789abcdef', CLIENT_DVB = 'dvb_synthetic_client_0123456789abcdef';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test'), C = craftedInstance('staff-c.clerk.test');
const configured = (extra: Record<string, unknown> = {}) => ({
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN, CLERK_CLIENT_SIGN_IN_URL: CLIENT_SIGN_IN,
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey, ...extra,
});
const withStaff = (s: typeof B) => configured({ CLERK_STAFF_PUBLISHABLE_KEY: s.publishableKey, CLERK_STAFF_SECRET_KEY: s.secretKey, CLERK_STAFF_JWT_KEY: s.jwtKey });
const live = (k: string) => k.replace(/^(pk|sk)_test_/, '$1_live_');
beforeEach(() => { workers.env = configured(); });

const doc = { 'sec-fetch-dest': 'document', accept: 'text/html' };
// The directives a development handshake with no session returns (the real shape: no suffixed dev browser).
const directives = (dvb: string) => ['__client_uat=0; Path=/; Domain=clearcase.test; Max-Age=315360000; SameSite=Lax; Secure', `__clerk_db_jwt=${dvb}; Path=/; Max-Age=315360000; SameSite=Lax; Secure`];
type Jar = Map<string, string>;
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
/** A browser cookie jar after `o`'s Set-Cookie directives (host-only; Max-Age=0 deletes). */
const apply = (jar: Jar, o: HandshakeOutcome): Jar => {
	expect(o.kind).toBe('redirect');
	const next = new Map(jar);
	for (const d of (o as { setCookies: string[] }).setCookies) {
		const [pair] = d.split(';'), eq = pair!.indexOf('=');
		const name = pair!.slice(0, eq), value = pair!.slice(eq + 1);
		if (/;\s*Max-Age=0(?:;|$)/i.test(d)) next.delete(name);
		else next.set(name, value);
	}
	return next;
};
const handshake = (env = workers.env) => {
	const made = clerkBrowserHandshakeFromEnv(env);
	if (!made.ok) throw new Error(made.reason);
	return made.handshake;
};
/** The jar after the browser's GET of `path` came back from an instance's Frontend API with a handshake signed by `signer`. */
const handedBack = async (jar: Jar, path: string, signer: typeof B, dvb: string, env = workers.env) =>
	apply(jar, await handshake(env).handle(new Request(`${ORIGIN}${path}${path.includes('?') ? '&' : '?'}__clerk_handshake=${signer.sign({ handshake: directives(dvb) })}`, { headers: { ...doc, ...(jar.size ? { cookie: header(jar) } : {}) } })));
/**
 * The jar after the browser's own staff handshake: its GET of `path` is sent to the staff Frontend API, which sends it
 * back to the handshake's redirect_url with a token signed by `signer`.
 */
const started = async (path: string, signer: typeof B, dvb: string, env = workers.env) => {
	const o = await handshake(env).handle(new Request(`${ORIGIN}${path}`, { headers: doc }));
	const jar = apply(new Map(), o), back = new URL(new URL((o as { location: string }).location).searchParams.get('redirect_url')!);
	back.searchParams.set('__clerk_handshake', signer.sign({ handshake: directives(dvb) }));
	return apply(jar, await handshake(env).handle(new Request(back, { headers: { ...doc, cookie: header(jar) } })));
};
const staffJar = () => started('/sign-in/operator?returnTo=%2Fcases%2Fcase-1', B, STAFF_DVB);

const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
const locals = { runtime: { testIdentity: null }, identity: anonymous } as unknown as App.Locals;
const outcome = async (f: () => unknown) => { try { return { value: (await f()) as { href?: string } }; } catch (e) { return { thrown: e as { status?: number; location?: string } }; } };
const operatorUrl = new URL(`${ORIGIN}/sign-in/operator?returnTo=${encodeURIComponent('/cases/case-1')}`);
const operatorPost = (cookie: string) => outcome(() => operator.actions.default!({ locals, url: operatorUrl, request: new Request(operatorUrl, { method: 'POST', headers: cookie ? { cookie } : {} }), cookies: { delete: () => {} } } as never));
const callback = `${ORIGIN}/sign-in/operator?returnTo=${encodeURIComponent('/cases/case-1')}`;
const plainStaff = `${STAFF_SIGN_IN}?redirect_url=${encodeURIComponent(callback)}`;
const forwarded = async (cookie: string) => {
	const r = await operatorPost(cookie);
	expect(r.thrown).toMatchObject({ status: 303 });
	return r.thrown!.location!;
};

describe('the operator sign-in forwards the staff dev browser a staff handshake set here', () => {
	it('hands the staff portal the browser\'s own staff dev browser exactly as @clerk/backend redirectToSignIn does', async () => {
		const jar = await staffJar();
		expect(jar.get('__clerk_db_jwt')).toBe(STAFF_DVB);
		const sdk = createRedirect({ publishableKey: B.publishableKey, baseUrl: ORIGIN, signInUrl: STAFF_SIGN_IN, devBrowserToken: STAFF_DVB, redirectAdapter: (u: string) => u }).redirectToSignIn({ returnBackUrl: callback });
		const location = await forwarded(header(jar));
		expect(location).toBe(sdk);
		const to = new URL(location);
		expect(to.origin).toBe(new URL(STAFF_SIGN_IN).origin);
		expect(to.searchParams.get('__clerk_db_jwt')).toBe(STAFF_DVB);
		expect(to.searchParams.get('redirect_url')).toBe(callback);
	});
	it('keeps every cookie it sets host-only, HttpOnly and Secure, and never puts the dev browser in page data', async () => {
		const o = await handshake().handle(new Request(`${ORIGIN}/sign-in/operator?__clerk_handshake=${B.sign({ handshake: directives(STAFF_DVB) })}`, { headers: doc }));
		for (const d of (o as { setCookies: string[] }).setCookies) {
			expect(d).not.toMatch(/Domain=/i);
			expect(d).toMatch(/; Secure$/);
			if (!d.startsWith('__client_uat')) expect(d).toMatch(/; HttpOnly/);
		}
		const jar = await staffJar();
		const page = await outcome(() => operator.load({ locals, url: operatorUrl, request: new Request(operatorUrl, { headers: { cookie: header(jar) } }) } as never));
		expect(JSON.stringify(page)).not.toContain(STAFF_DVB);
	});
	it('keeps the form-action CSP of the operator page to the staff portal and staff Frontend API origins', () => {
		expect(signInFormActionOrigins(workers.env, '/sign-in/operator')).toEqual(['https://accounts.staff-b.clerk.test', B.iss]);
	});
});

describe('the operator sign-in forwards nothing it cannot tie to the staff instance', () => {
	it('sends no dev browser for a production staff instance', async () => {
		const jar = await staffJar();
		workers.env = configured({ CLERK_STAFF_PUBLISHABLE_KEY: live(B.publishableKey), CLERK_STAFF_SECRET_KEY: live(B.secretKey) });
		expect(await forwarded(header(jar))).toBe(plainStaff);
	});
	it('sends no dev browser when the staff portal is on this origin', async () => {
		const jar = await staffJar();
		workers.env = configured({ CLERK_STAFF_SIGN_IN_URL: `${ORIGIN}/staff-portal` });
		expect(new URL(await forwarded(header(jar))).searchParams.has('__clerk_db_jwt')).toBe(false);
	});
	it('sends no dev browser for a plain cookie with no staff handshake behind it (a client one, or one planted)', async () => {
		expect(await forwarded(`__clerk_db_jwt=${STAFF_DVB}`)).toBe(plainStaff);
		const clientJar = await handedBack(new Map(), '/cases', A, CLIENT_DVB);
		expect(clientJar.get('__clerk_db_jwt')).toBe(CLIENT_DVB);
		expect(await forwarded(header(clientJar))).toBe(plainStaff);
	});
	it('sends no dev browser after a client handshake replaced the staff one (the client-to-staff switch)', async () => {
		const switched = await handedBack(await staffJar(), '/cases', A, CLIENT_DVB);
		expect(switched.get('__clerk_db_jwt')).toBe(CLIENT_DVB);
		expect(await forwarded(header(switched))).toBe(plainStaff);
	});
	it('sends no dev browser that another staff instance\'s handshake set', async () => {
		const other = await started('/sign-in/operator', C, STAFF_DVB, withStaff(C));
		expect(await forwarded(header(other))).toBe(plainStaff);
	});
	it('sets no staff tie for a client-signed handshake brought to the operator route', async () => {
		const o = await handshake().handle(new Request(`${ORIGIN}/sign-in/operator?__clerk_handshake=${A.sign({ handshake: directives(CLIENT_DVB) })}`, { headers: doc }));
		const jar = o.kind === 'redirect' ? apply(new Map(), o) : new Map<string, string>();
		expect(await forwarded(header(jar))).toBe(plainStaff);
	});
	it('sends no dev browser for a repeated, malformed or mismatched cookie beside the staff tie', async () => {
		const jar = await staffJar();
		const tie = [...jar].filter(([n]) => !n.startsWith('__clerk_') && n !== '__client_uat');
		expect(tie).toHaveLength(1);
		const [tieName, tieValue] = tie[0]!;
		for (const cookie of [
			`__clerk_db_jwt=${STAFF_DVB}; __clerk_db_jwt=${STAFF_DVB}; ${tieName}=${tieValue}`,
			`__clerk_db_jwt=${STAFF_DVB}; ${tieName}=${tieValue}; ${tieName}=${tieValue}`,
			`__clerk_db_jwt=${STAFF_DVB}x; ${tieName}=${tieValue}`,
			`__clerk_db_jwt=${STAFF_DVB}; ${tieName}=${tieValue}x`,
			`__clerk_db_jwt=${STAFF_DVB}; ${tieName}=`,
			`${tieName}=${tieValue}`,
			`__clerk_db_jwt=short; ${tieName}=${tieValue}`,
			`__clerk_db_jwt=${STAFF_DVB}`,
		]) expect(await forwarded(cookie), cookie).toBe(plainStaff);
	});
});

describe('the client sign-in is unchanged', () => {
	it('still hands the client portal the plain dev browser, and never the staff tie', async () => {
		const sdk = createRedirect({ publishableKey: A.publishableKey, baseUrl: ORIGIN, signInUrl: CLIENT_SIGN_IN, devBrowserToken: CLIENT_DVB, redirectAdapter: (u: string) => u }).redirectToSignIn({ returnBackUrl: `${ORIGIN}/cases` });
		const r = await outcome(() => client.actions.default!({ locals, url: new URL(`${ORIGIN}/sign-in`), request: new Request(`${ORIGIN}/sign-in`, { method: 'POST', headers: { cookie: `__clerk_db_jwt=${CLIENT_DVB}` } }), cookies: { delete: () => {} } } as never));
		expect(r.thrown).toMatchObject({ status: 303, location: sdk });
	});
});
