// adapter-cloudflare 8 calls server.respond(req, { getClientAddress }) with no platform, so no request reaches a route with
// event.platform.context. Unit evidence only: synthetic collaborators, no workerd, no Clerk; the live readback is the parent's.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { bindNativeRequestCompositions, installNativeCompositions } from '../../../src/lib/server/runtime/hosted/compositions.ts';
import { hostedServices } from '../../../src/lib/server/runtime/hosted/services.ts';
import { operatorDownloadControllerFor } from '../../../src/lib/submissions/download/composition.ts';
import type { OperatorDownloadPorts } from '../../../src/lib/submissions/download/ports.ts';
import type { SubmissionRepository } from '../../../src/lib/submissions/ports.ts';
import { planNativeRuntimeConfig } from '../../../deploy/native-alpha/runtime-config.ts';
import { MemoryR2, SqliteD1 } from '../storage/doubles.ts';
import { exampleWithBrowserAllocation } from '../native-runtime-config/example-input.ts';
import { runtimeEnv } from '../native-runtime-config/harness.ts';

beforeAll(() => installNativeCompositions());
const unused = async (): Promise<never> => { throw Error('unexpected unit collaborator call'); };
function fixture(client = 'client-a') {
	const clientId = id('client', client), list = vi.fn(async () => []);
	const append = vi.fn(async (event: { eventId: string }) => ({ eventId: event.eventId }));
	const identity: Identity = { kind: 'verified', clientId, principal: { issuer: 'https://synthetic.clerk.test', subject: 'user_' + client, kind: 'staff' },
		sessionId: id('session', 'session_' + client), checkRevocation: async () => {}, authorize: async () => {} };
	const repository: SubmissionRepository = { declare: unused, upload: unused, markStored: unused, reserveRevision: unused, commitRevision: unused, revision: unused, list };
	const work: Promise<void>[] = [];
	const scheduler = { waitUntil: vi.fn((job: Promise<void>) => { work.push(job); }) };
	const downloads: OperatorDownloadPorts = { clientId, authorizeOperate: async () => {}, repository, assets: { metadata: unused, get: unused }, audit: { append },
		now: () => new Date('2026-10-25T10:00:00.000Z') };
	return { downloads, scheduled: { ...downloads, waitUntil: (job: Promise<void>) => scheduler.waitUntil(job) }, identity, list, append, scheduler, work };
}
const request = () => new Request('https://client-a.test/operator/submissions/synthetic');
const input = (r: Request, identity: Identity) => ({ request: r, url: new URL(r.url), params: { caseId: 'synthetic' }, identity });
const list = async (r: Request, identity: Identity, platform: unknown = undefined) =>
	(await operatorDownloadControllerFor({ request: r, platform })).list(input(r, identity));

describe('operator downloads with the real adapter shape (no event.platform)', () => {
	it('releases with the trusted per-request scheduler and retains the terminal audit after EOF', async () => {
		const f = fixture(), r = request();
		bindNativeRequestCompositions(r, { intake: null, downloads: f.scheduled });
		const response = await list(r, f.identity);
		expect(response.status).toBe(200);
		await response.arrayBuffer(); await Promise.all(f.work);
		expect(f.scheduler.waitUntil).toHaveBeenCalledOnce();
		expect(f.append.mock.calls.map(([e]) => (e as { eventId: string }).eventId.endsWith(':completed'))).toEqual([false, true]);
	});
	it.each([['undefined', undefined], ['null', null], ['an empty platform', {}], ['an empty context', { context: {} }],
		['a non-function waitUntil', { context: { waitUntil: 'later' } }]])('stays unavailable with no bound scheduler and %s', async (_name, platform) => {
		const f = fixture(), r = request();
		bindNativeRequestCompositions(r, { intake: null, downloads: f.downloads });
		expect((await list(r, f.identity, platform)).status).toBe(503);
		expect(f.list).not.toHaveBeenCalled(); expect(f.append).not.toHaveBeenCalled();
	});
	it('never lends a bound scheduler to a cloned request or to another unscheduled request', async () => {
		const a = fixture(), b = fixture(), ra = request(), rb = request(), clone = new Request(ra);
		bindNativeRequestCompositions(ra, { intake: null, downloads: a.scheduled });
		bindNativeRequestCompositions(rb, { intake: null, downloads: b.downloads });
		expect((await list(clone, a.identity)).status).toBe(503);
		expect((await list(rb, b.identity)).status).toBe(503);
		expect(a.list).not.toHaveBeenCalled(); expect(b.list).not.toHaveBeenCalled(); expect(a.scheduler.waitUntil).not.toHaveBeenCalled();
	});
	it('ignores a scheduler grafted onto the bound download ports after binding', async () => {
		const f = fixture(), r = request(), ports: OperatorDownloadPorts = { ...f.downloads };
		bindNativeRequestCompositions(r, { intake: null, downloads: ports });
		(ports as { waitUntil?: OperatorDownloadPorts['waitUntil'] }).waitUntil = (job) => f.scheduler.waitUntil(job);
		expect((await list(r, f.identity)).status).toBe(503);
		expect(f.list).not.toHaveBeenCalled(); expect(f.scheduler.waitUntil).not.toHaveBeenCalled();
	});
	it('keeps overlapping requests on their own schedulers and audit sinks', async () => {
		const a = fixture(), b = fixture('client-b'), ra = request(), rb = request();
		bindNativeRequestCompositions(ra, { intake: null, downloads: a.scheduled });
		bindNativeRequestCompositions(rb, { intake: null, downloads: b.scheduled });
		const [one, two] = await Promise.all([list(ra, a.identity), list(rb, b.identity)]);
		expect([one.status, two.status]).toEqual([200, 200]);
		await Promise.all([one.arrayBuffer(), two.arrayBuffer()]); await Promise.all([...a.work, ...b.work]);
		expect(a.scheduler.waitUntil).toHaveBeenCalledOnce(); expect(b.scheduler.waitUntil).toHaveBeenCalledOnce();
		expect(a.append).toHaveBeenCalledTimes(2); expect(b.append).toHaveBeenCalledTimes(2);
		expect(a.list).toHaveBeenCalledWith({ clientId: 'client-a', caseId: 'synthetic' });
		expect(b.list).toHaveBeenCalledWith({ clientId: 'client-b', caseId: 'synthetic' });
	});
});

describe('hostedServices binds the request scheduler it is given into the download ports', () => {
	const file = planNativeRuntimeConfig(exampleWithBrowserAllocation()).clients.find((c) => c.clientId === 'client-a')!;
	const env = () => {
		const db = Object.assign(new SqliteD1(), { withSession: (_constraint: 'first-primary') => db });
		return runtimeEnv(file, { DB: db, BUCKET: new MemoryR2() });
	};
	it('an anonymous operator list reaches the identity gate (401) only when a scheduler was supplied', async () => {
		const scheduled = new Request('https://client-a.clearcase.test/operator/submissions/synthetic'), unscheduled = new Request(scheduled.url);
		const waitUntil = vi.fn();
		const ready = await hostedServices(scheduled, env(), { waitUntil });
		const bare = await hostedServices(unscheduled, env());
		expect([ready.ready, ready.services.identity.kind, bare.ready]).toEqual([true, 'anonymous', true]);
		expect((await list(scheduled, ready.services.identity)).status).toBe(401);
		expect((await list(unscheduled, bare.services.identity)).status).toBe(503);
		expect(waitUntil).not.toHaveBeenCalled();
	});
});

describe('the production hooks hand the Workers runtime waitUntil to each request', () => {
	afterEach(() => { vi.doUnmock('cloudflare:workers'); vi.doUnmock('../../../src/lib/server/runtime/hosted/services.ts'); vi.resetModules(); });
	it('passes a scheduler that forwards to cloudflare:workers waitUntil', async () => {
		vi.resetModules();
		const runtimeWaitUntil = vi.fn(), seen: unknown[][] = [];
		vi.doMock('cloudflare:workers', () => ({ env: Object.freeze({}), waitUntil: runtimeWaitUntil }));
		vi.doMock('../../../src/lib/server/runtime/hosted/services.ts', () => ({ hostedServices: async (...args: unknown[]) => {
			seen.push(args);
			return { ready: false, reason: 'synthetic', services: {} };
		} }));
		const { handle } = await import('../../../src/lib/server/runtime/hosted/hooks.server.ts');
		const url = new URL('https://client-a.test/operator/submissions/synthetic');
		const event = { request: new Request(url), url, locals: {}, isSubRequest: false } as unknown as Parameters<typeof handle>[0]['event'];
		expect((await handle({ event, resolve: unused })).status).toBe(503);
		expect(seen).toHaveLength(1);
		expect(seen[0]![0]).toBe(event.request);
		const scheduler = seen[0]![2] as { waitUntil(work: Promise<void>): void };
		const work = Promise.resolve();
		scheduler.waitUntil(work);
		expect(runtimeWaitUntil).toHaveBeenCalledExactlyOnceWith(work);
	});
});
