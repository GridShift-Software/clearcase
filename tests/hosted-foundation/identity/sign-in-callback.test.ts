// Clerk sees one fixed sign-in callback per client origin and flow (27 Oct). The staff instance allows only exact
// redirect URLs, so a redirect_url that carried returnTo needed an allow-list entry per target and per origin, and Clerk
// sent every other one to its home URL, another client's origin. The return target now rides in a `__Host-` cookie the
// sign-in POST sets and the callback reads once, validated again there. SYNTHETIC keys and hosts; route-handler unit
// evidence only, not a browser or a real Clerk instance.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClerkIdentityConfig, type InstanceKind } from '../../../src/lib/auth/clerk/config.ts';
import { SIGN_IN_RETURN_PREFIX, sealSignInReturn } from '../../../src/lib/auth/clerk/flow.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');

const ORIGIN_A = 'https://client-a.clearcase.test', ORIGIN_C = 'https://client-c.clearcase.test', ORIGIN_L = 'http://localhost:5173';
const STAFF_SIGN_IN = 'https://accounts.staff-b.clerk.test/sign-in';
const B = craftedInstance('staff-b.clerk.test');
const apps = {
	[ORIGIN_A]: { id: 'client-a', client: craftedInstance('client-a.clerk.test'), portal: 'https://accounts.client-a.clerk.test/sign-in' },
	[ORIGIN_C]: { id: 'client-c', client: craftedInstance('client-c.clerk.test'), portal: 'https://accounts.client-c.clerk.test/sign-in' },
	[ORIGIN_L]: { id: 'client-l', client: craftedInstance('client-l.clerk.test'), portal: 'https://accounts.client-l.clerk.test/sign-in' },
};
type Origin = keyof typeof apps;
const app = (origin: Origin): Record<string, unknown> => ({
	CLEARCASE_CLIENT_ID: apps[origin].id, CLEARCASE_APP_ORIGIN: origin, CLERK_STAFF_SIGN_IN_URL: STAFF_SIGN_IN, CLERK_CLIENT_SIGN_IN_URL: apps[origin].portal,
	CLERK_CLIENT_PUBLISHABLE_KEY: apps[origin].client.publishableKey, CLERK_CLIENT_SECRET_KEY: apps[origin].client.secretKey, CLERK_CLIENT_JWT_KEY: apps[origin].client.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
});
const flows = {
	staff: { route: operator, path: '/sign-in/operator', portal: (_: Origin) => STAFF_SIGN_IN },
	client: { route: client, path: '/sign-in', portal: (o: Origin) => apps[o].portal },
} as const;
const KINDS = ['staff', 'client'] as const;
afterEach(() => { vi.useRealTimers(); });

type Jar = Map<string, string>;
type CookieSet = { name: string; value: string; options: Record<string, unknown> };
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
const cookiesOf = (jar: Jar, sets: CookieSet[]) => ({
	set: (name: string, value: string, options: Record<string, unknown>) => { sets.push({ name, value, options }); jar.set(name, value); },
	delete: (name: string) => { jar.delete(name); },
	get: (name: string) => jar.get(name),
});
const outcome = async (f: () => unknown) => { try { return { value: (await f()) as { href?: string; status?: number } | undefined }; } catch (e) { return { thrown: e as { status?: number; location?: string } }; } };
const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
const verified = (kind: InstanceKind) => ({ kind: 'verified', principal: { kind }, sessionId: 'sess_synthetic' });
const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
const callbackUrl = (kind: InstanceKind, origin: Origin) => `${origin}${flows[kind].path}`;
const portalHref = (kind: InstanceKind, origin: Origin) => `${flows[kind].portal(origin)}?redirect_url=${encodeURIComponent(callbackUrl(kind, origin))}`;
const query = (returnTo: string | null) => (returnTo === null ? '' : `?returnTo=${encodeURIComponent(returnTo)}`);

/** The sign-in POST on `origin` with `returnTo`: where it sends the browser, the cookies it sets, and the jar after. */
async function post(kind: InstanceKind, origin: Origin, returnTo: string | null, jar: Jar = new Map(), cookie?: string) {
	workers.env = app(origin);
	const url = new URL(`${callbackUrl(kind, origin)}${query(returnTo)}`), sets: CookieSet[] = [];
	const presented = cookie ?? header(jar);
	const r = await outcome(() => flows[kind].route.actions.default!({ locals: locals(anonymous), url, request: new Request(url, { method: 'POST', headers: presented ? { cookie: presented } : {} }), cookies: cookiesOf(jar, sets) } as never));
	return { r, sets, jar };
}
/** The browser back on `origin`'s fixed callback with a verified session of `kind` and this jar: where the page sends it. */
async function callback(kind: InstanceKind, origin: Origin, jar: Jar) {
	workers.env = app(origin);
	const url = new URL(callbackUrl(kind, origin));
	const r = await outcome(() => flows[kind].route.load({ locals: locals(verified(kind)), url, request: new Request(url, { headers: jar.size ? { cookie: header(jar) } : {} }), cookies: cookiesOf(jar, []) } as never));
	expect(r.thrown, `${kind} callback on ${origin}`).toMatchObject({ status: 303 });
	return r.thrown!.location!;
}
/** This flow's attempt cookies in the jar, and the bytes they add to a Cookie header. */
const attemptsOf = (kind: InstanceKind, jar: Jar) => [...jar].filter(([n]) => n.startsWith(SIGN_IN_RETURN_PREFIX[kind]));
const attemptBytes = (kind: InstanceKind, jar: Jar) => attemptsOf(kind, jar).reduce((n, [name, value]) => n + name.length + value.length + 3, 0);
/** A fake Date one second further on each call, so attempts made in a loop have a definite order. */
const ticking = () => {
	vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-27T09:00:00Z') });
	return () => vi.setSystemTime(Date.now() + 1000);
};
/** Changes one decoded byte of a MAC near its end (the last base64url character also carries unused bits). */
const flip = (s: string) => `${s.slice(0, -3)}${s.at(-3) === 'A' ? 'B' : 'A'}${s.slice(-2)}`;
const sealed = async (kind: InstanceKind, origin: Origin, to: string) => {
	const c = await sealSignInReturn(configOf(origin), kind, to);
	if (!c) throw new Error('no attempt on this origin');
	return [c.name, c.value] as [string, string];
};
const configOf = (origin: Origin) => {
	const read = readClerkIdentityConfig(app(origin), { keys: 'optional' });
	if (!read.ok) throw new Error(read.reason);
	return read.config;
};

const TARGETS = [null, '/cases', '/cases/case-1', '/cases/case-2?tab=documents', '/cases/case-3/documents/doc-9#page=2', '//attacker.example.test/cases'];
const HOSTILE = [
	'https://attacker.example.test/cases', '//attacker.example.test/cases', '/\\attacker.example.test', '\\\\attacker.example.test', '/\\\\attacker.example.test',
	'javascript:alert(1)', '/cases\u0000x', '/cases\nx',
	'/sign-in', '/sign-in/operator', '/sign-in/operator?returnTo=/cases', '/sign-out', '/SIGN-IN/operator', '/cases/../sign-in/operator', '/%73ign-in/operator', '/sign-in%252Foperator', '/%2F%2Fsign-in/operator',
];

describe('Clerk sees one fixed callback per client origin and flow', () => {
	it.each(KINDS)('sends the %s portal the same redirect_url for every returnTo', async (kind) => {
		const hrefs = new Set<string>();
		for (const returnTo of TARGETS) {
			const { r } = await post(kind, ORIGIN_A, returnTo);
			expect(r.thrown, String(returnTo)).toMatchObject({ status: 303 });
			hrefs.add(r.thrown!.location!);
			workers.env = app(ORIGIN_A);
			const page = await outcome(() => flows[kind].route.load({ locals: locals(anonymous), url: new URL(`${callbackUrl(kind, ORIGIN_A)}${query(returnTo)}`) } as never));
			hrefs.add(page.value!.href!);
		}
		expect([...hrefs]).toEqual([portalHref(kind, ORIGIN_A)]);
	});
	it.each(KINDS)('names each client origin\'s own %s callback, so one allow-list entry per client covers every target', async (kind) => {
		for (const origin of [ORIGIN_A, ORIGIN_C] as const) {
			const { r } = await post(kind, origin, '/cases/case-1');
			const back = new URL(new URL(r.thrown!.location!).searchParams.get('redirect_url')!);
			expect(back.href).toBe(callbackUrl(kind, origin));
			expect([...back.searchParams]).toEqual([]);
		}
	});
});

describe('returnTo survives the round trip in a short-lived __Host- state cookie', () => {
	it.each(KINDS)('carries the %s target through the portal and back to the fixed callback', async (kind) => {
		const { sets, jar } = await post(kind, ORIGIN_A, '/cases/case-2?tab=documents');
		expect(sets).toHaveLength(1);
		const [set] = sets;
		expect(set!.name).toMatch(new RegExp(`^${SIGN_IN_RETURN_PREFIX[kind]}[A-Za-z0-9_-]{22}$`));
		expect(set!.name.startsWith('__Host-')).toBe(true);
		expect(set!.options).toMatchObject({ path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
		expect(set!.options).not.toHaveProperty('domain');
		expect(set!.options.maxAge).toBeGreaterThan(0);
		expect(set!.options.maxAge).toBeLessThanOrEqual(900);
		expect(await callback(kind, ORIGIN_A, jar)).toBe('/cases/case-2?tab=documents');
		expect(attemptsOf(kind, jar)).toEqual([]);
		expect(await callback(kind, ORIGIN_A, jar)).toBe('/cases');
	});
	it('keeps a staff and a client sign-in in flight in one browser apart', async () => {
		const jar: Jar = new Map();
		await post('staff', ORIGIN_A, '/cases/staff-target', jar);
		await post('client', ORIGIN_A, '/cases/client-target', jar);
		expect(await callback('client', ORIGIN_A, jar)).toBe('/cases/client-target');
		expect(await callback('staff', ORIGIN_A, jar)).toBe('/cases/staff-target');
	});
	it.each(KINDS)('sends a %s callback with no state to /cases', async (kind) => {
		expect(await callback(kind, ORIGIN_A, new Map())).toBe('/cases');
	});
});

/** The verified callback page on `origin` at `search` with this jar: its redirect location. */
async function land(kind: InstanceKind, origin: Origin, jar: Jar, search = '') {
	workers.env = app(origin);
	const url = new URL(`${callbackUrl(kind, origin)}${search}`);
	const r = await outcome(() => flows[kind].route.load({ locals: locals(verified(kind)), url, request: new Request(url, { headers: jar.size ? { cookie: header(jar) } : {} }), cookies: cookiesOf(jar, []) } as never));
	if (r.thrown) {
		expect(r.thrown, `${kind} callback on ${origin}${search}`).toMatchObject({ status: 303 });
		return { location: r.thrown.location! };
	}
	throw new Error('verified callback did not redirect');
}
describe('two tabs signing in through the same flow land home without guessing (alpha redesign)', () => {
	const ORDERS = [['A', 'B'], ['B', 'A']] as const;
	it.each(KINDS.flatMap((kind) => ORDERS.map((order) => [kind, order.join(' then ')] as const)))('%s: callbacks in order %s', async (kind, order) => {
		const jar: Jar = new Map(), target = (tab: string) => `/cases/tab-${tab}`, tick = ticking();
		await post(kind, ORIGIN_A, target('A'), jar);
		tick();
		await post(kind, ORIGIN_A, target('B'), jar);
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: '/cases?signIn=multiple-tabs' });
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: '/cases' });
		expect(attemptsOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: a second POST for the same target keeps one entry and returns straight there', async (kind) => {
		const jar: Jar = new Map();
		await post(kind, ORIGIN_A, '/cases/case-1', jar);
		await post(kind, ORIGIN_A, '/cases/case-1', jar);
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: '/cases/case-1' });
		expect(attemptsOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: bounds the set, keeping the newest attempts in a cookie a browser will hold', async (kind) => {
		const jar: Jar = new Map(), tick = ticking();
		for (const n of [1, 2, 3, 4, 5, 6]) { await post(kind, ORIGIN_A, `/cases/case-${n}`, jar); tick(); }
		expect(attemptsOf(kind, jar)).toHaveLength(4);
		expect(attemptBytes(kind, jar)).toBeLessThanOrEqual(3800);
		expect(attemptsOf(kind, jar).map(([, value]) => atob(value.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')))).toEqual(['/cases/case-3', '/cases/case-4', '/cases/case-5', '/cases/case-6']);
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: '/cases?signIn=multiple-tabs' });
		expect(attemptsOf(kind, jar)).toEqual([]);
		const big = (c: string) => `/cases/${c.repeat(2000)}`;
		await post(kind, ORIGIN_A, big('x'), jar);
		tick();
		await post(kind, ORIGIN_A, big('y'), jar);
		expect(attemptBytes(kind, jar)).toBeLessThanOrEqual(3800);
		for (const [name, value] of attemptsOf(kind, jar)) expect(name.length + value.length + 1, 'one cookie a browser will hold').toBeLessThan(4096);
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: big('y') });
	});
	it.each(KINDS)('%s: drops an expired, tampered or other-flow entry from the set and keeps the rest', async (kind) => {
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-27T09:00:00Z') });
		const other = kind === 'staff' ? 'client' : 'staff';
		const old = await sealed(kind, ORIGIN_A, '/cases/old');
		vi.setSystemTime(new Date('2026-10-27T09:15:01Z'));
		const fresh = await sealed(kind, ORIGIN_A, '/cases/fresh'), [foreignName, foreign] = await sealed(other, ORIGIN_A, '/cases/foreign');
		const [tamperedName, tampered] = await sealed(kind, ORIGIN_A, '/cases/tampered');
		// The other flow's attempt, renamed into this flow's prefix with its own id, still counts as none.
		const moved = `${SIGN_IN_RETURN_PREFIX[kind]}${foreignName.slice(SIGN_IN_RETURN_PREFIX[other].length)}`;
		const jar: Jar = new Map([old, [moved, foreign], [tamperedName, flip(tampered)], fresh]);
		expect(await land(kind, ORIGIN_A, jar)).toEqual({ location: '/cases/fresh' });
		expect(attemptsOf(kind, jar), 'the used attempt and the refused ones are deleted').toEqual([]);
	});
	it('keeps two staff tabs and a client tab apart in one browser', async () => {
		const jar: Jar = new Map(), tick = ticking();
		await post('staff', ORIGIN_A, '/cases/staff-A', jar);
		await post('client', ORIGIN_A, '/cases/client-A', jar);
		tick();
		await post('staff', ORIGIN_A, '/cases/staff-B', jar);
		expect(await land('client', ORIGIN_A, jar)).toEqual({ location: '/cases/client-A' });
		expect(await land('staff', ORIGIN_A, jar)).toEqual({ location: '/cases?signIn=multiple-tabs' });
		expect(attemptsOf('staff', jar)).toEqual([]);
	});
	it.each(KINDS)('%s: an explicit returnTo cannot choose among multiple attempts; none retains the existing fallback', async (kind) => {
		const jar: Jar = new Map(), tick = ticking();
		await post(kind, ORIGIN_A, '/cases/tab-A', jar);
		tick();
		await post(kind, ORIGIN_A, '/cases/tab-B', jar);
		expect(await land(kind, ORIGIN_A, jar, query('/cases/elsewhere'))).toEqual({ location: '/cases?signIn=multiple-tabs' });
		expect(attemptsOf(kind, jar)).toEqual([]);
		expect(await land(kind, ORIGIN_A, jar, query('/cases/elsewhere'))).toEqual({ location: '/cases/elsewhere' });
		expect(await land(kind, ORIGIN_A, jar, query('//attacker.example.test'))).toEqual({ location: '/cases' });
	});
});

describe('a hostile returnTo is refused when the state is set and when it is read', () => {
	it.each(KINDS.flatMap((kind) => HOSTILE.map((returnTo) => [kind, returnTo] as const)))('%s: sends %j to /cases, with the callback unchanged', async (kind, returnTo) => {
		const { r, jar } = await post(kind, ORIGIN_A, returnTo);
		expect(r.thrown).toMatchObject({ status: 303, location: portalHref(kind, ORIGIN_A) });
		expect(await callback(kind, ORIGIN_A, jar)).toBe('/cases');
	});
	it.each(KINDS.flatMap((kind) => HOSTILE.map((returnTo) => [kind, returnTo] as const)))('%s: refuses %j even under a state MAC that verifies', async (kind, returnTo) => {
		expect(await callback(kind, ORIGIN_A, new Map([await sealed(kind, ORIGIN_A, returnTo)]))).toBe('/cases');
	});
});

describe('a missing, expired, tampered or foreign state goes to /cases, never elsewhere', () => {
	const stateOf = async (kind: InstanceKind, origin: Origin, returnTo = '/cases/case-1') => attemptsOf(kind, (await post(kind, origin, returnTo)).jar)[0]!;

	it.each(KINDS)('expires a %s state after its lifetime', async (kind) => {
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-27T09:00:00Z') });
		const state = await stateOf(kind, ORIGIN_A);
		vi.setSystemTime(new Date('2026-10-27T09:14:00Z'));
		expect(await callback(kind, ORIGIN_A, new Map([state]))).toBe('/cases/case-1');
		vi.setSystemTime(new Date('2026-10-27T09:15:01Z'));
		expect(await callback(kind, ORIGIN_A, new Map([state]))).toBe('/cases');
	});
	it.each(KINDS)('refuses a tampered, truncated, repeated, renamed or moved %s state', async (kind) => {
		const [name, state] = await stateOf(kind, ORIGIN_A), [otherName, other] = await stateOf(kind, ORIGIN_A, '/cases/case-2');
		const [target, issued, mac] = state.split('.'), [otherTarget] = other.split('.');
		expect(await callbackWithHeader(kind, ORIGIN_A, `${name}=${state}`)).toBe('/cases/case-1');
		for (const cookie of [
			`${name}=${flip(state)}`, `${name}=${otherTarget}.${issued}.${mac}`, `${name}=${target}.${Number(issued) + 1}.${mac}`, `${name}=${target}.${issued}`, `${name}=${target}`, `${name}=`,
			`${name}=${state}; ${name}=${state}`, `${name}=${state}; ${name}=${other}`, `${name.replace('__Host-', '')}=${state}`,
			`${otherName}=${state}`, `${SIGN_IN_RETURN_PREFIX[kind].slice(0, -1)}=${state}`, `${name}x=${state}`,
		]) expect(await callbackWithHeader(kind, ORIGIN_A, cookie), cookie).toBe('/cases');
	});
	it.each(KINDS)('refuses a %s state minted on another client origin that shares the staff instance', async (kind) => {
		const state = await stateOf(kind, ORIGIN_C);
		expect(await callback(kind, ORIGIN_A, new Map([state]))).toBe('/cases');
		expect(await callback(kind, ORIGIN_C, new Map([state]))).toBe('/cases/case-1');
	});
	it('refuses a state minted for the other flow, under either cookie name', async () => {
		const into = (kind: InstanceKind, [name, value]: [string, string], from: InstanceKind) => new Map([[`${SIGN_IN_RETURN_PREFIX[kind]}${name.slice(SIGN_IN_RETURN_PREFIX[from].length)}`, value]]);
		const staff = await stateOf('staff', ORIGIN_A), clientState = await stateOf('client', ORIGIN_A);
		expect(await callback('client', ORIGIN_A, into('client', staff, 'staff'))).toBe('/cases');
		expect(await callback('staff', ORIGIN_A, into('staff', clientState, 'client'))).toBe('/cases');
		expect(await callback('client', ORIGIN_A, new Map([staff]))).toBe('/cases');
		expect(await callback('staff', ORIGIN_A, new Map([clientState]))).toBe('/cases');
	});
	it.each(KINDS)('sets no %s state on a plain http origin, which cannot hold a __Host- cookie, and returns it to /cases', async (kind) => {
		const { r, sets, jar } = await post(kind, ORIGIN_L, '/cases/case-1');
		expect(r.thrown).toMatchObject({ status: 303, location: portalHref(kind, ORIGIN_L) });
		expect(sets).toEqual([]);
		expect(await callback(kind, ORIGIN_L, jar)).toBe('/cases');
		expect(await sealSignInReturn(configOf(ORIGIN_L), kind, '/cases/case-1')).toBeNull();
	});
});

describe('the identity switch and the gate are unchanged', () => {
	it.each(KINDS)('refuses an ambiguous credential on the %s POST with 409 and sets no state', async (kind) => {
		const a = apps[ORIGIN_A].client;
		const ambiguous = `__session=${a.token({ sub: 'a', sid: 'b', azp: ORIGIN_A })}; __session_AbCd1234=${B.token({ sub: 'a', sid: 'b', azp: ORIGIN_A })}`;
		const { r, sets } = await post(kind, ORIGIN_A, '/cases/case-1', new Map(), ambiguous);
		expect(r.value).toMatchObject({ status: 409 });
		expect(sets).toEqual([]);
	});
	it('leaves a verified staff session on the client sign-in page, so it can switch to a client session', async () => {
		workers.env = app(ORIGIN_A);
		const url = new URL(`${ORIGIN_A}/sign-in`);
		const r = await outcome(() => client.load({ locals: locals(verified('staff')), url, request: new Request(url), cookies: cookiesOf(new Map(), []) } as never));
		expect(r.value).toMatchObject({ provider: 'clerk', href: portalHref('client', ORIGIN_A) });
	});
	it('sends a client session already verified on /sign-in to an explicit safe returnTo', async () => {
		workers.env = app(ORIGIN_A);
		for (const [returnTo, to] of [['/cases/case-9', '/cases/case-9'], ['//attacker.example.test', '/cases'], ['/sign-in', '/cases']] as const) {
			const url = new URL(`${ORIGIN_A}/sign-in${query(returnTo)}`);
			const r = await outcome(() => client.load({ locals: locals(verified('client')), url, request: new Request(url), cookies: cookiesOf(new Map(), []) } as never));
			expect(r.thrown, returnTo).toMatchObject({ status: 303, location: to });
		}
	});
});

async function callbackWithHeader(kind: InstanceKind, origin: Origin, cookie: string) {
	workers.env = app(origin);
	const url = new URL(callbackUrl(kind, origin));
	const r = await outcome(() => flows[kind].route.load({ locals: locals(verified(kind)), url, request: new Request(url, { headers: { cookie } }), cookies: cookiesOf(new Map(), []) } as never));
	expect(r.thrown).toMatchObject({ status: 303 });
	return r.thrown!.location!;
}
