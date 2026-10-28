// Synthetic route-handler and SSR evidence, not a browser or real Clerk. Overlapping POSTs must keep distinct
// attempts, but a shared callback cannot identify a tab: multiple attempts must all be cleared and land home.
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceKind } from '../../../src/lib/auth/clerk/config.ts';
import ClientPage from '../../../deploy/client/routes/sign-in/+page.svelte';
import StaffPage from '../../../deploy/client/routes/sign-in/operator/+page.svelte';
import CasesPage from '../../../deploy/client/routes/cases/+page.svelte';
import { createHandle } from '../../../src/lib/server/runtime/hosted/handle.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');
const cases = await import('../../../deploy/client/routes/cases/+page.server.ts');
const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
workers.env = {
	CLEARCASE_SESSION_KEY: 'a'.repeat(64), SESSIONS: { get: async () => null, put: async () => {} },
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_SIGN_IN_URL: 'https://accounts.client-a.clerk.test/sign-in', CLERK_STAFF_SIGN_IN_URL: 'https://accounts.staff-b.clerk.test/sign-in',
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
};
const flows = { staff: { route: operator, path: '/sign-in/operator', page: StaffPage }, client: { route: client, path: '/sign-in', page: ClientPage } } as const;
const KINDS = ['staff', 'client'] as const;
const STATE = { client: '__Host-clearcase_return', staff: '__Host-clearcase_staff_return' } as const;
const HOME = '/cases?signIn=multiple-tabs';
const NOTICE = 'You started sign-in in more than one tab, so we brought you here.';
type Jar = Map<string, string>;
type Reply = { sets: [string, string][]; deletes: string[] };
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
const recorder = (reply: Reply, jar?: Jar) => ({
	set: (name: string, value: string) => { reply.sets.push([name, value]); jar?.set(name, value); },
	delete: (name: string) => { reply.deletes.push(name); jar?.delete(name); },
	get: (name: string) => jar?.get(name),
});
const apply = (jar: Jar, reply: Reply) => {
	for (const name of reply.deletes) jar.delete(name);
	for (const [name, value] of reply.sets) jar.set(name, value);
};
const stateOf = (kind: InstanceKind, jar: Jar) => [...jar.keys()].filter((n) => n.startsWith(STATE[kind]));
const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e as { status?: number; location?: string } }; } };
const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
const verified = (kind: InstanceKind) => ({ kind: 'verified', principal: { kind, subject: 'user_synthetic', issuer: kind === 'staff' ? B.iss : 'https://client-a.clerk.test' }, sessionId: 'sess_synthetic' });
const target = (tab: string) => `/cases/tab-${tab}`;
async function post(kind: InstanceKind, returnTo: string, cookie: string, attempt?: string): Promise<Reply> {
	const url = new URL(`${ORIGIN}${flows[kind].path}?returnTo=${encodeURIComponent(returnTo)}`), reply: Reply = { sets: [], deletes: [] };
	const r = await outcome(() => flows[kind].route.actions.default!({ locals: locals(attempt ? verified(kind) : anonymous), url, request: new Request(url, { method: 'POST', headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, ...(attempt ? { body: new URLSearchParams({ attempt }) } : {}) }), cookies: recorder(reply) } as never));
	expect(r.thrown, `${kind} POST ${returnTo}`).toMatchObject({ status: 303 });
	if (attempt) expect(r.thrown!.location).toMatch(/^https:\/\/accounts\./); // a stale chooser form is not a selection
	return reply;
}
async function land(kind: InstanceKind, jar: Jar, a: { search?: string; headers?: Record<string, string>; isDataRequest?: boolean; dataPath?: boolean } = {}) {
	const url = new URL(`${ORIGIN}${flows[kind].path}${a.dataPath ? '/__data.json' : ''}${a.search ?? ''}`), reply: Reply = { sets: [], deletes: [] };
	const r = await outcome(() => flows[kind].route.load({ locals: locals(verified(kind)), url, isDataRequest: a.isDataRequest ?? false, request: new Request(url, { headers: { ...a.headers, ...(jar.size ? { cookie: header(jar) } : {}) } }), cookies: recorder(reply, jar) } as never));
	if (r.thrown) expect(r.thrown, `${kind} callback`).toMatchObject({ status: 303 });
	return { location: r.thrown?.location, reply, value: r.value };
}
async function overlap(kind: InstanceKind, before: Jar, answers: readonly number[]) {
	const cookie = header(before);
	const replies = await Promise.all(['A', 'B'].map((tab) => post(kind, target(tab), cookie)));
	const jar = new Map(before);
	for (const i of answers) apply(jar, replies[i]!);
	return jar;
}
async function twoInFlight(kind: InstanceKind) {
	const jar: Jar = new Map();
	apply(jar, await post(kind, target('A'), ''));
	apply(jar, await post(kind, target('B'), header(jar)));
	return jar;
}

describe('two overlapping sign-in POSTs never misroute a tab (M1, simplified alpha contract)', () => {
	const ANSWERS = [[0, 1], [1, 0]] as const, CALLBACKS = [['A', 'B'], ['B', 'A']] as const;
	const scenarios = KINDS.flatMap((kind) => ANSWERS.flatMap((answers) => CALLBACKS.map((callbacks) => [kind, answers.join(','), callbacks.join(','), answers] as const)));
	it.each(scenarios)('%s: answers %s, callbacks %s both land home', async (kind, _a, _c, answers) => {
		const jar = await overlap(kind, new Map(), answers);
		expect(stateOf(kind, jar)).toHaveLength(2);
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
		expect((await land(kind, jar)).location).toBe('/cases');
	});
	it.each(KINDS)('%s: an overlap keeps an older attempt, then clears all three at home', async (kind) => {
		const before: Jar = new Map();
		apply(before, await post(kind, target('C'), ''));
		const jar = await overlap(kind, before, [1, 0]);
		expect(stateOf(kind, jar)).toHaveLength(3);
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: a staff and a client POST in flight together keep both flows', async (kind) => {
		const other = kind === 'staff' ? 'client' : 'staff';
		const [mine, theirs] = await Promise.all([post(kind, target('mine'), ''), post(other, target('theirs'), '')]);
		const jar: Jar = new Map();
		apply(jar, theirs); apply(jar, mine);
		expect((await land(kind, jar)).location).toBe(target('mine'));
		expect((await land(other, jar)).location).toBe(target('theirs'));
	});
	it.each(KINDS)('%s: two concurrent attempts for the same target still land home', async (kind) => {
		const jar: Jar = new Map();
		for (const reply of await Promise.all([post(kind, target('A'), ''), post(kind, target('A'), '')])) apply(jar, reply);
		expect(stateOf(kind, jar)).toHaveLength(2);
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: clears every flow cookie, including beyond the validation scan cap', async (kind) => {
		const jar: Jar = new Map();
		for (let n = 0; n < 10; n++) apply(jar, await post(kind, target(String(n)), ''));
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: large concurrent targets do not become a singleton through byte eviction', async (kind) => {
		const jar: Jar = new Map();
		for (const c of ['A', 'B']) apply(jar, await post(kind, `/cases/${c.repeat(2000)}`, ''));
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
});

describe('a GET nobody clicked never consumes an attempt (M2)', () => {
	it.each(KINDS)('%s: a speculative data request preserves multiple and invalid cookies, including the other flow', async (kind) => {
		const jar = await twoInFlight(kind), other = kind === 'staff' ? 'client' : 'staff';
		apply(jar, await post(other, target('other'), ''));
		jar.set(`${STATE[kind]}-invalid`, 'invalid');
		const before = new Map(jar);
		expect((await land(kind, jar, { isDataRequest: true })).reply).toEqual({ sets: [], deletes: [] });
		expect(jar).toEqual(before);
		expect((await land(kind, jar)).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
		expect((await land(other, jar)).location).toBe(target('other'));
	});
	it.each(KINDS)('%s: a singleton follows its signed target, not a callback query', async (kind) => {
		const jar: Jar = new Map();
		apply(jar, await post(kind, target('A'), ''));
		expect((await land(kind, jar, { search: '?returnTo=/cases/elsewhere' })).location).toBe(target('A'));
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: replaying a consumed return hint stays a signed same-origin hint (accepted M4 Low)', async (kind) => {
		const jar: Jar = new Map();
		apply(jar, await post(kind, target('A'), ''));
		const replay = new Map(jar);
		expect((await land(kind, jar)).location).toBe(target('A'));
		expect(stateOf(kind, jar)).toEqual([]);
		expect((await land(kind, replay)).location).toBe(target('A'));
	});
	it.each(KINDS)('%s: no chooser remains; home shows the plain notice', async (kind) => {
		const landing = await land(kind, await twoInFlight(kind));
		expect(landing.location).toBe(HOME);
		const data = await cases.load({ url: new URL(landing.location!, ORIGIN), locals: { identity: verified(kind), store: { listCases: async () => [] } } } as never);
		const body = render(CasesPage, { props: { data } }).body;
		expect(body).toContain(NOTICE);
		expect(body).not.toContain('name="attempt"');
		const signIn = render(flows[kind].page, { props: { data: { provider: 'clerk', href: 'https://accounts.example.test', options: [] }, form: null } }).body;
		expect(signIn).not.toContain('name="attempt"');
	});
	it.each(KINDS)('%s: an old chooser GET cannot pick a target from multiple attempts', async (kind) => {
		const jar = await twoInFlight(kind);
		expect((await land(kind, jar, { search: `?returnTo=${encodeURIComponent(target('A'))}` })).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
	const requests = [
		['headerless Kit data preload', { isDataRequest: true }],
		['headerless __data.json', { dataPath: true }],
		...['sec-purpose', 'purpose'].flatMap((name) => ['prefetch', 'prefetch;prerender', 'preload'].map((value) => [`${name}: ${value}`, { headers: { [name]: value } }] as const)),
		...['cors', 'same-origin', 'no-cors'].map((mode) => [`fetch mode ${mode}`, { headers: { 'sec-fetch-mode': mode } }] as const),
	] as const;
	it.each(KINDS.flatMap((kind) => requests.map(([label, options]) => [kind, label, options] as const)))('%s: %s consumes nothing', async (kind, _label, options) => {
		const jar: Jar = new Map();
		apply(jar, await post(kind, target('A'), ''));
		const before = new Map(jar);
		const speculative = await land(kind, jar, options);
		expect(speculative.reply).toEqual({ sets: [], deletes: [] });
		expect(jar).toEqual(before);
		// A second sign-in after an unmarked preload must not leave B as a false singleton for tab A.
		apply(jar, await post(kind, target('B'), header(jar)));
		expect((await land(kind, jar, { headers: { 'sec-fetch-mode': 'navigate' } })).location).toBe(HOME);
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: a stale chooser POST cannot select or consume another pending target (M3)', async (kind) => {
		const jar = await twoInFlight(kind);
		const oldAttempt = stateOf(kind, jar)[0]!.slice(`${STATE[kind]}-`.length);
		expect((await land(kind, jar)).location).toBe(HOME);
		apply(jar, await post(kind, target('B'), ''));
		const reply = await post(kind, '/cases', header(jar), oldAttempt);
		expect(reply.deletes).not.toContain(stateOf(kind, jar)[0]);
	});
	it('disables inherited data preloading on the denial sign-in link', () => {
		const error = readFileSync(new URL('../../../deploy/client/routes/+error.svelte', import.meta.url), 'utf8');
		// auth-routing sends the link through signInHref, so it names the flow of the page that refused; preload stays off
		expect(error).toMatch(/<a\b[^>]*id="sign-in-link"[^>]*href=\{signInHref\([^>]*data-sveltekit-preload-data="off"/);
	});
});

describe('a sign-in POST passes the hosted exact-Origin check or reaches no route', () => {
	const handle = createHandle(async () => ({ ready: true, services: createUnavailableServices({ clientId: id('client', 'client-a'), now: () => new Date('2026-10-27T09:00:00.000Z') }) }));
	it.each(KINDS.flatMap((kind) => [['https://attacker.example.test'], ['https://client-c.clearcase.test'], ['null'], [null]].map(([origin]) => [kind, String(origin), origin] as const)))('%s: refuses Origin %s before the route', async (kind, _label, origin) => {
		const request = new Request(`${ORIGIN}${flows[kind].path}`, { method: 'POST', headers: { ...(origin === null ? {} : { origin }), 'content-type': 'application/x-www-form-urlencoded' }, body: 'attempt=AAAAAAAAAAAAAAAAAAAAAA' });
		const resolve = vi.fn(async () => new Response('route ran'));
		const response = await handle({ event: { request, url: new URL(request.url), locals: {} }, resolve } as unknown as Parameters<typeof handle>[0]);
		expect(response.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});
});
