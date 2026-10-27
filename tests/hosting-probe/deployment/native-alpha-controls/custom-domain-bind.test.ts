import { describe, expect, it } from 'vitest';
import { APPROVED_NATIVE_SCOPE } from '../../../../deploy/native-alpha/controls.ts';
import {
	bindScopeProblems, customDomainBindProblems, customDomainPrebindProblems, domainsReadOperation, planCustomDomainBind, planCustomDomainUnbind,
	zoneActiveProblems, zoneReadOperation,
} from '../../../../deploy/native-alpha/custom-domain-bind.ts';

// Synthetic provider answers shaped like the REST responses. Not provider, DNS or deployment evidence.
const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const ZONE = '1c82369e826ebe0afded65c295198fcd';
const WORKER = { a: 'cc-sbx-a-20261023', b: 'cc-sbx-b-20261023' } as const;
const HOST = { a: 'sbx-a.clearcase.co.za', b: 'sbx-b.clearcase.co.za' } as const;
const zone = (over: Record<string, unknown> = {}) => ({ id: ZONE, name: 'clearcase.co.za', status: 'active', paused: false, type: 'full', account: { id: ACCOUNT, name: 'synthetic' }, ...over });
const row = (letter: 'a' | 'b', over: Record<string, unknown> = {}) => ({ id: letter.charCodeAt(0).toString(16).repeat(16), hostname: HOST[letter], zone_id: ZONE, zone_name: 'clearcase.co.za', service: WORKER[letter], environment: 'production', ...over });
const scope = () => JSON.parse(JSON.stringify(APPROVED_NATIVE_SCOPE)) as any;

describe('the approved scope is this zone and these two single-label hosts', () => {
	it('names the zone, both hosts and both Workers', () => {
		expect(APPROVED_NATIVE_SCOPE.accountId).toBe(ACCOUNT);
		expect(APPROVED_NATIVE_SCOPE.zone).toEqual({ id: ZONE, name: 'clearcase.co.za' });
		expect(APPROVED_NATIVE_SCOPE.clients.map((c) => [c.client, c.worker, c.hostname])).toEqual([['client-a', WORKER.a, HOST.a], ['client-b', WORKER.b, HOST.b]]);
		expect(bindScopeProblems(scope())).toEqual([]);
	});
	it.each([
		['another zone id', (s: any) => { s.zone.id = 'db7c322907320aba562d64015ee7d673'; }, /approved zone/],
		['another zone name', (s: any) => { s.zone.name = 'gridshift.co.za'; }, /approved zone/],
		['another account', (s: any) => { s.accountId = '0'.repeat(32); }, /approved account/],
		['a wildcard host', (s: any) => { s.clients[0].hostname = '*.clearcase.co.za'; }, /wildcard/],
		['a wildcard label', (s: any) => { s.clients[0].hostname = 'sbx-*.clearcase.co.za'; }, /wildcard/],
		['a host outside the zone', (s: any) => { s.clients[0].hostname = 'sbx-a.gridshift.co.za'; }, /outside the zone/],
		['the old sandbox host', (s: any) => { s.clients[0].hostname = 'a.sandbox.gridshift.co.za'; }, /outside the zone/],
		['a look-alike suffix', (s: any) => { s.clients[0].hostname = 'sbx-a.clearcase.co.za.example.com'; }, /outside the zone/],
		['a nested host', (s: any) => { s.clients[0].hostname = 'x.sbx-a.clearcase.co.za'; }, /one label/],
		['the apex', (s: any) => { s.clients[0].hostname = 'clearcase.co.za'; }, /outside the zone/],
		['an upper-case host', (s: any) => { s.clients[0].hostname = 'SBX-A.clearcase.co.za'; }, /one label/],
		['the other client host', (s: any) => { s.clients[0].hostname = HOST.b; }, /not exactly client-a/],
		['the other client Worker', (s: any) => { s.clients[0].worker = WORKER.b; }, /not exactly client-a|more than once/],
		['both hosts the same', (s: any) => { s.clients[1].hostname = HOST.a; }, /more than once/],
		['a third client', (s: any) => { s.clients.push({ client: 'client-c', worker: 'cc-sbx-c-20261023', hostname: 'sbx-c.clearcase.co.za' }); }, /3 clients/],
		['one client missing', (s: any) => { s.clients.pop(); }, /1 clients/],
	])('refuses %s', (_label, edit, reason) => {
		const s = scope();
		edit(s);
		expect(bindScopeProblems(s).join('\n')).toMatch(reason);
		expect(() => planCustomDomainBind(s)).toThrow(/custom-domain bind refused/);
	});
	it.each([null, undefined, 'x', 7, [], {}, { clients: [] }, { clients: [], zone: null }])('refuses the non-scope %j', (value) => {
		expect(bindScopeProblems(value).length).toBeGreaterThan(0);
	});
});

describe('the bind is one free Workers Custom Domain PUT per client, each host on its own Worker', () => {
	it('is exactly two PUTs to /workers/domains in production and the approved zone, with no route', () => {
		const ops = planCustomDomainBind();
		expect(ops.map((o) => [o.method, o.path, o.body])).toEqual([
			['PUT', `/accounts/${ACCOUNT}/workers/domains`, { environment: 'production', hostname: HOST.a, service: WORKER.a, zone_id: ZONE }],
			['PUT', `/accounts/${ACCOUNT}/workers/domains`, { environment: 'production', hostname: HOST.b, service: WORKER.b, zone_id: ZONE }],
		]);
		expect(ops.map((o) => o.client)).toEqual(['client-a', 'client-b']);
		expect(JSON.stringify(ops)).not.toMatch(/routes|\*|pattern|custom_domain/);
	});
	it("never pairs a host with the other client's Worker", () => {
		for (const op of planCustomDomainBind()) {
			const letter = op.client === 'client-a' ? 'a' : 'b';
			expect(op.body.hostname).toBe(HOST[letter]);
			expect(op.body.service).toBe(WORKER[letter]);
		}
	});
	it('is frozen, so a caller cannot move a host or a Worker between planning and sending', () => {
		const ops = planCustomDomainBind();
		expect(() => { (ops[0] as any).body.service = WORKER.b; }).toThrow();
		expect(() => { (ops[0] as any).body.hostname = '*.clearcase.co.za'; }).toThrow();
		expect(planCustomDomainBind()[0]!.body.service).toBe(WORKER.a);
	});
	it('reads the zone first, by id, and the account domain list for the before and after state', () => {
		expect(zoneReadOperation()).toMatchObject({ method: 'GET', path: `/zones/${ZONE}` });
		expect(domainsReadOperation()).toMatchObject({ method: 'GET', path: `/accounts/${ACCOUNT}/workers/domains` });
	});
});

describe('the zone must read active before any bind', () => {
	it('accepts exactly the approved, active, full zone in the approved account', () => expect(zoneActiveProblems(zone())).toEqual([]));
	it.each(['pending', 'initializing', 'moved', 'deleted', 'deactivated', '', null, undefined, 'ACTIVE'])('refuses the status %j', (status) => {
		expect(zoneActiveProblems(zone({ status })).join('\n')).toMatch(/is not active/);
	});
	it.each([
		['another zone id', { id: 'db7c322907320aba562d64015ee7d673' }, /zone id/],
		['another zone name', { name: 'gridshift.co.za' }, /zone name/],
		['another account', { account: { id: '0'.repeat(32) } }, /approved account/],
		['no account', { account: undefined }, /approved account/],
		['a paused zone', { paused: true }, /paused/],
		['a partial zone', { type: 'partial' }, /not full/],
	])('refuses %s', (_label, over, reason) => expect(zoneActiveProblems(zone(over)).join('\n')).toMatch(reason));
	it.each([null, undefined, 'active', 3, [], []])('refuses the non-object %j', (value) => expect(zoneActiveProblems(value)).toEqual(['zone answer is not an object']));
});

describe('the before and after readbacks', () => {
	it('lets an empty account proceed and holds when an approved host is already bound or a Worker has another domain in the zone', () => {
		expect(customDomainPrebindProblems([])).toEqual([]);
		expect(customDomainPrebindProblems([row('a', { service: 'someone-else' })]).join('\n')).toMatch(/already bound/);
		expect(customDomainPrebindProblems([row('a', { hostname: 'other.clearcase.co.za' })]).join('\n')).toMatch(/unreviewed domain/);
		expect(customDomainPrebindProblems([row('a', { hostname: 'other.example.com', zone_id: '0'.repeat(32) })])).toEqual([]);
		expect(customDomainPrebindProblems('x')).toEqual(['domain list is not a list']);
	});
	it('accepts only each host bound once, in production, in the zone, to its own Worker', () => {
		expect(customDomainBindProblems([row('a'), row('b')])).toEqual([]);
		expect(customDomainBindProblems([row('b'), row('a')])).toEqual([]);
	});
	it.each([
		['a host on the other Worker', [row('a', { service: WORKER.b }), row('b')], /not its own Worker/],
		['both hosts on one Worker', [row('a'), row('b', { service: WORKER.a })], /not its own Worker/],
		['a missing host', [row('a')], /bound 0 times/],
		['a host bound twice', [row('a'), row('a', { id: 'f'.repeat(32) }), row('b')], /bound 2 times/],
		['another zone', [row('a', { zone_id: 'db7c322907320aba562d64015ee7d673' }), row('b')], /not the approved zone/],
		['a non-production environment', [row('a', { environment: 'staging' }), row('b')], /not production/],
		['an extra host on an owned Worker', [row('a'), row('b'), row('a', { hostname: 'extra.clearcase.co.za', id: 'e'.repeat(32) })], /also serves extra\.clearcase\.co\.za/],
		['a malformed row', [row('a'), row('b'), { hostname: HOST.a }], /is not \{ id, hostname/],
	])('refuses %s', (_label, list, reason) => expect(customDomainBindProblems(list).join('\n')).toMatch(reason));
});

describe('the rollback detaches only the two reviewed bindings', () => {
	it('is a DELETE by id for each exact binding, and nothing for a host that is not bound', () => {
		expect(planCustomDomainUnbind([row('a'), row('b')]).map((o) => [o.method, o.path, o.hostname])).toEqual([
			['DELETE', `/accounts/${ACCOUNT}/workers/domains/${row('a').id}`, HOST.a],
			['DELETE', `/accounts/${ACCOUNT}/workers/domains/${row('b').id}`, HOST.b],
		]);
		expect(planCustomDomainUnbind([row('b')]).map((o) => o.hostname)).toEqual([HOST.b]);
		expect(planCustomDomainUnbind([])).toEqual([]);
	});
	it('leaves an unrelated domain alone', () => {
		expect(planCustomDomainUnbind([row('a'), row('b'), row('a', { hostname: 'other.example.com', id: '9'.repeat(32) })]).map((o) => o.hostname)).toEqual([HOST.a, HOST.b]);
	});
	it.each([
		['an approved host on another Worker', [row('a', { service: 'someone-else' })]],
		['an approved host in another zone', [row('a', { zone_id: '0'.repeat(32) })]],
		['an approved host listed twice', [row('a'), row('a', { id: 'f'.repeat(32) })]],
		['an id that is not 32 hex', [row('a', { id: '../../zones' })]],
		['a malformed row', ['x']],
	])('refuses %s, so nothing is detached', (_label, list) => expect(() => planCustomDomainUnbind(list)).toThrow(/custom-domain unbind refused/));
	it.each([
		['staging', 'staging'],
		['an empty name', ''],
		['a look-alike name', 'Production'],
	])('refuses the whole rollback when an approved host has drifted to the environment %s, as the bind verification does', (_label, environment) => {
		for (const drifted of ['a', 'b'] as const) {
			const list = [row('a'), row('b')].map((r) => (r.hostname === HOST[drifted] ? { ...r, environment } : r));
			expect(customDomainBindProblems(list).join('\n')).toMatch(/not production/);
			expect(() => planCustomDomainUnbind(list)).toThrow(/custom-domain unbind refused: .*not exactly one production binding of/);
		}
	});
	it('refuses a single drifted binding even when the other host is not bound at all', () => {
		expect(() => planCustomDomainUnbind([row('b', { environment: 'staging' })])).toThrow(/custom-domain unbind refused/);
	});
});
