// Native alpha custom-domain controls, fix round r1: adverse tests for the review findings H1, H2 and M1-M4.
// Unit only: every provider state, dispatch result and canary observation is injected data. Passing is LOCAL-PLAN-VERIFIED
// at most; it is never REMOTE CONTROL-READY, provider proof or a funding decision. A 'network' label, a transport name or
// a StopResult handed in by a caller is data, not evidence of where it came from.
import { describe, expect, test } from 'vitest';
import {
	NATIVE_CONTROLS_SCHEMA,
	READBACK_MAX_AGE_MS,
	buildStopPlan,
	checkNegativeProof,
	parseNativeManifest,
	readOperations,
	readbackProblems,
	stopNativeAlpha,
	zoneRoutesReadOperation,
	type CanaryObservation,
	type NativeManifest,
	type ProviderReadback,
	type StopOperation,
	type StopResult,
} from '../../../../deploy/native-alpha/controls.ts';

const ACCOUNT = 'fb4c31b91c5d89b7a54afbdc34823170';
const ZONE = 'db7c322907320aba562d64015ee7d673';
const OTHER_ZONE = 'e'.repeat(32);
const hex = (c: string, n = 32) => c.repeat(n);
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;

function manifest(): NativeManifest {
	const client = (letter: 'a' | 'b', c: string, d: string) => ({
		client: `client-${letter}`,
		worker: `cc-sbx-${letter}-20261023`,
		domain: { id: hex(c), hostname: `${letter}.sandbox.gridshift.co.za`, zoneId: ZONE, service: `cc-sbx-${letter}-20261023`, environment: 'production' },
		versionIds: [uuid(c), uuid(d)],
		secretNames: ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'],
		d1: { binding: 'DB', name: `cc-sbx-${letter}-20261023-db`, id: uuid(c === '1' ? '5' : '6'), jurisdiction: 'eu' },
		r2: { binding: 'BUCKET', bucket: `cc-sbx-${letter}-20261023-files`, jurisdiction: 'eu' },
		release: { sourceSha: hex(c, 40), artifactSha256: `sha256:${hex(c, 64)}`, profileRevision: hex(d, 40) },
		canary: { appPath: '/', assetPath: '/_app/immutable/start.js', assetSha256: `sha256:${hex(d, 64)}` },
	});
	return { schema: NATIVE_CONTROLS_SCHEMA, accountId: ACCOUNT, zone: { id: ZONE, name: 'gridshift.co.za' }, clients: [client('a', '1', '2'), client('b', '3', '4')] } as NativeManifest;
}

/** The reviewed, KNOWN domain-detach side-effect policy for `m`. Structural data only; it is never owner approval. */
function knownPolicy(m: NativeManifest) {
	return {
		schema: 'clearcase.native-domain-detach-policy/1',
		status: 'KNOWN',
		appliesTo: { accountId: m.accountId, zoneId: m.zone.id, domains: m.clients.map((c) => ({ id: c.domain.id, hostname: c.domain.hostname })) },
		dnsRecord: 'retained',
		certificate: 'retained',
		newPaidCertificate: false,
		otherDnsRecordsTouched: false,
		source: { document: 'https://example.invalid/synthetic-primary-doc', section: 'synthetic section', excerptSha256: `sha256:${hex('c', 64)}` },
	};
}

/** The complete account inventory that a native readback carries besides the approved zone's routes. */
function inventory(m: NativeManifest, extraZones: { id: string; name: string }[] = []): Record<string, unknown> {
	return {
		routesComplete: true,
		accountZones: { complete: true, items: [{ id: m.zone.id, name: m.zone.name }, ...extraZones] },
		otherZoneRoutes: extraZones.map((z) => ({ zoneId: z.id, complete: true, routes: [] })),
	};
}

function readback(m: NativeManifest, observedAt: number, phase: 'before' | 'after'): ProviderReadback {
	return {
		accountId: m.accountId,
		zoneId: m.zone.id,
		observedAt,
		domains: phase === 'before' ? m.clients.map((c) => ({ ...c.domain })) : [],
		routes: [],
		workers: m.clients.map((c) => ({ worker: c.worker, workersDev: phase === 'before', previews: phase === 'before', versionIds: [...c.versionIds], secretNames: [...c.secretNames] })),
		d1: m.clients.map((c) => ({ id: c.d1.id, name: c.d1.name, jurisdiction: 'eu' })),
		r2: m.clients.map((c) => ({ bucket: c.r2.bucket, jurisdiction: 'eu', managedDomainEnabled: false, customDomains: [] })),
		...inventory(m),
	} as unknown as ProviderReadback;
}

type Opts = {
	before?: (s: any) => void;
	after?: (s: any) => void;
	/** Runs when an operation is dispatched; `clock` is the manual clock. */
	onDispatch?: (op: StopOperation, n: number, clock: { now: number }) => void;
	dispatchTakes?: number;
	policy?: unknown;
	noPolicy?: boolean;
};
function harness(opts: Opts = {}) {
	const m = manifest();
	const provider = manifest();
	const clock = { now: 1_000_000 };
	const calls: string[] = [];
	const dispatched: StopOperation[] = [];
	let reads = 0;
	const t: any = {
		manifest: m,
		now: () => clock.now,
		stopOwnerRequests: async () => {
			calls.push('stop-owner');
			clock.now += 10;
		},
		readState: async () => {
			calls.push('read');
			clock.now += 10;
			const s = readback(provider, clock.now, reads++ === 0 ? 'before' : 'after');
			(reads === 1 ? opts.before : opts.after)?.(s);
			return s;
		},
		dispatch: async (op: StopOperation) => {
			calls.push(`dispatch ${op.method} ${op.path}`);
			opts.onDispatch?.(op, dispatched.length, clock);
			dispatched.push(op);
			clock.now += opts.dispatchTakes ?? 10;
		},
	};
	if (!opts.noPolicy) t.domainDetachPolicy = opts.policy ?? knownPolicy(m);
	return { t, calls, dispatched, m, clock };
}

async function stopped(opts: Opts = {}) {
	const h = harness(opts);
	const r = await stopNativeAlpha(h.t);
	return { ...h, r, pm: parseNativeManifest(h.m) };
}

function observations(m: NativeManifest, r: StopResult, o: { transport?: 'injected' | 'network'; provenance?: boolean } = {}): CanaryObservation[] {
	const transport = o.transport ?? 'injected';
	return m.clients.flatMap((c) =>
		(['app', 'asset'] as const).flatMap((kind) => {
			const path = kind === 'app' ? c.canary.appPath : c.canary.assetPath;
			const base: any = { client: c.client, hostname: c.domain.hostname, path, kind, transport, route: 'public-dns', identity: { authenticated: true, client: c.client } };
			if (o.provenance) base.provenance = { receiptSha256: `sha256:${hex('9', 64)}`, resolver: 'public-dns', tlsVerified: true };
			return [
				{ ...base, phase: 'before', requestedAt: r.dispatchedAt! - 5, respondedAt: r.dispatchedAt! - 4, outcome: { type: 'response', status: 200, tlsHostname: c.domain.hostname, servedSourceSha: kind === 'app' ? c.release.sourceSha : null, bodySha256: kind === 'asset' ? c.canary.assetSha256 : `sha256:${hex('a', 64)}`, cache: 'miss' } },
				{ ...base, phase: 'after', requestedAt: r.after!.observedAt + 5, respondedAt: r.after!.observedAt + 6, outcome: { type: 'network-error', code: 'dns-nxdomain' } },
			] as CanaryObservation[];
		}),
	);
}
const proof = (pm: NativeManifest, stop: unknown, observations: CanaryObservation[]) => checkNegativeProof({ manifest: pm, stop: stop as StopResult, observations });

describe('H1: the after-state must follow the LAST completed dispatch, not the start of dispatch', () => {
	test('an after-state observed while the last action was still running HOLDs', async () => {
		// dispatches take 1000 ms each; the after-state is stamped between the first dispatch start and the last completion
		const { r } = await stopped({ dispatchTakes: 1000, after: (s) => (s.observedAt = 1_000_020 + 1) });
		expect(r.state).toBe('HOLD');
		expect(r.problems.join('\n')).toMatch(/after-state .*(before|predates).*last (completed )?(action|dispatch)/);
	});

	test('an after-state taken exactly at the last completion is not later than it and HOLDs', async () => {
		const { r } = await stopped({ dispatchTakes: 1000, after: (s) => (s.observedAt = 1_000_020 + 4 * 1000) });
		expect(r.state).toBe('HOLD');
	});

	test('a clock that goes backwards through the dispatches HOLDs with a clock problem and still sends each action once', async () => {
		const { r, dispatched } = await stopped({ onDispatch: (_op, n, clock) => n === 1 && (clock.now -= 500) });
		expect(r.state).toBe('HOLD');
		expect(r.problems.join('\n')).toMatch(/clock .*(backwards|monotonic)/);
		expect(dispatched).toHaveLength(4);
		expect(new Set(dispatched.map((op) => op.path)).size).toBe(4);
	});

	test('every dispatched record carries its own start and a completion taken after its await', async () => {
		const { r } = await stopped({ dispatchTakes: 7 });
		expect(r.state).toBe('STOP-READBACK-CONSISTENT');
		expect(r.dispatched).toHaveLength(4);
		let prev = r.dispatchedAt!;
		for (const d of r.dispatched as any[]) {
			expect(d.startedAt).toBeGreaterThanOrEqual(prev);
			expect(d.completedAt).toBeGreaterThan(d.startedAt);
			prev = d.completedAt;
		}
		expect((r as any).completedAt).toBe(prev);
		expect(r.after!.observedAt).toBeGreaterThan(prev);
	});

	test('the before-state is judged at its own reading and recorded', async () => {
		const { r } = await stopped();
		expect((r as any).beforeCheckedAt).toBeGreaterThanOrEqual(r.before!.observedAt);
		expect((r as any).afterCheckedAt).toBeGreaterThanOrEqual(r.after!.observedAt);
	});

	test('checkNegativeProof re-checks that its after-state follows the last completion', async () => {
		const { r, pm } = await stopped({ dispatchTakes: 100 });
		const late = structuredClone(r) as any;
		late.after.observedAt = r.dispatchedAt! + 150; // inside the dispatch window: later than its start, earlier than its last completion
		late.afterCheckedAt = late.after.observedAt;
		const v = proof(pm, late, observations(pm, r, { transport: 'injected' }));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/after-state .*(before|predates).*last (completed )?(action|dispatch)/);
	});
});

describe('H2: a StopResult handed to checkNegativeProof is re-validated, never trusted', () => {
	test('a fabricated result with no before-state, no actions and network-labelled canaries HOLDs', async () => {
		const { r, pm } = await stopped();
		const forged = { state: 'STOP-READBACK-CONSISTENT', problems: [], dispatched: [], dispatchedAt: r.dispatchedAt, after: r.after, providerProof: false, controlReady: false, retainedStorageBills: true };
		const v = proof(pm, forged, observations(pm, r, { transport: 'network', provenance: true }));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/before-state/);
		expect(v.problems.join('\n')).toMatch(/dispatched .*reviewed stop plan/);
	});

	test('a result missing one reviewed action HOLDs', async () => {
		const { r, pm } = await stopped();
		const edited = structuredClone(r) as any;
		edited.dispatched.pop();
		const v = proof(pm, edited, observations(pm, r));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/dispatched .*reviewed stop plan/);
	});

	test('a result whose actions are reordered or edited HOLDs', async () => {
		const { r, pm } = await stopped();
		const reordered = structuredClone(r) as any;
		reordered.dispatched.reverse();
		expect(proof(pm, reordered, observations(pm, r)).state).toBe('HOLD');
		const edited = structuredClone(r) as any;
		edited.dispatched[1].op.path = `/accounts/${ACCOUNT}/workers/domains/${hex('9')}`;
		expect(proof(pm, edited, observations(pm, r)).state).toBe('HOLD');
	});

	test('a half stop with a failed record relabelled accepted HOLDs by its record, not its label', async () => {
		const { r, pm } = await stopped();
		const half = structuredClone(r) as any;
		half.dispatched[3].outcome = 'failed';
		const v = proof(pm, half, observations(pm, r));
		expect(v.state).toBe('HOLD');
		const noTimes = structuredClone(r) as any;
		for (const d of noTimes.dispatched) delete d.completedAt;
		expect(proof(pm, noTimes, observations(pm, r)).state).toBe('HOLD');
	});

	test('an edited before-state (a domain missing) HOLDs', async () => {
		const { r, pm } = await stopped();
		const edited = structuredClone(r) as any;
		edited.before.domains = [];
		expect(proof(pm, edited, observations(pm, r)).state).toBe('HOLD');
	});

	test('timestamps out of order across before, dispatch and after HOLD', async () => {
		const { r, pm } = await stopped();
		const edited = structuredClone(r) as any;
		edited.before.observedAt = edited.dispatchedAt + 1000;
		edited.beforeCheckedAt = edited.before.observedAt;
		expect(proof(pm, edited, observations(pm, r)).state).toBe('HOLD');
	});

	test('an unmodified copy that stopNativeAlpha did not issue in this process HOLDs: persisted results are not re-judged here', async () => {
		const { r, pm } = await stopped();
		const copy = JSON.parse(JSON.stringify(r));
		const v = proof(pm, copy, observations(pm, r));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/not issued by stopNativeAlpha/);
	});

	test('network-labelled observations without provenance HOLD instead of reaching the contract name', async () => {
		const { r, pm } = await stopped();
		const v = proof(pm, r, observations(pm, r, { transport: 'network' }));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/provenance/);
	});

	test('network observations with a malformed or edited provenance HOLD', async () => {
		const { r, pm } = await stopped();
		for (const edit of [(p: any) => (p.receiptSha256 = 'abc'), (p: any) => (p.tlsVerified = false), (p: any) => (p.resolver = 'host-header'), (p: any) => (p.extra = true)]) {
			const o = observations(pm, r, { transport: 'network', provenance: true }) as any[];
			edit(o[0].provenance);
			expect(proof(pm, r, o).state).toBe('HOLD');
		}
	});

	test('a satisfied contract names itself structural: no remote proof, no control readiness', async () => {
		const { r, pm } = await stopped();
		const v = proof(pm, r, observations(pm, r, { transport: 'network', provenance: true })) as any;
		expect(v.state).toBe('NEGATIVE-PROOF-CONTRACT-SATISFIED');
		expect(v).toMatchObject({ controlReady: false, remoteProof: false, structuralOnly: true });
		expect((proof(pm, r, observations(pm, r)) as any).remoteProof).toBe(false);
	});
});

describe('M1: the positive canary is fresh, uncached and bounded by the before-state', () => {
	const mutateBefore = async (edit: (o: any) => void, who = 0) => {
		const { r, pm } = await stopped();
		const o = observations(pm, r) as any[];
		edit(o[who]);
		return proof(pm, r, o);
	};
	test('a positive canary taken years before the stop HOLDs', async () => {
		const v = await mutateBefore((o) => ((o.requestedAt -= 5 * 365 * 24 * 3600 * 1000), (o.respondedAt = o.requestedAt + 1)));
		expect(v.state).toBe('HOLD');
		expect(v.problems.join('\n')).toMatch(/positive canary .*older than/);
	});
	test('a positive canary just outside the age bound HOLDs and just inside does not', async () => {
		const { r, pm } = await stopped();
		const at = (offset: number) => {
			const o = observations(pm, r) as any[];
			o[0].requestedAt = r.before!.observedAt - READBACK_MAX_AGE_MS + offset;
			o[0].respondedAt = o[0].requestedAt + 1;
			return proof(pm, r, o);
		};
		expect(at(-1).state).toBe('HOLD');
		expect(at(0).state).toBe('UNIT-CONTRACT-ONLY');
	});
	test('a cache hit or unknown cache state on the positive canary HOLDs', async () => {
		for (const cache of ['hit', 'unknown']) {
			const v = await mutateBefore((o) => (o.outcome.cache = cache));
			expect(v.state).toBe('HOLD');
			expect(v.problems.join('\n')).toMatch(/positive canary .*cache/);
		}
	});
	test('a positive canary that finished after the first dispatch started, or ended before it began, HOLDs', async () => {
		const { r, pm } = await stopped();
		for (const edit of [(o: any) => (o.respondedAt = r.dispatchedAt! + 1), (o: any) => (o.respondedAt = o.requestedAt - 1), (o: any) => delete o.respondedAt]) {
			const o = observations(pm, r) as any[];
			edit(o[0]);
			expect(proof(pm, r, o).state).toBe('HOLD');
		}
	});
	test('a post-stop canary needs a valid end time after its start', async () => {
		const { r, pm } = await stopped();
		for (const edit of [(o: any) => (o.respondedAt = o.requestedAt - 1), (o: any) => delete o.respondedAt]) {
			const o = observations(pm, r) as any[];
			edit(o[1]);
			expect(proof(pm, r, o).state).toBe('HOLD');
		}
	});
	test('an after canary still must follow the after-readback; a cached asset 200 after the stop is not negative', async () => {
		const { r, pm } = await stopped();
		const o = observations(pm, r) as any[];
		o[3].outcome = { type: 'response', status: 200, tlsHostname: o[3].hostname, servedSourceSha: null, bodySha256: `sha256:${hex('2', 64)}`, cache: 'hit' };
		expect(proof(pm, r, o).state).toBe('HOLD');
	});
});

describe('M2: hostnames and route patterns are matched case-free and fail closed', () => {
	const m = () => parseNativeManifest(manifest());
	const before = (edit: (s: any) => void) => {
		const s = readback(m(), 100, 'before') as any;
		edit(s);
		return readbackProblems(m(), s, 110, 'before').join('\n');
	};
	const after = (edit: (s: any) => void) => {
		const s = readback(m(), 100, 'after') as any;
		edit(s);
		return readbackProblems(m(), s, 110, 'after').join('\n');
	};
	test.each(['A.sandbox.gridshift.co.za', 'a.SANDBOX.Gridshift.co.ZA', 'a.sandbox.gridshift.co.za.'])('an after-state binding on %s to a foreign service is still an owned binding', (host) => {
		expect(after((s) => s.domains.push({ id: hex('c'), hostname: host, zoneId: ZONE, service: 'someone-else', environment: 'production' }))).toMatch(/still bound/);
	});
	test.each(['A.sandbox.gridshift.co.za', 'a.sandbox.gridshift.co.za.'])('a before-state domain on %s that is not the reviewed binding HOLDs', (host) => {
		expect(before((s) => s.domains.push({ id: hex('c'), hostname: host, zoneId: ZONE, service: 'someone-else', environment: 'production' }))).toMatch(/reviewed binding|extra|exposes/);
	});
	test.each([
		'a.sandbox.gridshift.co.za*',
		'a.sandbox.gridshift.co.za*/*',
		'A.SANDBOX.GRIDSHIFT.CO.ZA/*',
		'HTTPS://a.sandbox.gridshift.co.za/*',
		'https://A.sandbox.gridshift.co.za/*',
		'a.sandbox.gridshift.co.za./*',
		'*.sandbox.gridshift.co.za/*',
		'a.*.gridshift.co.za/*',
		'a.sandbox.*/*',
		'*gridshift.co.za/*',
		'*/*',
		'*',
	])('a route pattern %s covers the owned hostname', (pattern) => {
		expect(before((s) => s.routes.push({ id: hex('d'), pattern, script: null }))).toMatch(/route .*exposes/);
	});
	test.each(['ftp://a.sandbox.gridshift.co.za/*', 'a.sandbox.gridshift.co.za:8443/*', 'a.sandbox.gridshift.co.za?x=1/*', '', ' a.sandbox.gridshift.co.za/*', '//a.sandbox.gridshift.co.za/*', 'a.sandbox.gridshift.co.za\\*'])(
		'an unknown route syntax %j fails closed',
		(pattern) => {
			expect(before((s) => s.routes.push({ id: hex('d'), pattern, script: null }))).toMatch(/route .*(unknown syntax|exposes)/);
		},
	);
	test('a non-string route pattern fails closed', () => {
		expect(before((s) => s.routes.push({ id: hex('d'), pattern: 7, script: null }))).toMatch(/route .*(unknown syntax|exposes)/);
	});
	test('a route to an owned Worker named in other case still HOLDs', () => {
		expect(before((s) => s.routes.push({ id: hex('d'), pattern: 'unrelated.example.com/*', script: 'CC-SBX-A-20261023' }))).toMatch(/route .*exposes/);
	});
	test('unrelated routes and domains do not HOLD', () => {
		expect(before((s) => s.routes.push({ id: hex('d'), pattern: 'unrelated.example.com/*', script: null }))).toBe('');
		expect(before((s) => s.domains.push({ id: hex('c'), hostname: 'elsewhere.example.com', zoneId: ZONE, service: 'someone-else', environment: 'production' }))).toBe('');
		expect(before((s) => s.routes.push({ id: hex('d'), pattern: 'xa.sandbox.gridshift.co.za/*', script: null }))).toBe('');
	});
	test('a provider domain hostname with a wildcard or an unreadable shape fails closed', () => {
		for (const hostname of ['*.sandbox.gridshift.co.za', 'a.sandbox.gridshift.co.za/x', 7, '']) {
			expect(after((s) => s.domains.push({ id: hex('c'), hostname, zoneId: ZONE, service: 'x', environment: 'production' }))).toMatch(/hostname .*(unreadable|wildcard|still bound)/);
		}
	});
});

describe('M3: the readback carries a complete account zone inventory and every zone route list', () => {
	const m = () => parseNativeManifest(manifest());
	const probe = (edit: (s: any) => void, phase: 'before' | 'after' = 'before') => {
		const s = readback(m(), 100, phase) as any;
		edit(s);
		return readbackProblems(m(), s, 110, phase).join('\n');
	};
	const OTHER = { id: OTHER_ZONE, name: 'other.example.com' };
	const withOther = (s: any, routes: any[] = [], complete = true) => {
		Object.assign(s, inventory(m(), [OTHER]));
		s.otherZoneRoutes = [{ zoneId: OTHER_ZONE, complete, routes }];
	};
	test('a readback with no zone inventory is refused', () => {
		expect(probe((s) => delete s.accountZones)).toMatch(/zone inventory is missing/);
	});
	test('an incomplete zone inventory is refused', () => {
		expect(probe((s) => (s.accountZones.complete = false))).toMatch(/zone inventory is not complete/);
	});
	test('an inventory that does not list the approved zone is refused', () => {
		expect(probe((s) => (s.accountZones.items = []))).toMatch(/approved zone .*not .*inventory/);
	});
	test('a missing, duplicated or unknown per-zone route entry is refused', () => {
		expect(probe((s) => (withOther(s), delete s.otherZoneRoutes))).toMatch(/other-zone routes .*missing/);
		expect(probe((s) => (withOther(s), (s.otherZoneRoutes = [])))).toMatch(/zone e+ .*no route list/);
		expect(probe((s) => (withOther(s), s.otherZoneRoutes.push({ zoneId: OTHER_ZONE, complete: true, routes: [] })))).toMatch(/zone e+ .*(more than once|twice)/);
		expect(probe((s) => (withOther(s), s.otherZoneRoutes.push({ zoneId: hex('f'), complete: true, routes: [] })))).toMatch(/zone f+ .*not in the inventory/);
	});
	test('a truncated route list for another zone, or for the approved zone, is refused', () => {
		expect(probe((s) => withOther(s, [], false))).toMatch(/zone e+ .*route list is not complete/);
		expect(probe((s) => (s.routesComplete = false))).toMatch(/approved zone .*route list is not complete/);
		expect(probe((s) => delete s.routesComplete)).toMatch(/approved zone .*route list is not complete/);
	});
	test('a route in ANOTHER zone to an owned Worker is refused, in either phase', () => {
		const route = { id: hex('d'), pattern: 'elsewhere.example.com/*', script: 'cc-sbx-a-20261023' };
		expect(probe((s) => withOther(s, [route]))).toMatch(/zone e+ .*route .*exposes/);
		expect(probe((s) => withOther(s, [route]), 'after')).toMatch(/zone e+ .*route .*exposes/);
	});
	test('a route in another zone whose pattern covers an owned hostname or is unreadable is refused', () => {
		expect(probe((s) => withOther(s, [{ id: hex('d'), pattern: '*/*', script: null }]))).toMatch(/zone e+ .*route .*exposes/);
		expect(probe((s) => withOther(s, [{ id: hex('d'), pattern: 7, script: null }]))).toMatch(/zone e+ .*route .*(unknown syntax|exposes)/);
	});
	test('another zone with only unrelated routes is accepted when its list is complete', () => {
		expect(probe((s) => withOther(s, [{ id: hex('d'), pattern: 'elsewhere.example.com/*', script: 'someone-else' }]))).toBe('');
	});
	test('an unknown key on the inventory is refused', () => {
		expect(probe((s) => (s.accountZones.cached = true))).toMatch(/accountZones/);
	});
	test('reads: GET /zones for the account and GET routes for each listed zone, GET only, no invented endpoint', () => {
		const ops = readOperations(m());
		const zones = ops.find((op) => op.path === '/zones') as any;
		expect(zones).toMatchObject({ method: 'GET', query: { 'account.id': ACCOUNT }, pagination: 'page-until-total' });
		expect(zones.source).toMatch(/zones\.list/);
		const routes = zoneRoutesReadOperation(m(), OTHER_ZONE) as any;
		expect(routes).toMatchObject({ method: 'GET', path: `/zones/${OTHER_ZONE}/workers/routes` });
		expect(routes.source).toMatch(/workers\.routes\.list/);
		expect(() => zoneRoutesReadOperation(m(), 'not a zone/../x')).toThrow(/zone/);
		for (const op of [...ops, routes]) expect(op.method).toBe('GET');
	});
});

describe('M4: a domain detach dispatches only under an explicit reviewed KNOWN DNS/certificate side-effect policy', () => {
	test('with no policy the stop HOLDs before ANY dispatch, naming the unknown DNS and certificate effect', async () => {
		const { r, dispatched, calls } = await stopped({ noPolicy: true });
		expect(r.state).toBe('HOLD');
		expect(dispatched).toEqual([]);
		expect(calls.filter((c) => c.startsWith('dispatch'))).toEqual([]);
		expect(r.problems.join('\n')).toMatch(/DNS .*certificate .*(UNKNOWN|unknown)/);
	});
	test('an UNKNOWN policy HOLDs before any dispatch', async () => {
		const m = manifest();
		const { r, dispatched } = await stopped({ policy: { ...knownPolicy(m), status: 'UNKNOWN' } });
		expect(r.state).toBe('HOLD');
		expect(dispatched).toEqual([]);
	});
	test.each<[string, (p: any) => void, RegExp]>([
		['one for another manifest domain id', (p) => (p.appliesTo.domains[0].id = hex('9')), /applies to/],
		['one missing a client domain', (p) => p.appliesTo.domains.pop(), /applies to/],
		['one for another zone', (p) => (p.appliesTo.zoneId = hex('9')), /applies to/],
		['one that buys a paid certificate', (p) => (p.newPaidCertificate = true), /newPaidCertificate/],
		['one that touches other DNS records', (p) => (p.otherDnsRecordsTouched = true), /otherDnsRecordsTouched/],
		['one with an unknown DNS effect', (p) => (p.dnsRecord = 'unknown'), /dnsRecord/],
		['one with no certificate effect', (p) => delete p.certificate, /certificate/],
		['one with no primary source', (p) => delete p.source, /source/],
		['one with a source that is not an https document', (p) => (p.source.document = 'because I said so'), /source/],
		['one with an unread key', (p) => (p.approved = true), /approved/],
		['one under another schema', (p) => (p.schema = 'x'), /schema/],
	])('a policy: %s HOLDs before any dispatch', async (_n, edit, why) => {
		const policy = knownPolicy(manifest()) as any;
		edit(policy);
		const { r, dispatched } = await stopped({ policy });
		expect(r.state).toBe('HOLD');
		expect(dispatched).toEqual([]);
		expect(r.problems.join('\n')).toMatch(why);
	});
	test('a policy a callback edits after the call cannot change the gate (it is copied before the first await)', async () => {
		const h = harness();
		const policy = h.t.domainDetachPolicy;
		const stopOwner = h.t.stopOwnerRequests;
		h.t.stopOwnerRequests = async () => {
			policy.status = 'UNKNOWN';
			await stopOwner();
		};
		const r = await stopNativeAlpha(h.t);
		expect(r.state).toBe('STOP-READBACK-CONSISTENT');
	});
	test('a valid KNOWN policy still dispatches the four reviewed actions once each, and the result stays unproven', async () => {
		const { r, dispatched } = await stopped();
		expect(r.state).toBe('STOP-READBACK-CONSISTENT');
		expect(dispatched.map((op) => op.path)).toEqual(buildStopPlan(parseNativeManifest(manifest())).map((op) => op.path));
		expect(r).toMatchObject({ providerProof: false, controlReady: false, retainedStorageBills: true });
	});
});
