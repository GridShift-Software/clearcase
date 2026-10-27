// Native alpha custom-domain controls (new native capability, not GRS-203). Unit only: every provider readback,
// dispatch result and canary observation below is injected data. Passing these tests is LOCAL-PLAN-VERIFIED at most;
// it is never REMOTE CONTROL-READY, provider proof or a funding decision.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	APPROVED_NATIVE_SCOPE,
	NATIVE_CONTROLS_SCHEMA,
	bindStageRecord,
	buildReenablePlan,
	buildStopPlan,
	checkNegativeProof,
	parseNativeManifest,
	readOperations,
	readbackProblems,
	stopNativeAlpha,
	stopOperationProblems,
	type CanaryObservation,
	type NativeManifest,
	type ProviderReadback,
	type StopOperation,
} from '../../../../deploy/native-alpha/controls.ts';

const SOURCE = path.join(import.meta.dirname, '../../../../deploy/native-alpha/controls.ts');
const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const ZONE = '1c82369e826ebe0afded65c295198fcd';
const hex = (c: string, n = 32) => c.repeat(n);
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;

// Synthetic identifiers; the approved account, zone, Worker names and hostnames come from the reviewed native scope.
function manifest(): NativeManifest {
	const client = (letter: 'a' | 'b', c: string, d: string) => ({
		client: `client-${letter}`,
		worker: `cc-sbx-${letter}-20261023`,
		domain: { id: hex(c), hostname: `sbx-${letter}.clearcase.co.za`, zoneId: ZONE, service: `cc-sbx-${letter}-20261023`, environment: 'production' },
		versionIds: [uuid(c), uuid(d)],
		secretNames: ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'],
		d1: { binding: 'DB', name: `cc-sbx-${letter}-20261023-db`, id: uuid(c === '1' ? '5' : '6'), jurisdiction: 'eu' },
		r2: { binding: 'BUCKET', bucket: `cc-sbx-${letter}-20261023-files`, jurisdiction: 'eu' },
		release: { sourceSha: hex(c, 40), artifactSha256: `sha256:${hex(c, 64)}`, profileRevision: hex(d, 40) },
		canary: { appPath: '/', assetPath: '/_app/immutable/start.js', assetSha256: `sha256:${hex(d, 64)}` },
	});
	return { schema: NATIVE_CONTROLS_SCHEMA, accountId: ACCOUNT, zone: { id: ZONE, name: 'clearcase.co.za' }, clients: [client('a', '1', '2'), client('b', '3', '4')] } as NativeManifest;
}

function readback(m: NativeManifest, observedAt: number, phase: 'before' | 'after'): ProviderReadback {
	return {
		accountId: m.accountId,
		zoneId: m.zone.id,
		observedAt,
		domains: phase === 'before' ? m.clients.map((c) => ({ ...c.domain })) : [],
		routes: [],
		// Fix round r1 fixture format: the complete account zone inventory (this synthetic account has one zone) and route-list completeness.
		routesComplete: true,
		accountZones: { complete: true, items: [{ id: m.zone.id, name: m.zone.name }] },
		otherZoneRoutes: [],
		workers: m.clients.map((c) => ({ worker: c.worker, workersDev: phase === 'before', previews: phase === 'before', versionIds: [...c.versionIds], secretNames: [...c.secretNames] })),
		d1: m.clients.map((c) => ({ id: c.d1.id, name: c.d1.name, jurisdiction: 'eu' })),
		r2: m.clients.map((c) => ({ bucket: c.r2.bucket, jurisdiction: 'eu', managedDomainEnabled: false, customDomains: [] })),
	};
}

/** An injected transport with a manual clock. `after` edits the after-state before it is returned. */
function harness(opts: { after?: (s: ProviderReadback) => void; before?: (s: ProviderReadback) => void; failDispatch?: (op: StopOperation) => boolean; onDispatch?: (op: StopOperation) => void } = {}) {
	const m = manifest();
	const provider = manifest(); // the provider's state is independent of the caller's manifest object
	let clock = 1_000_000;
	const calls: string[] = [];
	const dispatched: StopOperation[] = [];
	let reads = 0;
	const t = {
		manifest: m,
		// Fix round r1 fixture format: the reviewed KNOWN domain-detach side-effect policy (synthetic; absent means UNKNOWN = HOLD).
		domainDetachPolicy: {
			schema: 'clearcase.native-domain-detach-policy/1',
			status: 'KNOWN',
			appliesTo: { accountId: m.accountId, zoneId: m.zone.id, domains: m.clients.map((c) => ({ id: c.domain.id, hostname: c.domain.hostname })) },
			dnsRecord: 'retained',
			certificate: 'retained',
			newPaidCertificate: false,
			otherDnsRecordsTouched: false,
			source: { document: 'https://example.invalid/synthetic-primary-doc', section: 'synthetic section', excerptSha256: `sha256:${hex('c', 64)}` },
		},
		now: () => clock,
		stopOwnerRequests: async () => {
			calls.push('stop-owner');
			clock += 10;
		},
		readState: async () => {
			calls.push('read');
			clock += 10;
			const s = readback(provider, clock, reads++ === 0 ? 'before' : 'after');
			(reads === 1 ? opts.before : opts.after)?.(s);
			return s;
		},
		dispatch: async (op: StopOperation) => {
			calls.push(`dispatch ${op.method} ${op.path}`);
			opts.onDispatch?.(op);
			dispatched.push(op);
			clock += 10;
			if (opts.failDispatch?.(op)) throw new Error('provider said no');
		},
	};
	return { t, calls, dispatched, m };
}

describe('the reviewed native manifest', () => {
	test('accepts the exact approved native scope and returns a frozen copy', () => {
		const m = parseNativeManifest(manifest());
		expect(m.clients.map((c) => c.domain.hostname)).toEqual(['sbx-a.clearcase.co.za', 'sbx-b.clearcase.co.za']);
		expect(Object.isFrozen(m.clients[0]!.domain)).toBe(true);
		expect(APPROVED_NATIVE_SCOPE.accountId).toBe(ACCOUNT);
		expect(APPROVED_NATIVE_SCOPE.zone.id).toBe(ZONE);
	});

	test('the two-client list is reviewed data, not a coded count: one approved client alone is accepted', () => {
		const m = manifest();
		m.clients.splice(1, 1);
		expect(parseNativeManifest(m).clients).toHaveLength(1);
	});

	const refusals: [string, (m: any) => void, RegExp][] = [
		['a foreign account', (m) => (m.accountId = hex('9')), /account/],
		['a foreign zone', (m) => (m.zone.id = hex('8')), /zone/],
		['a wildcard hostname', (m) => (m.clients[0].domain.hostname = '*.clearcase.co.za'), /hostname/],
		['a foreign hostname', (m) => (m.clients[0].domain.hostname = 'sbx-a.example.com'), /hostname/],
		["another client's hostname", (m) => (m.clients[0].domain.hostname = 'sbx-b.clearcase.co.za'), /hostname/],
		['an unapproved client', (m) => (m.clients[0].client = 'client-z'), /client-z/],
		['a domain bound to another Worker', (m) => (m.clients[0].domain.service = 'cc-sbx-b-20261023'), /service/],
		['a domain in another zone', (m) => (m.clients[0].domain.zoneId = hex('7')), /zone/],
		['an unread key', (m) => (m.clients[0].directBypass = true), /directBypass/],
		['a public R2 setting', (m) => (m.clients[0].r2.publicAccess = true), /publicAccess/],
		['a non-EU D1', (m) => (m.clients[0].d1.jurisdiction = 'us'), /jurisdiction/],
		['a non-EU R2', (m) => (m.clients[0].r2.jurisdiction = 'auto'), /jurisdiction/],
		['no retained Worker versions', (m) => (m.clients[0].versionIds = []), /version/],
		['a D1 UUID shared by two clients', (m) => (m.clients[1].d1.id = m.clients[0].d1.id), /d1/i],
		['a duplicated client', (m) => m.clients.push(structuredClone(m.clients[0])), /client-a/],
		['a missing artifact digest', (m) => delete m.clients[0].release.artifactSha256, /artifact/],
		['a malformed domain ID', (m) => (m.clients[0].domain.id = 'not-an-id'), /domain/],
		['a preview environment', (m) => (m.clients[0].domain.environment = 'preview'), /environment/],
	];
	test.each(refusals)('refuses %s', (_name, mutate, why) => {
		const m = manifest() as any;
		mutate(m);
		expect(() => parseNativeManifest(m)).toThrow(why);
	});

	test('binds the checked stage record: same client and artifact digest, never a bypass', () => {
		const m = parseNativeManifest(manifest());
		const stageJson = (client: string, artifact: string) => JSON.stringify({ schema: 'clearcase.deploy-stage/1', client, files: {}, artifact, migrations: `sha256:${hex('0', 64)}` });
		expect(bindStageRecord(m, 'client-a', stageJson('client-a', m.clients[0]!.release.artifactSha256))).toEqual([]);
		expect(bindStageRecord(m, 'client-a', stageJson('client-b', m.clients[0]!.release.artifactSha256)).join()).toMatch(/client-b/);
		expect(bindStageRecord(m, 'client-a', stageJson('client-a', `sha256:${hex('f', 64)}`)).join()).toMatch(/artifact/);
	});
});

describe('the native stop plan', () => {
	test('ADVERSE: the plan detaches every owned custom domain, not only workers.dev and previews', () => {
		const plan = buildStopPlan(parseNativeManifest(manifest()));
		const detaches = plan.filter((op) => op.kind === 'detach-custom-domain');
		expect(detaches.map((op) => [op.method, op.path])).toEqual([
			['DELETE', `/accounts/${ACCOUNT}/workers/domains/${hex('1')}`],
			['DELETE', `/accounts/${ACCOUNT}/workers/domains/${hex('3')}`],
		]);
		expect(plan.filter((op) => op.kind === 'disable-workers-dev').map((op) => [op.method, op.path, op.body])).toEqual([
			['POST', `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023/subdomain`, { enabled: false, previews_enabled: false }],
			['POST', `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-b-20261023/subdomain`, { enabled: false, previews_enabled: false }],
		]);
		expect(plan).toHaveLength(4);
		expect(Object.isFrozen(plan) && plan.every((op) => Object.isFrozen(op))).toBe(true);
	});

	test('every operation names its primary spec source and every detach a re-attach rollback', () => {
		const m = parseNativeManifest(manifest());
		for (const op of buildStopPlan(m)) expect(op.source).toMatch(/cloudflare-typescript 5\.2\.0/);
		expect(buildReenablePlan(m).map((op) => [op.method, op.path, op.body])).toEqual(
			m.clients.map((c) => ['PUT', `/accounts/${ACCOUNT}/workers/domains`, { environment: 'production', hostname: c.domain.hostname, service: c.worker, zone_id: ZONE }]),
		);
	});

	test('reads use GET only and cover domains, routes, URL settings, versions, secrets, D1 and R2', () => {
		const ops = readOperations(parseNativeManifest(manifest()));
		expect(ops.every((op) => op.method === 'GET')).toBe(true);
		const paths = ops.map((op) => op.path);
		expect(paths).toContain(`/accounts/${ACCOUNT}/workers/domains`);
		expect(paths).toContain(`/zones/${ZONE}/workers/routes`);
		for (const w of ['cc-sbx-a-20261023', 'cc-sbx-b-20261023'])
			for (const leaf of ['subdomain', 'versions', 'secrets']) expect(paths).toContain(`/accounts/${ACCOUNT}/workers/scripts/${w}/${leaf}`);
		expect(paths).toContain(`/accounts/${ACCOUNT}/r2/buckets/cc-sbx-a-20261023-files/domains/custom`);
	});

	const unsafe: [string, Partial<StopOperation>][] = [
		['a Worker delete', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023` }],
		['a D1 delete', { method: 'DELETE', path: `/accounts/${ACCOUNT}/d1/database/${uuid('5')}` }],
		['an R2 delete', { method: 'DELETE', path: `/accounts/${ACCOUNT}/r2/buckets/cc-sbx-a-20261023-files` }],
		['a secret delete', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023/secrets/CLERK_SECRET_KEY` }],
		['a route delete', { method: 'DELETE', path: `/zones/${ZONE}/workers/routes/${hex('e')}` }],
		['a DNS record delete', { method: 'DELETE', path: `/zones/${ZONE}/dns_records/${hex('e')}` }],
		['a workers.dev DELETE', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023/subdomain` }],
		['a foreign domain detach', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/domains/${hex('9')}` }],
		['a re-enabling subdomain body', { method: 'POST', path: `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023/subdomain`, body: { enabled: true, previews_enabled: false } as never }],
	];
	test.each(unsafe)('refuses %s as a stop operation', (_name, op) => {
		const m = parseNativeManifest(manifest());
		expect(stopOperationProblems(m, { kind: 'detach-custom-domain', client: 'client-a', source: 'x', ...op } as StopOperation).length).toBeGreaterThan(0);
	});
	test('accepts its own operations', () => {
		const m = parseNativeManifest(manifest());
		for (const op of buildStopPlan(m)) expect(stopOperationProblems(m, op)).toEqual([]);
	});
});

describe('readback checks', () => {
	const m = () => parseNativeManifest(manifest());
	test('a complete fresh before-state passes; the after-state must show nothing serving', () => {
		expect(readbackProblems(m(), readback(m(), 100, 'before'), 110, 'before')).toEqual([]);
		expect(readbackProblems(m(), readback(m(), 100, 'after'), 110, 'after')).toEqual([]);
		expect(readbackProblems(m(), readback(m(), 100, 'before'), 110, 'after').join()).toMatch(/domain|workers\.dev/);
	});
	const bad: [string, (s: any) => void, RegExp][] = [
		['stale', (s) => (s.observedAt = 100 - 120_000), /stale/],
		['future-dated', (s) => (s.observedAt = 10_000), /stale|future/],
		['an unread key', (s) => (s.cached = true), /cached/],
		['a missing Worker', (s) => s.workers.pop(), /cc-sbx-b-20261023/],
		['an extra unreviewed domain on an owned Worker', (s) => s.domains.push({ id: hex('c'), hostname: 'x.clearcase.co.za', zoneId: ZONE, service: 'cc-sbx-a-20261023', environment: 'production' }), /x\.clearcase/],
		['an owned hostname bound to a foreign Worker', (s) => (s.domains[0].service = 'someone-else'), /someone-else/],
		['a route on an owned Worker', (s) => s.routes.push({ id: hex('d'), pattern: 'clearcase.co.za/a/*', script: 'cc-sbx-a-20261023' }), /route/],
		['a wildcard route covering an owned hostname', (s) => s.routes.push({ id: hex('d'), pattern: '*.clearcase.co.za/*', script: 'other' }), /route/],
		['changed retained versions', (s) => s.workers[0].versionIds.pop(), /version/],
		['changed secret names', (s) => s.workers[0].secretNames.push('NEW'), /secret/],
		['a non-EU R2', (s) => (s.r2[0].jurisdiction = 'default'), /R2|jurisdiction/],
		['a public R2 dev URL', (s) => (s.r2[0].managedDomainEnabled = true), /public|R2/],
		['an R2 custom domain', (s) => s.r2[0].customDomains.push('files.clearcase.co.za'), /public|R2/],
		['a changed D1 identity', (s) => (s.d1[0].id = uuid('7')), /D1/],
		['a foreign account', (s) => (s.accountId = hex('9')), /account/],
	];
	test('provider key order does not matter for an exact domain binding', () => {
		const s = readback(m(), 100, 'before');
		s.domains = s.domains.map(({ environment, service, zoneId, hostname, id }) => ({ environment, service, zoneId, hostname, id }));
		expect(readbackProblems(m(), s, 110, 'before')).toEqual([]);
	});
	test.each(bad)('the before-state is refused when %s', (_n, mutate, why) => {
		const s = readback(m(), 100, 'before') as any;
		mutate(s);
		expect(readbackProblems(m(), s, 110, 'before').join('\n')).toMatch(why);
	});
});

describe('the injected stop orchestration', () => {
	test('stops owner requests first, reads, dispatches each reviewed action once, then reads fresh after-state', async () => {
		const { t, calls } = harness();
		const r = await stopNativeAlpha(t);
		expect(r.state).toBe('STOP-READBACK-CONSISTENT');
		expect(calls[0]).toBe('stop-owner');
		expect(calls[1]).toBe('read');
		expect(calls.filter((c) => c.startsWith('dispatch'))).toHaveLength(4);
		expect(calls.at(-1)).toBe('read');
		expect(r.after!.observedAt).toBeGreaterThan(r.dispatchedAt!);
		expect(r).toMatchObject({ providerProof: false, controlReady: false, retainedStorageBills: true });
	});

	test('no default transport: missing callbacks HOLD before any action', async () => {
		const r = await stopNativeAlpha({ manifest: manifest() } as never);
		expect(r.state).toBe('HOLD');
		expect(r.dispatched).toEqual([]);
	});

	test('a stale manifest (versions changed) HOLDs before any dispatch', async () => {
		const { t, dispatched } = harness({ before: (s) => s.workers[0]!.versionIds.push(uuid('9')) });
		const r = await stopNativeAlpha(t);
		expect(r.state).toBe('HOLD');
		expect(dispatched).toEqual([]);
	});

	test('wrong client mapping in the before-state HOLDs before any dispatch', async () => {
		const { t, dispatched } = harness({ before: (s) => (s.domains[0]!.service = 'cc-sbx-b-20261023') });
		expect((await stopNativeAlpha(t)).state).toBe('HOLD');
		expect(dispatched).toEqual([]);
	});

	test('extra unreviewed route exposure HOLDs before any dispatch', async () => {
		const { t, dispatched } = harness({ before: (s) => s.routes.push({ id: hex('d'), pattern: 'sbx-a.clearcase.co.za/*', script: 'cc-sbx-a-20261023' }) });
		expect((await stopNativeAlpha(t)).state).toBe('HOLD');
		expect(dispatched).toEqual([]);
	});

	test('a callback that mutates the caller manifest or the operation cannot redirect the stop', async () => {
		const { t, dispatched } = harness({
			onDispatch: (op) => {
				try {
					(op as any).path = `/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023`;
				} catch {}
			},
		});
		const original = t.stopOwnerRequests;
		t.stopOwnerRequests = async () => {
			(t.manifest.clients[0]!.domain as any).id = hex('9');
			await original();
		};
		const r = await stopNativeAlpha(t);
		expect(dispatched.map((op) => op.path)).toContain(`/accounts/${ACCOUNT}/workers/domains/${hex('1')}`);
		expect(dispatched.map((op) => op.path)).not.toContain(`/accounts/${ACCOUNT}/workers/domains/${hex('9')}`);
		expect(dispatched.map((op) => op.path)).not.toContain(`/accounts/${ACCOUNT}/workers/scripts/cc-sbx-a-20261023`);
		expect(r.state).toBe('STOP-READBACK-CONSISTENT');
	});

	test('a partial disable HOLDs, keeps dispatching nothing twice, and never falls back to a delete of data', async () => {
		const { t, dispatched } = harness({ failDispatch: (op) => op.kind === 'detach-custom-domain' && op.client === 'client-b', after: (s) => s.domains.push({ ...manifest().clients[1]!.domain }) });
		const r = await stopNativeAlpha(t);
		expect(r.state).toBe('HOLD');
		expect(dispatched).toHaveLength(4);
		expect(new Set(dispatched.map((op) => op.path)).size).toBe(4);
		expect(r.problems.join('\n')).toMatch(/sbx-b|partial|failed/);
	});

	test('the app still served on a custom domain after dispatch HOLDs', async () => {
		const { t } = harness({ after: (s) => s.domains.push({ ...manifest().clients[0]!.domain }) });
		expect((await stopNativeAlpha(t)).state).toBe('HOLD');
	});

	test('workers.dev or previews still on after dispatch HOLDs', async () => {
		const { t } = harness({ after: (s) => (s.workers[1]!.previews = true) });
		expect((await stopNativeAlpha(t)).state).toBe('HOLD');
	});

	test('retained resources changed across the stop HOLD', async () => {
		const { t } = harness({ after: (s) => (s.r2[1]!.bucket = 'cc-sbx-b-20261023-other') });
		expect((await stopNativeAlpha(t)).state).toBe('HOLD');
	});

	test('an after-readback older than the dispatch HOLDs', async () => {
		const { t } = harness({ after: (s) => (s.observedAt -= 1_000) });
		expect((await stopNativeAlpha(t)).problems.join()).toMatch(/predates|stale/);
	});

	test('an unreadable after-state HOLDs with the outcome unknown', async () => {
		const h = harness();
		let n = 0;
		const read = h.t.readState;
		h.t.readState = async () => {
			if (n++ === 1) throw new Error('timeout');
			return read();
		};
		const r = await stopNativeAlpha(h.t);
		expect(r.state).toBe('HOLD');
		expect(r.problems.join()).toMatch(/unknown/);
	});

	test('a throwing clock after dispatch HOLDs with the dispatched record, never an escaped rejection', async () => {
		const h = harness();
		let n = 0;
		const now = h.t.now;
		h.t.now = () => {
			if (++n === 3) throw new Error('clock gone');
			return now();
		};
		const r = await stopNativeAlpha(h.t);
		expect(r.state).toBe('HOLD');
		expect(r.dispatched).toHaveLength(4);
		expect(r.problems.join()).toMatch(/clock gone/);
	});

	test('the module source has no default network, credential, environment, timer or process access', () => {
		const src = readFileSync(SOURCE, 'utf8');
		for (const banned of [/\bfetch\s*\(/, /process\.env/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bBun\./, /from ['"]node:/, /\brequire\(/, /\bDate\.now\b/, /cloud-run/, /\bimport\s*\(/]) expect(src).not.toMatch(banned);
		expect(src).not.toMatch(/^import /m);
	});
});

describe('the post-stop negative proof contract', () => {
	async function stopped() {
		const { t, m } = harness();
		const r = await stopNativeAlpha(t);
		return { r, m: parseNativeManifest(m) };
	}
	function observations(m: NativeManifest, r: Awaited<ReturnType<typeof stopNativeAlpha>>, transport: 'injected' | 'network'): CanaryObservation[] {
		return m.clients.flatMap((c) =>
			(['app', 'asset'] as const).flatMap((kind) => {
				const path = kind === 'app' ? c.canary.appPath : c.canary.assetPath;
				// Fix round r1 fixture format: a network-labelled observation carries provenance, and every observation an end time.
				const provenance = transport === 'network' ? { provenance: { receiptSha256: `sha256:${hex('9', 64)}`, resolver: 'public-dns' as const, tlsVerified: true } } : {};
				const base = { client: c.client, hostname: c.domain.hostname, path, kind, transport, route: 'public-dns' as const, identity: { authenticated: true, client: c.client }, ...provenance };
				return [
					{ ...base, phase: 'before' as const, requestedAt: r.dispatchedAt! - 5, respondedAt: r.dispatchedAt! - 4, outcome: { type: 'response' as const, status: 200, tlsHostname: c.domain.hostname, servedSourceSha: kind === 'app' ? c.release.sourceSha : null, bodySha256: kind === 'asset' ? c.canary.assetSha256 : `sha256:${hex('a', 64)}`, cache: 'miss' as const } },
					{ ...base, phase: 'after' as const, requestedAt: r.after!.observedAt + 5, respondedAt: r.after!.observedAt + 6, outcome: { type: 'network-error' as const, code: 'dns-nxdomain' as const } },
				];
			}),
		);
	}

	test('injected results satisfy the contract shape only as UNIT-CONTRACT-ONLY, never control-ready', async () => {
		const { r, m } = await stopped();
		const v = checkNegativeProof({ manifest: m, stop: r, observations: observations(m, r, 'injected') });
		expect(v).toMatchObject({ state: 'UNIT-CONTRACT-ONLY', controlReady: false });
	});

	test('even network-labelled data is a contract result for the parent to bind to receipts, not CONTROL-READY', async () => {
		const { r, m } = await stopped();
		const v = checkNegativeProof({ manifest: m, stop: r, observations: observations(m, r, 'network') });
		expect(v.state).toBe('NETWORK-LABELLED-STRUCTURALLY-CONSISTENT');
		expect(v.controlReady).toBe(false);
	});

	const fakes: [string, (o: CanaryObservation[], m: NativeManifest) => void, RegExp][] = [
		['a missing after canary on one domain', (o) => o.splice(o.findIndex((x) => x.phase === 'after' && x.client === 'client-b'), 1), /client-b/],
		['a nonexistent host 404', (o) => o.push({ ...o[1]!, hostname: 'nope.clearcase.co.za', outcome: { type: 'response', status: 404, tlsHostname: 'nope.clearcase.co.za', servedSourceSha: null, bodySha256: `sha256:${hex('b', 64)}`, cache: 'miss' } }), /nope/],
		['an anonymous request', (o) => (o[1]!.identity = { authenticated: false, client: null }), /authenticated/],
		['host-header emulation', (o) => (o[1]!.route = 'host-header' as never), /emulat|public-dns/],
		['a foreign build in the positive canary', (o) => ((o[0]!.outcome as any).servedSourceSha = hex('f', 40)), /build|source/],
		['the app still served after stop', (o) => (o[1]!.outcome = { type: 'response', status: 200, tlsHostname: o[1]!.hostname, servedSourceSha: hex('1', 40), bodySha256: `sha256:${hex('a', 64)}`, cache: 'miss' }), /served|2\d\d|build/],
		['the asset still 200 after stop', (o) => (o[3]!.outcome = { type: 'response', status: 200, tlsHostname: o[3]!.hostname, servedSourceSha: null, bodySha256: `sha256:${hex('2', 64)}`, cache: 'miss' }), /asset|served|2\d\d/],
		['the asset bytes from cache under an error status', (o) => (o[3]!.outcome = { type: 'response', status: 404, tlsHostname: o[3]!.hostname, servedSourceSha: null, bodySha256: `sha256:${hex('2', 64)}`, cache: 'hit' }), /asset|cache/],
		['a redirect counted as negative', (o) => (o[1]!.outcome = { type: 'response', status: 302, tlsHostname: o[1]!.hostname, servedSourceSha: null, bodySha256: `sha256:${hex('b', 64)}`, cache: 'miss' }), /redirect/],
		['an auth denial counted as unbinding', (o) => (o[1]!.outcome = { type: 'response', status: 401, tlsHostname: o[1]!.hostname, servedSourceSha: null, bodySha256: `sha256:${hex('b', 64)}`, cache: 'miss' }), /auth|401/],
		['an after canary taken before the after-readback', (o) => (o[1]!.requestedAt = 0), /after/],
		['a wrong-client identity', (o) => (o[1]!.identity = { authenticated: true, client: 'client-b' }), /client-b|identity/],
	];
	test.each(fakes)('refuses %s', async (_n, mutate, why) => {
		const { r, m } = await stopped();
		const o = observations(m, r, 'network');
		mutate(o, m);
		const v = checkNegativeProof({ manifest: m, stop: r, observations: o });
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(why);
	});

	test('an unparsed or foreign manifest, or a doctored after-state, cannot satisfy the contract', async () => {
		const { r, m } = await stopped();
		const o = observations(m, r, 'network');
		const foreign = structuredClone(manifest()) as any;
		foreign.accountId = hex('9');
		expect(checkNegativeProof({ manifest: foreign, stop: r, observations: o }).state).toBe('HOLD');
		const doctored = structuredClone(r);
		doctored.after!.domains.push({ ...manifest().clients[0]!.domain });
		expect(checkNegativeProof({ manifest: m, stop: doctored, observations: o }).problems.join()).toMatch(/still bound/);
	});

	test('a HOLD stop cannot be upgraded by canaries', async () => {
		const { t, m } = harness({ after: (s) => (s.workers[0]!.workersDev = true) });
		const r = await stopNativeAlpha(t);
		const pm = parseNativeManifest(m);
		expect(checkNegativeProof({ manifest: pm, stop: r, observations: [] }).state).toBe('HOLD');
	});
});
