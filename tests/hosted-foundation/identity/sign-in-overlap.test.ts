// Fix round 2 for the per-attempt return target (27 Oct, re-check M1 and M2). Two sign-in POSTs of one flow can leave
// the browser before either answer arrives, so both carry the same Cookie header; each answer must keep the other
// attempt. A chooser choice must take a deliberate POST: SvelteKit's hover preload (src/app.html) and a browser's
// speculative prefetch issue GETs nobody clicked, and such a GET must not consume an attempt. SYNTHETIC keys and hosts;
// route-handler and SSR markup evidence only, not a browser or a real Clerk instance.
import { readFileSync } from 'node:fs';
// @ts-expect-error jsdom ships no types and the root pins no @types/jsdom; the test only reads parsed markup.
import { JSDOM } from 'jsdom';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceKind } from '../../../src/lib/auth/clerk/config.ts';
import ClientPage from '../../../deploy/client/routes/sign-in/+page.svelte';
import StaffPage from '../../../deploy/client/routes/sign-in/operator/+page.svelte';
import { createHandle } from '../../../src/lib/server/runtime/hosted/handle.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { createUnavailableServices } from '../../../src/lib/server/runtime/unavailable.ts';
import { craftedInstance } from './synthetic.ts';

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const operator = await import('../../../deploy/client/routes/sign-in/operator/+page.server.ts');
const client = await import('../../../deploy/client/routes/sign-in/+page.server.ts');

const ORIGIN = 'https://client-a.clearcase.test';
const A = craftedInstance('client-a.clerk.test'), B = craftedInstance('staff-b.clerk.test');
workers.env = {
	CLEARCASE_CLIENT_ID: 'client-a', CLEARCASE_APP_ORIGIN: ORIGIN,
	CLERK_CLIENT_SIGN_IN_URL: 'https://accounts.client-a.clerk.test/sign-in', CLERK_STAFF_SIGN_IN_URL: 'https://accounts.staff-b.clerk.test/sign-in',
	CLERK_CLIENT_PUBLISHABLE_KEY: A.publishableKey, CLERK_CLIENT_SECRET_KEY: A.secretKey, CLERK_CLIENT_JWT_KEY: A.jwtKey,
	CLERK_STAFF_PUBLISHABLE_KEY: B.publishableKey, CLERK_STAFF_SECRET_KEY: B.secretKey, CLERK_STAFF_JWT_KEY: B.jwtKey,
};
const flows = { staff: { route: operator, path: '/sign-in/operator', page: StaffPage }, client: { route: client, path: '/sign-in', page: ClientPage } } as const;
const KINDS = ['staff', 'client'] as const;
// Every return-target cookie of a flow starts with its name; the client name is not a prefix of the staff one.
const STATE = { client: '__Host-clearcase_return', staff: '__Host-clearcase_staff_return' } as const;

type Jar = Map<string, string>;
type Reply = { sets: [string, string][]; deletes: string[] };
const header = (jar: Jar) => [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
const recorder = (reply: Reply, jar?: Jar) => ({
	set: (name: string, value: string) => { reply.sets.push([name, value]); jar?.set(name, value); },
	delete: (name: string) => { reply.deletes.push(name); jar?.delete(name); },
	get: (name: string) => jar?.get(name),
});
/** Applies one answer's Set-Cookie headers to the browser's jar, as the browser does when the answer arrives. */
const apply = (jar: Jar, reply: Reply) => {
	for (const name of reply.deletes) jar.delete(name);
	for (const [name, value] of reply.sets) jar.set(name, value);
};
const stateOf = (kind: InstanceKind, jar: Jar) => [...jar.keys()].filter((n) => n.startsWith(STATE[kind]));
const outcome = async (f: () => unknown) => { try { return { value: (await f()) as Record<string, unknown> | undefined }; } catch (e) { return { thrown: e as { status?: number; location?: string } }; } };
const locals = (identity: unknown) => ({ runtime: { testIdentity: null }, identity }) as unknown as App.Locals;
const anonymous = { kind: 'anonymous', principal: null, sessionId: null };
const verified = (kind: InstanceKind) => ({ kind: 'verified', principal: { kind }, sessionId: 'sess_synthetic' });
const target = (tab: string) => `/cases/tab-${tab}`;
type Pending = { to: string; attempt: string }[];

/** A sign-in POST for `returnTo` sent with `cookie`; its answer is not applied to any jar. */
async function post(kind: InstanceKind, returnTo: string, cookie: string): Promise<Reply> {
	const url = new URL(`${ORIGIN}${flows[kind].path}?returnTo=${encodeURIComponent(returnTo)}`), reply: Reply = { sets: [], deletes: [] };
	const r = await outcome(() => flows[kind].route.actions.default!({ locals: locals(anonymous), url, request: new Request(url, { method: 'POST', headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } }), cookies: recorder(reply) } as never));
	expect(r.thrown, `${kind} POST ${returnTo}`).toMatchObject({ status: 303 });
	return reply;
}
/** The verified callback GET with this jar (and extra headers): a 303 location or the offered choices, and its answer. */
async function land(kind: InstanceKind, jar: Jar, a: { search?: string; headers?: Record<string, string> } = {}) {
	const url = new URL(`${ORIGIN}${flows[kind].path}${a.search ?? ''}`), reply: Reply = { sets: [], deletes: [] };
	const r = await outcome(() => flows[kind].route.load({ locals: locals(verified(kind)), url, request: new Request(url, { headers: { ...a.headers, ...(jar.size ? { cookie: header(jar) } : {}) } }), cookies: recorder(reply, jar) } as never));
	if (r.thrown) {
		expect(r.thrown, `${kind} callback`).toMatchObject({ status: 303 });
		return { location: r.thrown.location!, reply };
	}
	return { pending: (r.value as { pending?: Pending }).pending, reply };
}
/** The chooser's POST for one attempt, from this origin, with this jar. */
async function choose(kind: InstanceKind, jar: Jar, attempt: string) {
	const url = new URL(`${ORIGIN}${flows[kind].path}`), reply: Reply = { sets: [], deletes: [] };
	const request = new Request(url, { method: 'POST', headers: { origin: ORIGIN, cookie: header(jar), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ attempt }) });
	const r = await outcome(() => flows[kind].route.actions.default!({ locals: locals(verified(kind)), url, request, cookies: recorder(reply, jar) } as never));
	expect(r.thrown, `${kind} choice`).toMatchObject({ status: 303 });
	return r.thrown!.location!;
}
/** Two tabs' POSTs, both sent with the cookies in `before`, answered in `answers` order. */
async function overlap(kind: InstanceKind, before: Jar, answers: readonly number[]) {
	const cookie = header(before);
	const replies = await Promise.all(['A', 'B'].map((tab) => post(kind, target(tab), cookie)));
	const jar = new Map(before);
	for (const i of answers) apply(jar, replies[i]!);
	return jar;
}

describe('two overlapping sign-in POSTs of one flow keep both attempts (re-check M1)', () => {
	const ANSWERS = [[0, 1], [1, 0]] as const, CALLBACKS = [['A', 'B'], ['B', 'A']] as const;
	const cases = KINDS.flatMap((kind) => ANSWERS.flatMap((answers) => CALLBACKS.map((callbacks) => [kind, answers.map((i) => 'AB'[i]).join(' then '), callbacks.join(' then '), answers, callbacks] as const)));
	it.each(cases)('%s: answers %s, callbacks %s', async (kind, _a, _c, answers, [first, second]) => {
		const jar = await overlap(kind, new Map(), answers);
		const offered = await land(kind, jar);
		expect(offered.location, 'the first callback must not guess a tab').toBeUndefined();
		expect(offered.pending?.map((p) => p.to).sort()).toEqual([target('A'), target('B')]);
		const own = offered.pending!.find((p) => p.to === target(first))!;
		expect(await choose(kind, jar, own.attempt)).toBe(target(first));
		expect((await land(kind, jar)).location).toBe(target(second));
		expect(stateOf(kind, jar)).toEqual([]);
	});
	it.each(KINDS)('%s: an overlap keeps an older attempt still in flight', async (kind) => {
		const before: Jar = new Map();
		apply(before, await post(kind, target('C'), ''));
		const jar = await overlap(kind, before, [1, 0]);
		expect((await land(kind, jar)).pending?.map((p) => p.to).sort()).toEqual([target('A'), target('B'), target('C')]);
	});
	it.each(KINDS)('%s: a staff and a client POST in flight together keep both flows', async (kind) => {
		const other = kind === 'staff' ? 'client' : 'staff';
		const [mine, theirs] = await Promise.all([post(kind, target('mine'), ''), post(other, target('theirs'), '')]);
		const jar: Jar = new Map();
		apply(jar, theirs);
		apply(jar, mine);
		expect((await land(kind, jar)).location).toBe(target('mine'));
		expect((await land(other, jar)).location).toBe(target('theirs'));
	});
});

describe('a GET nobody clicked never consumes an attempt (re-check M2)', () => {
	const twoInFlight = async (kind: InstanceKind) => {
		const jar: Jar = new Map();
		apply(jar, await post(kind, target('A'), ''));
		apply(jar, await post(kind, target('B'), header(jar)));
		return jar;
	};
	it.each(KINDS)('%s: the chooser offers each target as a POST form, not a link a hover can preload', async (kind) => {
		const offered = await land(kind, await twoInFlight(kind));
		expect(offered.pending).toHaveLength(2);
		const body = render(flows[kind].page, { props: { data: { provider: 'clerk', href: null, options: [], pending: offered.pending }, form: null } }).body;
		const shell = readFileSync(new URL('../../../src/app.html', import.meta.url), 'utf8').replace('%sveltekit.body%', body).replace('%sveltekit.head%', '');
		const dom = new JSDOM(shell, { url: `${ORIGIN}${flows[kind].path}` }), doc = dom.window.document;
		expect(doc.querySelectorAll('a[href]'), 'no chooser link a hover preload would fetch').toHaveLength(0);
		const forms = [...doc.querySelectorAll('form')].filter((f) => f.querySelector('input[name="attempt"]'));
		expect(forms.map((f) => [f.method, new URL(f.action).href, f.querySelector('button')?.textContent?.trim()])).toEqual(
			offered.pending!.map((p) => ['post', `${ORIGIN}${flows[kind].path}`, p.to]),
		);
		expect(forms.map((f) => (f.querySelector('input[name="attempt"]') as HTMLInputElement).value)).toEqual(offered.pending!.map((p) => p.attempt));
		dom.window.close();
	});
	it.each(KINDS)('%s: the old chooser link (a GET with returnTo) consumes neither attempt', async (kind) => {
		const jar = await twoInFlight(kind);
		const before = new Map(jar);
		expect((await land(kind, jar, { search: `?returnTo=${encodeURIComponent(target('A'))}` })).location).toBe(target('A'));
		expect(jar).toEqual(before);
		expect((await land(kind, jar)).pending?.map((p) => p.to).sort()).toEqual([target('A'), target('B')]);
	});
	it.each(KINDS.flatMap((kind) => [['sec-purpose', 'prefetch'], ['sec-purpose', 'prefetch;prerender'], ['purpose', 'prefetch']].map(([n, v]) => [kind, `${n}: ${v}`, n!, v!] as const)))('%s: a speculative callback GET (%s) consumes nothing', async (kind, _label, name, value) => {
		const jar: Jar = new Map();
		apply(jar, await post(kind, target('A'), ''));
		const before = new Map(jar);
		const speculative = await land(kind, jar, { headers: { [name]: value } });
		expect(speculative.reply).toEqual({ sets: [], deletes: [] });
		expect(jar).toEqual(before);
		expect((await land(kind, jar)).location).toBe(target('A'));
		expect(stateOf(kind, jar)).toEqual([]);
	});
});

describe('a chooser POST passes the hosted exact-Origin check or reaches no route', () => {
	const handle = createHandle(async () => ({ ready: true, services: createUnavailableServices({ clientId: id('client', 'client-a'), now: () => new Date('2026-10-27T09:00:00.000Z') }) }));
	it.each(KINDS.flatMap((kind) => [['https://attacker.example.test'], ['https://client-c.clearcase.test'], ['null'], [null]].map(([origin]) => [kind, String(origin), origin] as const)))('%s: refuses a choice with Origin %s before the route', async (kind, _label, origin) => {
		const request = new Request(`${ORIGIN}${flows[kind].path}`, { method: 'POST', headers: { ...(origin === null ? {} : { origin }), 'content-type': 'application/x-www-form-urlencoded' }, body: 'attempt=AAAAAAAAAAAAAAAAAAAAAA' });
		const resolve = vi.fn(async () => new Response('route ran'));
		const response = await handle({ event: { request, url: new URL(request.url), locals: {} }, resolve } as unknown as Parameters<typeof handle>[0]);
		expect(response.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
	});
});
